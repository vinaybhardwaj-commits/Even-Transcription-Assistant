/**
 * lib/bench-window.ts — the bench_window writer (K4a Part A).
 *
 * 0057 created bench_window and left it empty on purpose. This is what fills it: as a
 * session's chunks land, the grid slots they cover become rows, and a slot becomes `closed`
 * when the audio under it is completely there and verified.
 *
 * ─── THE GRID IS ALIGNED IN IST, ON PURPOSE, EVEN THOUGH IT NEED NOT BE TODAY ─────────────
 * Windows sit on a fixed 15-minute grid aligned to the IST hour: 00, 15, 30, 45.
 *
 * AT 15 MINUTES THIS IS CURRENTLY A NO-OP, and saying so is more useful than implying it is
 * load-bearing: IST is +05:30, which is exactly 22 x 15 minutes, so flooring in IST and
 * flooring in UTC land on the same instants. A unit test asserts that equality rather than a
 * difference, so nobody later "simplifies" this on the belief that it was doing something.
 *
 * It is written in IST space anyway because the ALIGNMENT WE MEAN is the clinic's quarter
 * hour, not the epoch's. The moment WINDOW_MS becomes anything that does not divide 05:30 —
 * 20 minutes, or an hour — a UTC floor silently starts cutting windows at :30 past the IST
 * hour, and every window straddles two clinic quarter-hours. Encoding the intent costs one
 * addition and one subtraction, and it is why IST_OFFSET_MS appears on both sides of the floor.
 *
 * ─── A WINDOW NEVER SHORTENS ITSELF TO FIT ────────────────────────────────────────────────
 * A slot closes ONLY when its whole 15 minutes is covered by chunks that are all
 * `upload_state = 'verified'`. Not "the chunks we have are verified" — the SPAN must be
 * covered. A chunk still uploading, a chunk that never arrived, or a tape that has not yet
 * reached the end of the slot all leave it `open`, and the gap is reported rather than
 * absorbed.
 *
 * That includes the trailing slot of an ENDED session, which will never be fully covered and
 * so stays open for ever. That is deliberate and it is the whole point: a 4-minute window
 * flying the flag of a 15-minute one is a lie that K4b would then transcribe and treat as
 * complete. An open window says "I am waiting", which is true, and something downstream can
 * decide what a permanently-partial slot deserves. A short window that looks complete is
 * worse than an open one that says it is waiting.
 *
 * ─── THE SESSION'S SPAN COMES FROM ITS CHUNKS, NEVER FROM session.ended_at ────────────────
 * This writer does not read bench_session.ended_at, and must not start. That column can be
 * WRONG in the direction that matters: on 22 August the day-rollover reaper stamped
 * bs_g3dwud4p ended at 19:00:36Z while its kiosk went on writing chunks until 00:58:46Z — six
 * hours of real, verified audio sitting after the recorded end. A writer that bounded the
 * session by ended_at would have produced windows for three hours of a nine-hour tape and
 * called the job done, and the six hours it dropped would have been invisible: no error, no
 * gap, just windows that were never created.
 *
 * The chunks are the tape. `tapeEndMs` is the newest chunk end across both lanes and nothing
 * else. (The reaper's Rule 2 was given a liveness condition the next day so it cannot make
 * that particular mistake again — but the rule here does not depend on that fix holding.)
 *
 * ─── ONE ROW PER SLOT, NOT ONE PER MIC ────────────────────────────────────────────────────
 * The unique index (session_id, start_ms, end_ms, source_mic) would happily hold both lanes,
 * but only the source decideSource picks is written. The backup lane is currently capturing
 * near-silence — 40 KB against 2.7 MB for the same 171 seconds — so writing both would double
 * the rows and the later transcription work for a lane with nothing in it.
 */

import { sql } from "@/lib/db";
import { decideSource, type MicEventRow, type MicSource } from "@/lib/bench-source";

/** The grid. 15 minutes, aligned to the IST hour. */
export const WINDOW_MS = 15 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Everything the evaluator needs about one chunk. A subset of BenchChunkRow. */
export type WindowChunk = {
  idx: number;
  source: MicSource;
  started_at: string | Date;
  ended_at: string | Date;
  upload_state: string;
};

export type GridSlot = { start_ms: number; end_ms: number };

const ms = (d: string | Date): number => (d instanceof Date ? d.getTime() : Date.parse(d));

/** PURE — the IST-aligned slot an instant falls in. */
export function slotStartFor(atMs: number): number {
  return Math.floor((atMs + IST_OFFSET_MS) / WINDOW_MS) * WINDOW_MS - IST_OFFSET_MS;
}

