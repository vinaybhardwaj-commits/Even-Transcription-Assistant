/**
 * lib/stt/silence.ts — E18. A window called silent is a NAMED state, an EVIDENCED verdict, and a set that can
 * be re-adjudicated in bulk.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────────────
 * E11 stopped a quiet room burning three attempts and reading as an outage. That is right and is unchanged
 * here: silence still costs NO attempt. What E11 left behind is a verdict nobody can check. E13 (a dead mic
 * cannot be told from a quiet room) and E15 (VAD calibration on room audio, UNVERIFIED) are both open, so the
 * verdict is known to be fallible — and a fallible verdict that cannot be re-examined is audio thrown away.
 *
 * ─── WHAT THIS MODULE DOES, AND WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
 * It records what was decided and what it was decided from, and it can hand the whole population back for a
 * second opinion. It does NOT decide anything: there is no detector here, no threshold, and no judgment about
 * whether a given window was an empty room or a dead microphone. That is E13's work, and this module exists so
 * that E13 has something to re-run against.
 *
 * ─── THE HONEST LIMIT (rule 21) ─────────────────────────────────────────────────────────────────────────
 * Today, an empty room and a dead mic produce the SAME row. The one field that could separate them is the
 * recorder's meter (bench_chunk.peak_level / avg_level, 0066), and the native recorder has never sent one:
 * 0 of 4,405 chunks. So `audio_level_source` is 'absent' on real windows, and the two causes are recorded
 * identically. This module makes that fact visible and durable instead of silently collapsing it — which is
 * the whole reason E13 is still open.
 */
import { sql } from "@/lib/db";

/** The state a settled silent window rests in. NEVER 'transcribed' — "we heard nothing" is its own claim. */
export const SILENT_STATE = "silent";

/** How silence was concluded. One value today: the engine read the window and returned no speech. */
export const VERDICT_EMPTY_TRANSCRIPT = "engine_empty_transcript";

/** Where the recorder's level came from, or that it was not sent. */
export type AudioLevelSource = "recorder" | "absent";
/** Where the whisper VAD parameters came from, or that the service did not report them. */
export type VadParamsSource = "service" | "unreported";

/**
 * The whisper parameters a verdict was made under. The service does not report these today, so
 * `readVadParams` returns `unreported` and every value stays NULL rather than being assumed from a config file
 * that the service may not be running. An invented parameter is worse than a missing one: it would read as a
 * fact and would be used to overturn or uphold a verdict it never governed.
 */
export type VadParams = {
  source: VadParamsSource;
  vad_enabled: boolean | null;
  no_speech_thold: number | null;
  suppress_nst: boolean | null;
  silero_version: string | null;
};

export const VAD_PARAMS_UNREPORTED: VadParams = {
  source: "unreported", vad_enabled: null, no_speech_thold: null, suppress_nst: null, silero_version: null,
};

/**
 * PURE — what the answer says about the flags it ran under.
 *
 * whisper.cpp's /inference returns transcript, segments and (rarely) a model name; it reports no VAD flags at
 * all (lib/whisper.ts). So this reads them defensively off whatever the answer carried and says `unreported`
 * when they are not there, which is every answer today. Wired this way so that the day the service starts
 * reporting them, the verdicts start carrying them with no schema change.
 */
export function readVadParams(answer: unknown): VadParams {
  const o = (answer ?? {}) as Record<string, unknown>;
  const raw = (o.vad ?? o.vad_params ?? o.params) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return VAD_PARAMS_UNREPORTED;
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const p = {
    vad_enabled: bool(raw.vad ?? raw.enabled),
    no_speech_thold: num(raw.no_speech_thold ?? raw.no_speech_threshold),
    suppress_nst: bool(raw.suppress_nst ?? raw.suppress_non_speech_tokens),
    silero_version: str(raw.silero_version ?? raw.vad_model_version),
  };
  // Nothing recognisable is not a report. Partial IS a report: what it names is a fact, and the CHECK in 0101
  // only forbids values on an 'unreported' row, not NULLs on a reported one.
  const any = p.vad_enabled !== null || p.no_speech_thold !== null || p.suppress_nst !== null || p.silero_version !== null;
  return any ? { source: "service", ...p } : VAD_PARAMS_UNREPORTED;
}

