/**
 * lib/admin/room-reads.ts — the app-side reads the SCREEN and the DOOR both make.
 *
 * The twin of lib/room-facts.ts: that file holds every decision, this one holds every query
 * behind those decisions. Build 1 §3.6 asks for one shared source for every room fact, and a
 * shared decision over two hand-copied queries is only half of one — the divergences this build
 * removes were as often in the SQL as in the rule.
 *
 * READ-ONLY. Nothing in this file writes, and there is no code path here that could.
 *
 * TAGGED TEMPLATES, NOT PARAMETERISED STRINGS, like every other reader in this codebase. lib/db's
 * `sql` is a Neon HTTP tag; reaching for `sql.query(text, params)` would work at runtime but
 * return undefined wherever the module is mocked as a bare tag — a silent empty monitor, which
 * is the one failure this screen must not have. That is also why these are functions rather than
 * exported SQL strings: a string can be shared, but only a function can be shared AND keep the
 * tag. Every one of them is listed verbatim in the build report.
 *
 * EVERY READ FAILS LOCALLY. Each returns its own `{ ok, degraded }` and never throws, so one
 * broken query degrades one section rather than turning a whole day's picture unknown. That
 * matters more than it sounds: the page treats "cannot tell" as unknown, so a single failed read
 * that was allowed to spread would silence the no-day-record alarm in every room — the one true
 * alarm this page has ever raised.
 */

import { sql } from "@/lib/db";
import type { StrandedRaw, TranscriptCounts } from "@/lib/room-facts";
import { ZERO_STRANDED_RAW } from "@/lib/room-facts";
import { micHealth, type MicHealth, type MicPiece } from "@/lib/mic-health";
import { finiteNumberOrNull, parseMicLevelPair } from "@/lib/bench-levels";

export type Read<T> = { value: T; degraded: string | null };

const fail = (label: string, e: unknown): string => `${label}:${String((e as Error)?.message ?? e).slice(0, 80)}`;

/**
 * Finished audio the manual recovery control can run, across the room's whole history.
 *
 * This is deliberately NOT scoped to today's sessions. The control was built for stranded tape
 * from prior clinic days; using the live monitor's day-scoped session list hid the sixteen
 * repaired Cardiology windows while the action itself could still run them.
 */
export async function readWaitingAudioCounts(roomIds: readonly string[]): Promise<Read<Map<string, number>>> {
  const out = new Map<string, number>();
  if (!roomIds.length) return { value: out, degraded: null };
  try {
    const rows = (await sql`
      SELECT s.room_id, COUNT(*)::int AS waiting_audio_count
        FROM bench_window w
        JOIN bench_session s ON s.id = w.session_id
       WHERE s.room_id = ANY(${roomIds as string[]}::text[])
         AND w.state = 'closed'
         AND w.grid_aligned = TRUE
         AND w.room_day_id IS NOT NULL
         AND NOT EXISTS (
               SELECT 1 FROM stt_subject_job j
                WHERE j.subject_type = 'bench_window' AND j.subject_id = w.id AND j.tier = 'asr'
             )
       GROUP BY s.room_id
    `) as Array<{ room_id: string; waiting_audio_count: number | string }>;
    for (const row of rows) out.set(row.room_id, Number(row.waiting_audio_count) || 0);
    return { value: out, degraded: null };
  } catch (e) {
    return { value: out, degraded: fail("waiting_audio_count_unavailable", e) };
  }
}

/**
 * The Transcript lane's counts AND the stranded-audio buckets, per room, for the given sessions.
 *
 * ONE READ, because they walk the same rows and splitting them would double the scan on the
 * heaviest table this monitor touches.
 *
 * `has_job` IS A SUBSELECT, NOT A JOIN, and that is deliberate. stt_subject_job has no unique
 * constraint on (subject_type, subject_id) that this code may assume, so a LEFT JOIN would
 * multiply a window's span by the number of job rows against it and silently inflate every
 * minute figure on the screen. EXISTS cannot.
 *
 * NO TIER FILTER. The drain's own read narrows to tier = 'asr'; this asks the question the
 * operator is actually asking — "has anybody enqueued this at all" — and 'asr' is the only tier
 * production has ever written, so the two agree today and this one stays right if that changes.
 *
 * SPANS COME FROM THE SLOT (end_ms - start_ms). Both are set at INSERT from the fifteen-minute
 * grid and both are in the unique index, so neither is ever null — including on an `open`
 * window, which is what makes the never-closed figure measurable at all.
 */
