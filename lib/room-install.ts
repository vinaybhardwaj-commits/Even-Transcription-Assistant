/**
 * lib/room-install.ts — the install and fleet server contract (Install and Fleet PRD §4, Build R1).
 *
 * Every `app_release` / `room_bootstrap_token` / `room_install` query in the app lives HERE, the
 * lib/bench-commands.ts convention, so the lifecycle is unit-testable against a mocked `sql` and
 * the SQL can be read in one place. Migration 0075 has NOT run at build time — every string below
 * is INFERRED against db/migrations/0075_room_install.sql.
 *
 * ─── TWO RULES GOVERN THIS WHOLE MODULE ──────────────────────────────────────────────────
 *
 * 1. LABELS ARE DERIVED, NEVER TYPED. `version`, `build_sha`, `sha256` and `size_bytes` come
 *    from the packaging manifest and from this server's own recomputation over the Blob object.
 *    `createRelease` refuses with SHA_MISMATCH on any difference between the two. There is no
 *    code path that stores a number a person supplied without checking it against the bytes.
 *
 * 2. THE PAGE NEVER ASSERTS COMPLETION. Nothing here is written by the admin card. Every state
 *    column on `room_install` is written by `applyInstallPoll`, from a poll the APP sent.
 *
 * ─── WHY THE TWO MULTI-WRITE PATHS USE sql.transaction AND NOT ONE CTE ───────────────────
 * The obvious way to write the enrol exchange is a single statement chaining data-modifying CTEs.
 * It is wrong here, and the reason is the partial unique index. Retiring the old install and
 * enrolling the new one both touch `uq_room_install_active_room`, and CTE EXECUTION ORDER IS NOT
 * DEFINED — if the enrol ran first, the new row would enter the index while the old row was still
 * in it, and the statement would fail on a uniqueness violation that has nothing to do with the
 * operator's intent. Neon's HTTP driver gives ordered statements inside one transaction, so the
 * retire lands first, by construction, every time.
 */

import { NextResponse } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { customAlphabet } from "nanoid";
import { sql } from "@/lib/db";
import { signRoomJwt } from "@/lib/room-auth";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import {
  groupFleet,
  type FleetPayload,
  type FleetRoom,
  type FleetRow,
  type InputDevice,
  type InstallView,
  type ReleaseView,
} from "@/lib/room-install-view";

export type { FleetPayload, FleetRow, InstallView, ReleaseView };

// ---------------------------------------------------------------------------
// Errors — the module's own codes, in the house envelope
// ---------------------------------------------------------------------------

/**
 * §4.2 names eight codes that lib/respond.ts does not carry, with statuses of their own
 * (409 VERSION_EXISTS, 409 NO_RELEASE). Rather than widen the app-wide `ErrorCode` union with
 * eight strings only this module can emit, the SHAPE is reused — `{ error: { code, message } }`
 * is byte-identical to what respondError produces — and the codes stay local.
 */
export type InstallErrorCode =
  | "BAD_BUNDLE"
  | "SHA_MISMATCH"
  | "VERSION_EXISTS"
  | "ROOM_UNKNOWN"
  | "NO_RELEASE"
  | "TOKEN_INVALID"
  | "BOOTSTRAP_RATE_LIMITED"
  | "ENROL_RATE_LIMITED"
  | "NOT_FOUND"
  | "RETIRED"
  | "BAD_CHANNEL"
  | "STORE_UNAVAILABLE";

export const INSTALL_ERROR_STATUS: Record<InstallErrorCode, number> = {
  BAD_BUNDLE: 400,
  SHA_MISMATCH: 400,
  VERSION_EXISTS: 409,
  ROOM_UNKNOWN: 404,
  NO_RELEASE: 409,
  TOKEN_INVALID: 400,
  BOOTSTRAP_RATE_LIMITED: 429,
  ENROL_RATE_LIMITED: 429,
  NOT_FOUND: 404,
  RETIRED: 409,
  // B2-D5. The assign route admits `stable` and nothing else; anything else is the caller's error.
  BAD_CHANNEL: 400,
  STORE_UNAVAILABLE: 503,
};

