/**
 * lib/fleet/release.ts — signed release records for the room app's whole-bundle update (TS-H8 #45, room app 0.1.37).
 *
 * GET /api/room-recorder/release now also answers `record` + `record_signature`: a small JSON object the root helper will act on, signed with the SAME fk1 Ed25519 key that signs
 * fleet command envelopes (FLEET_COMMAND_SIGNING_KEY). The helper trusts only that signature (the pkg itself is unsigned, so its sha256 is only as good as this record).
 * The record is bound to ONE device and machine and has a window of one hour. Exactly sixteen fields (the app refuses anything else):
 *   v:1, version, channel, pkg_url, pkg_sha256, pkg_size, min_helper, cohort, rollout_pct, device_cohorts[], device_id, machine, issued_at, expires_at, nonce, key_id
 * Signed bytes = canonicalJson(record) (lib/fleet/canonical.ts, the envelope rule); `record_signature` = standard base64 of the 64-byte signature.
 *
 * The functions below that say "mirror" re-implement the app's own checks (apps/room-recorder ReleaseRecord.parse / ReleaseVerifier.verify, branch gating/rr-0137) so a record the
 * app would turn away is never signed or served. Nothing here advances a rollout: stages are set only by an admin action (app/api/admin/fleet/releases/*), audited.
 */
import { createHash, randomBytes, sign as edSign } from "node:crypto";
import { canonicalJson } from "./canonical";
import type { FleetSql } from "./device-auth";
import { isoMs } from "./envelope";
import { signingBytes, verifyEnvelopeSignature, type Signer, type UnsignedEnvelope } from "./signing";

export const COHORT_NAMES = ["home_office", "audiometry", "opd1", "pct", "all"] as const;
/** the cohorts a DEVICE can belong to; `pct` and `all` are rollout stages, not memberships */
export const DEVICE_COHORTS = ["home_office", "audiometry", "opd1"] as const;
export type CohortName = (typeof COHORT_NAMES)[number];
export const RECORD_FIELDS = ["v", "version", "channel", "pkg_url", "pkg_sha256", "pkg_size", "min_helper", "cohort", "rollout_pct", "device_cohorts", "device_id", "machine", "issued_at", "expires_at", "nonce", "key_id"] as const;
export const RECORD_WINDOW_S = 3600;
export const MAX_RECORD_WINDOW_S = 24 * 3600;
export const SKEW_S = 120;
export const MAX_PKG_BYTES = 400 * 1024 * 1024;
export const ALLOWED_HOSTS = ["www.evenscribe.app", "evenscribe.app"] as const;
export const ALLOWED_HOST_SUFFIXES = [".public.blob.vercel-storage.com"] as const;
export const DEFAULT_MIN_HELPER = "0.2.0";
export const VERSION_RE = /^\d+(\.\d+){1,3}$/;

export type ReleaseRecord = {
  v: 1;
  version: string;
  channel: "stable" | "test";
  pkg_url: string;
  pkg_sha256: string;
  pkg_size: number;
  min_helper: string;
  cohort: CohortName;
  rollout_pct: number;
  device_cohorts: CohortName[];
  device_id: string;
  machine: string;
  issued_at: string;
  expires_at: string;
  nonce: string;
  key_id: string;
};

/** MIRROR of ReleaseRecord.bucket: first four bytes of SHA-256("<device_id>|<version>"), big-endian, modulo 100. */
export function bucketOf(deviceId: string, version: string): number {
  const d = createHash("sha256").update(`${deviceId}|${version}`, "utf8").digest();
  return d.readUInt32BE(0) % 100;
}

/** MIRROR of ReleaseRecord.eligible: is this device in the group the release is currently open to? */
export function eligible(r: Pick<ReleaseRecord, "cohort" | "rollout_pct" | "device_cohorts" | "device_id" | "version">): boolean {
  if (r.cohort === "all") return true;
  if (r.cohort === "pct") return bucketOf(r.device_id, r.version) < r.rollout_pct;
  return r.device_cohorts.includes(r.cohort);
}

