/**
 * lib/fleet/release-record.ts — the per-device signed update record GET /api/room-recorder/release hands the Room Recorder (RR 0.1.37 #45).
 * The helper verifies it (fk1/fk2 Ed25519 over the canonical JSON below) before it installs anything, so the record binds one package to one device and one machine for at most a day.
 * EXACTLY 16 fields: v, version, channel, pkg_url, pkg_sha256, pkg_size, min_helper, cohort, rollout_pct, device_cohorts, device_id, machine, issued_at, expires_at, nonce, key_id.
 * Signer and canonical form are lib/fleet/signing.ts and lib/fleet/canonical.ts, unchanged. Dark: with no signer the route serves no record (see closed reasons below).
 */
import { createHash, randomBytes, sign as edSign } from "node:crypto";
import { canonicalJson } from "./canonical";
import type { Signer } from "./signing";

/** Closed reason codes the route logs when it serves no record. */
export const NO_RECORD_REASONS = ["signing_key_unset", "no_device", "device_lookup_failed", "sign_failed"] as const;
export type NoRecordReason = (typeof NO_RECORD_REASONS)[number];

/** A record lives at most this long (the order allows up to 24 h; the helper may wait for a session to end before it installs). */
export const RECORD_TTL_MS = 12 * 60 * 60 * 1000;
/** The oldest helper that may take this app build; below it the helper keeps its version. */
export const RECORD_MIN_HELPER = "0.2.0";
/** No cohort store exists yet: every device is in cohort "all" at 100 %, and the bucket is the helper's to compare against rollout_pct. */
export const RECORD_COHORT = "all";
export const RECORD_ROLLOUT_PCT = 100;

export type ReleaseRecord = {
  v: 1;
  version: string;
  channel: string;
  pkg_url: string;
  pkg_sha256: string;
  pkg_size: number;
  min_helper: string;
  cohort: string;
  rollout_pct: number;
  device_cohorts: string[];
  device_id: string;
  machine: string;
  issued_at: string;
  expires_at: string;
  nonce: string;
  key_id: string;
};

export const RECORD_FIELDS = [
  "v", "version", "channel", "pkg_url", "pkg_sha256", "pkg_size", "min_helper", "cohort", "rollout_pct", "device_cohorts", "device_id", "machine", "issued_at", "expires_at", "nonce", "key_id",
] as const;

/** Rollout bucket 0..99: the first 4 bytes of sha256("<device_id>|<version>") read big-endian, mod 100. */
export function releaseBucket(deviceId: string, version: string): number {
  return createHash("sha256").update(`${deviceId}|${version}`, "utf8").digest().readUInt32BE(0) % 100;
}

export type RecordInput = {
  release: { version: string; sha256: string; size_bytes: number | string; blob_url: string };
  channel: string;
  device: { device_id: string; machine: string };
  signer: Signer;
  nowMs?: number;
  nonce?: string;
};

export function buildRecord(i: RecordInput): ReleaseRecord {
  const now = i.nowMs ?? Date.now();
  return {
    v: 1,
    version: i.release.version,
    channel: i.channel,
    pkg_url: i.release.blob_url,
    pkg_sha256: i.release.sha256,
    pkg_size: Number(i.release.size_bytes),
    min_helper: RECORD_MIN_HELPER,
    cohort: RECORD_COHORT,
    rollout_pct: RECORD_ROLLOUT_PCT,
    device_cohorts: [],
    device_id: i.device.device_id,
    machine: i.device.machine,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + RECORD_TTL_MS).toISOString(),
    nonce: i.nonce ?? randomBytes(16).toString("base64"),
    key_id: i.signer.keyId,
  };
}

/** Standard base64 Ed25519 signature over the canonical JSON bytes of the record. Throws on a non-canonical value (a float, a lone surrogate). */
export const signRecord = (r: ReleaseRecord, signer: Signer): string => edSign(null, Buffer.from(canonicalJson(r), "utf8"), signer.privateKey).toString("base64");
