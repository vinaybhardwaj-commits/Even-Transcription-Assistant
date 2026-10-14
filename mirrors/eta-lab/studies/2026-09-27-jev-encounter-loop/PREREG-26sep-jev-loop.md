# Jev encounter-loop, 26 Sep score — pre-registration (written before looking at 26 Sep data)

Owner lx; checker eta-refuter-2; scorer `fullday_score.py` (studies/2026-09-26-fullday-rescore,
verbatim, unmodified) importing `e7_score.py` (studies/2026-09-23-e7-pqm-truth, verbatim,
unmodified — re-running its T0 selftest before this score is the only permitted check on it).
Truth: PQM `queue_token_steps`/`queue_tokens` (Metabase db 13, station='CONSULTATION'), the same
source and columns as `PQM-SOURCE.md`. 26 Sep is described by the order as "fully transcribed,
1,060 windows" — translation completeness for those windows is a named open item (README §D.1),
confirmed before this file's numbers are run for real, not assumed.

**Revision note:** eta-refuter-2 FAILed the first version of this file (#4464 on b13ede81): B1/B2
below fix a self-contradiction (26 Sep was named as both the tuning set and the exit-test set) and
an under-specified re-try rule; G1-G4 freeze four values this version originally left to a
not-yet-written constants file or an ambiguous rule. Development/tuning of every constant in
`jev_loop_constants.py` happens **only** against a room-day at or before 25 Sep — 26 Sep is never
loaded, read, or scored until the constants file is committed and frozen (README, "Development-vs-
exit-test day split").

## 0. Frozen scope (per eta-refuter-2 #4464 G3) — filled before any hyp file is written

- **Room list for the 26 Sep score:** *TBD — named by Fable/whoever confirms 26 Sep coverage
  (README §D open items 1/3/5); listed here by room id before `run_loop.py` is pointed at 26 Sep,
  not decided by "whichever rooms happen to produce output."*
- **Truth CSV:** built via `studies/2026-09-24-e7-fullday/build_truth.py`; filter (date = 2026-09-26,
  station='CONSULTATION', `cycle_bucket` values included/excluded) and the resulting file's
  sha256 are named here once built — *TBD, README §D open item 4*. The scorer refuses to run
  against an unnamed-sha truth file (same "frozen before looking" discipline as everything else in
  this section).
- Both blanks above are filled by editing this file in place (a visible diff, reviewed like any
  other change to a frozen document) before the first real `run_loop.py --date 2026-09-26` call —
  not filled in retroactively after a score exists.

## 1. Hypothesis source (single choice, frozen)

`hyp-jevloop.json`, written by `run_loop.py` per the harness shape (`README.md`, "Scoring harness"),
`transcript_version` naming the STT + translation batch actually read, plus the pinned
`jev-1.13.0` model id and the `jev_loop_constants.py` sha (eta-refuter-2 #4464 G4 — recorded so the
frozen score is reproducible even though prod may run floating `jev-latest`). One arm, no variants
scored selectively after the fact.

## 2. What is reported

Per room, per the harness's existing report shape: **found** (recall — hypothesis encounters
matching a PQM consult at overlap ≥ 50% of the shorter interval, `e7_score`'s existing rule,
unchanged), **precision** (matching hypothesis encounters / all hypothesis encounters), **splits /
merges** by multiplicity (existing rule), and **start/end error** in minutes (median + p90, seconds
in parentheses — existing units). Reported **side by side** with `hyp-acoustic.json` and
`hyp-fused.json` on the same room-days and truth file, not in isolation (open item: confirm those
baselines have 26 Sep room-days first, README §D.3). Counts, opaque ids (`rd_id`, `chunk_id`) and
timings only — no transcript text, no patient identity, in the report or its JSON.

**Back-to-back split (eta-refuter-2 #4633 — frozen here, before any 26 Sep data):** the jev-loop
arm's start/end error is additionally reported as **two groups**, not one aggregate: encounters
with `back_to_back_start`/`back_to_back_end` true (README's declared chunk-boundary bias) vs.
encounters with both flags false. The combined median/p90 required above is still reported for
comparability with the acoustic/fused baselines (which don't carry this distinction), but the
back-to-back group's error is never allowed to be silently absorbed into that single number without
also showing the split — it is a systematic bias on a known subset, not sampling noise, and hiding
it would understate the arm's true placement error on isolated consults.

## 3. Exit test (frozen threshold — the only pass/fail line in this file)

**80% of queue consults found, with both the matched start AND end within 2 minutes (120 s) of the
PQM `called_at`/`completed_at` pair**, counted only over consults where a matching hypothesis
encounter exists (the same shorter-interval-overlap match `e7_score` already computes — this adds
one more condition on top of an existing match, it does not redefine "found"). Denominator = all
PQM consults in the truth CSV for the scored date/rooms, same denominator the harness already
reports "found" against — a consult with no hypothesis encounter at all counts against the 80%, it
is not excluded.

**Split rule (eta-refuter-2 #4464 G2):** when one PQM consult is matched by more than one
hypothesis encounter (a split), the 2-minute condition is checked on the **same best-overlap pair**
`e7_score.py` already selects for its start/end error arrays (`score_room_day`: `best_hi, _ =
max(lst, key=lambda x: x[1])` — the matched hyp with the highest overlap fraction, unmodified). It
is NOT the first start / last end spanning the whole split group. One consult is judged by one
pair, the same pair whose seconds already feed the reported median/p90 error — no second matching
rule is invented for the exit test.

This is descriptive-and-pass/fail by design (unlike `PREREG-rate20.md`'s descriptive-only stance)
because the order names 80%/2min as an explicit exit test, not a metric to observe.

No other threshold is pre-registered. Precision, splits/merges, and the acoustic/fused comparison
are reported for context and are NOT gates — same "indicative, never silently a gate" posture the
board's S3 scorecard ruling took for a different metric (be3a5d1a), applied here because the order
does not name a second pass mark.

## 4. Refusals (the scorer must fail loud, not silently drop)

Same refusal discipline `fullday_score.py --transcript` already enforces (declared
`transcript_version` mismatching the run's name → rc=3; undeclared hyp file refused unless
`--allow-undeclared`), plus a hard `response.model != "jev-1.13.0"` refusal (G4), plus, specific to
this arm:

**PARTIAL COVERAGE threshold (eta-refuter-2 #4464 G1 — frozen here, not in a not-yet-written
constants file):** a room-day with **more than 20% of its chunks `translation_missing`** is
reported as **PARTIAL COVERAGE** for that room-day rather than silently scored as if fully
covered. 20% is a round number fixed now, before any 26 Sep coverage number is seen — it is not fit
to whatever 26 Sep's actual gap turns out to be. A PARTIAL COVERAGE room-day still counts fully in
the exit test's denominator (§3); the flag exists only so the 80% headline is never read as if
translation were complete when it wasn't.

## 5. What this run does NOT do — and the re-try rule (eta-refuter-2 #4464 B2)

No CAP consult→prescription cross-check (README §D.2 — CAP is not yet a stable, refuter-2-PASSed
artifact at time of writing). No threshold tuning against 26 Sep — every constant in
`jev_loop_constants.py` is fixed (developed and frozen against a day at or before 25 Sep, §0/README)
before `run_loop.py` is ever pointed at 26 Sep.

**The FIRST `hyp-jevloop.json` produced against 26 Sep under the frozen constants is the verdict of
record for this pre-registration — pass or fail.** If the 80% exit test fails, lx diagnoses the
cause (missing evidence / model error / code error / service failure, per the skill's "when an
answer is wrong" rubric) and may build a revised constants file, but that fix is confirmed **only
against a fresh day (27 Sep or later) — never by re-running 26 Sep and treating a better number as
the result.** A second 26 Sep run, if it is ever made, is reported as exploratory and clearly
labeled as such; it never replaces the first run's verdict of record. This closes the "repeated
tries on 26 Sep are test-set tuning" gap eta-refuter-2 flagged.
