/**
 * lib/micguard-read.ts — the READ half of the mic-guard state (kind "mic_guard", posted by tools/eta-micguard-poller to /api/kiosk-health).
 *
 * Source: kiosk_health_events (migration 0126). ONE query: the newest mic_guard row per room_id inside the last 24 h, bounded on `received_at`
 * (the trusted arrival time). room_id and the asOf bound are bound parameters (Neon HTTP driver: no sql.unsafe).
 *
 * The server state is the poller's payload.state, with two rules applied here:
 *   - the newest row is more than 600 s old by received_at  -> state "stale", reason "poller_silent" (the poller is down, its last word is not current).
 *   - an unknown state word in the payload                   -> "read_error", reason "unparsed" (never forward what we do not recognise).
 * `alert` is true for restored, read_error, missing, write_failed, db_missing and stale. It is ALSO true whenever the room had a RESTORED today (IST):
 * the guard's .last line flips back to "ok" a minute after a restore, so the restore stays on the screen until IST midnight, labelled "restored HH:MM IST".
 *
 * Failure contract: a failed read never takes a screen down. It returns `{ byRoom: {}, ok: false }`; the caller shows no badge. One generic warning, never row contents.
 * A room with no mic_guard row in 24 h has no entry (the badge is absent, not green).
 */
import type { WindowsDb } from "@/lib/encounter-windows/db";

export const MG_WINDOW_H = 24;
export const MG_SILENT_S = 600;
export const MG_KIND = "mic_guard";

export type MicGuardState = "ok" | "restored" | "read_error" | "missing" | "write_failed" | "db_missing" | "stale" | "not_installed";
export const MG_STATES: readonly MicGuardState[] = ["ok", "restored", "read_error", "missing", "write_failed", "db_missing", "stale", "not_installed"];
const ALERT_STATES: ReadonlySet<MicGuardState> = new Set(["restored", "read_error", "missing", "write_failed", "db_missing", "stale"]);

export type MicGuardView = {
  state: MicGuardState;
  reason: string | null;
  alert: boolean;
  last_line_at: string | null;
  age_s: number | null;
  restored_today: number;
  last_restored_at: string | null;
  /** "restored HH:MM IST" while the room had a restore today (IST), else null */
  restored_label: string | null;
  /** received_at of the row this view came from */
  updated_at: string;
};

export type MicGuardRow = { room_id: string; ts: unknown; received_at: unknown; payload: unknown };

const IST_MS = 5.5 * 3_600_000;
const istDate = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istHm = (ms: number): string => new Date(ms + IST_MS).toISOString().slice(11, 16);

/** Lead addendum: kiosks are switched off at night, so stale/ssh_unreachable alerts only 08:00 <= IST time < 21:00. poller_silent and line_old alert at all hours. */
export function inClinicHoursIst(nowMs: number): boolean {
  const h = new Date(nowMs + IST_MS).getUTCHours();
  return h >= 8 && h < 21;
}

const ms = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const t = new Date(x as string | number | Date).getTime();
  return Number.isFinite(t) ? t : null;
};
const iso = (x: unknown): string | null => {
  const t = ms(x);
  return t === null ? null : new Date(t).toISOString();
};
const obj = (x: unknown): Record<string, unknown> => {
  if (typeof x === "string") {
    try {
      const p = JSON.parse(x);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
};
const isState = (x: unknown): x is MicGuardState => typeof x === "string" && (MG_STATES as readonly string[]).includes(x);
const reasonOf = (x: unknown): string | null => (typeof x === "string" && /^[a-z_]{1,32}$/.test(x) ? x : null);
const nat = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100_000) : 0;
};