/** MIRROR of ReleaseRecord.validatedURL: https, one of our hosts, no credentials/port/fragment, printable ASCII, <= 512. */
export function validPkgUrl(text: unknown): boolean {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 512 || !/^[\x21-\x7e]+$/.test(text)) return false;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash) return false;
  const host = u.hostname.toLowerCase();
  return (ALLOWED_HOSTS as readonly string[]).includes(host) || ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** MIRROR of ReleaseRecord.parse: null unless EXACTLY the sixteen fields, each the right type and inside its bounds. */
export function parseRecord(o: unknown): ReleaseRecord | null {
  if (!isObj(o)) return null;
  const keys = Object.keys(o);
  if (keys.length !== RECORD_FIELDS.length || !RECORD_FIELDS.every((k) => Object.prototype.hasOwnProperty.call(o, k))) return null;
  const int = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);
  if (o.v !== 1) return null;
  if (typeof o.version !== "string" || !VERSION_RE.test(o.version) || o.version.length > 32) return null;
  if (o.channel !== "stable" && o.channel !== "test") return null;
  if (!validPkgUrl(o.pkg_url)) return null;
  if (typeof o.pkg_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.pkg_sha256)) return null;
  if (!int(o.pkg_size) || o.pkg_size <= 0 || o.pkg_size > MAX_PKG_BYTES) return null;
  if (typeof o.min_helper !== "string" || !VERSION_RE.test(o.min_helper)) return null;
  if (typeof o.cohort !== "string" || !(COHORT_NAMES as readonly string[]).includes(o.cohort)) return null;
  if (!int(o.rollout_pct) || o.rollout_pct < 0 || o.rollout_pct > 100) return null;
  if (!Array.isArray(o.device_cohorts) || o.device_cohorts.length > 8 || !o.device_cohorts.every((c) => typeof c === "string" && (COHORT_NAMES as readonly string[]).includes(c))) return null;
  if (typeof o.device_id !== "string" || !/^dev_[0-9a-f]{24}$/.test(o.device_id)) return null;
  if (typeof o.machine !== "string" || Buffer.byteLength(o.machine, "utf8") < 1 || Buffer.byteLength(o.machine, "utf8") > 128 || /[\u0000-\u001f]/.test(o.machine)) return null;
  if (typeof o.issued_at !== "string" || !ISO_RE.test(o.issued_at) || typeof o.expires_at !== "string" || !ISO_RE.test(o.expires_at)) return null;
  if (typeof o.nonce !== "string" || Buffer.byteLength(o.nonce, "utf8") < 8 || Buffer.byteLength(o.nonce, "utf8") > 64) return null;
  if (typeof o.key_id !== "string" || !/^[a-z0-9]{1,8}$/.test(o.key_id)) return null;
  return o as unknown as ReleaseRecord;
}

export type VerifyFail = "record_malformed" | "record_bad_signature" | "record_expired" | "record_wrong_device";

/** MIRROR of ReleaseVerifier.verify (the app's steps, in its order; the first failure wins). */
export function verifyRecord(
  recordJson: string,
  signature: string | null,
  serverKeys: Record<string, string>,
  deviceId: string,
  machine: string,
  nowMs: number,
): { ok: true; record: ReleaseRecord } | { ok: false; reason: VerifyFail } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(recordJson);
  } catch {
    return { ok: false, reason: "record_malformed" };
  }
  if (Buffer.byteLength(recordJson, "utf8") > 4096) return { ok: false, reason: "record_malformed" };
  const record = parseRecord(parsed);
  if (!record) return { ok: false, reason: "record_malformed" };
  const key = Object.prototype.hasOwnProperty.call(serverKeys, record.key_id) ? serverKeys[record.key_id] : undefined;
  let sigOk = false;
  try {
    // the same Ed25519 check as envelopes: the signed bytes are the canonical JSON of the record
    sigOk = !!key && !!signature && verifyEnvelopeSignature(record as unknown as UnsignedEnvelope, signature, key);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: "record_bad_signature" };
  const iss = Date.parse(record.issued_at);
  const exp = Date.parse(record.expires_at);
  if (!(exp > iss) || exp - iss > MAX_RECORD_WINDOW_S * 1000 || nowMs < iss - SKEW_S * 1000 || nowMs > exp) return { ok: false, reason: "record_expired" };
  if (record.device_id !== deviceId || record.machine !== machine) return { ok: false, reason: "record_wrong_device" };
  return { ok: true, record };
}

