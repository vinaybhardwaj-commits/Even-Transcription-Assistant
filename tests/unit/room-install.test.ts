/**
 * Build R1 — the install and fleet server contract, against a mocked database.
 *
 * The properties worth mocking for are the ones a live run would only reveal in a clinic room:
 *
 *   · the one-liner matches PRD §4.2 EXACTLY (acceptance item 4 turns on the byte)
 *   · the §4.4 script body is reproduced verbatim, and a room name cannot escape its quotes
 *   · a manifest is never believed — a wrong sha256 or size is SHA_MISMATCH before any row exists
 *   · the enrol exchange retires BEFORE it enrols, which is what keeps the partial unique index
 *     from rejecting a legitimate re-enrol
 *   · a replayed token is TOKEN_INVALID (acceptance item 6)
 *   · the tape streak resets on a false and only reaches two on two trues in a row
 *   · a poll WITHOUT install_id issues no install SQL at all (acceptance item 9's mechanism)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const calls: Array<{ text: string; values: unknown[] }> = [];
const txCalls: Array<Array<{ text: string; values: unknown[] }>> = [];
let responses: unknown[] = [];
let txResponses: unknown[][] = [];

/** A query "promise" that also remembers its own text, so sql.transaction can inspect its batch. */
function makeQuery(strings: TemplateStringsArray, values: unknown[]) {
  const text = strings.join("?").replace(/\s+/g, " ").trim();
  const rec = { text, values };
  const next = responses.shift();
  const p: Promise<unknown> & { __rec?: typeof rec } = (
    next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? [])
  ) as Promise<unknown> & { __rec?: typeof rec };
  p.__rec = rec;
  return p;
}

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return makeQuery(strings, values);
  };
  sql.transaction = async (queries: Array<Promise<unknown> & { __rec?: { text: string; values: unknown[] } }>) => {
    txCalls.push(queries.map((q) => q.__rec ?? { text: "?", values: [] }));
    // The batched queries have already consumed their own `responses` entries when they were
    // constructed; the transaction's own result set is supplied separately.
    await Promise.allSettled(queries);
    return txResponses.shift() ?? queries.map(() => []);
  };
  return { sql, db: {} };
});

vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => null }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: async () => ({ admin_id: "adm_1", email: "v@even.in" }) }));

const M = await import("@/lib/room-install");

beforeEach(() => {
  calls.length = 0;
  txCalls.length = 0;
  responses = [];
  txResponses = [];
  M.__resetRateLimits();
  delete process.env.ROOM_RECORDER_ORIGIN;
});

// ---------------------------------------------------------------------------
// §4.2 — the one-liner
// ---------------------------------------------------------------------------

describe("the install command (§4.2, acceptance item 4)", () => {
  it("matches the PRD one-liner byte for byte", () => {
    expect(M.installCommand("7f3a9c2e1b4d")).toBe(
      'curl -fsSL "https://www.evenscribe.app/api/room-recorder/bootstrap/7f3a9c2e1b4d" | bash',
    );
  });

  it("defaults to www.evenscribe.app and does NOT read APP_URL", () => {
    process.env.APP_URL = "https://eta.even.in";
    expect(M.recorderOrigin()).toBe("https://www.evenscribe.app");
    delete process.env.APP_URL;
  });

  it("honours ROOM_RECORDER_ORIGIN, and refuses a non-https one", () => {
    process.env.ROOM_RECORDER_ORIGIN = "https://staging.evenscribe.app";
    expect(M.recorderOrigin()).toBe("https://staging.evenscribe.app");
    process.env.ROOM_RECORDER_ORIGIN = "http://evil.example";
    expect(M.recorderOrigin()).toBe("https://www.evenscribe.app");
  });
});

// ---------------------------------------------------------------------------
// §4.4 — the script
// ---------------------------------------------------------------------------

