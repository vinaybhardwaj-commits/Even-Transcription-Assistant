/**
 * lib/voice-blind.ts — S6-BLIND: the held-out room-day rule for the voice / diarize READ tools (scribe_window_speakers, scribe_diarize_segments, scribe_get_clusters, scribe_list_voice_samples).
 * The set is lib/rubrics/blind-room-days.ts (14 pairs). A window is placed through bench_window.room_day_id (and room_diarize_window.room_day_id) -> room_day (room_id, ist_date). The guard runs BEFORE
 * any content row or R2 read: it asks only for the window's / room-day's placement. A held-out pair is refused `blind_room_day`; a window with no resolvable room-day is refused `window_unplaced`
 * (fail closed). No pair is ever named in an answer. Read only.
 */
import { sql } from "@/lib/db";
import { BLIND_ROOM_DAYS, isBlindRoomDay } from "@/lib/rubrics/blind-room-days";

const BLIND_DAYS = BLIND_ROOM_DAYS.map(([d]) => d);
const BLIND_ROOMS = BLIND_ROOM_DAYS.map(([, r]) => r);

export type BlindRefusal = "blind_room_day" | "window_unplaced";
type Pair = { room_id: string; ist_date: string };

/** PURE — the refusal for a set of resolved pairs: none resolved = unplaced; any held out = blind. */
export function refusalForPairs(pairs: ReadonlyArray<Pair | null>): BlindRefusal | null {
  const real = pairs.filter((p): p is Pair => !!p && !!p.room_id && !!p.ist_date);
  if (real.length === 0) return "window_unplaced";
  return real.some((p) => isBlindRoomDay(p.ist_date, p.room_id)) ? "blind_room_day" : null;
}

/** A window's placement(s): bench_window.room_day_id and room_diarize_window.room_day_id, each through room_day. `known` = the window exists at all. */
export async function windowPlacement(windowId: string): Promise<{ known: boolean; pairs: Array<Pair | null> }> {
  const rows = (await sql`
    SELECT w.id, rd.room_id AS room_id, rd.ist_date::text AS ist_date, rd2.room_id AS room_id2, rd2.ist_date::text AS ist_date2
      FROM bench_window w
      LEFT JOIN room_day rd ON rd.id = w.room_day_id
      LEFT JOIN room_diarize_window d ON d.window_id = w.id
      LEFT JOIN room_day rd2 ON rd2.id = d.room_day_id
     WHERE w.id = ${windowId}::text
     LIMIT 1
  `) as Array<{ id: string; room_id: string | null; ist_date: string | null; room_id2: string | null; ist_date2: string | null }>;
  const r = rows[0];
  if (!r) return { known: false, pairs: [] };
  return { known: true, pairs: [r.room_id && r.ist_date ? { room_id: r.room_id, ist_date: r.ist_date } : null, r.room_id2 && r.ist_date2 ? { room_id: r.room_id2, ist_date: r.ist_date2 } : null] };
}

/**
 * B1 (REL2-R3): the number of room_turn_speaker rows (of this window and/or room-day) with ANY held-out placement: the row's OWN rts.room_day_id, or its window's bench_window.room_day_id or room_diarize_window.room_day_id.
 * A caller that serves those rows refuses when this is > 0 (fail closed, as N2-1 does for the nemotron shadow row).
 */
export async function rtsBlindRows(f: { windowId?: string | null; roomDayId?: string | null }): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS n
      FROM room_turn_speaker rts
      LEFT JOIN bench_window w ON w.id = rts.window_id
      LEFT JOIN room_diarize_window dw ON dw.window_id = rts.window_id
     WHERE (${f.windowId ?? null}::text IS NULL OR rts.window_id = ${f.windowId ?? null}::text)
       AND (${f.roomDayId ?? null}::text IS NULL OR rts.room_day_id = ${f.roomDayId ?? null}::text)
       AND EXISTS (SELECT 1 FROM room_day r1, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (rts.room_day_id, w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
  `) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * SWEEP (REL2-R3): is ANY placement of this window held out? bench_window.room_day_id, room_diarize_window.room_day_id, and the OWN room_day_id of its room_turn_speaker, jev_window_text and room_span_emotion rows.
 * Used by every reader and tool that serves a window's content (turns, emotion, window text, runs, windows). A window that does not exist is not blind (the caller says not_found).
 */
export async function windowBlindAny(windowId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT (
      EXISTS (SELECT 1 FROM room_day r1, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
      OR EXISTS (SELECT 1 FROM room_turn_speaker t JOIN room_day r2 ON r2.id = t.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b2(d, r) WHERE t.window_id = w.id AND b2.d = r2.ist_date AND b2.r = r2.room_id)
      OR EXISTS (SELECT 1 FROM jev_window_text j JOIN room_day r3 ON r3.id = j.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b3(d, r) WHERE j.window_id = w.id AND b3.d = r3.ist_date AND b3.r = r3.room_id)
      OR EXISTS (SELECT 1 FROM room_span_emotion e JOIN room_day r4 ON r4.id = e.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b4(d, r) WHERE e.window_id = w.id AND b4.d = r4.ist_date AND b4.r = r4.room_id)
    ) AS blind
      FROM bench_window w
      LEFT JOIN room_diarize_window dw ON dw.window_id = w.id
     WHERE w.id = ${windowId}::text
     LIMIT 1
  `) as Array<{ blind: boolean }>;
  return rows[0]?.blind === true;
}

