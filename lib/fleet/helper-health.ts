/**
 * lib/fleet/helper-health.ts — what the room-Mac helper says about itself, and the two attention rules built on it (TS-H9 #46, TS-H6 #43 read side).
 *
 * The helper posts a kiosk-health event of kind `helper.heartbeat` every 60 s (PRD §5.6; stored in kiosk_health_events by the existing ingest, source `helper`). Its payload is
 * the `data` object below. This module only READS it: every field is sanitised (type, length, closed vocabulary) before it reaches Bench or the MCP door, so a malformed
 * or hostile payload cannot put free text on a screen. Nothing here sends anything to a Mac.
 *
 * ATTENTION RULES (pure, `helperAttention`; 3 minutes = HELPER_FRESH_MS):
 *   app_missing     RED    the helper heartbeat is fresh, a console user is present, and the app has not polled the bench for over 3 min — the Mac is up, the recorder is not.
 *                          Not raised when the helper reports app_state needs_enrol / retired / no_console_user (deliberate or unattended states), or no console user.
 *   helper_missing  AMBER  the helper is REGISTERED (an active fleet_devices row), the app polled the bench within 3 min, and the helper has been silent (no heartbeat and no
 *                          long-poll, measured from the newest of the two or its registration) for over 3 min — capture is fine, the control channel is down.
 * The two cannot both hold (one needs a fresh bench poll, the other a stale one).
 */
import { canonicalMachine, expandKeys, matchKey } from "@/lib/kiosk-health-read";
import { machineKeys } from "@/lib/encounter-windows/machine-keys";
import type { FleetSql } from "./device-auth";

export const HELPER_HEARTBEAT_KIND = "helper.heartbeat";
export const HELPER_FRESH_MS = 180_000;
/** how far back the newest heartbeat is looked for */
export const HELPER_LOOKBACK_H = 24;

export const APP_STATES = ["running", "missing", "no_console_user", "needs_enrol", "retired"] as const;
export const REGISTRATIONS = ["enabled", "requires_approval", "not_registered"] as const;
export type AppState = (typeof APP_STATES)[number];

