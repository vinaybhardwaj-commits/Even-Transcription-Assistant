/**
 * lib/spine/ingest.ts — Spine S1: pure mapping of the Neon proxy tables onto spine_signal rows (SPINE-PLAN §2, M1). No clock, no randomness, no I/O.
 *
 *   pulse    <- eta_encounter_windows (I2)        source_key = consult_key
 *   acoustic <- encounter_hypothesis (I5)         source_key = the hypothesis row id
 *   timeline <- encounter_timeline_shadow (I6)    source_key = consult_key (the caller passes the newest run's row per consult_key)
 *
 * REV RULE. source_rev changes only when t_open, t_close, room_id or the close reason changes: `signalHash` is a stable hash of exactly those four.
 * `prior` carries the newest stored rev and its hash per source_key; an unchanged row keeps that rev (the insert then conflicts and is a no-op),
 * a changed row gets rev+1, a new key gets 1. Rows are only ever appended.
 * attrs holds only ids / quality / close_reason (the 0173 CHECK). No names, no text.
 */
import { createHash } from "node:crypto";

export const PROXIES = ["pulse", "pqm", "acoustic", "timeline", "doctor_activity", "cutter", "caa", "nemotron_window"] as const;
export type Proxy = (typeof PROXIES)[number];
export type IngestProxy = "pulse" | "acoustic" | "timeline";

export type SignalAttrs = { ids?: Record<string, unknown>; quality?: string; close_reason?: string };
export type SignalRow = {
  proxy: Proxy;
  source_key: string;
  source_rev: number;
  room_id: string | null;
  t_open: string;           // ISO UTC
  t_close: string | null;
  observed_at: string;
  attrs: SignalAttrs;
};
export type Prior = ReadonlyMap<string, { rev: number; hash: string }>;

export type Time = string | number | Date | null | undefined;
const ms = (v: Time): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : new Date(v).getTime();   // Neon returns timestamps as ISO strings, bigint ms as strings
  return Number.isFinite(t) ? t : null;
};
const iso = (v: Time): string | null => { const t = ms(v); return t === null ? null : new Date(t).toISOString(); };
const msOfBig = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Stable hash of the four fields whose change makes a new rev. Times are compared as epoch ms, so ISO spelling does not matter. */
export function signalHash(s: { t_open: Time; t_close: Time; room_id: string | null | undefined; close_reason: string | null | undefined }): string {
  return createHash("sha256").update(JSON.stringify([ms(s.t_open), ms(s.t_close), s.room_id ?? null, s.close_reason ?? null])).digest("hex").slice(0, 16);
}

/** The rev a signal gets, given the newest stored one for its key. undefined prior -> 1; same hash -> the same rev; a change -> rev+1. */
export function nextRev(prior: { rev: number; hash: string } | undefined, hash: string): number {
  if (!prior) return 1;
  return prior.hash === hash ? prior.rev : prior.rev + 1;
}

/** t_open / t_close may be ISO strings or Dates (the Neon driver returns timestamptz as a Date): they are compared as epoch ms, never stringified. */
export function hashOfSignal(s: { room_id: string | null; t_open: Time; t_close: Time; attrs: { close_reason?: string } }): string {
  return signalHash({ t_open: s.t_open, t_close: s.t_close, room_id: s.room_id, close_reason: s.attrs.close_reason });
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function build(proxy: Proxy, key: string, room: string | null, open: Time, close: Time, observed: Time, attrs: SignalAttrs, prior: Prior): SignalRow | null {
  const t_open = iso(open);
  if (!key || !t_open) return null;
  const t_close = iso(close);
  const hash = signalHash({ t_open, t_close, room_id: room, close_reason: attrs.close_reason });
  return { proxy, source_key: key, source_rev: nextRev(prior.get(key), hash), room_id: room, t_open, t_close, observed_at: iso(observed) ?? t_open, attrs };
}

/**
 * rows: I2 for "pulse" (consult_key, consult_uid, room_id, t_open, t_close, close_reason, quality, computed_at);
 *       I5 for "acoustic" (id, run_id, room_id [joined from room_day], start_ms, end_ms, closed_by, created_at);
 *       I6 for "timeline" (consult_key, id, run_id, room_id [joined], start_ms, end_ms, closed_by, created_at).
 * A row with no key or no usable open time is skipped (counted by the caller as the difference in length).
 */
export function toSignals(rows: ReadonlyArray<Raw>, proxy: IngestProxy, prior: Prior = new Map()): SignalRow[] {
  const out: SignalRow[] = [];
  for (const r of rows) {
    let s: SignalRow | null = null;
    if (proxy === "pulse") {
      s = build("pulse", str(r.consult_key) ?? "", str(r.room_id), r.t_open as Time, r.t_close as Time, r.computed_at as Time,
        { ids: { consult_key: str(r.consult_key), consult_uid: str(r.consult_uid) }, ...(str(r.quality) ? { quality: str(r.quality)! } : {}), ...(str(r.close_reason) ? { close_reason: str(r.close_reason)! } : {}) }, prior);
    } else if (proxy === "acoustic") {
      const id = str(r.id);
      s = build("acoustic", id ?? "", str(r.room_id), msOfBig(r.start_ms), msOfBig(r.end_ms), r.created_at as Time,
        { ids: { hypothesis_id: id, room_day_id: str(r.room_day_id), run_id: str(r.run_id) }, ...(str(r.closed_by) ? { close_reason: str(r.closed_by)! } : {}) }, prior);
    } else {
      s = build("timeline", str(r.consult_key) ?? "", str(r.room_id), msOfBig(r.start_ms), msOfBig(r.end_ms), r.created_at as Time,
        { ids: { consult_key: str(r.consult_key), shadow_id: str(r.id), run_id: str(r.run_id) }, ...(str(r.closed_by) ? { close_reason: str(r.closed_by)! } : {}) }, prior);
    }
    if (s) out.push(s);
  }
  return out;
}