/** The windows of this list with ANY held-out placement, in one statement (the batch form of windowBlindAny). */
export async function windowsBlindAny(windowIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(windowIds.filter((x) => /^[A-Za-z0-9_-]{1,80}$/.test(x)))];
  if (ids.length === 0) return new Set();
  const rows = (await sql`
    SELECT w.id FROM bench_window w LEFT JOIN room_diarize_window dw ON dw.window_id = w.id
     WHERE w.id = ANY(${ids}::text[]) AND (
      EXISTS (SELECT 1 FROM room_day r1, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
      OR EXISTS (SELECT 1 FROM room_turn_speaker t JOIN room_day r2 ON r2.id = t.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b2(d, r) WHERE t.window_id = w.id AND b2.d = r2.ist_date AND b2.r = r2.room_id)
      OR EXISTS (SELECT 1 FROM jev_window_text j JOIN room_day r3 ON r3.id = j.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b3(d, r) WHERE j.window_id = w.id AND b3.d = r3.ist_date AND b3.r = r3.room_id)
      OR EXISTS (SELECT 1 FROM room_span_emotion e JOIN room_day r4 ON r4.id = e.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b4(d, r) WHERE e.window_id = w.id AND b4.d = r4.ist_date AND b4.r = r4.room_id))
  `) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/** Is this room-day id a held-out pair? (An unknown id is not blind: the caller keeps its own not-found answer.) */
export async function roomDayIsBlind(roomDayId: string): Promise<boolean> {
  const p = await roomDayPlacement(roomDayId);
  return !!p && isBlindRoomDay(p.ist_date, p.room_id);
}

export async function roomDayPlacement(roomDayId: string): Promise<Pair | null> {
  const rows = (await sql`SELECT room_id, ist_date::text AS ist_date FROM room_day WHERE id = ${roomDayId}::text LIMIT 1`) as Array<Pair>;
  return rows[0] ?? null;
}

/** The refusal for a window id (unknown windows are `window_unplaced` here: no placement, fail closed), or null. */
export async function guardWindow(windowId: string): Promise<BlindRefusal | null> {
  const p = await windowPlacement(windowId);
  return refusalForPairs(p.pairs);
}
export async function guardRoomDay(roomDayId: string): Promise<BlindRefusal | null> {
  return refusalForPairs([await roomDayPlacement(roomDayId)]);
}

/**
 * Source ids of voice samples that are held out or unplaced WINDOWS. A passive sample is keyed by an ENCOUNTER (no room-day link: left as is); only an id that is a bench_window is checked, and a
 * window that is held out or unplaced blocks its sample's audio URL. Returns the blocked source ids.
 */
export async function blockedSampleSources(sourceIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(sourceIds.filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x)))];
  if (ids.length === 0) return new Set();
  const rows = (await sql`
    SELECT w.id, rd.room_id AS room_id, rd.ist_date::text AS ist_date, rd2.room_id AS room_id2, rd2.ist_date::text AS ist_date2
      FROM bench_window w
      LEFT JOIN room_day rd ON rd.id = w.room_day_id
      LEFT JOIN room_diarize_window d ON d.window_id = w.id
      LEFT JOIN room_day rd2 ON rd2.id = d.room_day_id
     WHERE w.id = ANY(${ids}::text[])
  `) as Array<{ id: string; room_id: string | null; ist_date: string | null; room_id2: string | null; ist_date2: string | null }>;
  const out = new Set<string>();
  for (const r of rows) if (refusalForPairs([r.room_id && r.ist_date ? { room_id: r.room_id, ist_date: r.ist_date } : null, r.room_id2 && r.ist_date2 ? { room_id: r.room_id2, ist_date: r.ist_date2 } : null])) out.add(r.id);
  return out;
}