export async function readTranscriptAndStranded(
  sessionIds: readonly string[],
): Promise<Read<Map<string, { counts: TranscriptCounts; stranded: StrandedRaw }>>> {
  const out = new Map<string, { counts: TranscriptCounts; stranded: StrandedRaw }>();
  if (!sessionIds.length) return { value: out, degraded: null };
  try {
    const rows = (await sql`
      SELECT s.room_id,
             COUNT(*) FILTER (WHERE w.state = 'transcribed')  ::int AS done,
             -- E18 R1.1 — silence is its own settled state and is NEVER added to the done count.
             COUNT(*) FILTER (WHERE w.state = 'silent')       ::int AS silent,
             -- CLOSED splits in two, and the split is the whole point of this column pair.
             -- A closed window with a room_day is finished audio nobody has run. One without
             -- cannot be processed at all: room-drain.ts returns no_room_day BEFORE the claim,
             -- so it never becomes 'failed' and never leaves 'closed'.
             COUNT(*) FILTER (WHERE w.state = 'closed' AND w.room_day_id IS NOT NULL)::int AS waiting,
             COUNT(*) FILTER (WHERE w.state = 'closed' AND w.room_day_id IS NULL)    ::int AS no_day,
             COUNT(*) FILTER (WHERE w.state = 'transcribing') ::int AS in_progress,
             COUNT(*) FILTER (WHERE w.state = 'failed')       ::int AS failed,
             COALESCE(SUM(w.end_ms - w.start_ms) FILTER (WHERE w.state = 'transcribed'), 0)::bigint AS words_ms,
             -- ---- STRANDED AUDIO (D7): four disjoint buckets, minutes and slots ------------
             -- Finished audio with NO job row of any kind. On 24 August Cardiology had
             -- seventeen of these and the card called them "waiting" — nothing had ever been
             -- enqueued, so there was no queue for them to be waiting in.
             COALESCE(SUM(w.end_ms - w.start_ms) FILTER (WHERE w.state = 'closed' AND w.room_day_id IS NOT NULL AND NOT w.has_job), 0)::bigint AS closed_no_job_ms,
             COUNT(*) FILTER (WHERE w.state = 'closed' AND w.room_day_id IS NOT NULL AND NOT w.has_job)::int AS closed_no_job_n,
             COALESCE(SUM(w.end_ms - w.start_ms) FILTER (WHERE w.state = 'closed' AND w.room_day_id IS NULL AND NOT w.has_job), 0)::bigint AS closed_no_job_no_day_ms,
             COUNT(*) FILTER (WHERE w.state = 'closed' AND w.room_day_id IS NULL AND NOT w.has_job)::int AS closed_no_job_no_day_n,
             -- Still open although the session that owns it has ended: nothing will ever close
             -- it, so the audio inside it can never be asked for.
             COALESCE(SUM(w.end_ms - w.start_ms) FILTER (WHERE w.state = 'open' AND s.ended_at IS NOT NULL AND w.room_day_id IS NOT NULL), 0)::bigint AS open_after_end_ms,
             COUNT(*) FILTER (WHERE w.state = 'open' AND s.ended_at IS NOT NULL AND w.room_day_id IS NOT NULL)::int AS open_after_end_n,
             COALESCE(SUM(w.end_ms - w.start_ms) FILTER (WHERE w.state = 'open' AND s.ended_at IS NOT NULL AND w.room_day_id IS NULL), 0)::bigint AS open_after_end_no_day_ms,
             COUNT(*) FILTER (WHERE w.state = 'open' AND s.ended_at IS NOT NULL AND w.room_day_id IS NULL)::int AS open_after_end_no_day_n
        FROM (
               SELECT bw.id, bw.session_id, bw.start_ms, bw.end_ms, bw.state, bw.room_day_id,
                      EXISTS (
                        SELECT 1 FROM stt_subject_job j
                         WHERE j.subject_type = 'bench_window' AND j.subject_id = bw.id
                      ) AS has_job
                 FROM bench_window bw
                WHERE bw.session_id = ANY(${sessionIds as string[]}::text[])
             ) w
        JOIN bench_session s ON s.id = w.session_id
       GROUP BY s.room_id
    `) as Array<Record<string, unknown>>;
    const num = (v: unknown) => Number(v) || 0;
    for (const r of rows) {
      const roomId = String(r.room_id ?? "");
      if (!roomId) continue;
      out.set(roomId, {
        counts: {
          done: num(r.done), silent: num(r.silent), waiting: num(r.waiting), no_day: num(r.no_day),
          in_progress: num(r.in_progress), failed: num(r.failed), words_ms: num(r.words_ms),
        },
        stranded: {
          closed_no_job_ms: num(r.closed_no_job_ms), closed_no_job_n: num(r.closed_no_job_n),
          closed_no_job_no_day_ms: num(r.closed_no_job_no_day_ms), closed_no_job_no_day_n: num(r.closed_no_job_no_day_n),
          open_after_end_ms: num(r.open_after_end_ms), open_after_end_n: num(r.open_after_end_n),
          open_after_end_no_day_ms: num(r.open_after_end_no_day_ms), open_after_end_no_day_n: num(r.open_after_end_no_day_n),
        },
      });
    }
    return { value: out, degraded: null };
  } catch (e) {
    return { value: out, degraded: fail("transcript_counts_unavailable", e) };
  }
}

