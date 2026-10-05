/**
 * lib/fleet-attention-format.ts — the browser-safe half of the fleet attention list.
 *
 * Types and wording only: NO database import, so the Bench page's client components can import it
 * without pulling the Postgres driver into the bundle (the same split lib/bench-bus-constants.ts
 * makes). The rules and the DB loader live in lib/fleet-attention.ts, which re-exports these types.
 */

export type AttentionSeverity = "red" | "amber";

/** One kind per rule R1..R7. A room carries at most one item of each kind. */
export type AttentionKind =
  | "asleep"
  | "capture_frozen"
  | "silent_tape"
  | "consult_without_tape"
  | "no_session_in_clinic"
  | "open_outbox"
  | "stale_start";

export type AttentionItem = {
  room_id: string;
  room_name: string;
  /** presence machine name (room_install.hostname), or null when the room has none on file */
  machine: string | null;
  kind: AttentionKind;
  /** ISO instant the condition began (a lower bound where the data cannot say more) */
  since: string;
  /** one plain sentence: what is wrong */
  detail: string;
  /** one plain sentence: what the person standing there should do */
  action: string;
  severity: AttentionSeverity;
};

export type FleetAttentionResponse = {
  generated_at: string;
  items: AttentionItem[];
  rooms_checked: number;
  /** Data sources that could not be read this call. Non-empty means "nothing needs attention" must NOT be shown. */
  degraded?: string[];
};

/** The kind in plain words — what the staff-facing row calls it. */
export const KIND_LABEL: Record<AttentionKind, string> = {
  asleep: "Mac not capturing",
  capture_frozen: "Microphone frozen",
  silent_tape: "Recording is silence",
  consult_without_tape: "Consult not being recorded",
  no_session_in_clinic: "No recording started",
  open_outbox: "Watchdog alert still open",
  stale_start: "Remote start failed",
};

/** "for 3 h 12 m", "for 45 m", "for under a minute", "for 4 d 3 h". Never negative. */
export function fmtFor(sinceIso: string, nowMs: number): string {
  const t = Date.parse(sinceIso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.floor(Math.max(0, nowMs - t) / 60_000);
  if (mins < 1) return "for under a minute";
  if (mins < 60) return `for ${mins} m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `for ${hrs} h ${mins % 60} m`;
  return `for ${Math.floor(hrs / 24)} d ${hrs % 24} h`;
}

const IST_OFFSET_MS = 19_800_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "01:36 IST" when the instant is on the same IST day as `nowMs`, else "4 Oct 01:36 IST". */
export function fmtIst(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "an unknown time";
  const d = new Date(t + IST_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const dayOf = (ms: number) => Math.floor((ms + IST_OFFSET_MS) / 86_400_000);
  if (dayOf(t) === dayOf(nowMs)) return `${hh}:${mm} IST`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm} IST`;
}