const IST_OFFSET_MS = 19_800_000;
const DAY_MS = 86_400_000;
const istDayStartMs = (d: string): number => Date.parse(`${d}T00:00:00Z`) - IST_OFFSET_MS;

/**
 * PURE — does the time span [t0, t1] (epoch ms) touch the IST day of any held-out pair for this room? Every IST day the span overlaps is tested, so a span crossing midnight is refused
 * from either side (the day before a held-out day, or the day itself). Touching the last millisecond of a day counts.
 */
export function spanTouchesBlindDay(roomId: string, t0: number, t1: number): boolean {
  const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
  return BLIND_ROOM_DAYS.some(([d, r]) => r === roomId && lo < istDayStartMs(d) + DAY_MS && hi >= istDayStartMs(d));
}

/**
 * B3 (REL2-R3): the held-out rule for the tape tools (scribe_get_session, scribe_get_recording, scribe_extract_audio, scribe_transcribe_range and the stitch / transcribe_range jobs), BEFORE any
 * R2 read or presign. A session is refused (`blind_room_day`) if (a) the span asked for [startMs, endMs] (default: the whole session, started_at to its last end or chunk) or the session's own start
 * touches a held-out (room, IST date), or (b) ANY bench_window of the session has a held-out placement (bench_window.room_day_id or room_diarize_window.room_day_id). null = not held out.
 * An unknown session returns null: the caller's own not-found answer stands.
 */
export async function guardSessionSpan(sessionId: string, span?: { startMs?: number | null; endMs?: number | null }): Promise<"blind_room_day" | null> {
  const rows = (await sql`
    SELECT s.room_id, (extract(epoch FROM s.started_at) * 1000)::bigint AS started_ms,
           (extract(epoch FROM COALESCE(GREATEST(s.ended_at, (SELECT max(c.ended_at) FROM bench_chunk c WHERE c.session_id = s.id)), (SELECT max(c.ended_at) FROM bench_chunk c WHERE c.session_id = s.id), s.started_at)) * 1000)::bigint AS last_ms,
           EXISTS (SELECT 1 FROM bench_window w LEFT JOIN room_diarize_window dw ON dw.window_id = w.id WHERE w.session_id = s.id AND (
             EXISTS (SELECT 1 FROM room_day r1, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
             OR EXISTS (SELECT 1 FROM room_turn_speaker t JOIN room_day r2 ON r2.id = t.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b2(d, r) WHERE t.window_id = w.id AND b2.d = r2.ist_date AND b2.r = r2.room_id)
             OR EXISTS (SELECT 1 FROM jev_window_text j JOIN room_day r3 ON r3.id = j.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b3(d, r) WHERE j.window_id = w.id AND b3.d = r3.ist_date AND b3.r = r3.room_id)
             OR EXISTS (SELECT 1 FROM room_span_emotion e JOIN room_day r4 ON r4.id = e.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b4(d, r) WHERE e.window_id = w.id AND b4.d = r4.ist_date AND b4.r = r4.room_id))) AS window_blind
      FROM bench_session s WHERE s.id = ${sessionId}::text LIMIT 1
  `) as Array<{ room_id: string; started_ms: string | number; last_ms: string | number | null; window_blind: boolean }>;
  const s = rows[0];
  if (!s) return null;
  if (s.window_blind) return "blind_room_day";
  const started = Number(s.started_ms);
  const last = Math.max(started, Number(s.last_ms ?? started));
  // B3-2: the WHOLE session span decides, whatever range was asked for (no chunk-level partial serving); a range that reaches outside the session into a held-out day is refused too
  if (spanTouchesBlindDay(s.room_id, started, last)) return "blind_room_day";
  if (span?.startMs != null && span?.endMs != null && spanTouchesBlindDay(s.room_id, span.startMs, span.endMs)) return "blind_room_day";
  return null;
}

/**
 * K3-1 (REL2-R3): the batch form of guardSessionSpan for listings: of these session ids, the ones that are held out (the same rule, whole session, in SQL): the session's room has a held-out IST day overlapping
 * [started_at, its last end or chunk end], or a window of the session has a held-out placement.
 */
