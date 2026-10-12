/**
 * lib/consult-index/mirror-staleness.ts — PURE. The lab consult-index mirror is stale when either:
 *   - during 09:00–20:00 IST (every day, 09:00 inclusive, 20:00 exclusive) the newest consult_index
 *     entry's end lags the newest non-shadow REB stt/role track by MORE than 30 minutes, or
 *   - the last index-mirror run exited non-zero.
 * Exactly 30 minutes is not stale. Outside those hours a lag is reported and does not go red;
 * a non-zero exit does, at any hour. An exit that was never reported is not a non-zero exit.
 * No identifiers: clocks, a lag, an integer exit code, and a short machine reason.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const MIRROR_LAG_RED_MS = 30 * 60_000;
export const MIRROR_THRESHOLD_MINUTES = 30 as const;
/** 09:00 inclusive. */
export const MIRROR_CLINIC_OPEN_MIN = 9 * 60;
/** 20:00 exclusive. */
export const MIRROR_CLINIC_CLOSE_MIN = 20 * 60;
const IST_OFFSET_MS = 19_800_000;
const DAY_MS = 86_400_000;
const EXIT_MIN = -2_147_483_648;
const EXIT_MAX = 2_147_483_647;

/** A machine reason: codes and short tokens. A free-text string is refused so a name cannot land in health output or a log. */
export const EXIT_REASON_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

export type MirrorHealth = {
  ok: boolean;
  lag_minutes: number | null;
  threshold_minutes: typeof MIRROR_THRESHOLD_MINUTES;
  clinic_hours: boolean;
  exit_code: number | null;
  reason: string | null;
  error?: string;
};

/** PURE — 09:00 inclusive to 20:00 exclusive, IST, every day. */
export function inMirrorClinicHours(nowMs: number): boolean {
  const shifted = nowMs + IST_OFFSET_MS;
  const mod = ((shifted % DAY_MS) + DAY_MS) % DAY_MS;
  const minutes = Math.floor(mod / 60_000);
  return minutes >= MIRROR_CLINIC_OPEN_MIN && minutes < MIRROR_CLINIC_CLOSE_MIN;
}

export function sanitizeExitReason(v: unknown): string | null {
  return typeof v === "string" && EXIT_REASON_RE.test(v) ? v : null;
}

/** PURE — an integer exit code, or a decimal-free string of one. Anything else is "not reported". */
export function readExitCode(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= EXIT_MIN && v <= EXIT_MAX) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= EXIT_MIN && n <= EXIT_MAX) return n;
  }
  return null;
}

/** PURE — exit fields from a manifest object. Absent or unreadable fields stay null and do not fail the mirror. `exit_reason` wins over `reason` when the key is present, even if its value is refused. */
export function readManifestExit(m: { exit_code?: unknown; exit_reason?: unknown; reason?: unknown }): { exit_code: number | null; reason: string | null } {
  const exit_code = readExitCode(m.exit_code);
  if ("exit_reason" in m && m.exit_reason !== undefined) return { exit_code, reason: sanitizeExitReason(m.exit_reason) };
  return { exit_code, reason: sanitizeExitReason(m.reason) };
}

/** PURE — manifest generated_at, when it is a real zoned timestamp. */
export function parseReportedAt(v: string | null): string | null {
  if (!v || !ISO_TS.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * PURE. lag_minutes is (reb end − mirror end) / 60000, signed. Null when either clock is missing:
 * a missing clock is not a measured lag over 30 minutes.
 * ok is false when the lag rule fires or exit_code is an integer other than 0.
 */
export function judgeConsultIndexMirror(input: {
  nowMs: number;
  mirrorT1Ms: number | null;
  rebT1Ms: number | null;
  exitCode: number | null;
  exitReason: string | null;
}): MirrorHealth {
  const clinic = inMirrorClinicHours(input.nowMs);
  const both = input.mirrorT1Ms !== null && input.rebT1Ms !== null && Number.isFinite(input.mirrorT1Ms) && Number.isFinite(input.rebT1Ms);
  const lagMs = both ? input.rebT1Ms! - input.mirrorT1Ms! : null;
  const lagRed = clinic && lagMs !== null && lagMs > MIRROR_LAG_RED_MS;
  const exitRed = input.exitCode !== null && input.exitCode !== 0;
  return {
    ok: !lagRed && !exitRed,
    lag_minutes: lagMs === null ? null : lagMs / 60_000,
    threshold_minutes: MIRROR_THRESHOLD_MINUTES,
    clinic_hours: clinic,
    exit_code: input.exitCode,
    reason: input.exitReason,
  };
}

export type MirrorRunBody = { exit_code: number; reason: string | null };

/** PURE — the ingest body. Only exit_code and a reason are read; any other key is ignored. */
export function parseMirrorRunBody(body: unknown): { ok: true; run: MirrorRunBody } | { ok: false; error: "bad_body" | "bad_exit_code" | "bad_reason" } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "bad_body" };
  const r = body as Record<string, unknown>;
  if (!("exit_code" in r)) return { ok: false, error: "bad_exit_code" };
  const exit_code = readExitCode(r.exit_code);
  if (exit_code === null) return { ok: false, error: "bad_exit_code" };
  const hasReason = "reason" in r;
  const hasExitReason = "exit_reason" in r;
  if (hasReason && hasExitReason && r.reason !== r.exit_reason) return { ok: false, error: "bad_reason" };
  const raw = hasExitReason ? r.exit_reason : hasReason ? r.reason : undefined;
  if (raw === undefined || raw === null) return { ok: true, run: { exit_code, reason: null } };
  const reason = sanitizeExitReason(raw);
  if (reason === null) return { ok: false, error: "bad_reason" };
  return { ok: true, run: { exit_code, reason } };
}

/** Constant-time bearer check. Every configured token is compared; a blank presented token never matches. */
export function bearerMatches(header: string, tokens: readonly string[]): boolean {
  const presented = header.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7).trim() : "";
  const a = createHash("sha256").update(presented).digest();
  const list = tokens.map((t) => t.trim()).filter((t) => t !== "");
  let ok = false;
  for (const t of list.length > 0 ? list : [" "]) {
    const b = createHash("sha256").update(t).digest();
    if (timingSafeEqual(a, b) && presented !== "") ok = true;
  }
  return ok;
}

export function sqlState(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^(?=.*[0-9])[0-9A-Z]{5}$/.test(c) ? c : "unknown";
}
