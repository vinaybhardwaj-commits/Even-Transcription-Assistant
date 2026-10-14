# STT-STACK-PARITY set 2 (c0947aa), eta-refuter-2

**The FAIL (B5 by count) is CONFIRMED.** The numbers reproduce exactly. Two corrections to the report's reading are below.

## Reproduced from results/*.json (first runs only; repeats are never in the bar, per the pre-registration)
| bar | set 2 | set 1 |
|---|---|---|
| rows | 20 windows, 1 run each, 20/20 audio sha match, 0 errors | 18 windows (+2 repeat rows excluded) |
| B1 | median 0.854, min 0.501, 0 below 0.50 (n=16 non-silent) PASS | 0.792 / 0.491 FAIL |
| B2 | 18/20 = 90.0% PASS, exactly on the line | 13/18 = 72% FAIL |
| B3 | engine median 0.960, language median 0.960 | 0.851 |
| B4 | 4/4 empty, same status PASS | 4/4 |
| B5 | median abs diff 0.014; **2 windows** below stored-0.15 (max 1) **FAIL** | 0 |

## Process checks
- The pre-registration (bc1894f 12:49) predates set 1. The addendum (47a24e1 13:53) predates set 2 and leaves the bar unchanged.
- The 3-gram function was committed only in c0947aa, but set 1's results already carry `ngram_*` fields. That is commit lag, not a post-hoc metric.
- Twin router running file: this box, pid 1704, `router_server.py` sha256 400710ee (matches the report). The process started 12:19, after the file mtime 11:49, so running == file.

## Correction 1: B3 is labelled "engine+language" but the harness never computes the joint
`span_match` returns engine and language agreement separately, and the report quotes the engine median as the combined value. Per window, joint >= engine + language - 1. With both medians at 0.960 the PASS holds, but the label is wrong.

## Correction 2: the noise-floor rule is applied off-protocol
- The pre-registration: twin-vs-twin repeats of **4** windows; if the **median** is < 0.90, label the verdict "within noise".
- The report has **2** such windows (0.875, 0.962), **median 0.918, which is >= 0.90**. By the written rule, set 2 is a **clean FAIL**. It is not "FAIL within noise".
- The report instead applies the rule per window ("met in one of the two").
- The set-2 repeats (x0cfel, h4953y) were chosen BECAUSE they failed. They are useful exploratory evidence that whisper flips language between runs, but they are selected by the outcome and cannot stand in for the floor.

## Also
- B2 passes at exactly 90%. Given the observed run-to-run language flips, one flip turns B2 into a FAIL. B2's PASS is itself within noise.
- The one stable English window at about 0.5 (CUDA vs Metal) is systematic, not noise. It needs its own look before HIST relies on twin text for English.

## Recommendation for Fable's decision
The claim "the residual is whisper non-determinism" is **plausible but not established**. A decisive, cheap test:
- Run the twin 3 times on a RANDOM (not failure-selected) sample of at least 8 set-2 windows.
- Report the twin-vs-twin median similarity, and B2/B5 per run.
- If twin-vs-twin spread is about the twin-vs-stored gap, "parity within noise" is supported. If the twin is self-consistent (>= 0.90) while it disagrees with stored, the gap is systematic (CUDA vs Metal) and HIST text is not production text.
