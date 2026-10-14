# 2026-09-26-fullday-rescore — W28.2 re-score harness, ready before CLARITY lands

**What:** the harness that re-scores encounter detection on a FULL clinic day against the PQM queue
truth with the first 23 Sep metric UNCHANGED — found (recall) / precision / splits / merges /
start-end error — with the transcript version NAMED ON THE COMMAND LINE, so the same command re-runs
the day CLARITY's first improvement lands. Built on order W28.2; NOT run on any new data.

**Files**
- `fullday_score.py` — the scorer. The matching rule is not reimplemented: it imports the 23 Sep
  study's `studies/2026-09-23-e7-pqm-truth/e7_score.py` pure functions verbatim (`load_truth`,
  `overlap_frac`, `score_room_day`, `median_p90`), so the metric cannot drift from the first score.
  CLI:

      python3 fullday_score.py --truth out-<date>/e7-truth-<date>.csv \
          --hyp out-<date>/hyp-fused.json [--hyp out-<date>/hyp-arm-d.json ...] \
          --transcript "<name>" [--allow-undeclared] [--date <YYYY-MM-DD>] [--out md] [--json json]

  - `--transcript` is REQUIRED, verbatim in the card and JSON. Every hyp file must ACCOUNT for it
    (refuter-2 B1, fixed): a file whose declared `transcript_version` differs fails rc=3; a file
    with no `transcript_version` (pre-26 Sep artifacts) is also refused unless `--allow-undeclared`
    is given, and then the arm's version line says UNDECLARED — the title's name is the RUN's
    provenance, never claimed to be the file's.
  - Errors are in MINUTES (1 dp) with the identical-seconds value in parentheses (the 23 Sep cards
    printed seconds; both are shown so any old card checks digit for digit).
  - Consults keyed to no replayed (room, date) are counted in the report ("outside the replayed
    room-days"), never silently added to totals — same rule as e7_score.py, made visible.
- `fullday-rescore.sh` — the one-command driver (+ `fullday_lib.sh`). Wraps
  `studies/2026-09-24-e7-fullday/e7-rescore.sh` UNCHANGED for the pipeline (rooms / pqm / truth /
  replay — credentials, `81cec3a` pin, Jev cost tracking, lock stay its stages) and replaces only
  the score stage:

      fullday-rescore.sh 2026-09-30 --transcript "CLARITY-v1 first land"
      fullday-rescore.sh 2026-09-23 --transcript "route-v2 23sep" --allow-undeclared \
          --from replay --to replay

  - `--from/--to` pass through to e7-rescore.sh, and only REAL stage names are validated
    (refuter-2 B3, fixed: the old script rejected the flag tokens themselves, rc=2 on every slice).
  - Only hyp-*.json written by THIS run are scored: `--select-only` prints the exact selection
    (mtime after the run's start marker in /tmp); an out-<date>/ holding arms from different runs
    never labels a stale arm with a new version (refuter-2 B2, fixed).
  - `--plan` prints the exact command lines and runs nothing (offline test path).
- `selftest.sh` — the refuter-2 fix tests, rerunnable offline (no DB, no Mini, /tmp files only):
  metric identity (T0), the version gate (T1-T3), the fresh-file selection (T4-T5), the
  `--from/--to` parse (T5-T6), and the wiring trace + field references (T7-T8). All 10 pass.
- `E7-SCORE-REPRO-23SEP.{md,json}` — the ordered reproduction test (the ONLY scored data): the
  first 23 Sep fused score reproduced exactly. `E7-SCORE-ARM-D-24SEP-example.{md,json}` — a second
  in-sample check on existing 24 Sep outputs; every number equals SCORE-24SEP.md's arm-d row.
- `fullday_score.py --help` prints the full contract.

**Version wiring (built, refuter-2 B1):** `e7-rescore.sh` accepts `--transcript <name>` and exports
`E7_TRANSCRIPT_VERSION` into the replay child only; `stage_db.ts` records it in every hyp-*.json it
writes (null when the flag is absent — no behavior change without the flag) and `arm_d.py` does the
same for hyp-arm-d.json. The wiring is verified offline (selftest T7 parses + exports the var before
preflight stops; stage_db.ts loads under the e61 vite-node). The fully end-to-end proof (a real
replay writing a record with the field, then the scorer accepting that file as declared) needs a
real Jev-sampled replay run — Fable's go on that; the scorer does not depend on it: undeclared
files are simply refused unless --allow-undeclared.

**Transcript-version reality (checked 26 Sep, SELECT-only):** the warehouse has no transcript
version column. `transcription_run` carries per-row engine (`route` 1437, `whisper` 36, `sarvam` 15)
and the shadow's evidence load takes the LATEST run per window (`shadow-io.ts` DISTINCT ON
created_at DESC), so "which transcript version" = which engines wrote and when. When CLARITY's first
improvement lands, the version name on the command line is what THIS harness records — the pipeline
stage that must change (if E-5 chooses runs by version) is stage_data (shadow-io), not the scorer;
scoring logic needs none.

**What was deliberately NOT done**
- No run on any data beyond the two named reproduction tests (23 Sep + 24 Sep artifacts already on
  disk). No DB read/write beyond the SELECT checks named in REPRO; no Metabase, no R2 audio, no
  Jev call, no Mini.
- No change to the 23 Sep scoring metric, `e7-rescore.sh` stage semantics, or the E-6.1 pin.
- Not merged to main: eta-refuter-2 reviews this branch first (order W28.2).

**Reproduction (exact)**
- 23 Sep first score, `hyp-fused.json` (7 hyps, 9 room-days incl. 6 energy-gap) vs
  `e7-truth-23sep.csv` (14 consults, 3 rooms): **found 3/14, precision 3/7** — the order's numbers —
  splits 0, merges 0, start error median 175.2 s / p90 369.6 (2.9 / 6.2 min), end error
  327.6 / 356.8 (5.5 / 5.9); per-room rows equal the 23 Sep cards.
- 24 Sep, `hyp-arm-d.json` vs the 24 Sep truth: found 18/23 (78.3%), precision 19/44 (43.2%),
  splits 2, merges 2, start 157.5 / 528.0 s, end 143.5 / 796.0 s — every value equals the
  `SCORE-24SEP.md` arm-d row.
- Version gate: a hyp file declaring `transcript_version: wrong-name` under `--transcript
  "route-v2 23sep home"` fails rc=3 (test run recorded, not committed — trivially reproducible).
