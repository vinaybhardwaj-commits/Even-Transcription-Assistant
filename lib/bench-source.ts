/**
 * lib/bench-source.ts — which microphone answers a window (ETA-MCP-UPGRADE PRD §7, U4).
 *
 * Every recording runs two microphones. When the main one fails the backup keeps the room, but
 * asking for audio still returns the main stream, so a window covering a microphone failure comes
 * back silent while a good recording of the same minutes sits unused beside it.
 *
 * THE RECORDING'S OWN EVENTS DECIDE (D1). Nothing here listens to audio to judge silence, and
 * nothing here reads the database — the caller hands in the `bench_event` rows it already has.
 * The only inputs are `mic_primary_lost` / `mic_primary_restored` and the end of the tape.
 *
 * The three rules, in the order they are applied (D13):
 *   1. No microphone named — a window overlapping any period the primary was recorded as lost is
 *      answered from the backup, with the reason and the overlap said out loud.
 *   2. A microphone named explicitly always wins. Asking for `primary` over a lost window returns
 *      the primary, silence and all; the events are not even consulted.
 *   3. Nothing here invents audio. Choosing the backup does not assert a backup exists — where no
 *      backup pieces were recorded the range resolver finds none and `no_audio_in_range` stands.
 *
 * No migration, no table, no column: the events have been written since K-B (0045).
 */

/** The event row shape this module needs — a structural subset of `BenchEventRow`. */
export type MicEventRow = {
  id: string;
  kind: string;
  at: string | Date;
  payload?: unknown;
};

/** A loss opens an interval. The next restore closes it. Nothing else is consulted. */
export const MIC_LOST_KIND = "mic_primary_lost";
export const MIC_RESTORED_KIND = "mic_primary_restored";

/** The reason the answer gives when it reaches for the backup on its own. */
export const PRIMARY_LOST_REASON = "primary_lost";

/** A period during which the recording says the primary microphone was lost. */
export type LostInterval = {
  from: string;
  to: string;
  from_ms: number;
  to_ms: number;
  /** A loss with no matching restore: the microphone was still down when the recording ended,
   *  so the interval is held open to the end of the tape rather than tidied away. */
  open_to_tape_end: boolean;
  /** The loss event's own recorded reason (`track_ended`, `silence`, …), when it carries one. */
  reason: string | null;
  /** What the loss recorded about the backup at that moment — `"active"` on every real loss. */
  backup: string | null;
  lost_event_id: string;
  restored_event_id: string | null;
};

