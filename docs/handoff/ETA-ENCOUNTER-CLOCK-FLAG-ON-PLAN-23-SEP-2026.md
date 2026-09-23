# ETA — ENCOUNTER_CLOCK flag-on plan — 23 Sep 2026

Written by split-speaker at Fable's request, 23 Sep. Covers `vinay/encounter-clock` @ `c19ece8`
(E-1 probe scheduler + extract contract, E-2 gate, E-4 hysteresis smoother; flag off, no caller).

## What must be true first

1. **`c19ece8` is on `vinay/s1-auto-drain`.** Tonight the defective bridging (`2203873`) is on that
   branch and the fix isn't. Verify by ancestry, not by the commit existing.
2. **There is a caller.** Nothing reads the flag today; the modules are pure with no route, job or
   migration. Flag-on with no consumer changes nothing — the real gate is E-5's hypothesis store
   (migration 114) plus whatever job builds probes and writes rows.
3. **First run is shadow only.** Encounters get written to their own table and read by nobody: no
   note, no UI, no billing, no clinician-facing text. Nothing downstream consumes them until V's
   labelled day has been scored against them.
4. **The constants are unvalidated.** Enter 2, exit 3, merge 3 min, bridge 3 min, 0.15 unique
   chars/s, 0.05 active frames — all provisional, none checked against a label. V's session is the
   first real measurement.
5. **Accept the known limitation in writing:** the clock finds *talking*, not *visits*. A 90-minute
   block of continuous speech is one encounter, because back-to-back consults never produce the
   silence that closes one. Splitting them needs speaker identity (E-3). Whatever consumes an
   encounter must not call it a consultation.
6. **Not blockers, but say them out loud:** the energy half is inert (the level log began at 19:53 on
   22 Sep and every peak sits above the floor), and 56–71% of probes come back unjudged for want of a
   placeable transcript. Both are honest outputs, not failures — but if anyone expects encounter
   coverage of a working day, they will be surprised.

## What we watch in the first hour

| Signal | Expected | Act if |
|---|---|---|
| Encounters per room-day | 4–9 | 0 on a day with transcripts, or >15 |
| Longest encounter | ≤ 90 min | any > 2 h — the bridging rule has a hole |
| Median duration | 8–29 min | median > 60 min |
| Unjudged fraction | 55–75% | > 85% — transcripts broke upstream |
| `closed_by` mix | mostly `non_speech` / `unjudged_gap` | all one kind |
| Contract checksums | 0 mismatches | any mismatch |
| Mini load and memory | well under tonight's OOM | approaching it — each chunk is fetched by ~3 probes; a per-day chunk cache belongs in the caller |
| Log contents | ids, times, counts | any transcript text or presigned URL |

## Rollback

- **Primary:** unset `ENCOUNTER_CLOCK`. It's read through the shared flag parser at call time, and
  nothing else reaches the modules, so off means inert. No revert, no migration.
- **Data:** shadow rows live in their own table and touch no production table. Rollback is stop
  writing, then delete that run's rows by run id.
- **Bad constant:** exported and overridable — change and redeploy, no schema change.
- **Hard:** revert the merge. At `c19ece8` the branch is additive — seven TypeScript files, no
  routes, no migrations — so a revert is clean.

**Roll back within the hour if:** any encounter exceeds 2 hours, unjudged passes 90%, any checksum
mismatch appears, the Mini approaches last night's memory ceiling, or any patient text reaches a log.