export class InstallError extends Error {
  constructor(
    public code: InstallErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** 42P01 → the migration has not run. Said out loud rather than as a 500. */
export function classifyInstallError(e: unknown): InstallError {
  if (e instanceof InstallError) return e;
  const code = (e as { code?: unknown })?.code;
  const msg = String((e as Error)?.message ?? e);
  if (code === "42P01" || /relation "?(app_release|room_bootstrap_token|room_install)"? does not exist/i.test(msg)) {
    return new InstallError("STORE_UNAVAILABLE", "migration 0075 has not been applied");
  }
  if (code === "23505" || /duplicate key value/i.test(msg)) {
    return new InstallError("VERSION_EXISTS", "a release with this version already exists on this channel");
  }
  return new InstallError("STORE_UNAVAILABLE", msg.slice(0, 200));
}

// ---------------------------------------------------------------------------
// Ids, tokens, origin
// ---------------------------------------------------------------------------

const shortId = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 12);

export const newReleaseId = (): string => `rel_${shortId()}`;
export const newInstallId = (): string => `install_${shortId()}`;

/**
 * THE TOKEN IS THE ONLY CREDENTIAL on two unauthenticated routes, so it is minted from the
 * system CSPRNG rather than from the nanoid used for row ids. 24 bytes of hex is 192 bits.
 *
 * The mockup draws a 12-character token; that is illustrative of the URL's shape and is not a
 * ratified length. Nothing about the card changes with a longer one.
 */
export const newBootstrapToken = (): string => randomBytes(24).toString("hex");

/** §4.1: the TTL is 30 minutes, and it is stated once. */
export const TOKEN_TTL_MINUTES = 30;
/** D10: install sessions last 365 days. Human PIN logins are untouched at 30. */
export const INSTALL_SESSION_TTL_SECONDS = 60 * 60 * 24 * 365;

/**
 * The origin that goes into the pasted one-liner.
 *
 * NOT `APP_URL`, deliberately. §8 acceptance item 4 requires the returned `command` to match the
 * §4.2 one-liner EXACTLY, which names `https://www.evenscribe.app`. This repository already
 * documents (app/api/admin/doctors/route.ts) that the deployed `APP_URL` holds a stale value that
 * has to be overridden in code — reading it here would silently emit a command that fails the
 * acceptance it was written for, or worse, points a clinic Mac at a host that does not answer.
 * `ROOM_RECORDER_ORIGIN` is the deliberate override; the default is the PRD's literal.
 */
export function recorderOrigin(): string {
  const raw = (process.env.ROOM_RECORDER_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (raw && /^https:\/\/[a-z0-9.-]+$/i.test(raw)) return raw;
  return "https://www.evenscribe.app";
}

/** §4.2 — the exact one-liner. One function, so the card and the script cannot disagree. */
export function installCommand(token: string, origin = recorderOrigin()): string {
  return `curl -fsSL "${origin}/api/room-recorder/bootstrap/${token}" | bash`;
}

// ---------------------------------------------------------------------------
// Rate limiting — the two §4.2 codes, and nothing more
// ---------------------------------------------------------------------------

/**
 * §4.2 names BOOTSTRAP_RATE_LIMITED and ENROL_RATE_LIMITED but states no numbers, and the kickoff
 * forbids any limiting "beyond the two numbers in §4.2". The codes are part of the contract, so
 * the routes must be able to emit them; the numbers are NOT in the document.
 *
 * These two are therefore CHOSEN, not quoted, and flagged in the build report for V to ratify.
 * They are set high enough that no honest install can reach them — one paste makes one bootstrap
 * fetch and one enrol call — and low enough that a script hammering a token is stopped.
 *
 * IN-PROCESS AND PER-INSTANCE, on purpose. A shared store would be new infrastructure, and the
 * kickoff rules out anything from a security checklist. This is the cheap thing that makes the
 * two named codes real; it is not a defence and is not described as one.
 */
export const BOOTSTRAP_RATE_LIMIT = { max: 30, windowMs: 60_000 };
export const ENROL_RATE_LIMIT = { max: 10, windowMs: 60_000 };

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimited(key: string, limit: { max: number; windowMs: number }, nowMs = Date.now()): boolean {
  const b = rateBuckets.get(key);
  if (!b || b.resetAt <= nowMs) {
    rateBuckets.set(key, { count: 1, resetAt: nowMs + limit.windowMs });
    // Cheap eviction: this map must not grow without bound on a long-lived instance.
    if (rateBuckets.size > 5_000) {
      for (const [k, v] of rateBuckets) if (v.resetAt <= nowMs) rateBuckets.delete(k);
    }
    return false;
  }
  b.count += 1;
  return b.count > limit.max;
}

/** Test seam — the buckets are module state and a test must be able to start from zero. */
export function __resetRateLimits(): void {
  rateBuckets.clear();
}

// ---------------------------------------------------------------------------
// Releases (§4.2)
// ---------------------------------------------------------------------------

export type ReleaseManifest = {
  version: string;
  build_sha: string;
  sha256: string;
  size_bytes: number;
  min_macos?: string;
  notes?: string;
};

/**
 * PURE — is this the packaging script's release.json, and nothing else?
 *
 * Every field is checked for SHAPE here and for TRUTH by `createRelease`, which recomputes the
 * two that can be checked against bytes. A manifest that passes this and fails that is a
 * SHA_MISMATCH, which is a different and much more interesting failure than a malformed field.
 */
export function parseManifest(raw: unknown): ReleaseManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const version = typeof m.version === "string" ? m.version.trim() : "";
  const buildSha = typeof m.build_sha === "string" ? m.build_sha.trim() : "";
  const sha256 = typeof m.sha256 === "string" ? m.sha256.trim().toLowerCase() : "";
  const size = typeof m.size_bytes === "number" ? m.size_bytes : Number(m.size_bytes);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) return null;
  if (!/^[0-9a-fA-F]{7,64}$/.test(buildSha)) return null;
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const minMacos = typeof m.min_macos === "string" && m.min_macos.trim() ? m.min_macos.trim() : "15.0";
  const notes = typeof m.notes === "string" && m.notes.trim() ? m.notes.trim().slice(0, 2000) : null;
  return {
    version,
    build_sha: buildSha.toLowerCase(),
    sha256,
    size_bytes: size,
    min_macos: minMacos,
    ...(notes ? { notes } : {}),
  };
}

/**
 * PURE — is this address a Vercel Blob object?
 *
 * The bootstrap script hands this URL to `curl` on a clinic Mac and runs what comes back, so it
 * is not merely a database field: it is the address of code that will execute in a consulting
 * room. `app_release.blob_url` is documented as "the Vercel Blob download address" and this
 * checks it is one, rather than trusting the column comment.
 */
export function isBlobUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false; /* not a URL at all */
  }
  if (u.protocol !== "https:") return false;
  return /(^|\.)blob\.vercel-storage\.com$/i.test(u.hostname);
}

export type BundleDigest = { sha256: string; size_bytes: number };

/**
 * Stream the Blob object and compute what is actually there.
 *
 * STREAMED, not buffered: the bundle is tens of megabytes and a serverless function that holds
 * one in memory to hash it is one bundle-size increase away from an OOM that would look like an
 * unrelated outage.
 */
export async function digestBlob(
  blobUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BundleDigest> {
  const res = await fetchImpl(blobUrl, { cache: "no-store" });
  if (!res.ok || !res.body) {
    throw new InstallError("BAD_BUNDLE", `blob fetch failed with ${res.status}`);
  }
  const hash = createHash("sha256");
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      hash.update(value);
      size += value.byteLength;
    }
  }
  return { sha256: hash.digest("hex"), size_bytes: size };
}

/** Constant-time compare of two hex digests of equal length. */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export type CreateReleaseInput = {
  blobUrl: string;
  channel: "stable" | "test";
  manifest: ReleaseManifest;
  publishedBy: string;
  fetchImpl?: typeof fetch;
};

/**
 * Register a release the publisher has already uploaded to Blob.
 *
 * THE ORDER MATTERS. The bytes are hashed BEFORE the row is written, so a bundle that does not
 * match its manifest never reaches the table at all — there is no window in which the fleet card
 * could offer an install command for a release whose checksum was later found to be wrong.
 */
export async function createRelease(input: CreateReleaseInput): Promise<ReleaseView> {
  const actual = await digestBlob(input.blobUrl, input.fetchImpl ?? fetch);

  if (actual.size_bytes !== input.manifest.size_bytes) {
    throw new InstallError(
      "SHA_MISMATCH",
      `size mismatch: the manifest says ${input.manifest.size_bytes} bytes, the blob is ${actual.size_bytes}`,
    );
  }
  if (!sameDigest(actual.sha256, input.manifest.sha256)) {
    throw new InstallError(
      "SHA_MISMATCH",
      `sha256 mismatch: the manifest says ${input.manifest.sha256}, the blob hashes to ${actual.sha256}`,
    );
  }

  const id = newReleaseId();
  try {
    const rows = (await sql`
      INSERT INTO app_release (
        id, version, build_sha, sha256, size_bytes, blob_url, channel, published_by, notes, min_macos
      ) VALUES (
        ${id}, ${input.manifest.version}, ${input.manifest.build_sha}, ${actual.sha256},
        ${actual.size_bytes}, ${input.blobUrl}, ${input.channel}, ${input.publishedBy},
        ${input.manifest.notes ?? null}, ${input.manifest.min_macos ?? "15.0"}
      )
      RETURNING id, version, build_sha, sha256, size_bytes, blob_url, channel,
                published_at, published_by, withdrawn_at, notes, min_macos
    `) as ReleaseView[];
    return normaliseRelease(rows[0]!);
  } catch (e) {
    throw classifyInstallError(e);
  }
}