/** What this window's own chunks metered, as the recorder reported it — or that none of them did. */
export type WindowAudioLevel = {
  source: AudioLevelSource;
  peak_level: number | null;
  avg_level: number | null;
  level_chunks: number;
  total_chunks: number;
};

/**
 * The window's meter reading, read at verdict time from the chunks that overlap it.
 *
 * `total_chunks` is recorded beside `level_chunks` on purpose: "no level" and "no chunks" are different
 * absences, and a reader that cannot tell them apart would read an unrecorded window as a silent one.
 */
export async function readWindowAudioLevel(
  sessionId: string, source: string, startMs: number, endMs: number,
): Promise<WindowAudioLevel> {
  // The SAME half-open overlap the measure job uses (lib/stt/measure-job.ts, INFERRED SQL #2): a chunk that
  // merely touches a boundary contributes nothing, and the mic is part of the key — the backup mic's meter is
  // not evidence about what the primary heard.
  const rows = (await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE c.peak_level IS NOT NULL OR c.avg_level IS NOT NULL)::int AS levelled,
           max(c.peak_level) AS peak,
           avg(c.avg_level)  AS avg
      FROM bench_chunk c
     WHERE c.session_id = ${sessionId}
       AND c.source = ${source}
       AND c.started_at < to_timestamp(${endMs}::bigint / 1000.0)
       AND c.ended_at   > to_timestamp(${startMs}::bigint / 1000.0)
  `) as Array<{ total: number; levelled: number; peak: number | null; avg: number | null }>;
  const r = rows[0] ?? { total: 0, levelled: 0, peak: null, avg: null };
  const levelled = Number(r.levelled ?? 0);
  const peak = r.peak === null || r.peak === undefined ? null : Number(r.peak);
  const avg = r.avg === null || r.avg === undefined ? null : Number(r.avg);
  return {
    source: levelled > 0 && (peak !== null || avg !== null) ? "recorder" : "absent",
    peak_level: levelled > 0 ? peak : null,
    avg_level: levelled > 0 ? avg : null,
    level_chunks: levelled,
    total_chunks: Number(r.total ?? 0),
  };
}

export type SilenceVerdict = {
  windowId: string;
  roomDayId: string | null;
  sessionId: string;
  verdict: string;
  engine: string;
  engineVersion?: string | null;
  audioSeconds?: number | null;
  level: WindowAudioLevel;
  vad: VadParams;
  /** Whatever the answer carried, verbatim. Counts and ids only — never transcript text (there is none). */
  answer?: Record<string, unknown> | null;
};

/**
 * Record the verdict, AT THE MOMENT IT IS MADE.
 *
 * A re-drain of the same window overwrites the row and CLEARS the re-adjudication stamps: the new row is a new
 * verdict, and carrying the old batch forward would say a decision had been reviewed when it had not.
 */
export async function recordSilenceVerdict(v: SilenceVerdict): Promise<void> {
  await sql`
    INSERT INTO bench_window_silence
      (window_id, room_day_id, session_id, decided_at, verdict, engine, engine_version, audio_seconds,
       audio_level_source, peak_level, avg_level, level_chunks, total_chunks,
       vad_params_source, vad_enabled, no_speech_thold, suppress_nst, silero_version, answer_json)
    VALUES
      (${v.windowId}, ${v.roomDayId}, ${v.sessionId}, NOW(), ${v.verdict}, ${v.engine},
       ${v.engineVersion ?? null}, ${v.audioSeconds ?? null},
       ${v.level.source}, ${v.level.peak_level}, ${v.level.avg_level}, ${v.level.level_chunks}, ${v.level.total_chunks},
       ${v.vad.source}, ${v.vad.vad_enabled}, ${v.vad.no_speech_thold}, ${v.vad.suppress_nst}, ${v.vad.silero_version},
       ${v.answer === null || v.answer === undefined ? null : JSON.stringify(v.answer)}::jsonb)
    ON CONFLICT (window_id) DO UPDATE SET
      room_day_id        = EXCLUDED.room_day_id,
      session_id         = EXCLUDED.session_id,
      decided_at         = EXCLUDED.decided_at,
      verdict            = EXCLUDED.verdict,
      engine             = EXCLUDED.engine,
      engine_version     = EXCLUDED.engine_version,
      audio_seconds      = EXCLUDED.audio_seconds,
      audio_level_source = EXCLUDED.audio_level_source,
      peak_level         = EXCLUDED.peak_level,
      avg_level          = EXCLUDED.avg_level,
      level_chunks       = EXCLUDED.level_chunks,
      total_chunks       = EXCLUDED.total_chunks,
      vad_params_source  = EXCLUDED.vad_params_source,
      vad_enabled        = EXCLUDED.vad_enabled,
      no_speech_thold    = EXCLUDED.no_speech_thold,
      suppress_nst       = EXCLUDED.suppress_nst,
      silero_version     = EXCLUDED.silero_version,
      answer_json        = EXCLUDED.answer_json,
      reopened_at        = NULL,
      reopened_batch     = NULL,
      reopened_reason    = NULL,
      -- reopened_history is NOT cleared: a new verdict has not been reviewed by the old batch, but the fact that
      -- this window WAS re-adjudicated before is exactly what R39 says must survive.
      reopened_detector  = NULL
  `;
}

export type SilenceFilter = {
  /** One room, or every room when omitted. */
  roomId?: string | null;
  roomDayId?: string | null;
  /** Window start bounds on the room-day clock, inclusive/exclusive as named. */
  fromMs?: number | null;
  toMs?: number | null;
  /** Default false: a window already handed back once is not offered again unless asked for. */
  includeReopened?: boolean;
  limit?: number;
};

export type SilentWindowRow = {
  window_id: string;
  room_id: string | null;
  room_day_id: string | null;
  session_id: string;
  start_ms: number;
  end_ms: number;
  clip_r2_key: string | null;
  decided_at: string | null;
  verdict: string | null;
  engine: string | null;
  audio_level_source: string | null;
  peak_level: number | null;
  avg_level: number | null;
  level_chunks: number | null;
  total_chunks: number | null;
  vad_params_source: string | null;
  reopened_at: string | null;
  reopened_batch: string | null;
};

const capped = (n: number | undefined, dflt: number, max: number) =>
  Math.max(1, Math.min(max, Math.trunc(Number(n ?? dflt)) || dflt));

/**
 * R1.3 — THE SET, not a window at a time.
 *
 * LEFT JOIN, deliberately: a window in state 'silent' with no evidence row is exactly the thing a reader must
 * be able to see (a verdict written before 0101, or one whose evidence write failed). Dropping it would hide
 * the windows most in need of a second look.
 */
export async function listSilentWindows(f: SilenceFilter = {}): Promise<SilentWindowRow[]> {
  const limit = capped(f.limit, 100, 1000);
  return (await sql`
    SELECT w.id AS window_id, s.room_id, w.room_day_id, w.session_id, w.start_ms, w.end_ms, w.clip_r2_key,
           z.decided_at::text AS decided_at, z.verdict, z.engine,
           z.audio_level_source, z.peak_level, z.avg_level, z.level_chunks, z.total_chunks,
           z.vad_params_source, z.reopened_at::text AS reopened_at, z.reopened_batch
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
      LEFT JOIN bench_window_silence z ON z.window_id = w.id
     WHERE w.state = ${SILENT_STATE}
       AND (${f.roomId ?? null}::text IS NULL OR s.room_id = ${f.roomId ?? null}::text)
       AND (${f.roomDayId ?? null}::text IS NULL OR w.room_day_id = ${f.roomDayId ?? null}::text)
       AND (${f.fromMs ?? null}::bigint IS NULL OR w.start_ms >= ${f.fromMs ?? null}::bigint)
       AND (${f.toMs ?? null}::bigint IS NULL OR w.start_ms < ${f.toMs ?? null}::bigint)
       AND (${f.includeReopened === true}::boolean OR z.reopened_at IS NULL)
     ORDER BY w.start_ms ASC
     LIMIT ${limit}
  `) as SilentWindowRow[];
}

export type ReopenResult = { batch: string; detector: string; reopened: number; window_ids: string[] };

/** What a detector name may look like. An identity later passes are compared against, not a vocabulary. */
export const DETECTOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * R31.2 — WHAT A BULK RUN WOULD DO, WITHOUT DOING IT.
 *
 * An empty room and a dead mic produce the same row, and the third shape — no level at all — is the real
 * production shape. A bulk operation over a population we have just admitted we cannot classify is exactly the
 * thing that must be previewable. So this is what the operator surface answers by default, and doing the work
 * takes a second, explicit argument.
 *
 * It reports the size of the set, the span of days it covers, how many rooms it touches, and the distribution of
 * the evidence those windows hold — because "re-adjudicate 4,000 windows" and "re-adjudicate 4,000 windows of
 * which none carries an audio level" are different decisions.
 */
export type SilencePreview = {
  /** What THIS call would move: the filter AND the same limit the apply uses. */
  windows: number;
  rooms: number;
  first_start_ms: number | null;
  last_start_ms: number | null;
  evidence: { level_recorder: number; level_absent: number; no_evidence_row: number; vad_reported: number; vad_unreported: number };
  by_verdict: Array<{ verdict: string | null; n: number }>;
  by_engine: Array<{ engine: string | null; n: number }>;
  /** How many windows match the filter ALTOGETHER, ignoring the limit. The number the operator is deciding about. */
  eligible: { total: number; rooms: number; first_start_ms: number | null; last_start_ms: number | null };
};

/**
 * R37 — ONE BOUND, TWO NUMBERS.
 *
 * The preview used to count the whole matching set while the apply moved at most `limit` of it: 250 previewed,
 * 100 moved. A dry run that miscounts is worse than no dry run, because it licenses an apply nobody described.
 * So `windows` is now what THIS call will move — the same filter, the same ORDER BY and the same LIMIT the apply
 * uses — and `eligible.total` is how many match altogether. An operator needs both: one says what is about to
 * happen, the other says how much is left after it.
 *
 * ONE STATEMENT, so the two numbers cannot drift. The roll-ups used to come from a second query with its own copy
 * of the filter; a future edit to one could have left the other behind. There is now nothing to keep in step.
 */
export async function previewSilenceReadjudication(f: SilenceFilter = {}): Promise<SilencePreview> {
  const limit = capped(f.limit, 100, 1000);
  const rows = (await sql`
    WITH matched AS (
      SELECT w.id, w.start_ms, s.room_id, z.window_id AS ev, z.audio_level_source, z.vad_params_source, z.verdict, z.engine
        FROM bench_window w
        JOIN bench_session s ON s.id = w.session_id
        LEFT JOIN bench_window_silence z ON z.window_id = w.id
       WHERE w.state = ${SILENT_STATE}
         AND (${f.roomId ?? null}::text IS NULL OR s.room_id = ${f.roomId ?? null}::text)
         AND (${f.roomDayId ?? null}::text IS NULL OR w.room_day_id = ${f.roomDayId ?? null}::text)
         AND (${f.fromMs ?? null}::bigint IS NULL OR w.start_ms >= ${f.fromMs ?? null}::bigint)
         AND (${f.toMs ?? null}::bigint IS NULL OR w.start_ms < ${f.toMs ?? null}::bigint)
         AND (${f.includeReopened === true}::boolean OR z.reopened_at IS NULL)
    ),
    -- EXACTLY the apply's own bound: same order, same limit. These are the windows that would move.
    picked AS (SELECT * FROM matched ORDER BY start_ms ASC LIMIT ${limit})
    SELECT (SELECT count(*)::int FROM matched) AS eligible_total,
           (SELECT count(DISTINCT room_id)::int FROM matched) AS eligible_rooms,
           (SELECT min(start_ms)::bigint FROM matched) AS eligible_first,
           (SELECT max(start_ms)::bigint FROM matched) AS eligible_last,
           count(*)::int AS windows,
           count(DISTINCT room_id)::int AS rooms,
           min(start_ms)::bigint AS first_start_ms,
           max(start_ms)::bigint AS last_start_ms,
           count(*) FILTER (WHERE audio_level_source = 'recorder')::int AS level_recorder,
           count(*) FILTER (WHERE audio_level_source = 'absent')::int AS level_absent,
           count(*) FILTER (WHERE ev IS NULL)::int AS no_evidence_row,
           count(*) FILTER (WHERE vad_params_source = 'service')::int AS vad_reported,
           count(*) FILTER (WHERE vad_params_source = 'unreported')::int AS vad_unreported,
           (SELECT COALESCE(jsonb_agg(jsonb_build_object('verdict', v.verdict, 'n', v.n) ORDER BY v.n DESC), '[]'::jsonb)
              FROM (SELECT verdict, count(*)::int AS n FROM picked GROUP BY verdict) v) AS by_verdict,
           (SELECT COALESCE(jsonb_agg(jsonb_build_object('engine', e.engine, 'n', e.n) ORDER BY e.n DESC), '[]'::jsonb)
              FROM (SELECT engine, count(*)::int AS n FROM picked GROUP BY engine) e) AS by_engine
      FROM picked
  `) as Array<Record<string, unknown>>;
  const r = rows[0] ?? {};
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const orNull = (v: unknown) => (v === null || v === undefined ? null : n(v));
  return {
    windows: n(r.windows), rooms: n(r.rooms),
    first_start_ms: orNull(r.first_start_ms), last_start_ms: orNull(r.last_start_ms),
    evidence: {
      level_recorder: n(r.level_recorder), level_absent: n(r.level_absent), no_evidence_row: n(r.no_evidence_row),
      vad_reported: n(r.vad_reported), vad_unreported: n(r.vad_unreported),
    },
    by_verdict: (r.by_verdict ?? []) as SilencePreview["by_verdict"],
    by_engine: (r.by_engine ?? []) as SilencePreview["by_engine"],
    eligible: {
      total: n(r.eligible_total), rooms: n(r.eligible_rooms),
      first_start_ms: orNull(r.eligible_first), last_start_ms: orNull(r.eligible_last),
    },
  };
}

/**
 * R1.3 — HAND THE WHOLE SET BACK, in one statement.
 *
 * When E15 calibrates VAD and E13 lands a dead-mic detector, the backlog is re-run against the better
 * detector. That needs a mechanism, not a per-window `force`: this moves every matching silent window back to
 * 'closed' — the state the drain picks up — and stamps the evidence row with the batch and the reason, so the
 * population that was re-run is itself queryable afterwards.
 *
 * ONE STATEMENT. The window move and the ledger stamp are one CTE, so a window can never be re-offered with
 * nothing recording why, and a stamp can never name a window that was not moved. The stamp is an UPSERT (R38):
 * a window with no evidence row — the population 0101's header calls the real production shape — used to move
 * with nothing written at all, which made that first promise false and left those windows eligible for every
 * later pass in silence. It APPENDS to reopened_history (R39) rather than overwriting the scalars alone, because
 * a second detector that replaces the first destroys the fact that the window was re-adjudicated before.
 * `reason` is required: a bulk
 * re-adjudication nobody has to justify is how the last unexplained backlog happened. `detector` is required for
 * the same reason one step further on (R31.3): a second pass with a better detector must be distinguishable from
 * the first, or we have overwritten one verdict with another and lost the fact that we did.
 */
export async function reopenSilentWindows(f: SilenceFilter & { batch: string; reason: string; detector: string }): Promise<ReopenResult> {
  const batch = String(f.batch ?? "").trim();
  const reason = String(f.reason ?? "").trim();
  const detector = String(f.detector ?? "").trim();
  if (!batch) throw new Error("reopenSilentWindows: a batch id is required — the set must be nameable afterwards");
  if (!reason) throw new Error("reopenSilentWindows: a reason is required — a re-adjudication nobody justified is not a mechanism");
  if (!detector) throw new Error("reopenSilentWindows: a detector is required — a second pass must be distinguishable from the first");
  // The detector name is an IDENTITY that later passes are compared against, so it is constrained to something
  // that can be matched exactly: letters, digits and . _ : - only. This is not a safety boundary (the door
  // authenticates, and nothing renders this string); it stops "detector v2" and "detector_v2 " being two names
  // for one pass. It deliberately does NOT constrain the VALUE to a known vocabulary — inventing one here would
  // be the smuggled classifier R31.5 forbids.
  if (!DETECTOR_NAME.test(detector)) {
    throw new Error(`reopenSilentWindows: detector "${detector.slice(0, 32)}" is not a usable name — letters, digits and . _ : - only, 1-64 characters`);
  }
  const limit = capped(f.limit, 100, 1000);
  const rows = (await sql`
    WITH picked AS (
      SELECT w.id
        FROM bench_window w
        JOIN bench_session s ON s.id = w.session_id
        LEFT JOIN bench_window_silence z ON z.window_id = w.id
       WHERE w.state = ${SILENT_STATE}
         AND (${f.roomId ?? null}::text IS NULL OR s.room_id = ${f.roomId ?? null}::text)
         AND (${f.roomDayId ?? null}::text IS NULL OR w.room_day_id = ${f.roomDayId ?? null}::text)
         AND (${f.fromMs ?? null}::bigint IS NULL OR w.start_ms >= ${f.fromMs ?? null}::bigint)
         AND (${f.toMs ?? null}::bigint IS NULL OR w.start_ms < ${f.toMs ?? null}::bigint)
         AND (${f.includeReopened === true}::boolean OR z.reopened_at IS NULL)
       ORDER BY w.start_ms ASC
       LIMIT ${limit}
    ),
    moved AS (
      UPDATE bench_window w SET state = 'closed'
       WHERE w.id IN (SELECT id FROM picked) AND w.state = ${SILENT_STATE}
      RETURNING w.id
    ),
    -- R38 — ONLY the moved windows, and ALL of them: an INSERT over the moved set (so a window with no evidence
    -- row gets its first row here) with ON CONFLICT for the ones that already have one. R39 — the pass APPENDS.
    stamped AS (
      INSERT INTO bench_window_silence
        (window_id, session_id, room_day_id, reopened_at, reopened_batch, reopened_reason, reopened_detector, reopened_history)
      SELECT m.id, w.session_id, w.room_day_id, NOW(), ${batch}::text, ${reason}::text, ${detector}::text,
             jsonb_build_array(jsonb_build_object('at', NOW(), 'batch', ${batch}::text, 'reason', ${reason}::text, 'detector', ${detector}::text))
        FROM moved m JOIN bench_window w ON w.id = m.id
      ON CONFLICT (window_id) DO UPDATE SET
        reopened_at       = EXCLUDED.reopened_at,
        reopened_batch    = EXCLUDED.reopened_batch,
        reopened_reason   = EXCLUDED.reopened_reason,
        reopened_detector = EXCLUDED.reopened_detector,
        reopened_history  = bench_window_silence.reopened_history || EXCLUDED.reopened_history
      RETURNING window_id
    )
    SELECT id FROM moved ORDER BY id
  `) as Array<{ id: string }>;
  return { batch, detector, reopened: rows.length, window_ids: rows.map((r) => r.id) };
}

/** How many silent windows are waiting on a second opinion, and how many have had one. */
export async function silenceBacklog(roomId?: string | null): Promise<{ pending: number; reopened: number; no_evidence: number }> {
  const rows = (await sql`
    SELECT count(*) FILTER (WHERE z.window_id IS NOT NULL AND z.reopened_at IS NULL)::int AS pending,
           count(*) FILTER (WHERE z.reopened_at IS NOT NULL)::int AS reopened,
           count(*) FILTER (WHERE z.window_id IS NULL)::int AS no_evidence
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
      LEFT JOIN bench_window_silence z ON z.window_id = w.id
     WHERE w.state = ${SILENT_STATE}
       AND (${roomId ?? null}::text IS NULL OR s.room_id = ${roomId ?? null}::text)
  `) as Array<{ pending: number; reopened: number; no_evidence: number }>;
  const r = rows[0] ?? { pending: 0, reopened: 0, no_evidence: 0 };
  return { pending: Number(r.pending ?? 0), reopened: Number(r.reopened ?? 0), no_evidence: Number(r.no_evidence ?? 0) };
}
