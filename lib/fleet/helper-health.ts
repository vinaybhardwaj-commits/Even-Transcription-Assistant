/**
 * lib/fleet/helper-health.ts — what the room app reports about its privileged helper and the Mac's power schedule, and the two attention rules built on it
 * (TS-H9 #46, TS-H6 #43 read side).
 *
 * THERE IS NO HELPER HEARTBEAT. The helper has no server credential for telemetry, so everything arrives on the APP's bench poll (GET /api/bench/commands, ~1.5 s) and is
 * stored on the install's room_install row (migration 0153, written best-effort by lib/room-install.ts writeHelperFields). This module only READS those columns and applies the
 * rules; it sends nothing to any Mac.
 *
 * ATTENTION RULES (pure, `helperAttention`; 3 minutes = HELPER_FRESH_MS):
 *   helper_missing  AMBER  the app is polling (a bench poll within 3 min) AND it has reported the helper as not ok — `helper_state` other than 'ok', or `helper_xpc_ok` false —
 *                          continuously for 3 min (`helper_bad_since`, kept by the server). Capture is fine; the control channel is down. A room whose app has never reported
 *                          helper state (any app below 0.1.35) raises nothing: "not reported" is not "not ok".
 *   app_missing     RED    no bench poll for over 3 min, during 07:30-21:30 IST, for an install whose LAST poll that said so had a console user (`console_user` true) — the Mac was
 *                          being used, and the recorder stopped reporting. Never raised outside clinic hours (an evening shutdown is normal) or for an install that never polled.
 *                          Skipped by the caller when R1 already says the whole Mac is unreachable (one red row per fault).
 * The two cannot both hold (one needs a fresh bench poll, the other a stale one).
 */
import { inClinicHours } from "./verbs";

export const HELPER_FRESH_MS = 180_000;
export const APP_STATES_OK = "ok";

export type HelperSignals = {
  /** room_install.last_seen_at: the app's bench poll */
  bench_at: string | null;
  helper_state: string | null;
  helper_xpc_ok: boolean | null;
  /** server-maintained: when helper_state/xpc first went bad and stayed bad; null while healthy or never reported */
  helper_bad_since: string | null;
  console_user: boolean | null;
};

export type HelperHealth = {
  helper_version: string | null;
  helper_registration: string | null;
  helper_xpc_ok: boolean | null;
  helper_state: string | null;
  console_user: boolean | null;
  power_schedule: string | null;
  /** pmset settings that drifted from the baseline */
  pmset_drift: string[];
};

export type HelperAttention = { kind: "app_missing" | "helper_missing"; severity: "red" | "amber"; since_ms: number; detail: string; action: string };

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** PURE. At most one of the two rules, or null. */
export function helperAttention(s: HelperSignals, nowMs: number, roomName: string): HelperAttention | null {
  const bench = ms(s.bench_at);
  const benchFresh = Number.isFinite(bench) && nowMs - bench <= HELPER_FRESH_MS;

  if (benchFresh) {
    const bad = ms(s.helper_bad_since);
    // the server keeps helper_bad_since only while the latest reading is bad; the reading itself is re-checked here so a stale column can never raise on a healthy room
    const readingBad = (s.helper_state !== null && s.helper_state !== APP_STATES_OK) || s.helper_xpc_ok === false;
    if (readingBad && Number.isFinite(bad) && nowMs - bad > HELPER_FRESH_MS) {
      const why = s.helper_xpc_ok === false ? "the app cannot reach it over XPC" : `the app reports its state as ${s.helper_state}`;
      return {
        kind: "helper_missing",
        severity: "amber",
        since_ms: bad,
        detail: `The recorder in ${roomName} is reporting, but its helper has not been healthy for over 3 minutes (${why}).`,
        action: `Recording is not affected. The helper may have been stopped or removed; if it stays down, check Login Items on the Mac in ${roomName}.`,
      };
    }
    return null;
  }

  if (Number.isFinite(bench) && s.console_user === true && nowMs - bench > HELPER_FRESH_MS && inClinicHours(nowMs)) {
    return {
      kind: "app_missing",
      severity: "red",
      since_ms: bench,
      detail: `The recorder app in ${roomName} has not reported for over 3 minutes while the Mac was in use (a user was logged in at its last report).`,
      action: `Go to ${roomName} and open the Room Recorder, or send restart_recorder from Bench if the helper is up.`,
    };
  }
  return null;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const textOrNull = (x: unknown, max: number): string | null => (typeof x === "string" && x.length > 0 && x.length <= max ? x : null);

/** PURE. A room_install row (the helper columns) as the read-only view Bench and the MCP door show. Values were bounded at write time; they are bounded again here. */
export function healthFromRow(r: Record<string, unknown>): HelperHealth {
  const drift = Array.isArray(r.pmset_drift) ? r.pmset_drift.filter((d): d is string => typeof d === "string" && d.length <= 48).slice(0, 20) : isObj(r.pmset_drift) ? [] : [];
  return {
    helper_version: textOrNull(r.helper_version, 32),
    helper_registration: textOrNull(r.helper_registration, 24),
    helper_xpc_ok: typeof r.helper_xpc_ok === "boolean" ? r.helper_xpc_ok : null,
    helper_state: textOrNull(r.helper_state, 32),
    console_user: typeof r.console_user === "boolean" ? r.console_user : null,
    power_schedule: textOrNull(r.power_schedule, 64),
    pmset_drift: drift,
  };
}

/** Whether the row has reported anything about its helper at all (an app below 0.1.35 has not). */
export const hasReportedHelper = (h: HelperHealth): boolean =>
  h.helper_version !== null || h.helper_registration !== null || h.helper_xpc_ok !== null || h.helper_state !== null || h.power_schedule !== null || h.pmset_drift.length > 0;

/** Postgres undefined_column (42703) / undefined_table (42P01), by code only (G2): a database without 0153 yet is "no helper fields", not a fault. */
export const isMissingSchema = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "42703" || code === "42P01";
};