const msOf = (v: string | Date): number | null => {
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

const strOf = (payload: unknown, key: string): string | null => {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Total order over mic events: time, then kind, then row id — the same tie-break `buildReplayCues`
 * uses, so a pair recorded in the same millisecond pairs the same way in both tools (`…_lost`
 * sorts before `…_restored`, and equal ids cannot happen). Event ids are random, not monotonic,
 * so time alone is not a total order and two runs could otherwise disagree.
 *
 * Pairs can be close together without being ties: two events on `bs_wy5yjj7a` are 131 ms apart,
 * and that is one interval, not two.
 */
export function compareMicEvents(a: MicEventRow, b: MicEventRow): number {
  return (msOf(a.at) ?? 0) - (msOf(b.at) ?? 0) || cmp(a.kind, b.kind) || cmp(a.id, b.id);
}

/**
 * PURE — the periods the primary was recorded as lost, from the session's own events.
 *
 * A loss opens an interval; the next restore closes it. A second loss while one is already open
 * changes nothing (the microphone was already down), and a restore with nothing open is ignored
 * (there is no loss for it to close).
 *
 * `tapeEndMs` is the end of the last piece recorded on EITHER microphone — the tape clock, never
 * the stored `ended_at`. An unpaired loss is held open to it. Where the tape ended at or before
 * the loss (or no piece was recorded at all) the interval collapses to the instant of the loss:
 * there is no recorded audio after that point for a window to overlap, so nothing is lost by
 * saying so honestly rather than inventing an end.
 */
export function buildPrimaryLostIntervals(
  events: ReadonlyArray<MicEventRow>,
  tapeEndMs: number | null,
): LostInterval[] {
  const relevant = events
    .filter((e) => e.kind === MIC_LOST_KIND || e.kind === MIC_RESTORED_KIND)
    .filter((e) => msOf(e.at) !== null)
    .sort(compareMicEvents);

  const out: LostInterval[] = [];
  let open: { at: number; ev: MicEventRow } | null = null;

  for (const e of relevant) {
    const at = msOf(e.at)!;
    if (e.kind === MIC_LOST_KIND) {
      if (open) continue; // already down — the same interval, not a second one
      open = { at, ev: e };
      continue;
    }
    if (!open) continue; // a restore closing nothing
    out.push({
      from: new Date(open.at).toISOString(),
      to: new Date(Math.max(at, open.at)).toISOString(),
      from_ms: open.at,
      to_ms: Math.max(at, open.at),
      open_to_tape_end: false,
      reason: strOf(open.ev.payload, "reason"),
      backup: strOf(open.ev.payload, "backup"),
      lost_event_id: open.ev.id,
      restored_event_id: e.id,
    });
    open = null;
  }

  if (open) {
    const end = tapeEndMs !== null && tapeEndMs > open.at ? tapeEndMs : open.at;
    out.push({
      from: new Date(open.at).toISOString(),
      to: new Date(end).toISOString(),
      from_ms: open.at,
      to_ms: end,
      open_to_tape_end: true,
      reason: strOf(open.ev.payload, "reason"),
      backup: strOf(open.ev.payload, "backup"),
      lost_event_id: open.ev.id,
      restored_event_id: null,
    });
  }
  return out;
}

export type LostOverlap = {
  interval: LostInterval;
  from: string;
  to: string;
  ms: number;
  seconds: number;
};

/**
 * PURE — every lost interval the window `[startMs, endMs)` meets, earliest first.
 *
 * Overlap is the half-open test the range resolver already uses (`resolveRange`): a window ending
 * exactly where a loss begins does not meet it; one millisecond further in does. One rule for
 * "does this window touch that period", written once.
 */
export function findLostOverlaps(
  intervals: ReadonlyArray<LostInterval>,
  startMs: number,
  endMs: number,
): LostOverlap[] {
  const out: LostOverlap[] = [];
  for (const iv of intervals) {
    if (!(startMs < iv.to_ms && endMs > iv.from_ms)) continue;
    const from = Math.max(startMs, iv.from_ms);
    const to = Math.min(endMs, iv.to_ms);
    out.push({
      interval: iv,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      ms: to - from,
      seconds: Math.round(((to - from) / 1000) * 100) / 100,
    });
  }
  return out.sort((a, b) => a.interval.from_ms - b.interval.from_ms);
}

export type MicSource = "primary" | "backup";

export type SourceDecision = {
  /** The microphone the window will be resolved against. */
  source: MicSource;
  /** What the caller asked for; null when no microphone was named. */
  requested: MicSource | null;
  /** True only when nothing was named AND the window met a lost period. */
  auto_switched: boolean;
  reason: typeof PRIMARY_LOST_REASON | null;
  /** The lost periods the window met (empty unless `auto_switched`). */
  overlaps: LostOverlap[];
};

/**
 * PURE — rule 1 and rule 2 in one place.
 *
 * With a microphone named the events are not consulted at all: a stated choice is never
 * overridden, so there is nothing for them to decide. With none named, the intervals built from
 * those events decide, and the window either meets one (backup) or does not (primary, as now).
 */
export function decideSource(opts: {
  requested: MicSource | null;
  events: ReadonlyArray<MicEventRow>;
  tapeEndMs: number | null;
  startMs: number;
  endMs: number;
}): SourceDecision {
  if (opts.requested !== null) {
    // Rule 2 — a microphone named explicitly always wins.
    return { source: opts.requested, requested: opts.requested, auto_switched: false, reason: null, overlaps: [] };
  }
  const intervals = buildPrimaryLostIntervals(opts.events, opts.tapeEndMs);
  const overlaps = findLostOverlaps(intervals, opts.startMs, opts.endMs);
  if (overlaps.length === 0) {
    return { source: "primary", requested: null, auto_switched: false, reason: null, overlaps: [] };
  }
  return { source: "backup", requested: null, auto_switched: true, reason: PRIMARY_LOST_REASON, overlaps };
}

/**
 * The fields every answer carries so a caller can never discover after the fact that it was given
 * a different microphone than it expected: which microphone was used, what was asked for, and —
 * when the backup was reached for without being asked — the reason and the overlap that caused it.
 */
export function sourceAnswer(d: SourceDecision): Record<string, unknown> {
  const first = d.overlaps[0];
  return {
    source_used: d.source,
    source_requested: d.requested ?? "unspecified",
    ...(d.auto_switched && first
      ? {
          reason: d.reason,
          primary_lost: {
            interval: first.interval,
            overlap: { from: first.from, to: first.to, ms: first.ms, seconds: first.seconds },
            intervals_met: d.overlaps.length,
          },
          note_source:
            "no microphone was named and this window overlaps a period the recording says the primary was lost, so the backup answered it (D1/D13); name source:'primary' to get the primary anyway",
        }
      : {}),
  };
}