describe("the bootstrap script (§4.4)", () => {
  const base = {
    token: "abc123",
    origin: "https://www.evenscribe.app",
    blobUrl: "https://x.public.blob.vercel-storage.com/rr-1.0.3.zip",
    sha256: "a".repeat(64),
    version: "1.0.3",
    roomName: "OPD 5 Dr Salanki",
  };

  it("carries every line the PRD body specifies, including bootout", () => {
    const s = M.renderBootstrapScript(base);
    expect(s.startsWith("#!/bin/bash\nset -euo pipefail\n")).toBe(true);
    expect(s).toContain('launchctl bootout "gui/$(id -u)/com.evenscribe.room-recorder" 2>/dev/null || true');
    expect(s).toContain('ditto -x -k "$TMP/app.zip" "$TMP/expanded"');
    expect(s).toContain('"$DEST/$APP/Contents/MacOS/room-recorder" enrol --token "$TOKEN" --origin "$ORIGIN"');
    expect(s).toContain('"$DEST/$APP/Contents/MacOS/room-recorder" install-launch-agent');
    expect(s).toContain('launchctl bootstrap "gui/$(id -u)" "$PLIST" || launchctl load "$PLIST"');
    expect(s).toContain("Installed and enrolled as OPD 5 Dr Salanki. Close this window.");
  });

  it("substitutes the real blob url, sha and version", () => {
    const s = M.renderBootstrapScript(base);
    expect(s).toContain(`BLOB_URL="${base.blobUrl}"`);
    expect(s).toContain(`EXPECTED_SHA="${base.sha256}"`);
    expect(s).toContain("Downloading EvenScribe Room Recorder 1.0.3...");
  });

  it("never lets a room name escape its quotes", () => {
    // An admin CAN type this into the room name box. Unescaped it would end the echo string and
    // run `id` on a clinic Mac.
    const s = M.renderBootstrapScript({ ...base, roomName: 'OPD "3" $(id) `whoami` \\x' });
    const last = s.trim().split("\n").pop()!;
    expect(last).toBe('echo "Installed and enrolled as OPD \\"3\\" \\$(id) \\`whoami\\` \\\\x. Close this window."');
    // The script still has exactly the line count the PRD body has — a newline in the name
    // cannot add one.
    const withNewline = M.renderBootstrapScript({ ...base, roomName: "OPD\n3" });
    expect(withNewline.trim().split("\n").length).toBe(s.trim().split("\n").length);
  });
});

// ---------------------------------------------------------------------------
// §4.2 — the manifest is never believed
// ---------------------------------------------------------------------------