/**
 * Audio recorded today, per room. PRIMARY ONLY.
 *
 * The backup lane records the same wall-clock in parallel, so summing both would report double
 * the audio that exists. This is minutes of TAPE, summed from the pieces themselves — a
 * different measure from the window spans above, and every surface that shows both says so.
 */
export async function readAudioMs(sessionIds: readonly string[]): Promise<Read<Map<string, number>>> {
  const out = new Map<string, number>();
  if (!sessionIds.length) return { value: out, degraded: null };
  try {
    const rows = (await sql`
      SELECT s.room_id, COALESCE(SUM(c.duration_ms), 0)::bigint AS audio_ms
        FROM bench_chunk c JOIN bench_session s ON s.id = c.session_id
       WHERE c.session_id = ANY(${sessionIds as string[]}::text[]) AND c.source = 'primary'
       GROUP BY s.room_id
    `) as Array<{ room_id: string; audio_ms: string | number }>;
    for (const r of rows) out.set(r.room_id, Number(r.audio_ms) || 0);
    return { value: out, degraded: null };
  } catch (e) {
    return { value: out, degraded: fail("audio_minutes_unavailable", e) };
  }
}

/**
 * The two processing switches, as stored, for one room — and NULL where they cannot be read.
 *
 * NOT lib/room-switches.ts's readRoomSwitches, which is right for the recording path and wrong
 * here: it fails CLOSED, returning off for a room it could not read. On a recording path that is
 * the safe direction. On a monitor it would report a room as not transcribing when it is, which
 * is a wrong number on a screen — and §6's rule is that a vital which cannot be computed reads
 * unknown, never false. It is also uncached, because a monitor showing a five-second-old switch
 * position is the same lie in slow motion.
 */
export async function readSwitches(
  roomId: string,
): Promise<Read<{ transcript_enabled: boolean | null; visits_enabled: boolean | null }>> {
  const unknown = { transcript_enabled: null, visits_enabled: null };
  try {
    const rows = (await sql`
      SELECT transcript_enabled, visits_enabled FROM room WHERE id = ${roomId} LIMIT 1
    `) as Array<{ transcript_enabled: boolean; visits_enabled: boolean }>;
    const row = rows[0];
    if (!row) return { value: unknown, degraded: null };
    return {
      value: { transcript_enabled: Boolean(row.transcript_enabled), visits_enabled: Boolean(row.visits_enabled) },
      degraded: null,
    };
  } catch (e) {
    return { value: unknown, degraded: fail("switches_unavailable", e) };
  }
}

/**
 * ENDED DISAGREES, per session, for one room's day — the CAPTURE-clock count.
 *
 * The screen has always had this because its own session read carries the FILTER. The door read
 * a different rollup and so could not raise the alarm at all, which is one of the three
 * divergences §3.6 names. Rather than teach the door's rollup a new column — other consumers
 * depend on that shape — the count gets its own small read, and both surfaces now answer the
 * same question with the same predicate.
 *
 * `c.started_at`, NOT `c.created_at`, and that is the whole precision of the alarm: the kiosk
 * marks a session ended as soon as the recorder stops and only THEN finishes uploading its
 * flush, so a chunk ROW created after ended_at is what every ordinary evening looks like. What
 * this counts is audio whose CAPTURE began after the end, which a flush cannot produce.
 */