/**
 * PURE — every grid slot the half-open span [startMs, endMs) touches, ascending.
 *
 * "Touches" is overlap, not containment: a chunk that runs from 10:14 to 10:19 produces the
 * 10:00 slot AND the 10:15 one, because both contain audio that chunk is the only source of.
 */
export function gridSlotsFor(startMs: number, endMs: number): GridSlot[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const out: GridSlot[] = [];
  for (let s = slotStartFor(startMs); s < endMs; s += WINDOW_MS) {
    out.push({ start_ms: s, end_ms: s + WINDOW_MS });
  }
  return out;
}

/**
 * PURE — how much of [from,to) the given intervals cover, and where the holes are.
 *
 * Intervals are merged before measuring, so overlapping chunks (a handover writes two chunks
 * covering the same second) count once rather than inflating coverage past 100%.
 */
export function coverageOf(
  intervals: ReadonlyArray<{ from: number; to: number }>,
  from: number,
  to: number,
): { covered_ms: number; gaps: Array<{ from: number; to: number }> } {
  const clipped = intervals
    .map((i) => ({ from: Math.max(i.from, from), to: Math.min(i.to, to) }))
    .filter((i) => i.to > i.from)
    .sort((a, b) => a.from - b.from);
  const gaps: Array<{ from: number; to: number }> = [];
  let covered = 0;
  let cursor = from;
  for (const i of clipped) {
    if (i.from > cursor) gaps.push({ from: cursor, to: i.from });
    if (i.to > cursor) {
      covered += i.to - Math.max(cursor, i.from);
      cursor = Math.max(cursor, i.to);
    }
  }
  if (cursor < to) gaps.push({ from: cursor, to });
  return { covered_ms: covered, gaps };
}

export type WindowVerdict = GridSlot & {
  source_mic: MicSource;
  /** true → this slot may be `closed`; false → it stays `open` */
  complete: boolean;
  covered_ms: number;
  /** why it is not complete. Empty when it is. */
  gaps: Array<{ from: number; to: number }>;
  /** chunk indices of the decided source that touch this slot but are not yet verified */
  unverified_idx: number[];
};

/**
 * PURE — the whole decision, for every slot a session's chunks touch.
 *
 * Takes the chunks and the mic events; returns one verdict per slot. No I/O, no clock: the
 * caller supplies the tape's end, because "how far has this tape got" is a fact about the
 * world and not one this function may go and look up.
 */
export function evaluateWindows(input: {
  chunks: readonly WindowChunk[];
  events: readonly MicEventRow[];
  /** newest chunk end across BOTH lanes, or null when the session has no chunks */
  tapeEndMs: number | null;
}): WindowVerdict[] {
  const { chunks, events, tapeEndMs } = input;
  if (chunks.length === 0) return [];

  // Slots come from ALL chunks, either lane: a slot exists because audio exists for it, and
  // which microphone answers it is decided per slot below.
  const slots = new Map<number, GridSlot>();
  for (const c of chunks) {
    for (const s of gridSlotsFor(ms(c.started_at), ms(c.ended_at))) slots.set(s.start_ms, s);
  }

  const out: WindowVerdict[] = [];
  for (const slot of [...slots.values()].sort((a, b) => a.start_ms - b.start_ms)) {
    // A3 — the same rule the range machinery uses. `requested: null` means "no one named a
    // mic", which is the only way auto_switched can fire.
    const decision = decideSource({
      requested: null,
      events,
      tapeEndMs,
      startMs: slot.start_ms,
      endMs: slot.end_ms,
    });
    const mine = chunks.filter((c) => c.source === decision.source);
    const touching = mine.filter((c) => ms(c.ended_at) > slot.start_ms && ms(c.started_at) < slot.end_ms);
    const verified = touching.filter((c) => c.upload_state === "verified");

    const { covered_ms, gaps } = coverageOf(
      verified.map((c) => ({ from: ms(c.started_at), to: ms(c.ended_at) })),
      slot.start_ms,
      slot.end_ms,
    );
    out.push({
      ...slot,
      source_mic: decision.source,
      // The FULL span, from verified chunks only. See the header on why this is not
      // "everything present is verified".
      complete: gaps.length === 0,
      covered_ms,
      gaps,
      unverified_idx: touching.filter((c) => c.upload_state !== "verified").map((c) => c.idx).sort((a, b) => a - b),
    });
  }
  return out;
}