export type HelperHealth = {
  helper_version: string | null;
  app_version: string | null;
  registration: (typeof REGISTRATIONS)[number] | null;
  xpc_ok: boolean | null;
  app_state: AppState | null;
  console_user: boolean | null;
  session_open: boolean | null;
  /** e.g. "MTWRFSU 07:05" — free text from the helper, bounded and control-character-free */
  power_schedule: string | null;
  /** names of pmset settings that drifted from the baseline (bounded list of short tokens) */
  pmset_drift: string[];
  chrome_policy: string | null;
  poll_last_ok_s: number | null;
  safe_mode: boolean | null;
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const text = (x: unknown, max: number): string | null =>
  typeof x === "string" && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(x) && !/[\uD800-\uDFFF]/.test(x) ? x : null;
const bool = (x: unknown): boolean | null => (typeof x === "boolean" ? x : null);
const oneOf = <T extends string>(x: unknown, set: readonly T[]): T | null => (typeof x === "string" && (set as readonly string[]).includes(x) ? (x as T) : null);

/** PURE. A heartbeat payload (the §5.6 `data` object) reduced to what Bench may show. Unknown keys are dropped; wrong types become null. */
export function parseHelperHeartbeat(payload: unknown): HelperHealth {
  const p = isObj(payload) ? payload : {};
  const drift = Array.isArray(p.pmset_drift) ? p.pmset_drift.map((d) => text(d, 48)).filter((d): d is string => d !== null).slice(0, 20) : [];
  const poll = p.poll_last_ok_s;
  return {
    helper_version: text(p.helper_version, 32),
    app_version: text(p.app_version, 32),
    registration: oneOf(p.registration, REGISTRATIONS),
    xpc_ok: bool(p.xpc_ok),
    app_state: oneOf(p.app_state, APP_STATES),
    console_user: bool(p.console_user),
    session_open: bool(p.session_open),
    power_schedule: text(p.power_schedule, 64),
    pmset_drift: drift,
    chrome_policy: text(p.chrome_policy, 32),
    poll_last_ok_s: typeof poll === "number" && Number.isInteger(poll) && poll >= 0 && poll <= 86_400 ? poll : null,
    safe_mode: bool(p.safe_mode),
  };
}

export type HelperSignals = {
  /** an ACTIVE fleet_devices row exists for the room */
  registered: boolean;
  registered_at: string | null;
  /** fleet_devices.last_poll_at: the helper's long-poll */
  helper_poll_at: string | null;
  /** newest helper.heartbeat received_at, and its sanitised content */
  heartbeat_at: string | null;
  heartbeat: HelperHealth | null;
  /** room_install.last_seen_at: the app's bench poll */
  bench_at: string | null;
};
export type HelperAttention = { kind: "app_missing" | "helper_missing"; severity: "red" | "amber"; since_ms: number; detail: string; action: string };

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** PURE. At most one of the two rules, or null. */
export function helperAttention(s: HelperSignals, nowMs: number, roomName: string): HelperAttention | null {
  const hb = ms(s.heartbeat_at);
  const bench = ms(s.bench_at);
  const poll = ms(s.helper_poll_at);
  const reg = ms(s.registered_at);
  const benchFresh = Number.isFinite(bench) && nowMs - bench <= HELPER_FRESH_MS;
  const hbFresh = Number.isFinite(hb) && nowMs - hb <= HELPER_FRESH_MS;

  if (hbFresh && s.heartbeat?.console_user === true && !benchFresh) {
    const st = s.heartbeat.app_state;
    if (st !== "needs_enrol" && st !== "retired" && st !== "no_console_user") {
      const since = Number.isFinite(bench) ? bench : hb;
      return {
        kind: "app_missing",
        severity: "red",
        since_ms: since,
        detail: `The Mac in ${roomName} is up and the helper is reporting, but the recorder app has not reported for over 3 minutes${st ? ` (helper says: ${st})` : ""}.`,
        action: `The helper will try to relaunch the recorder app. If it does not poll again soon, go to ${roomName} and open the Room Recorder, or send restart_recorder from Bench.`,
      };
    }
    return null;
  }

  if (s.registered && benchFresh) {
    const last = Math.max(...[hb, poll, reg].filter(Number.isFinite), -Infinity);
    if (Number.isFinite(last) && nowMs - last > HELPER_FRESH_MS) {
      return {
        kind: "helper_missing",
        severity: "amber",
        since_ms: last,
        detail: `The recorder in ${roomName} is reporting, but its helper has been silent for over 3 minutes (no heartbeat, no command poll).`,
        action: `Recording is not affected. The helper may have been stopped or removed; if it stays silent, check Login Items on the Mac in ${roomName}.`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The database half: read-only, bound parameters. A database that does not have the fleet tables yet (migration 0148 not applied) is "no helper fleet", not a fault.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Postgres undefined_table (42P01). */
export const isMissingTable = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === "42P01"; // by code only, like notCollectedReason (G2)

export type HeartbeatRow = { received_at: string; health: HelperHealth };

/** The newest helper.heartbeat per machine, keyed by matchKey(canonical machine). */
export async function readHelperHeartbeats(sql: FleetSql, hostnames: readonly string[], asOfMs: number): Promise<Map<string, HeartbeatRow>> {
  const keys = [...new Set(hostnames.flatMap((h) => expandKeys(machineKeys(h))))];
  const out = new Map<string, HeartbeatRow>();
  if (keys.length === 0) return out;
  const lo = new Date(asOfMs - HELPER_LOOKBACK_H * 3_600_000).toISOString();
  const hi = new Date(asOfMs).toISOString();
  const rows = (await sql`
    SELECT DISTINCT ON (k.machine) k.machine,
           to_char(k.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at, k.payload
      FROM kiosk_health_events k
     WHERE k.machine = ANY(${keys}::text[]) AND k.kind = ${HELPER_HEARTBEAT_KIND}
       AND k.received_at > ${lo}::timestamptz AND k.received_at <= ${hi}::timestamptz
     ORDER BY k.machine, k.received_at DESC
  `) as Array<{ machine: string; received_at: string; payload: unknown }>;
  for (const r of rows) {
    const key = matchKey(canonicalMachine(r.machine));
    const prev = out.get(key);
    if (!prev || Date.parse(r.received_at) > Date.parse(prev.received_at)) out.set(key, { received_at: r.received_at, health: parseHelperHeartbeat(r.payload) });
  }
  return out;
}

export const heartbeatKey = (hostname: string): string => matchKey(canonicalMachine(hostname));

/** One room's signals from already-read parts (shared by the attention loader and the Bench/MCP view). */
export function signalsFor(
  device: { status: string; registered_at: string | null; last_poll_at: string | null } | undefined,
  hostname: string | null,
  heartbeats: Map<string, HeartbeatRow>,
  benchAt: string | null,
): HelperSignals {
  const hb = hostname ? heartbeats.get(heartbeatKey(hostname)) : undefined;
  return {
    registered: !!device && device.status === "active",
    registered_at: device?.registered_at ?? null,
    helper_poll_at: device?.last_poll_at ?? null,
    heartbeat_at: hb?.received_at ?? null,
    heartbeat: hb?.health ?? null,
    bench_at: benchAt,
  };
}