export async function readChunksAfterEnd(
  roomId: string,
  fromIso: string,
  toIso: string,
  skewGraceMs: number,
): Promise<Read<Map<string, number>>> {
  const out = new Map<string, number>();
  try {
    const rows = (await sql`
      SELECT s.id,
             COUNT(c.id) FILTER (
               WHERE s.ended_at IS NOT NULL
                 AND c.started_at > s.ended_at + make_interval(secs => ${Math.round(skewGraceMs / 1000)}::int)
             )::int AS chunks_after_end
        FROM bench_session s
        LEFT JOIN bench_chunk c ON c.session_id = s.id
       WHERE s.room_id = ${roomId}
         AND s.started_at >= ${fromIso}::timestamptz
         AND s.started_at <  ${toIso}::timestamptz
       GROUP BY s.id, s.ended_at
    `) as Array<{ id: string; chunks_after_end: number }>;
    for (const r of rows) out.set(r.id, Number(r.chunks_after_end) || 0);
    return { value: out, degraded: null };
  } catch (e) {
    return { value: out, degraded: fail("chunks_after_end_unavailable", e) };
  }
}

/**
 * §2.3 — THE SIZE VITAL, per microphone, for one room's live session.
 *
 * Reads the pieces themselves and judges each microphone against ITS OWN recent work. Freshness
 * is untouched and still answers "is audio still arriving"; this answers the different question
 * that let four hours of Cardiology go unnoticed — "is what arrives actually audio".
 *
 * BASELINE_PIECES + a couple, ordered newest-first and reversed, so the window is the same one
 * the recorder learns from and the two cannot disagree about the same microphone.
 *
 * FAILS TO UNKNOWN. An error returns no entry at all, the vital renders nothing, and nothing on
 * the card claims a microphone is healthy or broken on the strength of a failed query.
 */
export async function readMicSizes(
  sessionIds: readonly string[],
): Promise<Read<Map<string, { primary: MicHealth; backup: MicHealth; spare_exists: boolean }>>> {
  const out = new Map<string, { primary: MicHealth; backup: MicHealth; spare_exists: boolean }>();
  if (!sessionIds.length) return { value: out, degraded: null };
  try {
    const rows = (await sql`
      SELECT s.room_id, c.session_id, c.idx, c.source, c.duration_ms, c.size_bytes,
             c.peak_level, c.avg_level
        FROM bench_chunk c
        JOIN bench_session s ON s.id = c.session_id
       WHERE c.session_id = ANY(${sessionIds as string[]}::text[])
         AND c.upload_state = 'verified'
       ORDER BY s.room_id, c.source, c.idx
    `) as Array<Record<string, unknown>>;

    const byRoom = new Map<string, { primary: MicPiece[]; backup: MicPiece[] }>();
    for (const r of rows) {
      const roomId = String(r.room_id ?? "");
      if (!roomId) continue;
      const lane = r.source === "backup" ? "backup" : "primary";
      const bucket = byRoom.get(roomId) ?? { primary: [], backup: [] };
      const levels = parseMicLevelPair(r.peak_level, r.avg_level);
      bucket[lane].push({
        idx: finiteNumberOrNull(r.idx) ?? 0,
        source: lane,
        duration_ms: finiteNumberOrNull(r.duration_ms) ?? 0,
        size_bytes: finiteNumberOrNull(r.size_bytes),
        peak_level: levels?.peak ?? null,
        avg_level: levels?.avg ?? null,
      });
      byRoom.set(roomId, bucket);
    }
    for (const [roomId, b] of byRoom) {
      // The flush piece is exempt (§2.3): it is legitimately 27 KB, and judging it would raise a
      // fault at the end of every ordinary day.
      const lastOf = (list: MicPiece[]) => (list.length ? list[list.length - 1]!.idx : null);
      out.set(roomId, {
        primary: micHealth(b.primary, { lastIdxOfSession: lastOf(b.primary) }),
        backup: micHealth(b.backup, { lastIdxOfSession: lastOf(b.backup) }),
        // D32 — a spare EXISTS only where one actually recorded something. Most rooms have one
        // microphone and that is normal; nothing about a spare is shown for them.
        spare_exists: b.backup.length > 0,
      });
    }
    return { value: out, degraded: null };
  } catch (e) {
    return { value: out, degraded: fail("mic_sizes_unavailable", e) };
  }
}
