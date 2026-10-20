# ft-engines-ref1 REFUTE @ d296961 — PASS-WITH-FIXES (Opus 5.5)
Scope: newcat-orch override, read-only checks on real D outputs, counts and ids only. No network, Clef or GPU calls. There is no ft-engines-R*.md round file; items come from .bc/brief.txt plus the scope override.
Checker: /tmp/ref1/t/check.py (independent reimplementation, 34 checks). Mutants: /tmp/ref1/t/mk.py, run by /tmp/ref1/t/runm.sh (copies under /tmp/ref1/mut). Source untouched (git status clean apart from .bc).

## Tests (rerun from clean state into /tmp/ref1/{work,out}; work files symlinked, so assembled.pkl went to /tmp)
- roles_A.py rebuild: winA_role.jsonl matches byte for byte; calls_roles.parquet equal (933x17).
- assemble.py + cov.py rebuild: all 5 parquets equal to published (369x365, 211x114, 2611x1028, 507x1027, 933x24); guard tsv identical; COVERAGE.md identical apart from the timestamp line.
- check.py on published outputs: 34/34 PASS. Two first-run FAILs were defects in my own tests: talk share uses a top-2 denominator, and a GCP-vs-the lab box tolerance was too strict. Fixed and rerun.

## Items
| # | item | verdict | evidence |
|---|---|---|---|
| a1 | elig_tT == ft-rl-feat rule (rlf_assemble.py:44-53) | PASS | own reimpl == percall elig_t3/7/14 (n=445/632/782); 0 eligible calls with day>=T, post-event or outcome_revealed |
| a2 | every engine aggregate uses only elig calls | PASS | recomputed n_calls, ody/e2v patient, e2v counsellor negative, wavlm all, clef patient/all at t3/t7/t14 for all 369 eps: 8856/8856 cells match |
| a3 | no outcome-stating Clef field | PASS | raw Clef keys = valence/arousal_ev/anxious/engaged/one_speaker/valence_p1-5 + bookkeeping; no outcome-like output column |
| a4 | labels only as masks | PASS (note) | only h14,h90,ale,days_to_surgery,age_days,split; documented in DONE.md, but they sit in the feature parquet |
| b1 | no H episode in any output | PASS | 0 H in all 5 parquets; 0 H 16-hex ids in md/tsv |
| b2 | seal_check.py | PASS | FILES_WITH_H {}; TOTAL {'D':556,'not_a_linked_consult':124} |
| b3 | consults_split_guard.tsv | PASS (note) | 211 rows = feats; D 174; 37 not_a_linked_consult with labels split D (37 eps) |
| c1 | A window keys join across engines | PASS | ody/e2v/wavlm 9823/9823 |
| c2 | winA_role roles vs calls_roles | PASS | 9424 role windows, 0 talk-share mismatches; role_src percall == calls_roles |
| c3 | B GCP vs the lab box rows | PASS | the lab box rows are a subset of GCP (wavlm 1259, e2v 1177); one model_rev; argmax agreement .998/.999; max abs diff .013/.035; GCP priority recomputed: 0/422 mismatches |
| c4 | B window joins | PASS (note) | 9885/9923 ok; 38 status=error windows are not counted as "failed" in COVERAGE |
| c5 | emb rows == n_win | PASS | A 2611 rows = cells with wavlm n_win>0, 0 n_win mismatches, 1024-d; B 507 rows, 0 mismatches |
| d | COVERAGE reproduces | PASS | regenerated output identical; independent T=3/7/14 h14 cells (297/25/201, 287/15/240, 272/0/261), role_src counts, 9823 windows / 911 calls |
| e | defaults / upstream unchanged | PASS | rl/feat last written 02:51 (ft-rl-feat lane), before the ft-engines smoke run at 04:24; lane code only reads it; outputs 0600 |
| f | DONE.md claims | PASS | n_calls>0 255/306/344; 76 B rows with NaN episode; 11 untagged calls; Clef spend US$0.516 (sum of cost_usd US$0.5159) |

## Mutants (copies of assemble.py writing only to /tmp): 12/12 killed
M01 drop ~outcome_revealed (7 checks fail) · M02 drop ~post_event, run with event_date shifted -30 d (4) · M03 in_t14 for every T (5) · M04 drop tagged requirement (4) · M05 Clef over all episode calls (1) · M06 swap patient/counsellor (2) · M07 e2v negative adds sad (1) · M08 inject H episode into B and drop the assert (1) · M09 embeddings not filtered by T (1) · M10 window key rounded to 1 dp (4) · M11 the lab box rows win over GCP (1) · M12 old who_old roles (1).
Control M00 (shifted labels, no mutation): elig and values PASS; only the stale-COVERAGE cells fail, as expected.
Equivalent on real data, so dropped as mutants: STT filter (933/933 ok) and B split filter (expansion base is 137/137 D). post_event is 0 on real data (manifest pre-filtered), which is why M02 needed shifted labels.

## Issues (none blocking)
1. 37 Ale-extension consults have no link to split_guard and are cleared on labels split only. A patient-cluster overlap with H cannot be ruled out for them. Fix: guard by patient_key via another link, or drop them before the freeze.
2. Label columns live in engine_feats_calls.parquet. Consumers must drop h14/h90/ale/days_to_surgery/age_days from X. Safer: move them to a sidecar file.
3. nemo all_speech_share > 1 on 244/933 calls (max 1.27), because overlapping segments are double-counted. Fix: rename it or clip it to 1.
4. COVERAGE set B reports 0 failed, but 38 B windows have status=error. Fix: report window-level failures.
