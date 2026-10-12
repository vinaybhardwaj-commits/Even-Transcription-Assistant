/**
 * lib/enc/view.ts - pure helpers for the ENC admin pages (no DB, no React). Everything here is unit-tested
 * in tests/unit/enc-w2-ui.test.ts with fake rows.
 */
import type { BoundarySource, EncAlert, EncIsolation, EncRoomDay, EncStatus, StewardItem } from "@/lib/enc/queries";

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Tailwind classes per status chip. Same palette the tape page uses for its state chips. */
export const STATUS_CHIP: Record<EncStatus, { label: string; cls: string }> = {
  ok: { label: "ok", cls: "bg-green-50 text-green-700 border-green-200" },
  warn: { label: "warn", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  alert: { label: "alert", cls: "bg-red-50 text-red-700 border-red-200" },
  nodata: { label: "no data", cls: "bg-even-ink-100 text-even-navy-800/70 border-even-ink-200" },
};

/** The alert with the highest count (first wins a tie); null for none. */
export function topAlert(alerts: readonly EncAlert[]): EncAlert | null {
  let best: EncAlert | null = null;
  for (const a of alerts) if (!best || a.count > best.count) best = a;
  return best;
}

export type CoverageRow = {
  room_id: string;
  room_name: string;
  has_data: boolean;
  visits: number;
  placed: number;
  isolated: number;
  processed: number;
  rx_matched: number;
  status: EncStatus;
  top_alert: string | null;
};

/**
 * One row per room. `processed` = the Sarvam lane count (the lane every cut consult passes through first);
 * W1's schema has no column called processed. A room with no enc_room_day row is shown as nodata, never as zeros-and-ok.
 */
export function buildCoverageRows(rooms: ReadonlyArray<{ id: string; name: string; disabled_at?: string | null }>, days: readonly EncRoomDay[]): CoverageRow[] {
  const byRoom = new Map(days.map((d) => [d.room_id, d] as const));
  return rooms
    .filter((r) => !r.disabled_at || byRoom.has(r.id))
    .map((r) => {
      const d = byRoom.get(r.id);
      if (!d) {
        return { room_id: r.id, room_name: r.name, has_data: false, visits: 0, placed: 0, isolated: 0, processed: 0, rx_matched: 0, status: "nodata" as const, top_alert: null };
      }
      const a = topAlert(d.alerts);
      return {
        room_id: r.id,
        room_name: r.name,
        has_data: true,
        visits: d.visits,
        placed: d.placed,
        isolated: d.isolated,
        processed: d.lane_sarvam,
        rx_matched: d.rx_matched,
        status: d.status,
        top_alert: a ? (a.count > 1 ? `${a.message} (${a.count})` : a.message) : null,
      };
    });
}

/** A YYYY-MM-DD string or null. Rejects 2026-13-45 style values. */
export function parseIstDate(v: string | null | undefined): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

/** Today's date in IST as YYYY-MM-DD. */
export function istToday(nowMs: number = Date.now()): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Room/day timeline strip
// ---------------------------------------------------------------------------

export const BOUNDARY_COLOR: Record<BoundarySource, { label: string; bar: string }> = {
  pulse: { label: "pulse", bar: "bg-even-blue-600" },
  pqm: { label: "pqm", bar: "bg-green-600" },
  hyp: { label: "hyp", bar: "bg-amber-500" },
  refined: { label: "refined", bar: "bg-purple-600" },
};

export type TapeSpan = { start_ms: number; end_ms: number; recorded: boolean };
export type Seg = { left: number; width: number };

/** Tape slots (the existing room-day tape) to coverage spans: a slot with a bench window is recorded, a no_recording slot is a gap. */
export function tapeSpansFromSlots(slots: ReadonlyArray<{ start_ms: number; end_ms: number; kind: string }>): TapeSpan[] {
  return slots.map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms, recorded: s.kind !== "no_recording" }));
}

/** The axis: whole hours around everything on the page, default 08:00-20:00 IST when there is nothing. Returns absolute ms. */
export function timelineBounds(date: string, isolations: readonly EncIsolation[], tape: readonly TapeSpan[]): { startMs: number; endMs: number } {
  const dayStart = Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS;
  const HOUR = 3600_000;
  const points: number[] = [];
  for (const i of isolations) {
    points.push(Date.parse(i.t_start), Date.parse(i.t_end));
  }
  for (const s of tape) if (s.recorded) points.push(s.start_ms, s.end_ms);
  const finite = points.filter((p) => Number.isFinite(p));
  if (finite.length === 0) return { startMs: dayStart + 8 * HOUR, endMs: dayStart + 20 * HOUR };
  const lo = Math.max(dayStart, Math.floor((Math.min(...finite) - dayStart) / HOUR) * HOUR + dayStart);
  const hi = Math.min(dayStart + 24 * HOUR, Math.ceil((Math.max(...finite) - dayStart) / HOUR) * HOUR + dayStart);
  return hi > lo ? { startMs: lo, endMs: hi } : { startMs: dayStart + 8 * HOUR, endMs: dayStart + 20 * HOUR };
}

/** Percent position of [a, b) inside [startMs, endMs], clamped to the axis. width >= 0.4 so a short bar stays visible. */
export function toSeg(a: number, b: number, startMs: number, endMs: number): Seg {
  const span = endMs - startMs;
  const l = Math.min(100, Math.max(0, ((a - startMs) / span) * 100));
  const r = Math.min(100, Math.max(0, ((b - startMs) / span) * 100));
  return { left: l, width: Math.max(0.4, r - l) };
}

