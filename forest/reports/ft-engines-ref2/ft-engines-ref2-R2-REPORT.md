# ft-engines-ref2 ROUND 2 @ 15b31b3 (Opus 5.5, 20 Oct 06:50 IST). Verdict: PASS
Requested by cb-ft-engines over ubus. Same scope as round 1: read-only on real D outputs, counts and ids only, no network, Clef or GPU. The lane code was not modified (git status is clean). Mutants were run in /tmp/ftref2-mut and then deleted.
Scripts: work/check2.py (34 checks) and work/mutants2.py. The round 1 report is ft-engines-ref2-REPORT.md.

## Rerun from clean state (roles_A -> assemble -> cov, writing to /tmp/r3)
- winA_role.jsonl is byte-identical and calls_roles.parquet is equal. All 6 parquets are DataFrame-equal: calls 369x585, sidecar 369x7, percall 933x25, consults 211x114, emb calls 2032x1028, emb consults 507x1027. COVERAGE.md is identical apart from the timestamp, and split_guard.tsv is byte-identical.
- check2.py: **34/34 PASS**. seal_check: **FILES_WITH_H {}** (D 556, not_a_linked_consult 124).

## Fix items
| # | item | result | evidence |
|---|---|---|---|
| 1 | Role columns use only lexicon or lexicon_weak calls; `_lex2` twins use lexicon only; n_calls_roleok / rolelex2; emb masked the same way | PASS | A4: 558 cols x 369 eps = 205,902 cells recomputed, 0 mismatch. This covers ody, wavlm, e2v, clef and nemo-role, the _lex2 twins, and n_calls_roleok/rolelex2. Episodes with an ok call at T3/7/14: roleok 168/210/233, lex2 114/134/148 (of 255/306/344). C5: emb 2032 rows, n_win == masked wavlm n_win; C6: 25 means recomputed. `_all_` columns and turns_per_min still use every eligible call (assemble.py NEMO_ROLE) |
| 2 | No labels in engine_feats_calls; sidecar instead | PASS | R2: only `split` is left; R2b: sidecar h14/h90/days_to_surgery/age_days == labels.parquet, and ale follows the rule |
| 3 | all_speech_cover_share <= 1 | PASS | R3: recomputed as the union of the A_nemo segments for 933 calls, 0 mismatch, range [0, 0.987]; all_overlap_s >= 0; old all_speech_share is gone. Nit: DONE says "max 0.97", the actual max is 0.987 |
| 4 | COVERAGE set B lists failed windows | PASS | R4: ody/wavlm/e2v have 38 failed of 9923 windows in 2 consults, matching the recompute |
| 5 | 37 unlinked consults guarded via the labels cluster_key | PASS | R5: my own split_guard.set_of(cluster_key) gives D for 37/37; the tsv says `guard_via_labels_cluster=D` |
| - | Round 1 items (leakage, D/H, joins, set B, COVERAGE) | PASS | A0-A7, B1-B5, C1-C9 unchanged: elig 445/632/782, 0 differ; joins 9823/9823; set B 87 cols, 0 mismatch |

## Mutants: 14/14 killed (13 on copies of assemble.py, 1 on roles_A.py)
- Masking: ROLE_OK includes fallback; lex2 includes lexicon_weak; emb masking removed; nemo role columns unmasked; window mask dropped; patient/counsellor swap; turns_per_min wrongly masked.
- Leakage: outcome filter dropped; <=T; untagged calls kept; Clef over all episode calls.
- Other: labels back in the feature file; the lab box overrides GCP; cover share = sum instead of union (max 1.272).

## Open (not blocking)
- forest-lead must pick the main (lexicon + lexicon_weak) or the `_lex2` column family at the freeze.
- Set B wavlm/e2v GPU drift between the lab box and GCP (up to 3.7e-2) is unchanged and harmless, because GCP is used consistently.
- h14 at T14 has 0 at-risk positives.