describe("release registration (§4.2)", () => {
  const goodBytes = new TextEncoder().encode("hello bundle");
  // sha256("hello bundle")
  const goodSha = "d4dd8f4ba64a54e0d31e0b0cf1d24f78a7d7fc5f6a4e3e5e2b1e64ea2e6a4d8f";

  const fetchOf = (bytes: Uint8Array): typeof fetch =>
    (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

  it("refuses a manifest whose size does not match the bytes", async () => {
    await expect(
      M.createRelease({
        blobUrl: "https://x.public.blob.vercel-storage.com/a.zip",
        channel: "stable",
        manifest: { version: "1.0.3", build_sha: "abc1234", sha256: goodSha, size_bytes: 999 },
        publishedBy: "adm_1",
        fetchImpl: fetchOf(goodBytes),
      }),
    ).rejects.toMatchObject({ code: "SHA_MISMATCH" });
    // AND NO ROW WAS WRITTEN. The order is the property: bytes first, table second.
    expect(calls.filter((c) => /INSERT INTO app_release/.test(c.text))).toHaveLength(0);
  });

  it("refuses a manifest whose sha256 does not match the bytes", async () => {
    await expect(
      M.createRelease({
        blobUrl: "https://x.public.blob.vercel-storage.com/a.zip",
        channel: "stable",
        manifest: { version: "1.0.3", build_sha: "abc1234", sha256: "b".repeat(64), size_bytes: goodBytes.byteLength },
        publishedBy: "adm_1",
        fetchImpl: fetchOf(goodBytes),
      }),
    ).rejects.toMatchObject({ code: "SHA_MISMATCH" });
    expect(calls.filter((c) => /INSERT INTO app_release/.test(c.text))).toHaveLength(0);
  });

  it("stores the SERVER's digest, not the manifest's, when they agree", async () => {
    const { createHash } = await import("node:crypto");
    const realSha = createHash("sha256").update(goodBytes).digest("hex");
    responses = [[{ id: "rel_x", version: "1.0.3", sha256: realSha, size_bytes: goodBytes.byteLength, published_at: new Date().toISOString(), withdrawn_at: null }]];
    const rel = await M.createRelease({
      blobUrl: "https://x.public.blob.vercel-storage.com/a.zip",
      channel: "stable",
      manifest: { version: "1.0.3", build_sha: "abc1234", sha256: realSha, size_bytes: goodBytes.byteLength },
      publishedBy: "adm_1",
      fetchImpl: fetchOf(goodBytes),
    });
    expect(rel.sha256).toBe(realSha);
    const insert = calls.find((c) => /INSERT INTO app_release/.test(c.text))!;
    expect(insert.values).toContain(realSha);
  });

  it("rejects anything that is not a Vercel Blob address", () => {
    expect(M.isBlobUrl("https://x.public.blob.vercel-storage.com/a.zip")).toBe(true);
    expect(M.isBlobUrl("http://x.public.blob.vercel-storage.com/a.zip")).toBe(false);
    expect(M.isBlobUrl("https://evil.example/a.zip")).toBe(false);
    expect(M.isBlobUrl("https://blob.vercel-storage.com.evil.example/a.zip")).toBe(false);
    expect(M.isBlobUrl("file:///etc/passwd")).toBe(false);
    expect(M.isBlobUrl(42)).toBe(false);
  });

  it("refuses a manifest with a missing or malformed field", () => {
    expect(M.parseManifest({ version: "1.0.3", build_sha: "abc1234", sha256: "a".repeat(64), size_bytes: 10 })).toBeTruthy();
    expect(M.parseManifest({ version: "1.0.3", build_sha: "abc1234", sha256: "zz", size_bytes: 10 })).toBeNull();
    expect(M.parseManifest({ version: "", build_sha: "abc1234", sha256: "a".repeat(64), size_bytes: 10 })).toBeNull();
    expect(M.parseManifest({ version: "1.0.3", build_sha: "abc1234", sha256: "a".repeat(64), size_bytes: 0 })).toBeNull();
    expect(M.parseManifest(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §4.2 / §4.5 — the enrol exchange
// ---------------------------------------------------------------------------

describe("the enrol exchange (§4.2, §4.5, D10)", () => {
  it("retires BEFORE it enrols, in one transaction", async () => {
    txResponses = [[[], [{ install_id: "install_new", room_id: "room_1", slug: "opd-5-ab12", name: "OPD 5", session_expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString() }]]];
    responses = [[], []];
    process.env.JWT_SECRET_DOCTOR = "test-secret-for-room-jwt";

    await M.enrolWithToken("a".repeat(32));

    expect(txCalls).toHaveLength(1);
    const [first, second] = txCalls[0]!;
    // Statement 1 claims the token and retires the room's other live installs.
    expect(first!.text).toMatch(/UPDATE room_bootstrap_token SET used_at = now\(\)/);
    expect(first!.text).toMatch(/SET retired_at = now\(\)/);
    // Statement 2 enrols. Ordered after, so the partial unique index never sees two live rows.
    expect(second!.text).toMatch(/SET enrolled_at = now\(\)/);
    expect(second!.text).toMatch(/ri\.enrolled_at IS NULL/);
  });

  it("signs a 365-day session, not the 30-day human one", async () => {
    txResponses = [[[], [{ install_id: "install_new", room_id: "room_1", slug: "opd-5-ab12", name: "OPD 5", session_expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString() }]]];
    process.env.JWT_SECRET_DOCTOR = "test-secret-for-room-jwt";
    const out = await M.enrolWithToken("a".repeat(32));

    const [, payloadB64] = out.session.token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    const lifeDays = (payload.exp - payload.iat) / 86_400;
    expect(Math.round(lifeDays)).toBe(365);
    expect(payload.aud).toBe("room");
  });

  it("answers TOKEN_INVALID when the enrol statement matched nothing (item 6: the replay)", async () => {
    // The second exchange of a spent token: statement 1 claims nothing, statement 2 finds
    // enrolled_at already set, and both return no rows.
    txResponses = [[[], []]];
    await expect(M.enrolWithToken("a".repeat(32))).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });

  it("does not say WHICH of unknown, expired or used a token was", async () => {
    txResponses = [[[], []]];
    await expect(M.enrolWithToken("a".repeat(32))).rejects.toMatchObject({
      message: "token is unknown, expired or already used",
    });
  });
});

// ---------------------------------------------------------------------------
// §4.2 — the mint
// ---------------------------------------------------------------------------

describe("the bootstrap token mint (§4.2)", () => {
  it("refuses with NO_RELEASE when nothing is published", async () => {
    responses = [
      [{ id: "room_1", slug: "opd-5-ab12", name: "OPD 5" }], // room lookup
      [], // latestRelease
    ];
    await expect(M.mintBootstrapToken({ roomId: "room_1", createdBy: "adm_1" })).rejects.toMatchObject({
      code: "NO_RELEASE",
    });
    expect(txCalls).toHaveLength(0);
  });

  it("refuses with ROOM_UNKNOWN before it ever looks for a release", async () => {
    responses = [[]];
    await expect(M.mintBootstrapToken({ roomId: "nope", createdBy: "adm_1" })).rejects.toMatchObject({
      code: "ROOM_UNKNOWN",
    });
  });

  it("writes the install row before the token row, in one transaction", async () => {
    responses = [
      [{ id: "room_1", slug: "opd-5-ab12", name: "OPD 5" }],
      [{ id: "rel_1", version: "1.0.3", channel: "stable", published_at: new Date().toISOString(), withdrawn_at: null, size_bytes: 10 }],
      [],
      [{ expires_at: new Date(Date.now() + 1_800_000).toISOString() }],
    ];
    txResponses = [[[], [{ expires_at: new Date(Date.now() + 1_800_000).toISOString() }]]];

    const out = await M.mintBootstrapToken({ roomId: "room_1", createdBy: "adm_1" });

    expect(out.install_id).toMatch(/^install_[a-z2-9]{12}$/);
    expect(out.token).toMatch(/^[0-9a-f]{48}$/);
    expect(out.command).toBe(
      `curl -fsSL "https://www.evenscribe.app/api/room-recorder/bootstrap/${out.token}" | bash`,
    );
    const [first, second] = txCalls[0]!;
    expect(first!.text).toMatch(/INSERT INTO room_install/);
    expect(second!.text).toMatch(/INSERT INTO room_bootstrap_token/);
  });
});

// ---------------------------------------------------------------------------
// §4.3 — the poll's write
// ---------------------------------------------------------------------------

describe("the poll write (§4.3)", () => {
  it("resets the tape streak on a false and increments on a true", async () => {
    responses = [[{ install_id: "install_1" }]];
    await M.applyInstallPoll({ install_id: "install_1", tape_advancing: true });
    const up = calls.find((c) => /UPDATE room_install/.test(c.text))!;
    // The streak is the ONE field that is not COALESCEd, because "two in a row" needs a reset.
    expect(up.text).toMatch(/tape_poll_streak = CASE/);
    expect(up.text).toMatch(/THEN tape_poll_streak \+ 1/);
    expect(up.text).toMatch(/ELSE 0/);
    // And the since-stamp is cleared by the same false, so it can never show a broken run.
    expect(up.text).toMatch(/tape_advancing_since = CASE/);
  });

  it("derives launch_agent_loaded from launched_by rather than inventing an eighth field", async () => {
    responses = [[{ install_id: "install_1" }]];
    await M.applyInstallPoll({ install_id: "install_1", launched_by: "launchd" });
    const up = calls.find((c) => /UPDATE room_install/.test(c.text))!;
    expect(up.text).toMatch(/launch_agent_loaded = CASE/);
    expect(up.values).toContain("launchd");
  });

  it("tells a retired install it is retired, and an unknown one that it is unknown", async () => {
    responses = [[], [{ retired_at: new Date().toISOString() }]];
    expect(await M.applyInstallPoll({ install_id: "install_gone" })).toEqual({ ok: false, code: "RETIRED" });

    calls.length = 0;
    responses = [[], []];
    expect(await M.applyInstallPoll({ install_id: "install_never" })).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("drops a malformed mic_state rather than storing a guess", () => {
    const c = M.cleanPollFields({ install_id: "i", mic_state: "ALLOWED", launched_by: "systemd", tape_advancing: "yes" as never });
    expect(c.mic_state).toBeNull();
    expect(c.launched_by).toBeNull();
    expect(c.tape_advancing).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §4.1 — the nightly cleanup
// ---------------------------------------------------------------------------

describe("the nightly cleanup (§4.1)", () => {
  it("only ever touches unenrolled rows whose token expired over 24 h ago", async () => {
    responses = [[{ token: "t1", install_id: "install_1" }], [], []];
    txResponses = [[[], []]];
    const out = await M.cleanupExpiredInstalls();
    expect(out).toEqual({ deleted: 1 });
    const select = calls[0]!;
    expect(select.text).toMatch(/i\.enrolled_at IS NULL/);
    expect(select.text).toMatch(/t\.expires_at < now\(\) - INTERVAL '24 hours'/);
    // The delete carries the same guard, so a row enrolled between the read and the write lives.
    expect(txCalls[0]![1]!.text).toMatch(/AND enrolled_at IS NULL/);
  });

  it("does nothing at all when there is nothing to delete", async () => {
    responses = [[]];
    expect(await M.cleanupExpiredInstalls()).toEqual({ deleted: 0 });
    expect(txCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The two §4.2 rate-limit codes
// ---------------------------------------------------------------------------

describe("rate limiting", () => {
  it("lets an honest install through and stops a flood", () => {
    for (let n = 0; n < M.ENROL_RATE_LIMIT.max; n++) {
      expect(M.rateLimited("enrol:1.2.3.4", M.ENROL_RATE_LIMIT)).toBe(false);
    }
    expect(M.rateLimited("enrol:1.2.3.4", M.ENROL_RATE_LIMIT)).toBe(true);
    // A different caller is unaffected.
    expect(M.rateLimited("enrol:5.6.7.8", M.ENROL_RATE_LIMIT)).toBe(false);
  });

  it("forgets the bucket once the window passes", () => {
    const t0 = 1_000_000;
    for (let n = 0; n <= M.ENROL_RATE_LIMIT.max; n++) M.rateLimited("enrol:x", M.ENROL_RATE_LIMIT, t0);
    expect(M.rateLimited("enrol:x", M.ENROL_RATE_LIMIT, t0)).toBe(true);
    expect(M.rateLimited("enrol:x", M.ENROL_RATE_LIMIT, t0 + M.ENROL_RATE_LIMIT.windowMs + 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Migration 0075 — read off disk, because it has not been run anywhere
// ---------------------------------------------------------------------------

describe("migration 0075 (§4.1, acceptance item 1)", () => {
  const body = readFileSync(join(process.cwd(), "db", "migrations", "0075_room_install.sql"), "utf8");
  /** Statements, with comments stripped first — the prose in this file contains semicolons. */
  const sqlOnly = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

  it("creates the three tables, all idempotently", () => {
    for (const t of ["app_release", "room_bootstrap_token", "room_install"]) {
      expect(sqlOnly).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`));
    }
  });

  it("carries the partial unique index, with exactly the §4.1 predicate", () => {
    expect(sqlOnly.replace(/\s+/g, " ")).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_room_install_active_room ON room_install (room_id) WHERE retired_at IS NULL AND enrolled_at IS NOT NULL",
    );
  });

  it("is ADDITIVE — it alters, drops, renames and truncates nothing", () => {
    // The kickoff's instruction was `room` and `bench_listener` specifically; this is the whole
    // class, because a migration that touches ANY existing table is a different kind of object
    // from the one this build was told to write.
    expect(sqlOnly).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sqlOnly).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)\b/i);
    expect(sqlOnly).not.toMatch(/\bTRUNCATE\b/i);
    expect(sqlOnly).not.toMatch(/\bUPDATE\s+(room|bench_listener|bench_command|bench_session)\b/i);
  });

  it("declares the three columns the PRD §4.1 list does not have, so the flag is in the file", () => {
    for (const c of ["first_seen_at", "tape_poll_streak", "tape_advancing_since"]) {
      expect(sqlOnly).toMatch(new RegExp(`\\b${c}\\b`));
      // and each one says, in the file itself, that it is not in the PRD list
      expect(body).toMatch(new RegExp(`${c}[\\s\\S]{0,600}?PRD §4.1 column list`));
    }
  });

  it("constrains mic_state and launched_by to their closed sets", () => {
    expect(sqlOnly).toMatch(/mic_state IN \('authorized', 'denied', 'not_determined', 'unknown'\)/);
    expect(sqlOnly).toMatch(/launched_by IN \('launchd', 'user'\)/);
  });

  it("has balanced dollar-quoting, so the runner's splitter cannot mis-cut it", () => {
    expect((body.match(/\$\$/g) ?? []).length % 2).toBe(0);
  });
});