function normaliseRelease(r: ReleaseView): ReleaseView {
  return {
    ...r,
    size_bytes: Number(r.size_bytes),
    published_at: new Date(r.published_at).toISOString(),
    withdrawn_at: r.withdrawn_at ? new Date(r.withdrawn_at).toISOString() : null,
  };
}

export async function listReleases(channel?: string | null): Promise<ReleaseView[]> {
  try {
    const ch = channel === "stable" || channel === "test" ? channel : null;
    const rows = (await sql`
      SELECT id, version, build_sha, sha256, size_bytes, blob_url, channel,
             published_at, published_by, withdrawn_at, notes, min_macos
        FROM app_release
       WHERE (${ch}::text IS NULL OR channel = ${ch}::text)
       ORDER BY published_at DESC
       LIMIT 200
    `) as ReleaseView[];
    return rows.map(normaliseRelease);
  } catch (e) {
    throw classifyInstallError(e);
  }
}

/**
 * The newest release on a channel that has not been withdrawn.
 *
 * THIS IS THE FEATURE GATE AND THE R3 ROLLBACK, one query serving both. Null here means the fleet
 * card reads "No release published yet" and every install button is off; withdrawing the newest
 * row makes this return the one before it, which is what walks a Mac backwards in Build R3.
 */
export async function latestRelease(channel: "stable" | "test" = "stable"): Promise<ReleaseView | null> {
  try {
    const rows = (await sql`
      SELECT id, version, build_sha, sha256, size_bytes, blob_url, channel,
             published_at, published_by, withdrawn_at, notes, min_macos
        FROM app_release
       WHERE channel = ${channel} AND withdrawn_at IS NULL
       ORDER BY published_at DESC
       LIMIT 1
    `) as ReleaseView[];
    return rows[0] ? normaliseRelease(rows[0]) : null;
  } catch (e) {
    throw classifyInstallError(e);
  }
}

