/**
 * lib/overnight-translate/select.ts — WHICH window the overnight driver takes next. READ-ONLY.
 *
 * ORDER (Fable's ruling of 21 Sep 2026, part c):
 *   1. the Jev FIXTURE room-days, first;
 *   2. then the rest of the backlog, oldest window first, with the label-free proxies removing what is
 *      clearly empty.
 *
 * TRANSCRIPT-OFF ROOMS ARE INCLUDED (V, 21 Sep 2026). There is no filter on `room.transcript_enabled`
 * anywhere in this file — the column is SELECTED so the driver knows which jobs need
 * `switch_override`, never used to exclude. A test pins that.
 *
 * THE PROXIES. The speech gate cannot supply "clearly empty": it flags diarization SEGMENTS, gives no window
 * verdict, and its own measurement refutes it (it rejects 73.0% of clinic segments against 38.6% of
 * closed-hours ones). What can be measured per WINDOW without a model or a label is:
 *   - the CLOCK. A window that starts 21:00-06:59 IST is in closed hours, when no consultation occurs
 *     (ledger, ETA-Refuter: 7,548 speaker-labelled segments fall there, false by construction);
 *   - the DIARIZER'S OWN `no_speakers` state (41 of 792 diarized clinic windows, 5.2%).
 * Run against the live database (read-only, 21 Sep 15:30 IST) they excluded 238 + 35 = at most 273 of
 * ~2,574 never-transcribed non-fixture windows: about 10%, a little under the ~12-15% the ruling
 * expected. A third proxy — zero Silero VAD spans, 12 of 80 sampled windows — needs the /vad endpoint
 * that is still under refutation, so it is NOT implemented; expect "about 10%", not 15%.
 *
 * FIXTURES ARE DIFFERENT IN ONE WAY. A fixture window that ALREADY has a run needs only English, so it is
 * re-drained iff the run has text, has no `transcript_english`, and J0 would NOT read it as native English
 * (lib/jev/english.ts isNativeEnglish — imported, not copied, so "already English" always means what J0
 * will decide). A fixture window with NO run gets the proxies like any other.
 *
 * NEVER WRITES. `Store` has three read methods. The SQL below is SELECT-only and a test asserts it.
 * Ids, counts and timestamps only — no transcript text is selected, only its LENGTH.
 */
import { isNativeEnglish } from "@/lib/jev/english";

export type Candidate = {
  window_id: string;
  room_id: string;
  room_day_id: string;
  start_ms: number;
  end_ms: number;
  klass: "fixture" | "backlog";
  /** false → the room's own Transcript switch is off, so the job must carry switch_override. */
  room_transcript_on: boolean;
  /** true → a run exists and only English is missing (a re-drain); false → never transcribed. */
  has_run: boolean;
};

export type Summary = {
  fixture_windows: number;
  fixture_need_asr: number;
  fixture_need_english_only: number;
  fixture_skipped_native_english: number;
  fixture_skipped_proxy: number;
  backlog_remaining: number;
  backlog_in_transcript_off_rooms: number;
  excluded_closed_hours: number;
  excluded_no_speakers: number;
};

export type Store = {
  /** The next window to submit, or null when nothing is left. `exclude` = windows already tried this run. */
  next(exclude: ReadonlySet<string>): Promise<Candidate | null>;
  /** Counts only, for the dry run and the night_start log line. */
  summarize(): Promise<Summary>;
  /**
   * THE ENGLISH CANARY, asked after a job reports `done`. "missing" only when the window's newest run HAS text but no
   * `transcript_english` — the one outcome that means the job ran and did not do what this driver exists to do.
   * A window with no run at all (a silent window never reaches the engine) or a run with no text is "ok": there was
   * nothing to translate. Reads two LENGTHS, never text.
   */
  englishCheck(windowId: string): Promise<"ok" | "missing">;
};

export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export type StoreConfig = {
  /** room_day ids of the Jev fixtures. Passed in (env or flag), never written into source. */
  fixtureRoomDays: readonly string[];
  /** A window whose room_window jobs have failed this many times is skipped for good. */
  maxFailedJobs: number;
};

/** Window start hour in IST, 0-23. Closed hours = 21:00-06:59 (the ledger's "21:00-07:00"). */
export const isClosedHourIst = (hourIst: number): boolean => hourIst >= 21 || hourIst < 7;

type FixtureRow = {
  id: string; room_id: string; room_day_id: string; start_ms: string | number; end_ms: string | number;
  transcript_enabled: boolean; run_id: string | null; orig_len: string | number | null; eng_len: string | number | null;
  metrics_json: unknown; hour_ist: string | number; no_speakers: boolean;
};

const num = (v: unknown): number => Number(v);