export async function sessionsBlindAny(sessionIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(sessionIds.filter((x) => typeof x === "string" && x.length > 0))];
  if (ids.length === 0) return new Set();
  const rows = (await sql`
    SELECT s.id FROM bench_session s
     WHERE s.id = ANY(${ids}::text[])
       AND (
         EXISTS (SELECT 1 FROM unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r)
                  WHERE b.r = s.room_id
                    AND (b.d::timestamp AT TIME ZONE 'Asia/Kolkata') <= GREATEST(s.started_at, s.ended_at, (SELECT max(c.ended_at) FROM bench_chunk c WHERE c.session_id = s.id))
                    AND (b.d::timestamp AT TIME ZONE 'Asia/Kolkata') + interval '1 day' > s.started_at)
         OR EXISTS (SELECT 1 FROM unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r)
                     WHERE b.r = s.room_id AND (s.started_at AT TIME ZONE 'Asia/Kolkata')::date = b.d)
         OR EXISTS (SELECT 1 FROM bench_window w LEFT JOIN room_diarize_window dw ON dw.window_id = w.id WHERE w.session_id = s.id AND (
             EXISTS (SELECT 1 FROM room_day r1, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
             OR EXISTS (SELECT 1 FROM room_turn_speaker t JOIN room_day r2 ON r2.id = t.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b2(d, r) WHERE t.window_id = w.id AND b2.d = r2.ist_date AND b2.r = r2.room_id)
             OR EXISTS (SELECT 1 FROM jev_window_text j JOIN room_day r3 ON r3.id = j.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b3(d, r) WHERE j.window_id = w.id AND b3.d = r3.ist_date AND b3.r = r3.room_id)
             OR EXISTS (SELECT 1 FROM room_span_emotion e JOIN room_day r4 ON r4.id = e.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b4(d, r) WHERE e.window_id = w.id AND b4.d = r4.ist_date AND b4.r = r4.room_id)))
       )
  `) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * DRAIN-GUARD: every window a production CHOOSER (auto-drain, room drain, diarize / emotion enqueue, measure, join-only, repeat-run backfill) must leave out, in one statement: a window with ANY held-out
 * placement (windowBlindAny's rule), a window of a session that touches a held-out day or holds such a window (sessionsBlindAny's rule, whole session). The chooser removes these ids BEFORE its LIMIT
 * (`w.id <> ALL(...)`), so a held-out window never takes a slot and the batch size is unchanged; it logs the count as `n_blind_excluded`.
 */
export async function blindWindowIds(): Promise<string[]> {
  const rows = (await sql`
    WITH bw AS (
      SELECT w.id, w.session_id
        FROM bench_window w
        LEFT JOIN room_diarize_window dw ON dw.window_id = w.id
       WHERE EXISTS (SELECT 1 FROM room_day r1, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
          OR EXISTS (SELECT 1 FROM room_turn_speaker t JOIN room_day r2 ON r2.id = t.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b2(d, r) WHERE t.window_id = w.id AND b2.d = r2.ist_date AND b2.r = r2.room_id)
          OR EXISTS (SELECT 1 FROM jev_window_text j JOIN room_day r3 ON r3.id = j.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b3(d, r) WHERE j.window_id = w.id AND b3.d = r3.ist_date AND b3.r = r3.room_id)
          OR EXISTS (SELECT 1 FROM room_span_emotion e JOIN room_day r4 ON r4.id = e.room_day_id, unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b4(d, r) WHERE e.window_id = w.id AND b4.d = r4.ist_date AND b4.r = r4.room_id)
    )
    SELECT w.id FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
     WHERE w.id IN (SELECT id FROM bw)
        OR w.session_id IN (SELECT session_id FROM bw)
        OR EXISTS (SELECT 1 FROM unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r)
                    WHERE b.r = s.room_id
                      AND (b.d::timestamp AT TIME ZONE 'Asia/Kolkata') <= GREATEST(s.started_at, s.ended_at, (SELECT max(c.ended_at) FROM bench_chunk c WHERE c.session_id = s.id))
                      AND (b.d::timestamp AT TIME ZONE 'Asia/Kolkata') + interval '1 day' > s.started_at)
        OR EXISTS (SELECT 1 FROM unnest(${BLIND_DAYS}::date[], ${BLIND_ROOMS}::text[]) AS b(d, r)
                    WHERE b.r = s.room_id AND (s.started_at AT TIME ZONE 'Asia/Kolkata')::date = b.d)
  `) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