/** One row (or none) -> the view. Pure; `nowMs` is the clock. */
export function micGuardView(row: MicGuardRow | undefined | null, nowMs: number): MicGuardView | null {
  if (!row) return null;
  const receivedMs = ms(row.received_at);
  if (receivedMs === null) return null;
  const p = obj(row.payload);
  let state: MicGuardState;
  let reason: string | null;
  if (isState(p.state)) {
    state = p.state;
    reason = reasonOf(p.reason);
  } else {
    state = "read_error";
    reason = "unparsed";
  }
  let ageS: number | null = Number.isFinite(Number(p.age_s)) && p.age_s !== null ? Math.max(0, Math.round(Number(p.age_s))) : null;
  if (nowMs - receivedMs > MG_SILENT_S * 1000) {
    state = "stale";
    reason = "poller_silent";
    ageS = null;
  }
  const restoredToday = nat(p.restored_today);
  const lastRestoredMs = ms(p.last_restored_at);
  // restored today (IST): the restore's own stamp when it has one, else the day the row arrived
  const restoredDay = lastRestoredMs !== null ? istDate(lastRestoredMs) : istDate(receivedMs);
  const restoredNow = restoredToday > 0 && restoredDay === istDate(nowMs);
  const label = restoredNow ? (lastRestoredMs !== null ? `restored ${istHm(lastRestoredMs)} IST` : "restored today") : null;
  return {
    state,
    reason,
    alert: (ALERT_STATES.has(state) && !(state === "stale" && reason === "ssh_unreachable" && !inClinicHoursIst(nowMs))) || restoredNow,
    last_line_at: iso(p.last_line_at),
    age_s: ageS,
    restored_today: restoredToday,
    last_restored_at: iso(p.last_restored_at),
    restored_label: label,
    updated_at: new Date(receivedMs).toISOString(),
  };
}

/** Newest mic_guard view per room_id. Never throws. */
export async function readMicGuard(sql: WindowsDb, roomIds: readonly string[], asOfMs: number = Date.now()): Promise<{ byRoom: Record<string, MicGuardView>; ok: boolean }> {
  const byRoom: Record<string, MicGuardView> = {};
  try {
    const ids = [...new Set(roomIds.filter((r) => typeof r === "string" && r.length > 0))];
    if (ids.length === 0) return { byRoom, ok: true };
    const hi = new Date(asOfMs).toISOString();
    const rows = (await sql`
      SELECT DISTINCT ON (k.room_id) k.room_id, k.ts, k.received_at, k.payload
        FROM kiosk_health_events k
       WHERE k.kind = 'mic_guard'
         AND k.room_id = ANY(${ids}::text[])
         AND k.received_at >= ${hi}::timestamptz - interval '24 hours'
         AND k.received_at <= ${hi}::timestamptz
       ORDER BY k.room_id, k.received_at DESC, k.ts DESC
    `) as unknown as MicGuardRow[];
    for (const r of rows) {
      const v = micGuardView(r, asOfMs);
      if (v && typeof r.room_id === "string") byRoom[r.room_id] = v;
    }
    return { byRoom, ok: true };
  } catch {
    console.warn("[micguard] read failed");
    return { byRoom: {}, ok: false };
  }
}

/** The badge words, shared by both screens. tone: ok = quiet, alert = needs a look, idle = not applicable. */
export function micGuardBadge(v: MicGuardView): { text: string; tone: "ok" | "alert" | "idle"; title: string } {
  const STATE_WORD: Record<MicGuardState, string> = {
    ok: "ok",
    restored: "restored",
    read_error: "read error",
    missing: "grant missing",
    write_failed: "restore failed",
    db_missing: "db missing",
    stale: "stale",
    not_installed: "not installed",
  };
  const base = v.state === "stale" && v.reason ? `stale (${v.reason.replace(/_/g, " ")})` : STATE_WORD[v.state];
  const text = v.restored_label && v.state !== "restored" ? `${base} · ${v.restored_label}` : v.state === "restored" && v.restored_label ? v.restored_label : base;
  const tone = v.alert ? "alert" : v.state === "not_installed" ? "idle" : "ok";
  return { text: `MIC-PERM ${text}`, tone, title: "Microphone permission guard on the room Mac" };
}
