# Refute — Slice J0 (jev-english) @ b995c5f — evidence (counts, ids, timings only; no transcript text)

Method: read the diff from git objects (merge-base 341b65c); own detached worktree for the test run (removed);
live DB via Neon HTTP (connection string never printed); probes are synthetic text only.
Mini: STOP_sustained_pressure held me for ~2 min; ran only CPU-light work afterwards (WARN_tightening, free 20-27%).
No Docker container was started, so migration idempotency is by statement-level reading, NOT executed.

## 1. Migration 0105
- Scanned 57 refs (heads + remotes) by filename AND by `VALUES (104|105|106,` inside migration SQL.
  0105 -> only heads/vinay/jev-j0-english. 0104 -> only heads/vinay/phrase-loop-guard (0104_room_turn_repeat_run).
- Live schema_migrations: versions 100,101,102,104 (0104_room_turn_repeat_run applied 2026-09-19 04:09Z). 105 free. 103 absent (watchdog, unrelated).
- Idempotent by reading: CREATE TABLE IF NOT EXISTS; CREATE INDEX IF NOT EXISTS; COMMENT ON x4 (re-runnable);
  INSERT INTO schema_migrations ... ON CONFLICT DO NOTHING against live PRIMARY KEY (version). FK target bench_window PK(id) exists live.
- Stale comment: "Rolls forward from the current head (0103)" (live head is 104).

## 2. Columns vs live DB (information_schema)
bench_window.id text NOT NULL (PK); room_day_id text NULL; state text NOT NULL; start_ms bigint.
transcription_run: transcript_english/transcript_original/detected_language/error text NULL; metrics_json jsonb NOT NULL;
created_at timestamptz; subject_type/subject_id text NOT NULL. jev_window_text does not exist yet (to_regclass null).
All match what the code assumes. Neon-driver hazards (Date objects, unsafe, transactions): none used; jsonb arrives as object.

## 3. Three-way rule (lib/jev/english.ts:51-69)
Strict conjunction: full_window_language.trim().toLowerCase()==="english" AND sarvam_language.trim().toLowerCase().startsWith("en")
AND language_mix present, non-empty, every key in {en,und}. Any leg missing/NULL/non-string => false => translate
(or source='empty' when flag off / no original). Not 2-of-3, not OR. Live data: full_window_language is 'english' on 62/62 bench runs
(incl. sarvam kn/hi), so leg 1 is vacuous; sarvam_language NULL on 13/62; language_mix present on 47/62; all 86 mix values numeric.
Latent: languageMix() (line 41) drops non-numeric values, so {en:2,hi:"x"} reads as English.

## 4. Terminal states
- Live: bench_window by state (windows / with NO transcription run): closed 2265/2263, open 270/270, transcribed 60/0, silent 30/30, failed 8/8.
  Bench runs total 62, 0 errors, 0 shadow, 0 windows with >1 run.
- P1 (probe): window with no run -> row {source:'empty', char_count:0, model:null}; job's bench_window SELECT never reads state
  (jev-english.ts:106). Rerun without force skips it (:109-112). Test jev-english.test.ts:189-195 asserts this as intended.
- P2 (probe): qwen throws -> job result done {empty:1}; row {source:'empty', model:null, latency_ms:null}. translate.ts:59-62 bare catch;
  ctx.signal abort/timeout swallowed the same way. No test drives a qwen throw.
- P3 (probe): original 9500 chars -> prompt 8025 chars; row source='translated' (translate.ts:54 slice(0,8000)). Live: 14 of 62 runs > 8000 chars.
- latestRun (jev-english.ts:50-56) = newest run of any kind; E31 C6/C7 keeps failed attempts and route windows write shadow rows.
  0 occurrences live today.
- Flag unset => every non-English window 'empty' and skipped forever without force (spec §3A mandates it; conflates not-tried with tried).

## 5. Tests (own worktree @ b995c5f)
`npx vitest run tests/unit/jev-english.test.ts tests/unit/tier2-jobs.test.ts` -> 2 files, 60 passed / 0 failed (23 + 37).
Probe file (fails on purpose, 3 assertions): scratchpad/zz-refute-jev.test.ts.txt.