/** Merge touching/overlapping spans of the same kind. Input need not be sorted. */
export function mergeSpans(spans: ReadonlyArray<{ start_ms: number; end_ms: number }>): Array<{ start_ms: number; end_ms: number }> {
  const sorted = [...spans].sort((x, y) => x.start_ms - y.start_ms);
  const out: Array<{ start_ms: number; end_ms: number }> = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, s.end_ms);
    else out.push({ start_ms: s.start_ms, end_ms: s.end_ms });
  }
  return out;
}

export type TimelineModel = {
  startMs: number;
  endMs: number;
  hourTicks: Array<{ left: number; label: string }>;
  tape: Seg[];
  tapeGaps: Seg[];
  visits: Array<Seg & { id: string; isolated: boolean }>;
  encounters: Array<Seg & { id: string; boundary_source: BoundarySource; status: EncIsolation["status"]; label: string }>;
  unisolatedVisits: number;
};

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

/**
 * Builds the strip. Visits = isolation rows that carry a pqm_step_uid (a PQM visit); a visit is "isolated" when a cut
 * row overlaps it (including itself if it is cut). Encounters = cut rows. Gaps = the no_recording spans inside the axis,
 * and each visit with no cut row over it (drawn red on the visit lane).
 */
export function buildTimeline(date: string, isolations: readonly EncIsolation[], tape: readonly TapeSpan[]): TimelineModel {
  const { startMs, endMs } = timelineBounds(date, isolations, tape);
  const cuts = isolations.filter((i) => i.status === "cut");
  const visitsSrc = isolations.filter((i) => i.pqm_step_uid);
  const recorded = mergeSpans(tape.filter((s) => s.recorded));
  const missing = mergeSpans(tape.filter((s) => !s.recorded));
  const ms = (iso: string) => Date.parse(iso);
  const visits = visitsSrc.map((v) => {
    const iso0 = ms(v.t_start);
    const iso1 = ms(v.t_end);
    const isolated = cuts.some((c) => overlaps(iso0, iso1, ms(c.t_start), ms(c.t_end)));
    return { ...toSeg(iso0, iso1, startMs, endMs), id: v.consult_uid, isolated };
  });
  const ticks: Array<{ left: number; label: string }> = [];
  for (let t = startMs; t <= endMs; t += 3600_000) {
    const hh = new Date(t + IST_OFFSET_MS).getUTCHours();
    ticks.push({ left: toSeg(t, t, startMs, endMs).left, label: `${String(hh).padStart(2, "0")}` });
  }
  return {
    startMs,
    endMs,
    hourTicks: ticks,
    tape: recorded.filter((s) => s.end_ms > startMs && s.start_ms < endMs).map((s) => toSeg(s.start_ms, s.end_ms, startMs, endMs)),
    tapeGaps: missing.filter((s) => s.end_ms > startMs && s.start_ms < endMs).map((s) => toSeg(s.start_ms, s.end_ms, startMs, endMs)),
    visits,
    encounters: cuts.map((c) => ({
      ...toSeg(ms(c.t_start), ms(c.t_end), startMs, endMs),
      id: c.consult_uid,
      boundary_source: c.boundary_source,
      status: c.status,
      label: `${c.boundary_source}${c.confidence !== null ? ` ${Math.round(c.confidence * 100)}%` : ""}`,
    })),
    unisolatedVisits: visits.filter((v) => !v.isolated).length,
  };
}

// ---------------------------------------------------------------------------
// Steward
// ---------------------------------------------------------------------------

/** Open and approved items need a person; question items are shown on their own list. */
export function splitItems(items: readonly StewardItem[]): { decisions: StewardItem[]; questions: StewardItem[]; decided: StewardItem[] } {
  const decisions: StewardItem[] = [];
  const questions: StewardItem[] = [];
  const decided: StewardItem[] = [];
  for (const it of items) {
    if (it.kind === "question") {
      if (it.state === "open") questions.push(it);
      else decided.push(it);
    } else if (it.state === "open") decisions.push(it);
    else decided.push(it);
  }
  return { decisions, questions, decided };
}

/** Spend against the cap: ratio in 0..1 (null with no cap) and the bar tone. */
export function spendMeter(spend: number, cap: number | null): { ratio: number | null; tone: "ok" | "warn" | "alert" } {
  if (cap === null || !(cap > 0)) return { ratio: null, tone: "ok" };
  const ratio = Math.min(1, spend / cap);
  return { ratio, tone: spend >= cap ? "alert" : ratio >= 0.8 ? "warn" : "ok" };
}

// ---------------------------------------------------------------------------
// System map lights
// ---------------------------------------------------------------------------

export type Light = { key: string; title: string; ok: boolean; detail: string };
export const ENC_FRESH_HOURS = 30;
export const STEWARD_FRESH_HOURS = 30;

/**
 * Two lights from the last enc_room_day.computed_at and the newest steward_run. Green = recent (within the window)
 * and, for the steward, a status other than failed/error. Red otherwise, including "never".
 */
export function encLights(h: { last_computed_at: string | null; last_run_status: string | null; last_run_started_at: string | null }, nowMs: number = Date.now()): Light[] {
  const age = (iso: string | null): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? (nowMs - t) / 3600_000 : null;
  };
  const a = age(h.last_computed_at);
  const b = age(h.last_run_started_at);
  const bad = h.last_run_status !== null && /fail|error/i.test(h.last_run_status);
  return [
    {
      key: "recon",
      title: "Daily recon export (enc_room_day)",
      ok: a !== null && a <= ENC_FRESH_HOURS,
      detail: a === null ? "never computed" : `computed ${a.toFixed(1)} h ago`,
    },
    {
      key: "steward",
      title: "Steward run",
      ok: b !== null && b <= STEWARD_FRESH_HOURS && !bad,
      detail: b === null ? "no run yet" : `${h.last_run_status ?? "unknown"}, ${b.toFixed(1)} h ago`,
    },
  ];
}