export type RolloutRow = { version: string; channel: "stable" | "test"; pkg_url: string; pkg_sha256: string; pkg_size: number; min_helper: string; cohort: CohortName; rollout_pct: number };
export type DeviceRef = { device_id: string; machine: string };

/** Build the record (unsigned). Null when the app would refuse it — a record that cannot pass the app's own parser is never offered. */
export function buildRecord(roll: RolloutRow, device: DeviceRef, deviceCohorts: readonly string[], keyId: string, nowMs: number): ReleaseRecord | null {
  const rec = {
    v: 1,
    version: roll.version,
    channel: roll.channel,
    pkg_url: roll.pkg_url,
    pkg_sha256: roll.pkg_sha256,
    pkg_size: Number(roll.pkg_size),
    min_helper: roll.min_helper,
    cohort: roll.cohort,
    rollout_pct: roll.rollout_pct,
    device_cohorts: [...deviceCohorts].filter((c): c is CohortName => (COHORT_NAMES as readonly string[]).includes(c)).sort(),
    device_id: device.device_id,
    machine: device.machine,
    issued_at: isoMs(nowMs),
    expires_at: isoMs(nowMs + RECORD_WINDOW_S * 1000),
    nonce: randomBytes(16).toString("base64"),
    key_id: keyId,
  };
  return parseRecord(rec);
}

/** Sign a record: Ed25519 over canonicalJson(record), standard base64. */
export function signRecord(record: ReleaseRecord, signer: Signer): string {
  return edSign(null, Buffer.from(canonicalJson(record), "utf8"), signer.privateKey).toString("base64");
}
export { signingBytes };

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The database half
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The active device registered for a room (the newest, if there are several). The app sends nothing new: the room session maps to the device. */
export async function deviceForRoom(sql: FleetSql, roomId: string): Promise<DeviceRef | null> {
  const rows = (await sql`
    SELECT device_id, machine FROM fleet_devices WHERE room_id = ${roomId} AND status = 'active' ORDER BY registered_at DESC, device_id LIMIT 1
  `) as DeviceRef[];
  return rows[0] ?? null;
}

export async function rolloutFor(sql: FleetSql, version: string, channel: string): Promise<RolloutRow | null> {
  const rows = (await sql`
    SELECT version, channel, pkg_url, pkg_sha256, pkg_size::text AS pkg_size, min_helper, cohort, rollout_pct
      FROM fleet_release_rollout WHERE version = ${version} AND channel = ${channel}
  `) as Array<Omit<RolloutRow, "pkg_size"> & { pkg_size: string }>;
  const r = rows[0];
  return r ? { ...r, pkg_size: Number(r.pkg_size) } : null;
}

export async function cohortsOf(sql: FleetSql, deviceId: string): Promise<string[]> {
  const rows = (await sql`SELECT cohort FROM fleet_device_cohort WHERE device_id = ${deviceId} ORDER BY cohort`) as Array<{ cohort: string }>;
  return rows.map((r) => r.cohort);
}

export type RolloutInput = { version: string; channel: string; pkg_url: string; pkg_sha256: string; pkg_size: number; min_helper?: string; cohort: string; rollout_pct?: number };

/** PURE. Reason a rollout request is refused, or null. */
export function rolloutProblem(i: RolloutInput): string | null {
  if (typeof i.version !== "string" || !VERSION_RE.test(i.version) || i.version.length > 32) return "bad_version";
  if (i.channel !== "stable" && i.channel !== "test") return "bad_channel";
  if (!validPkgUrl(i.pkg_url)) return "bad_pkg_url";
  if (typeof i.pkg_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(i.pkg_sha256)) return "bad_pkg_sha256";
  if (!Number.isSafeInteger(i.pkg_size) || i.pkg_size <= 0 || i.pkg_size > MAX_PKG_BYTES) return "bad_pkg_size";
  if (i.min_helper !== undefined && (typeof i.min_helper !== "string" || !VERSION_RE.test(i.min_helper))) return "bad_min_helper";
  if (typeof i.cohort !== "string" || !(COHORT_NAMES as readonly string[]).includes(i.cohort)) return "bad_cohort";
  const pct = i.rollout_pct ?? (i.cohort === "all" ? 100 : 0);
  if (!Number.isSafeInteger(pct) || pct < 0 || pct > 100) return "bad_rollout_pct";
  if (i.cohort === "all" && pct !== 100) return "bad_rollout_pct";
  return null;
}