/** IST calendar date of an instant — the key room_day is stored under. */
export function istDateOf(atMs: number): string {
  return new Date(atMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export type WriteWindowsResult = {
  session_id: string;
  slots: number;
  inserted: number;
  closed: number;
  still_open: number;
  unchanged: number;
  error?: string;
};

/**
 * Evaluate one session's windows and write them. Never throws.
 *
 * A4 — this runs in an `after()` hook, NEVER in the chunk request path. It reads three
 * tables and writes one; none of that may sit in front of a kiosk waiting to hear that its
 * upload landed.
 *
 * A8 — idempotent in both directions. The insert takes ON CONFLICT on 0057's unique span
 * index, and the update that closes a window is guarded by `state = 'open'`, so a window that
 * is already closed, transcribing or transcribed is never dragged backwards by a later
 * re-evaluation. Re-running this for a whole session is safe and is how a backfill would work.
 */
export async function evaluateAndWriteWindows(sessionId: string): Promise<WriteWindowsResult> {
  const base: WriteWindowsResult = { session_id: sessionId, slots: 0, inserted: 0, closed: 0, still_open: 0, unchanged: 0 };
  try {
    const chunks = (await sql`
      SELECT idx, source, started_at, ended_at, upload_state
        FROM bench_chunk WHERE session_id = ${sessionId}
       ORDER BY source, idx
    `) as WindowChunk[];
    if (chunks.length === 0) return base;

    const events = (await sql`
      SELECT id, kind, at, payload FROM bench_event
       WHERE session_id = ${sessionId} ORDER BY at ASC, id ASC
    `) as MicEventRow[];

    const srows = (await sql`SELECT room_id FROM bench_session WHERE id = ${sessionId} LIMIT 1`) as Array<{ room_id: string }>;
    const roomId = srows[0]?.room_id ?? null;
    if (!roomId) return { ...base, error: "session_not_found" };

    // From the CHUNKS, never from session.ended_at — see the header. bs_g3dwud4p is the row
    // that proves why: its ended_at is six hours earlier than its own last chunk.
    const tapeEndMs = Math.max(...chunks.map((c) => ms(c.ended_at)));
    const verdicts = evaluateWindows({ chunks, events, tapeEndMs });
    base.slots = verdicts.length;

    // A5 — room_day by LOOKUP ONLY. A missing day leaves the column NULL; creating one is the
    // brain's job and this build does not touch the brain.
    const dates = [...new Set(verdicts.map((v) => istDateOf(v.start_ms)))];
    const dayRows = (await sql`
      SELECT id, ist_date::text AS ist_date FROM room_day
       WHERE room_id = ${roomId} AND ist_date::text = ANY(${dates}::text[])
    `) as Array<{ id: string; ist_date: string }>;
    const dayByDate = new Map(dayRows.map((r) => [r.ist_date, r.id]));

    for (const v of verdicts) {
      const id = `bw_${sessionId.replace(/^bs_/, "")}_${v.start_ms}_${v.source_mic}`.slice(0, 128);
      const roomDayId = dayByDate.get(istDateOf(v.start_ms)) ?? null;
      try {
        const ins = (await sql`
          INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, grid_aligned, state)
          VALUES (${id}, ${sessionId}, ${roomDayId}, ${v.start_ms}, ${v.end_ms}, ${v.source_mic}, TRUE, 'open')
          ON CONFLICT (session_id, start_ms, end_ms, source_mic) DO NOTHING
          RETURNING id
        `) as Array<{ id: string }>;
        if (ins.length > 0) base.inserted++;

        // A backfilled room_day: the day may not have existed when the window was first
        // written. Filling a NULL is not a change of mind, so it is not guarded by state.
        if (roomDayId) {
          await sql`
            UPDATE bench_window SET room_day_id = ${roomDayId}
             WHERE session_id = ${sessionId} AND start_ms = ${v.start_ms} AND end_ms = ${v.end_ms}
               AND source_mic = ${v.source_mic} AND room_day_id IS NULL
          `;
        }

        if (v.complete) {
          // `state = 'open'` is the whole of A8's no-regression guarantee: once a window has
          // moved on to transcribing or transcribed, this cannot pull it back.
          const upd = (await sql`
            UPDATE bench_window SET state = 'closed', closed_at = NOW()
             WHERE session_id = ${sessionId} AND start_ms = ${v.start_ms} AND end_ms = ${v.end_ms}
               AND source_mic = ${v.source_mic} AND state = 'open'
             RETURNING id
          `) as Array<{ id: string }>;
          if (upd.length > 0) base.closed++;
          else base.unchanged++;
        } else {
          base.still_open++;
        }
      } catch (e) {
        base.error = String((e as Error)?.message ?? e).slice(0, 160);
      }
    }
    return base;
  } catch (e) {
    return { ...base, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