export async function withdrawRelease(id: string): Promise<ReleaseView | null> {
  try {
    const rows = (await sql`
      UPDATE app_release
         SET withdrawn_at = now()
       WHERE id = ${id} AND withdrawn_at IS NULL
      RETURNING id, version, build_sha, sha256, size_bytes, blob_url, channel,
                published_at, published_by, withdrawn_at, notes, min_macos
    `) as ReleaseView[];
    return rows[0] ? normaliseRelease(rows[0]) : null;
  } catch (e) {
    throw classifyInstallError(e);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap token mint (§4.2)
// ---------------------------------------------------------------------------

export type MintResult = {
  token: string;
  install_id: string;
  command: string;
  expires_at: string;
  room: { id: string; slug: string; name: string };
  release: ReleaseView;
};

/**
 * Mint a bootstrap token and the install row it names, in one transaction.
 *
 * NO RELEASE, NO TOKEN. §4.2 requires 409 NO_RELEASE, and the reason is worth stating: the script
 * this token would fetch substitutes a Blob URL and a sha256 from the release. Without one there
 * is nothing to download, and a token that could only ever produce a broken paste is worse than
 * a refusal, because the operator would take it to the room before finding out.
 */
export async function mintBootstrapToken(input: {
  roomId: string;
  createdBy: string;
}): Promise<MintResult> {
  const rooms = (await sql`
    SELECT id, slug, name FROM room WHERE id = ${input.roomId} LIMIT 1
  `) as Array<{ id: string; slug: string; name: string }>;
  const room = rooms[0];
  if (!room) throw new InstallError("ROOM_UNKNOWN", "no such room");

  // STABLE, and only stable. The token row has no channel column to carry any other choice, and
  // the bootstrap fetch reads the release again minutes later — so a token minted against a
  // different channel could not be honoured by the script it produces. `latestRelease` keeps its
  // channel parameter for Build R3's release route, which reads it per request.
  const release = await latestRelease("stable");
  if (!release) throw new InstallError("NO_RELEASE", "no release published yet");

  const token = newBootstrapToken();
  const installId = newInstallId();
  const ttlSeconds = TOKEN_TTL_MINUTES * 60;

  try {
    // Install row FIRST: room_bootstrap_token.install_id names it, and a token pointing at a row
    // that does not exist yet would be a broken foreign key in the other ordering.
    const results = (await sql.transaction([
      sql`
        INSERT INTO room_install (install_id, room_id, enrolled_by)
        VALUES (${installId}, ${room.id}, ${input.createdBy})
      `,
      sql`
        INSERT INTO room_bootstrap_token (token, room_id, install_id, created_by, expires_at)
        VALUES (
          ${token}, ${room.id}, ${installId}, ${input.createdBy},
          now() + (${ttlSeconds}::int * INTERVAL '1 second')
        )
        RETURNING expires_at
      `,
    ])) as unknown as Array<Array<{ expires_at: string | Date }>>;

    const expiresAt = results[1]?.[0]?.expires_at ?? new Date(Date.now() + ttlSeconds * 1000);
    return {
      token,
      install_id: installId,
      command: installCommand(token),
      expires_at: new Date(expiresAt).toISOString(),
      room,
      release,
    };
  } catch (e) {
    throw classifyInstallError(e);
  }
}

// ---------------------------------------------------------------------------
// The bootstrap script (§4.4)
// ---------------------------------------------------------------------------

/**
 * Make a value safe INSIDE the double quotes the §4.4 body already uses.
 *
 * §4.4 is reproduced verbatim, which means the substitution points sit inside `"..."` — where
 * bash still expands `$`, honours a backslash and runs a backtick. Four rooms are named by an
 * admin typing into a text box, and `OPD "3"` would end the string. Nothing here is restructured
 * to avoid the problem: the four characters that matter are escaped, and control characters
 * (a newline would end the statement outright) are dropped.
 */
export function escapeForDoubleQuotes(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/([\\"`$])/g, "\\$1");
}

export type ScriptInput = {
  token: string;
  origin: string;
  blobUrl: string;
  sha256: string;
  version: string;
  roomName: string;
};

/**
 * Render the §4.4 body for one token. The body is REPRODUCED VERBATIM from the PRD — the only
 * changes are the six substitutions it marks. `bootout` is present, and it is present for a
 * reason worth keeping in view: a re-install on a Mac already running the app is the same single
 * paste, and this line is what stops the earlier copy before its bundle is replaced underneath it.
 */
export function renderBootstrapScript(input: ScriptInput): string {
  const token = escapeForDoubleQuotes(input.token);
  const origin = escapeForDoubleQuotes(input.origin);
  const blobUrl = escapeForDoubleQuotes(input.blobUrl);
  const sha = escapeForDoubleQuotes(input.sha256);
  const version = escapeForDoubleQuotes(input.version);
  const roomName = escapeForDoubleQuotes(input.roomName);

  return `#!/bin/bash
set -euo pipefail

APP="EvenScribe Room Recorder.app"
DEST="$HOME/Applications"
PLIST="$HOME/Library/LaunchAgents/com.evenscribe.room-recorder.plist"
TOKEN="${token}"
ORIGIN="${origin}"
BLOB_URL="${blobUrl}"
EXPECTED_SHA="${sha}"
TMP="$(mktemp -d)"

echo "Downloading EvenScribe Room Recorder ${version}..."
curl -fsSL -o "$TMP/app.zip" "$BLOB_URL"

echo "Verifying the download..."
ACTUAL_SHA="$(shasum -a 256 "$TMP/app.zip" | awk '{print $1}')"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "Checksum mismatch. Install stopped. Nothing was changed."
  exit 1
fi

echo "Stopping any earlier copy..."
launchctl bootout "gui/$(id -u)/com.evenscribe.room-recorder" 2>/dev/null || true

echo "Installing into ~/Applications..."
mkdir -p "$DEST"
ditto -x -k "$TMP/app.zip" "$TMP/expanded"
rm -rf "$DEST/$APP"
ditto "$TMP/expanded/$APP" "$DEST/$APP"

echo "Enrolling this Mac..."
"$DEST/$APP/Contents/MacOS/room-recorder" enrol --token "$TOKEN" --origin "$ORIGIN"

echo "Installing the LaunchAgent..."
"$DEST/$APP/Contents/MacOS/room-recorder" install-launch-agent

echo "Starting the app..."
launchctl bootstrap "gui/$(id -u)" "$PLIST" || launchctl load "$PLIST"

rm -rf "$TMP"
echo "Installed and enrolled as ${roomName}. Close this window."
`;
}

/**
 * The script for a token, or null when the token is unknown, expired or already spent.
 *
 * IT DOES NOT CONSUME THE TOKEN (§4.2). The script needs the same token a few seconds later for
 * the enrol call, so `used_at` stays NULL here; only the enrol exchange spends it.
 */
export async function bootstrapScriptFor(token: string): Promise<string | null> {
  try {
    const rows = (await sql`
      SELECT t.token, r.name AS room_name
        FROM room_bootstrap_token t
        JOIN room r ON r.id = t.room_id
       WHERE t.token = ${token}
         AND t.used_at IS NULL
         AND t.expires_at > now()
       LIMIT 1
    `) as Array<{ token: string; room_name: string }>;
    const row = rows[0];
    if (!row) return null;

    // The release is read at FETCH time, not at mint time, so a withdraw between the copy and
    // the paste is honoured: the script that runs is built from what is published now.
    const release = await latestRelease("stable");
    if (!release) return null;

    return renderBootstrapScript({
      token: row.token,
      origin: recorderOrigin(),
      blobUrl: release.blob_url,
      sha256: release.sha256,
      version: release.version,
      roomName: row.room_name,
    });
  } catch (e) {
    throw classifyInstallError(e);
  }
}

// ---------------------------------------------------------------------------
// The enrol exchange (§4.2, §4.5, D10)
// ---------------------------------------------------------------------------

export type EnrolResult = {
  install_id: string;
  room_slug: string;
  room_name: string;
  session: { token: string; expires_at: string };
};

/**
 * Spend a token: mark it used, enrol its install, retire whatever else held the room, and sign a
 * 365-day room session — in one transaction, in this order.
 *
 * THE CLAIM AND THE RETIRE ARE THE SAME STATEMENT. The first statement's CTE sets `used_at` only
 * if it is still NULL and the row is unexpired, and the retire hangs off that CTE's RETURNING —
 * so nothing is retired unless this call is the one that won the token. Two simultaneous
 * exchanges cannot both retire: the loser's UPDATE re-evaluates `used_at IS NULL` after the row
 * lock and matches nothing.
 *
 * THE SECOND STATEMENT IS THE SINGLE-USE GUARANTEE, from a different direction. It enrols only a
 * row whose `enrolled_at` is still NULL, so a token replayed after a successful exchange finds
 * the install already enrolled and updates nothing — and this function reports TOKEN_INVALID off
 * exactly that emptiness. Acceptance item 6 is that sentence.
 */
export async function enrolWithToken(token: string): Promise<EnrolResult> {
  const ttl = INSTALL_SESSION_TTL_SECONDS;
  let rows: Array<{ install_id: string; room_id: string; slug: string; name: string; session_expires_at: string | Date }>;

  try {
    const results = (await sql.transaction([
      // 1. Claim the token, and retire every OTHER live install of that room off the claim.
      sql`
        WITH claimed AS (
          UPDATE room_bootstrap_token
             SET used_at = now()
           WHERE token = ${token}
             AND used_at IS NULL
             AND expires_at > now()
          RETURNING room_id, install_id
        )
        UPDATE room_install ri
           SET retired_at = now()
          FROM claimed c
         WHERE ri.room_id = c.room_id
           AND ri.install_id <> c.install_id
           AND ri.retired_at IS NULL
           AND ri.enrolled_at IS NOT NULL
        RETURNING ri.install_id
      `,
      // 2. Enrol the install the token names. Runs AFTER the retire, so the partial unique index
      //    never sees two live enrolments of one room even for the width of a statement.
      sql`
        UPDATE room_install ri
           SET enrolled_at = now(),
               session_expires_at = now() + (${ttl}::int * INTERVAL '1 second')
          FROM room_bootstrap_token t
          JOIN room r ON r.id = t.room_id
         WHERE t.token = ${token}
           AND t.used_at IS NOT NULL
           AND ri.install_id = t.install_id
           AND ri.enrolled_at IS NULL
           AND ri.retired_at IS NULL
        RETURNING ri.install_id, ri.room_id, r.slug, r.name, ri.session_expires_at
      `,
    ])) as unknown as [unknown, typeof rows];
    rows = results[1];
  } catch (e) {
    throw classifyInstallError(e);
  }

  const row = rows?.[0];
  if (!row) {
    // Unknown, expired and used tokens are ONE answer, deliberately (§4.2). Telling the caller
    // which of the three it was would let an unauthenticated endpoint confirm that a token
    // existed, and no honest client on a clinic Mac has any use for the distinction.
    throw new InstallError("TOKEN_INVALID", "token is unknown, expired or already used");
  }

  const jwt = await signRoomJwt({ room_id: row.room_id, slug: row.slug }, { ttlSeconds: ttl });
  // The row's own `session_expires_at` is preferred because it is the database's clock, which is
  // the one the fleet card counts down from. Falling back to this server's clock rather than
  // throwing: the JWT has already been signed at this point, and a formatting fault must not turn
  // a successful enrolment into a 500 that leaves the token spent and the app with no session.
  const stampMs = Date.parse(String(row.session_expires_at ?? ""));
  const expiresAt = Number.isFinite(stampMs) ? new Date(stampMs) : new Date(Date.now() + ttl * 1000);

  return {
    install_id: row.install_id,
    room_slug: row.slug,
    room_name: row.name,
    session: {
      token: jwt,
      expires_at: expiresAt.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Retire (§4.2, §4.5 rule 5)
// ---------------------------------------------------------------------------

export async function retireInstall(installId: string): Promise<InstallView | null> {
  try {
    const rows = (await sql`
      UPDATE room_install
         SET retired_at = now()
       WHERE install_id = ${installId} AND retired_at IS NULL
      RETURNING install_id, room_id, created_at, enrolled_at, session_expires_at, launched_by,
             hostname, hardware_model, os_version, input_device_name, app_version, build_sha,
             first_seen_at, last_seen_at, mic_state, launch_agent_loaded,
             tape_advancing, tape_poll_streak, tape_advancing_since, never_sleep, retired_at,
             session_open, update_channel, last_update_result, last_update_version,
             last_update_error, last_update_at, disk_free_bytes,
             assigned_channel, peak, zero_ratio, input_devices
    `) as InstallView[];
    return rows[0] ? normaliseInstall(rows[0]) : null;
  } catch (e) {
    throw classifyInstallError(e);
  }
}

// ---------------------------------------------------------------------------
// The poll's write (§4.3)
// ---------------------------------------------------------------------------

export type InstallPollFields = {
  install_id: string;
  app_version?: string | null;
  build_sha?: string | null;
  mic_state?: string | null;
  tape_advancing?: boolean | null;
  never_sleep?: boolean | null;
  launched_by?: string | null;
  /** Machine facts, carried on the first poll. Not among §4.3's seven; see applyInstallPoll. */
  hostname?: string | null;
  hardware_model?: string | null;
  os_version?: string | null;
  /** §4.3's eighth field (V, 8 Sep): what the configured input device is called, measured. */
  input_device_name?: string | null;
  // ── Build R3, §13.4 ──────────────────────────────────────────────────────────────────────
  /** R3-6. A LIVE reading of the app's own engine. The one field below that is not COALESCEd. */
  session_open?: boolean | null;
  /** R3-8. `stable` or `test`, from the Mac's own config.json. */
  update_channel?: string | null;
  /** From update-result.json, written by the swap script and read once by the new copy. */
  last_update_result?: string | null;
  /** The version that attempt was reaching for. Its own column since Fix 1 (V, 9 Sep). */
  last_update_version?: string | null;
  last_update_error?: string | null;
  last_update_at?: string | null;
  /** V, 9 Sep. Free bytes on the captures volume. Never 0 or -1 — absent when unreadable. */
  disk_free_bytes?: string | number | null;
  // ── Release B2 (0079). Sent by 0.1.20 and later; every earlier app omits all three. ─────────
  /** B2-D7. Highest absolute sample over the last piece window, 0..1. */
  peak?: string | number | null;
  /** B2-D7. Fraction of bit-exact zero samples over the same window, 0..1. */
  zero_ratio?: string | number | null;
  /** B2-D10. The device list, as the JSON text the query string carried (or already parsed). */
  input_devices?: string | unknown[] | null;
};

export type InstallPollResult = { ok: true } | { ok: false; code: "RETIRED" | "NOT_FOUND" };

const MIC_STATES = new Set(["authorized", "denied", "not_determined", "unknown"]);

/** §13.4 plus Fix 2's G1 — the outcomes an app may report, and nothing else is stored. */
const UPDATE_RESULTS = new Set([
  "ok",
  "checksum_mismatch",
  "signature_mismatch",
  "download_failed",
  "expand_failed",
  "swap_failed",
  "version_mismatch",
]);

/** R3-8 — the two channels that exist. An unknown one is not reported, never coerced to stable. */
const UPDATE_CHANNELS = new Set(["stable", "test"]);

/** PURE — sanitise one poll's claims. Anything malformed becomes "not reported", never a guess. */
export function cleanPollFields(raw: InstallPollFields): {
  install_id: string;
  app_version: string | null;
  build_sha: string | null;
  mic_state: string | null;
  tape_advancing: boolean | null;
  never_sleep: boolean | null;
  launched_by: string | null;
  hostname: string | null;
  hardware_model: string | null;
  os_version: string | null;
  input_device_name: string | null;
  session_open: boolean | null;
  update_channel: string | null;
  last_update_result: string | null;
  last_update_version: string | null;
  last_update_error: string | null;
  last_update_at: string | null;
  disk_free_bytes: string | null;
  peak: number | null;
  zero_ratio: number | null;
  /** Normalised JSON text for the `::jsonb` cast, or null. */
  input_devices: string | null;
} {
  const str = (v: unknown, max: number): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t && t.length <= max ? t : null;
  };
  const mic = str(raw.mic_state, 32);
  const launched = str(raw.launched_by, 16);
  const updateResult = str(raw.last_update_result, 32);
  const updateChannel = str(raw.update_channel, 16);
  // AN INSTANT OR NOTHING. The Mac's clock wrote this into update-result.json, so it can be
  // anything; an unparseable stamp becomes "not reported" and the column keeps what it had rather
  // than taking a string Postgres would reject and failing the whole poll.
  const updateAtRaw = str(raw.last_update_at, 64);
  const updateAtMs = updateAtRaw === null ? NaN : Date.parse(updateAtRaw);
  // POSITIVE BYTES OR NOTHING (§5.5, V's 9 Sep addition). 0 and -1 are the two values a broken
  // reader produces and the two this column must never hold: "0 bytes free" would read as a
  // clinical emergency on a Mac that simply could not answer. Sent as a string because a byte
  // count on a 2 TB volume exceeds what JSON numbers carry safely once it reaches bigint.
  const diskRaw = raw.disk_free_bytes;
  const diskDigits =
    typeof diskRaw === "string"
      ? diskRaw.trim()
      : typeof diskRaw === "number" && Number.isSafeInteger(diskRaw)
        ? String(diskRaw)
        : "";
  return {
    install_id: raw.install_id,
    app_version: str(raw.app_version, 64),
    build_sha: str(raw.build_sha, 64),
    mic_state: mic && MIC_STATES.has(mic) ? mic : null,
    tape_advancing: typeof raw.tape_advancing === "boolean" ? raw.tape_advancing : null,
    never_sleep: typeof raw.never_sleep === "boolean" ? raw.never_sleep : null,
    launched_by: launched === "launchd" || launched === "user" ? launched : null,
    hostname: str(raw.hostname, 128),
    hardware_model: str(raw.hardware_model, 128),
    os_version: str(raw.os_version, 64),
    // 128 to match hostname/hardware_model. CoreAudio device names are short, but an aggregate
    // device can be given any name a person types into Audio MIDI Setup.
    input_device_name: str(raw.input_device_name, 128),
    // ── Build R3 (§13.4) ───────────────────────────────────────────────────────────────────
    session_open: typeof raw.session_open === "boolean" ? raw.session_open : null,
    update_channel: updateChannel && UPDATE_CHANNELS.has(updateChannel) ? updateChannel : null,
    last_update_result:
      updateResult && UPDATE_RESULTS.has(updateResult) ? updateResult : null,
    // A VERSION OR NOTHING. 64 to match app_version, which holds the same kind of string. The
    // card renders this inside a sentence, so a value that is not version-shaped is dropped
    // rather than printed — a Mac cannot put arbitrary text on a clinical screen through it.
    last_update_version: (() => {
      const v = str(raw.last_update_version, 64);
      return v && /^[0-9]+(\.[0-9]+){1,3}(-[0-9A-Za-z.]+)?$/.test(v) ? v : null;
    })(),
    // 300 to match the app's own bounded error strings, which are cut at 500 before they are ever
    // written to disk. Long enough for the sentence the card renders, short enough that a garbled
    // file cannot put a paragraph on a clinical screen.
    last_update_error: str(raw.last_update_error, 300),
    last_update_at: Number.isFinite(updateAtMs) ? new Date(updateAtMs).toISOString() : null,
    disk_free_bytes: /^[0-9]{1,19}$/.test(diskDigits) && diskDigits !== "0" ? diskDigits : null,
    // ── Release B2 ─────────────────────────────────────────────────────────────────────────
    peak: unitRatio(raw.peak),
    zero_ratio: unitRatio(raw.zero_ratio),
    input_devices: cleanInputDevices(raw.input_devices),
  };
}

/**
 * PURE — B2-D7. A number in 0..1, or nothing. Out of range is DROPPED, never clamped: a clamped
 * value is indistinguishable from a real one (the `cleanLevels` rule). Exponent form is accepted
 * because Swift prints a small Double as `1e-05`; `NaN`, `Infinity`, hex and empty are not.
 */
export function unitRatio(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/** B2-D10 bounds, as the kickoff fixed them. */
export const INPUT_DEVICES_MAX = 16;
export const INPUT_DEVICE_FIELD_MAX = 64;

/**
 * PURE — B2-D10. The device list, bounded, as JSON text for the `::jsonb` cast — or null.
 *
 * ALL OR NOTHING. One malformed entry drops the whole list and the COALESCE keeps the last good
 * one. Dropping only the bad entry would render a shorter list that looks complete, and "the TONOR
 * is not plugged in" is exactly the wrong thing to tell an operator when it is. More than one
 * default is also malformed: CoreAudio has at most one default input.
 *
 * An EMPTY array is kept — it is a measurement ("nothing is plugged in"), not an absence.
 */
export function cleanInputDevices(v: unknown): string | null {
  let parsed: unknown = v;
  if (typeof v === "string") {
    if (v.length > 16_384) return null;
    try {
      parsed = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length > INPUT_DEVICES_MAX) return null;
  const out: InputDevice[] = [];
  for (const d of parsed) {
    if (!d || typeof d !== "object") return null;
    const { name, uid, is_default } = d as Record<string, unknown>;
    if (typeof name !== "string" || typeof uid !== "string" || typeof is_default !== "boolean") return null;
    const n = name.trim();
    const u = uid.trim();
    if (!n || !u || n.length > INPUT_DEVICE_FIELD_MAX || u.length > INPUT_DEVICE_FIELD_MAX) return null;
    out.push({ name: n, uid: u, is_default });
  }
  if (out.filter((d) => d.is_default).length > 1) return null;
  return JSON.stringify(out);
}

/**
 * Write what a poll reported onto its install row.
 *
 * COALESCE ON EVERY FIELD, the bench_listener convention and for the same reason: a poll that
 * momentarily cannot read one fact must not erase the last good value and make a working Mac look
 * broken. `last_seen_at` moves on every poll regardless, so a reader can always tell a stale
 * number from a fresh one.
 *
 * `tape_poll_streak` IS THE EXCEPTION, and has to be. §6 step 4 needs two polls in a row, so a
 * poll reporting false must RESET it rather than coalesce over it — otherwise a single true
 * followed by silence would eventually reach two and mark a dead room as recording. A poll that
 * does not mention the tape at all leaves the streak untouched, because it made no claim.
 *
 * `session_open` IS THE SECOND EXCEPTION, added in Build R3 (§13.4), and for the opposite reason
 * to the first. It is a LIVE reading of whether a patient is in the room right now, and the whole
 * of R3-3 rests on it being able to go false: the card suppresses "Tape not advancing" when no
 * session is open, so a COALESCE here would freeze a room at "recording" the moment its last
 * session ended and bring the false warning straight back. A poll that omits it — every install
 * below 0.1.8, for ever — still writes NULL, which reads as "not reported" and raises nothing.
 *
 * THE FIVE R3 UPDATE COLUMNS COALESCE, and that is what makes a failure stick (R3-7). The app that
 * attempted the update is gone; its successor reports the receipt once, on one poll, and deletes
 * the file. Every poll after that omits the fields, and the row must go on saying why the room is
 * still on the old version until a later update overwrites it.
 *
 * A RETIRED INSTALL IS TOLD SO (§4.5 rule 3). The route turns this into 409 RETIRED and the app
 * stops polling, which is what makes the last writer of `bench_listener` the new install.
 */
export async function applyInstallPoll(raw: InstallPollFields): Promise<InstallPollResult> {
  const f = cleanPollFields(raw);
  try {
    const rows = (await sql`
      UPDATE room_install
         SET last_seen_at   = now(),
             first_seen_at  = COALESCE(first_seen_at, now()),
             app_version    = COALESCE(${f.app_version}::text,   app_version),
             build_sha      = COALESCE(${f.build_sha}::text,     build_sha),
             hostname       = COALESCE(${f.hostname}::text,      hostname),
             hardware_model = COALESCE(${f.hardware_model}::text, hardware_model),
             os_version     = COALESCE(${f.os_version}::text,    os_version),
             -- COALESCE like the rest: a poll sent while the mic is unplugged omits the name,
             -- and the row keeps the last device it actually saw rather than going blank.
             input_device_name = COALESCE(${f.input_device_name}::text, input_device_name),
             mic_state      = COALESCE(${f.mic_state}::text,     mic_state),
             never_sleep    = COALESCE(${f.never_sleep}::boolean, never_sleep),
             launched_by    = COALESCE(${f.launched_by}::text,   launched_by),
             -- DERIVED, not reported: §4.3 fixes the poll's additions at seven fields and
             -- launch_agent_loaded is not one of them. launchd owning the process IS the fact
             -- the column names.
             launch_agent_loaded = CASE
               WHEN ${f.launched_by}::text IS NULL THEN launch_agent_loaded
               ELSE ${f.launched_by}::text = 'launchd'
             END,
             tape_advancing = COALESCE(${f.tape_advancing}::boolean, tape_advancing),
             tape_poll_streak = CASE
               WHEN ${f.tape_advancing}::boolean IS NULL THEN tape_poll_streak
               WHEN ${f.tape_advancing}::boolean THEN tape_poll_streak + 1
               ELSE 0
             END,
             tape_advancing_since = CASE
               WHEN ${f.tape_advancing}::boolean IS NULL THEN tape_advancing_since
               WHEN ${f.tape_advancing}::boolean THEN COALESCE(tape_advancing_since, now())
               ELSE NULL
             END,
             -- R3-6 / §13.4. WRITTEN RAW, NOT COALESCED — see the doc comment above. This is the
             -- only poll column whose false must survive the write.
             session_open   = ${f.session_open}::boolean,
             update_channel = COALESCE(${f.update_channel}::text, update_channel),
             last_update_result = COALESCE(${f.last_update_result}::text, last_update_result),
             last_update_version = COALESCE(${f.last_update_version}::text, last_update_version),
             last_update_error  = COALESCE(${f.last_update_error}::text,  last_update_error),
             last_update_at     = COALESCE(${f.last_update_at}::timestamptz, last_update_at),
             disk_free_bytes    = COALESCE(${f.disk_free_bytes}::bigint, disk_free_bytes),
             -- Release B2 (0079). COALESCE like the rest: every app below 0.1.20 omits all three,
             -- and its polls must leave a newer app's last reading exactly where it was.
             peak               = COALESCE(${f.peak}::real, peak),
             zero_ratio         = COALESCE(${f.zero_ratio}::real, zero_ratio),
             input_devices      = COALESCE(${f.input_devices}::jsonb, input_devices)
       WHERE install_id = ${f.install_id}
         AND retired_at IS NULL
      RETURNING install_id
    `) as Array<{ install_id: string }>;

    if (rows.length > 0) return { ok: true };

    // Nothing updated: either the row is retired, or there is no such install. Distinguished
    // because they mean different things to the app — stop for ever, or you were never enrolled.
    const probe = (await sql`
      SELECT retired_at FROM room_install WHERE install_id = ${f.install_id} LIMIT 1
    `) as Array<{ retired_at: string | null }>;
    if (probe[0]?.retired_at) return { ok: false, code: "RETIRED" };
    return { ok: false, code: "NOT_FOUND" };
  } catch (e) {
    throw classifyInstallError(e);
  }
}

// ---------------------------------------------------------------------------
// The fleet read (§4.2, §6)
// ---------------------------------------------------------------------------

function normaliseInstall(r: InstallView): InstallView {
  const iso = (v: string | null): string | null => (v ? new Date(v).toISOString() : null);
  return {
    ...r,
    created_at: new Date(r.created_at).toISOString(),
    enrolled_at: iso(r.enrolled_at),
    session_expires_at: iso(r.session_expires_at),
    first_seen_at: iso(r.first_seen_at),
    last_seen_at: iso(r.last_seen_at),
    tape_advancing_since: iso(r.tape_advancing_since),
    retired_at: iso(r.retired_at),
    tape_poll_streak: Number(r.tape_poll_streak ?? 0),
    last_update_at: iso(r.last_update_at ?? null),
    // bigint arrives as a STRING from the driver, and a byte count is worth nothing to the card as
    // a string. 2 TB is 2e12, comfortably inside Number.MAX_SAFE_INTEGER, so this is lossless for
    // any volume a Mac mini has. Null stays null — see the column comment: never 0.
    disk_free_bytes:
      r.disk_free_bytes === null || r.disk_free_bytes === undefined
        ? null
        : Number(r.disk_free_bytes),
    // Release B2 (0079). `real` can arrive as a string from some drivers; jsonb normally arrives
    // parsed, but a string is parsed here rather than rendered as one. Anything else is null.
    assigned_channel: r.assigned_channel === "stable" ? "stable" : null,
    peak: r.peak === null || r.peak === undefined ? null : Number(r.peak),
    zero_ratio: r.zero_ratio === null || r.zero_ratio === undefined ? null : Number(r.zero_ratio),
    input_devices: (() => {
      const v = r.input_devices as unknown;
      if (Array.isArray(v)) return v as InputDevice[];
      if (typeof v === "string") {
        try {
          const p = JSON.parse(v);
          return Array.isArray(p) ? (p as InputDevice[]) : null;
        } catch {
          return null;
        }
      }
      return null;
    })(),
  };
}

/**
 * One row for each room, with the bound install, an outstanding token's install, and the last
 * retired one.
 *
 * FAIL-SAFE PER SECTION, the readRoomsLive convention: a fault in the release read must not take
 * the room list down with it. A card that renders four rooms and says why it cannot show the
 * release header is useful; a 500 is not.
 */
export async function readFleet(now: Date = new Date()): Promise<FleetPayload> {
  const degraded: string[] = [];

  let rooms: FleetRoom[] = [];
  let roomsRead = false;
  try {
    // WHICH ROOMS ARE ON THIS CARD, and the second half of the predicate is the important half.
    //
    // The first half matches lib/admin/rooms-live.ts exactly — enabled, and not one of the fuse's
    // `room_scratch_` replay targets. Without it the card listed eight rows for five rooms and
    // offered "Copy install command" on a scratch room, which is not a place a Mac can be put.
    //
    // THE `EXISTS` IS THERE SO A BOUND MAC CAN NEVER BECOME INVISIBLE. A blanket filter would
    // mean disabling a room for a week silently removes its running install from the one card
    // whose whole job is "which Mac runs which room" — the exact failure this card exists to
    // prevent. So a row that has a live install is shown whatever the room's state, and its
    // Retire action stays reachable.
    rooms = (await sql`
      SELECT id, slug, name, disabled_at
        FROM room
       WHERE (
               disabled_at IS NULL
               AND left(id, length('room_scratch_'::text)) <> 'room_scratch_'::text
             )
          OR EXISTS (
               SELECT 1 FROM room_install ri
                WHERE ri.room_id = room.id AND ri.retired_at IS NULL
             )
       ORDER BY name ASC
    `) as typeof rooms;
    roomsRead = true;
  } catch (e) {
    degraded.push(`rooms_unavailable:${String((e as Error)?.message ?? e).slice(0, 120)}`);
  }

  // BOUNDED, and the bound is generous on purpose. Four rooms produce one row per install
  // attempt; abandoned mints are deleted nightly and only re-enrolments leave a retired row
  // behind, so 500 is decades of this clinic. If it were ever reached, `created_at DESC` means
  // what falls off the end is the OLDEST RETIRED rows — the `retired` pill, not a bound Mac.
  let installs: InstallView[] = [];
  try {
    installs = (
      (await sql`
        SELECT install_id, room_id, created_at, enrolled_at, session_expires_at, launched_by,
             hostname, hardware_model, os_version, input_device_name, app_version, build_sha,
             first_seen_at, last_seen_at, mic_state, launch_agent_loaded,
             tape_advancing, tape_poll_streak, tape_advancing_since, never_sleep, retired_at,
             session_open, update_channel, last_update_result, last_update_version,
             last_update_error, last_update_at, disk_free_bytes,
             assigned_channel, peak, zero_ratio, input_devices
          FROM room_install
         ORDER BY created_at DESC
         LIMIT 500
      `) as InstallView[]
    ).map(normaliseInstall);
  } catch (e) {
    const err = classifyInstallError(e);
    degraded.push(`installs_unavailable:${err.code}`);
  }

  // ─── BOTH CHANNELS, BECAUSE A ROW IS ONLY BEHIND ON ITS OWN SHELF (Fix 1, F6) ────────────
  //
  // This read was `latestRelease("stable")` alone, and `deriveRow` compared every row against it.
  // Home Office sits on `test` (R3-8), so it would have worn `update pending` for ever against a
  // release it is not asking for and will never be offered — and the approved mockup's state E
  // draws it with no such pill. Two reads, guarded separately like every other section here, so a
  // fault on one channel still leaves the other's rows correct.
  const releases: { stable: ReleaseView | null; test: ReleaseView | null } = {
    stable: null,
    test: null,
  };
  for (const channel of ["stable", "test"] as const) {
    try {
      releases[channel] = await latestRelease(channel);
    } catch (e) {
      const err = classifyInstallError(e);
      degraded.push(`release_unavailable_${channel}:${err.code}`);
    }
  }
  // The card HEADER is the stable release and stays the stable release — §5.8 of the main kickoff
  // is explicit that the header does not change in R3.
  const release = releases.stable;

  // ─── ONE ROW PER ROOM (B2-D3) ─────────────────────────────────────────────────────────────
  // `groupFleet` (lib/room-install-view.ts) is where bound / pending / last_retired are decided —
  // the same three rules that lived inline here, moved so they can be tested without a database —
  // plus the retired count on each row and the Unassigned list.
  //
  // UNASSIGNED ONLY WHEN THE ROOM LIST IS TRUE. If the room read failed, every install would look
  // room-less, and a card that listed the whole fleet as "Unassigned" would be a louder lie than the
  // `rooms_unavailable` line it already shows.
  const grouped = groupFleet({
    rooms,
    installs,
    nowMs: now.getTime(),
    tokenTtlMs: TOKEN_TTL_MINUTES * 60_000,
  });
  const rows: FleetRow[] = grouped.rows;

  return {
    now: now.toISOString(),
    rows,
    latest_release: release,
    releases,
    degraded,
    unassigned: roomsRead ? grouped.unassigned : [],
  };
}

// ---------------------------------------------------------------------------
// The server-assigned channel (B2-D5)
// ---------------------------------------------------------------------------

/**
 * Assign `stable` to one install. ONE-WAY by type and by the 0079 CHECK: there is no way to pass
 * `test` here, and the column would refuse it if there were. Null when the install is unknown or
 * retired — the route answers 404 for both, as the retire route does.
 */
export async function assignInstallChannel(
  installId: string,
  channel: "stable",
): Promise<{ install_id: string; assigned_channel: "stable" } | null> {
  try {
    const rows = (await sql`
      UPDATE room_install
         SET assigned_channel = ${channel}
       WHERE install_id = ${installId} AND retired_at IS NULL
      RETURNING install_id, assigned_channel
    `) as Array<{ install_id: string; assigned_channel: "stable" }>;
    return rows[0] ?? null;
  } catch (e) {
    throw classifyInstallError(e);
  }
}

/**
 * The value the poll response carries as `assigned_channel`. FAIL-SAFE TO NULL, never a throw:
 * this runs on every native poll, and "nothing assigned" is always a safe answer — the Mac keeps
 * the channel its own config.json names. That includes the minutes between a deploy and
 * migration 0079, when the column does not exist yet.
 */
export async function readAssignedChannel(installId: string): Promise<"stable" | null> {
  try {
    const rows = (await sql`
      SELECT assigned_channel FROM room_install
       WHERE install_id = ${installId} AND retired_at IS NULL
       LIMIT 1
    `) as Array<{ assigned_channel: string | null }>;
    return rows[0]?.assigned_channel === "stable" ? "stable" : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Nightly cleanup (§4.1)
// ---------------------------------------------------------------------------

/**
 * Delete unenrolled installs whose token expired more than 24 hours ago.
 *
 * ONLY UNENROLLED ROWS, and the join to the token is the guard: an enrolled install is the fleet's
 * record of a Mac and is never deleted by a schedule, only retired by a person or by a second
 * paste. What this removes is the litter of an operator who copied a command and did not use it.
 *
 * THE TOKEN GOES WITH IT. The token row is spent-by-expiry and points at the install by foreign
 * key, so leaving it would both break the delete and keep a dead credential in the table.
 */
export async function cleanupExpiredInstalls(): Promise<{ deleted: number }> {
  try {
    const doomed = (await sql`
      SELECT t.token, i.install_id
        FROM room_install i
        JOIN room_bootstrap_token t ON t.install_id = i.install_id
       WHERE i.enrolled_at IS NULL
         AND t.expires_at < now() - INTERVAL '24 hours'
       LIMIT 500
    `) as Array<{ token: string; install_id: string }>;

    if (doomed.length === 0) return { deleted: 0 };
    const ids = doomed.map((d) => d.install_id);

    await sql.transaction([
      sql`DELETE FROM room_bootstrap_token WHERE install_id = ANY(${ids}::text[])`,
      sql`DELETE FROM room_install WHERE install_id = ANY(${ids}::text[]) AND enrolled_at IS NULL`,
    ]);
    return { deleted: ids.length };
  } catch (e) {
    throw classifyInstallError(e);
  }
}

// ---------------------------------------------------------------------------
// Route plumbing — the guard and the error envelope, said once
// ---------------------------------------------------------------------------

/**
 * Admin cookie, OR `Bearer MIGRATION_SECRET` — the pattern the stt admin routes already use
 * (app/api/admin/stt-leaderboard/route.ts), reused verbatim so V's operator flow can drive every
 * route in this module with curl and no browser. That is not a convenience: acceptance items 3
 * to 8 are all curl against production, and a cookie-only guard would make them unrepeatable.
 *
 * AN EMPTY SECRET MUST NEVER AUTHORISE. `Bearer ` would otherwise match an env var set to "".
 */
export async function installAdminGuard(
  req: Request,
): Promise<{ ok: true; adminId: string } | { ok: false }> {
  const secret = process.env.MIGRATION_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (secret && auth === `Bearer ${secret}`) return { ok: true, adminId: "migration_secret" };
  const cookie = await readAdminCookie();
  if (cookie) {
    try {
      const claims = await verifyAdminJwt(cookie);
      return { ok: true, adminId: String(claims.admin_id ?? claims.email ?? "admin") };
    } catch {
      /* expired or invalid cookie — falls through to the refusal below */
    }
  }
  return { ok: false };
}

/**
 * The house envelope, with this module's codes and their §4.2 statuses.
 *
 * `status` OVERRIDES ONE CODE THAT §4.2 GIVES TWO OF. `TOKEN_INVALID` is a 404 on the bootstrap
 * fetch and a 400 on the enrol exchange, and the table means it: the fetch is a GET of a resource
 * that is not there, the exchange is a POST whose body is no longer good for anything. The
 * default is the enrol case; the bootstrap route passes 404 explicitly.
 */
export function installError(code: InstallErrorCode, message: string, status?: number): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status: status ?? INSTALL_ERROR_STATUS[code], headers: { "cache-control": "no-store" } },
  );
}

/** Turn anything thrown by this module into its named response. Never a 500. */
export function installErrorFrom(e: unknown): NextResponse {
  const err = classifyInstallError(e);
  return installError(err.code, err.message);
}

/** The caller's address, for the two §4.2 rate-limit buckets. */
export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") || "";
  const ip = fwd.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  return ip.slice(0, 64);
}