/** PURE — the decision for one fixture window. */
export function fixtureVerdict(r: FixtureRow): "asr" | "english_only" | "skip_native_english" | "skip_proxy" | "skip_nothing_to_translate" {
  if (!r.run_id) {
    // Never transcribed: only if it is not clearly empty by the label-free proxies.
    return isClosedHourIst(num(r.hour_ist)) || r.no_speakers ? "skip_proxy" : "asr";
  }
  const orig = num(r.orig_len ?? 0);
  const eng = num(r.eng_len ?? 0);
  if (eng > 0) return "skip_nothing_to_translate";       // English already there
  if (orig === 0) return "skip_nothing_to_translate";    // a run with no text has nothing to translate
  return isNativeEnglish(r.metrics_json as never) ? "skip_native_english" : "english_only";
}

export function makeStore(sql: SqlTag, cfg: StoreConfig): Store {
  const fixtures = [...cfg.fixtureRoomDays];
  // Set once a scan of the fixtures finds nothing left to do. `exclude` only ever grows within a run and a fixture
  // window's need is decided by what is already in the database, so a scan that came up empty stays empty: the
  // ~100-row lateral join is not re-run on every later call.
  let fixturesExhausted = fixtures.length === 0;

  /** Every fixture window that could need work, oldest first. ~100 rows; no text, only lengths. */
  async function fixtureRows(): Promise<FixtureRow[]> {
    if (fixtures.length === 0) return [];
    return (await sql`
      SELECT w.id, s.room_id, w.room_day_id, w.start_ms, w.end_ms, r.transcript_enabled,
             t.id AS run_id, length(coalesce(t.transcript_original, '')) AS orig_len,
             length(coalesce(t.transcript_english, '')) AS eng_len, t.metrics_json,
             extract(hour FROM (to_timestamp(w.start_ms / 1000.0) AT TIME ZONE 'Asia/Kolkata'))::int AS hour_ist,
             EXISTS (SELECT 1 FROM room_diarize_window d WHERE d.window_id = w.id AND d.state = 'no_speakers') AS no_speakers
        FROM bench_window w
        JOIN bench_session s ON s.id = w.session_id
        JOIN room r ON r.id = s.room_id
        LEFT JOIN LATERAL (
          SELECT id, transcript_original, transcript_english, metrics_json
            FROM transcription_run
           WHERE subject_type = 'bench_window' AND subject_id = w.id
           ORDER BY created_at DESC LIMIT 1
        ) t ON TRUE
       WHERE w.room_day_id = ANY(${fixtures}::text[])
         AND w.state IN ('closed', 'transcribed')
         AND w.grid_aligned = TRUE
         AND NOT EXISTS (
               SELECT 1 FROM scribe_job j
                WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id AND j.status IN ('queued', 'running'))
         AND (SELECT count(*) FROM scribe_job j
               WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id AND j.status = 'failed') < ${cfg.maxFailedJobs}
       ORDER BY w.end_ms ASC, w.id ASC
    `) as FixtureRow[];
  }

  return {
    async next(exclude) {
      const skip = [...exclude];

      // 1. FIXTURES FIRST.
      if (!fixturesExhausted) {
        for (const r of await fixtureRows()) {
          if (exclude.has(r.id)) continue;
          const v = fixtureVerdict(r);
          if (v === "asr" || v === "english_only") {
            return {
              window_id: r.id, room_id: r.room_id, room_day_id: r.room_day_id,
              start_ms: num(r.start_ms), end_ms: num(r.end_ms), klass: "fixture",
              room_transcript_on: Boolean(r.transcript_enabled), has_run: v === "english_only",
            };
          }
        }
        fixturesExhausted = true;
      }

      // 2. THE BACKLOG. Never transcribed, oldest first, minus the two label-free proxies. NO filter on the
      //    room's Transcript switch (V's ruling) — `transcript_enabled` is selected, not tested.
      const rows = (await sql`
        SELECT w.id, s.room_id, w.room_day_id, w.start_ms, w.end_ms, r.transcript_enabled
          FROM bench_window w
          JOIN bench_session s ON s.id = w.session_id
          JOIN room r ON r.id = s.room_id
         WHERE w.state IN ('closed', 'transcribed')
           AND w.grid_aligned = TRUE
           AND w.room_day_id IS NOT NULL
           AND w.room_day_id <> ALL(${fixtures}::text[])
           AND NOT EXISTS (SELECT 1 FROM transcription_run t WHERE t.subject_type = 'bench_window' AND t.subject_id = w.id)
           AND NOT (extract(hour FROM (to_timestamp(w.start_ms / 1000.0) AT TIME ZONE 'Asia/Kolkata')) >= 21
                    OR extract(hour FROM (to_timestamp(w.start_ms / 1000.0) AT TIME ZONE 'Asia/Kolkata')) < 7)
           AND NOT EXISTS (SELECT 1 FROM room_diarize_window d WHERE d.window_id = w.id AND d.state = 'no_speakers')
           AND NOT EXISTS (
                 SELECT 1 FROM scribe_job j
                  WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id AND j.status IN ('queued', 'running'))
           AND (SELECT count(*) FROM scribe_job j
                 WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id AND j.status = 'failed') < ${cfg.maxFailedJobs}
           AND w.id <> ALL(${skip}::text[])
         ORDER BY w.end_ms ASC, w.id ASC
         LIMIT 1
      `) as Array<{ id: string; room_id: string; room_day_id: string; start_ms: string | number; end_ms: string | number; transcript_enabled: boolean }>;
      const b = rows[0];
      if (!b) return null;
      return {
        window_id: b.id, room_id: b.room_id, room_day_id: b.room_day_id,
        start_ms: num(b.start_ms), end_ms: num(b.end_ms), klass: "backlog",
        room_transcript_on: Boolean(b.transcript_enabled), has_run: false,
      };
    },

    async englishCheck(windowId) {
      const rows = (await sql`
        SELECT length(coalesce(transcript_original, '')) AS orig_len, length(coalesce(transcript_english, '')) AS eng_len
          FROM transcription_run
         WHERE subject_type = 'bench_window' AND subject_id = ${windowId}
         ORDER BY created_at DESC LIMIT 1
      `) as Array<{ orig_len: string | number; eng_len: string | number }>;
      const r = rows[0];
      if (!r) return "ok";
      return num(r.orig_len) > 0 && num(r.eng_len) === 0 ? "missing" : "ok";
    },

    async summarize() {
      const fx = await fixtureRows();
      const tally = { asr: 0, english_only: 0, skip_native_english: 0, skip_proxy: 0, skip_nothing_to_translate: 0 };
      for (const r of fx) tally[fixtureVerdict(r)] += 1;

      const [c] = (await sql`
        SELECT
          count(*) AS remaining,
          count(*) FILTER (WHERE NOT r.transcript_enabled) AS in_off_rooms
          FROM bench_window w
          JOIN bench_session s ON s.id = w.session_id
          JOIN room r ON r.id = s.room_id
         WHERE w.state IN ('closed', 'transcribed') AND w.grid_aligned = TRUE AND w.room_day_id IS NOT NULL
           AND w.room_day_id <> ALL(${fixtures}::text[])
           AND NOT EXISTS (SELECT 1 FROM transcription_run t WHERE t.subject_type = 'bench_window' AND t.subject_id = w.id)
           AND NOT (extract(hour FROM (to_timestamp(w.start_ms / 1000.0) AT TIME ZONE 'Asia/Kolkata')) >= 21
                    OR extract(hour FROM (to_timestamp(w.start_ms / 1000.0) AT TIME ZONE 'Asia/Kolkata')) < 7)
           AND NOT EXISTS (SELECT 1 FROM room_diarize_window d WHERE d.window_id = w.id AND d.state = 'no_speakers')
           AND NOT EXISTS (
                 SELECT 1 FROM scribe_job j
                  WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id AND j.status IN ('queued', 'running'))
           AND (SELECT count(*) FROM scribe_job j
                 WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id AND j.status = 'failed') < ${cfg.maxFailedJobs}
      `) as Array<{ remaining: string | number; in_off_rooms: string | number }>;

      const [x] = (await sql`
        SELECT
          count(*) FILTER (WHERE extract(hour FROM (to_timestamp(w.start_ms / 1000.0) AT TIME ZONE 'Asia/Kolkata')) >= 21
                              OR extract(hour FROM (to_timestamp(w.start_ms / 1000.0) AT TIME ZONE 'Asia/Kolkata')) < 7) AS closed_hours,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM room_diarize_window d WHERE d.window_id = w.id AND d.state = 'no_speakers')) AS no_speakers
          FROM bench_window w
         WHERE w.state IN ('closed', 'transcribed') AND w.grid_aligned = TRUE AND w.room_day_id IS NOT NULL
           AND w.room_day_id <> ALL(${fixtures}::text[])
           AND NOT EXISTS (SELECT 1 FROM transcription_run t WHERE t.subject_type = 'bench_window' AND t.subject_id = w.id)
      `) as Array<{ closed_hours: string | number; no_speakers: string | number }>;

      return {
        fixture_windows: fx.length,
        fixture_need_asr: tally.asr,
        fixture_need_english_only: tally.english_only,
        fixture_skipped_native_english: tally.skip_native_english,
        fixture_skipped_proxy: tally.skip_proxy,
        backlog_remaining: num(c?.remaining ?? 0),
        backlog_in_transcript_off_rooms: num(c?.in_off_rooms ?? 0),
        excluded_closed_hours: num(x?.closed_hours ?? 0),
        excluded_no_speakers: num(x?.no_speakers ?? 0),
      };
    },
  };
}
