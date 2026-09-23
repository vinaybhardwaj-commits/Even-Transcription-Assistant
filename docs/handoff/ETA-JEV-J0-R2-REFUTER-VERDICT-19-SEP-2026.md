# Re-refute — Slice J0 fix @ 3729dd8 (diff b995c5f..3729dd8) — evidence (counts/ids/timings only)

Method: diff read from git; own detached worktree (removed); probes on a THROWAWAY local postgres:16 container with the
REAL db/migrations/0105 DDL and the branch's REAL kind/translate code; live DB read-only via Neon HTTP (no writes, no job run).
Probe file: scratch/zz-refute-j0r2.test.ts.txt. Builder's report point 9 was not on disk; I checked the assumptions the brief lists
plus every SQL string extracted from the diff.

GATE DISCLOSURE: at the start of the probe command the last verdict read STOP_heavy_swap_now (diarize_ms 10). My check printed the
verdict but was not wired to block the run, so one ~15 s Docker postgres ran during STOP. Container removed (0 left). Earlier check
(~20 s before) was ok; 90 s after it was WARN_spike. No other heavy step was run after that.

## P1 / P2 / P3 (real Postgres)
P1 PASS  windows closed/open/failed/silent with no run -> source='not_ready', english NULL, error NULL, input_chars NULL, char_count 0.
         Re-run without force: not_ready:4, skipped:1 (only the terminal one). After a run appears for one window, a no-force re-run
         made it 'translated'. (Old test that pinned the defect is gone.)
P2 PASS  qwen Error -> failed/qwen_error; QwenError(timeout) -> failed/qwen_timeout; AbortError -> failed/qwen_abort;
         empty JSON output -> failed/empty_output. Job result counts failed:4 (not empty). No-force re-run retried all 4 -> translated,
         error column cleared to NULL. Job status is still 'done' when every window failed.
P3 PASS* originals 9,500/20,000/20,001/25,000/60,000 -> prompts sent 9,525 / 20,025 / 20,025 / 20,025 / 20,025 (25-char prefix):
         9,500 sent in full; >20,000 clipped at 20,000. input_chars = true length on every row. *No cap/clipped column: the row only
         shows the clip if the reader knows the 20,000 constant.
         Live (now): 83 bench runs; 17 > 8,000; 0 > 20,000; max 15,194.

## Three states readable from a row
not_ready (english NULL, error NULL) / empty (english NULL, error NULL) / failed (english NULL, error NOT NULL) — distinct by `source`.
Fourth way to a terminal 'empty' EXISTS (probe E, real PG): jev-english.ts:172-174 (translate step) and :125,142-145 (classify) use
latestRun = newest run of ANY kind. A newer run with NULL text between classify and translate -> 'empty' for a window classify saw text in;
a run that vanishes -> 'empty'. Live prevalence: 83 windows with runs, 0 with >1 run, 0 error rows, 0 shadow rows -> latent.

## Schema (live, information_schema)
bench_window: id text NOT NULL (PK), room_day_id text NULL, start_ms bigint NOT NULL.
transcription_run: transcript_english/transcript_original/detected_language text NULL; metrics_json jsonb NOT NULL (default);
subject_id text NOT NULL; subject_type text NOT NULL (default); created_at timestamptz NOT NULL (default).
10 live columns checked, 0 wrong. jev_window_text does not exist live (0105 not applied): its 10 columns
(window_id, room_day_id, english, source, char_count, model, error, input_chars, latency_ms, created_at) were checked by executing the
real DDL and running the branch's real upsert + selects with untyped-string parameters: 0 wrong. FK target bench_window PK(id) exists.

## Migration 0105
Unique: 58 refs scanned by filename and by `VALUES (103..109,` -> 0105 only on heads/vinay/jev-j0-english (and that branch's own worktree).
Live schema_migrations now: 100,101,102,103 (applied 2026-09-19 07:42:13Z),104. 105 free. 0104 exists only on vinay/phrase-loop-guard.
CHECK: admits run_english, native_en, translated, empty, not_ready, failed; the code writes exactly those six (JevSource union, english.ts:71-83);
real PG accepted all six and refused 'bogus'. Idempotent: applied twice with no error (CREATE ... IF NOT EXISTS, COMMENT ON, INSERT ... ON CONFLICT DO NOTHING).

## Findings (all non-blocking)
1 fourth path to terminal 'empty' (above). 2 terminal rows are never re-evaluated when the window's run is regenerated (jev-english.ts:116);
  17 of 83 live runs have empty text — the VAD-starvation population — and would become terminal 'empty', which the migration calls
  "genuinely empty". 3 job ends 'done' with failed:N (:158,:188). 4 clip not self-describing; failed rows have no input_chars.
5 stale docs: jev-english.ts:13-16 says gated-off lands 'empty' (code writes not_ready); migration lists 3 failed codes, code writes 5,
  and real qwen.ts:112-113 maps an external abort to 'timeout', so qwen_abort is unreachable in production.
6 silent windows (40 live, no run) sit at not_ready forever; the job never reads bench_window.state.

## Tests
`npx vitest run tests/unit/jev-english.test.ts tests/unit/tier2-jobs.test.ts` -> 64 passed / 0 failed (27 + 37); typecheck and typecheck:tests clean.