/** Set (or move) a version's rollout stage. ONE statement: the row and its fleet_audit row land together or not at all. Requires a published, un-withdrawn macOS release of that version. */
export async function setRollout(sql: FleetSql, actor: string, i: RolloutInput): Promise<{ ok: true; from: string | null } | { ok: false; reason: string }> {
  const problem = rolloutProblem(i);
  if (problem) return { ok: false, reason: problem };
  const pub = await sql`SELECT 1 FROM app_release WHERE version = ${i.version} AND channel = ${i.channel} AND platform = 'macos' AND withdrawn_at IS NULL LIMIT 1`;
  if (pub.length === 0) return { ok: false, reason: "release_not_published" };
  const pct = i.rollout_pct ?? (i.cohort === "all" ? 100 : 0);
  const before = (await sql`SELECT cohort, rollout_pct FROM fleet_release_rollout WHERE version = ${i.version} AND channel = ${i.channel}`) as Array<{ cohort: string; rollout_pct: number }>;
  const was = before[0] ? `${before[0].cohort}${before[0].cohort === "pct" ? ` ${before[0].rollout_pct}%` : ""}` : null;
  const now = `${i.cohort}${i.cohort === "pct" ? ` ${pct}%` : ""}`;
  const rows = await sql`
    WITH up AS (
      INSERT INTO fleet_release_rollout (version, channel, pkg_url, pkg_sha256, pkg_size, min_helper, cohort, rollout_pct, set_by)
      VALUES (${i.version}, ${i.channel}, ${i.pkg_url}, ${i.pkg_sha256}, ${i.pkg_size}, ${i.min_helper ?? DEFAULT_MIN_HELPER}, ${i.cohort}, ${pct}, ${actor})
      ON CONFLICT (version, channel) DO UPDATE
         SET pkg_url = EXCLUDED.pkg_url, pkg_sha256 = EXCLUDED.pkg_sha256, pkg_size = EXCLUDED.pkg_size, min_helper = EXCLUDED.min_helper,
             cohort = EXCLUDED.cohort, rollout_pct = EXCLUDED.rollout_pct, set_by = EXCLUDED.set_by, set_at = now()
      RETURNING version, channel
    )
    INSERT INTO fleet_audit (actor, action, summary)
    SELECT ${actor}, 'release_rollout', ${`${i.version} (${i.channel}): ${was ?? "not offered"} -> ${now}`} FROM up
    RETURNING id
  `;
  return rows.length === 1 ? { ok: true, from: was } : { ok: false, reason: "db" };
}

/** Replace a device's cohort memberships. ONE statement with its audit row. */
export async function setDeviceCohorts(sql: FleetSql, actor: string, deviceId: string, cohorts: readonly string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  const uniq = [...new Set(cohorts)];
  if (!uniq.every((c) => (DEVICE_COHORTS as readonly string[]).includes(c))) return { ok: false, reason: "bad_cohort" };
  const dev = (await sql`SELECT machine, status FROM fleet_devices WHERE device_id = ${deviceId}`) as Array<{ machine: string; status: string }>;
  if (!dev[0]) return { ok: false, reason: "unknown_device" };
  const rows = await sql`
    WITH del AS (DELETE FROM fleet_device_cohort WHERE device_id = ${deviceId} RETURNING cohort),
    ins AS (
      INSERT INTO fleet_device_cohort (device_id, cohort, assigned_by)
      SELECT ${deviceId}, c, ${actor} FROM unnest(${uniq}::text[]) AS c
      ON CONFLICT (device_id, cohort) DO NOTHING
      RETURNING cohort
    )
    INSERT INTO fleet_audit (actor, action, machine, summary)
    VALUES (${actor}, 'device_cohorts', ${dev[0].machine}, ${`device ${deviceId}: [${uniq.join(", ")}]`})
    RETURNING id
  `;
  return rows.length === 1 ? { ok: true } : { ok: false, reason: "db" };
}
