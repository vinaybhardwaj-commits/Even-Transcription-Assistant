# ft-convo DONE (first pass, 20 Oct 2026 14:10 IST). Lane ft-convo, mx-ft-convo on the lab box. D split only; H, ft8/H and ft-h1shot/sealed never read.

## Status
- **Done.** The 1-6 brief items:
  - time-anchored cut, with the Opus 10% check
  - pre-registered rubric
  - Opus max scoring (599/600 units)
  - Jev 15% kappa
  - BH tests (Fisher, within-doctor CMH, L0-adjusted logit)
  - forest delta AUC (8, Holm)
  - quotes
  - the extra calls (9 in scope, transcribed with v4)
- **Not done.** Within-counsellor (agent-id) stratification: ft-runolink has not delivered agent ids (DONE-PARTIAL). That test re-runs when the ids land.
- **Scope.** Whole-conversation checklist only, per the newcat-orch 12:31 note. There are no dialogue-act sequences here.

## Pre-registration
- RUBRIC.md sha 140ac083e10f and code/cc.py sha eb1f28253658, frozen at 12:15:37 IST. Read-only copies are in ~/eta-data/forest/ft-convo/*.prereg.*.
- Opus scoring started after that. cc.py is unchanged since (same sha). The deviations are listed in CONVO.md.

## Spend
- **Sarvam saaras:v4:** 25.1 min, 9 calls (orch GO 251 / 475 min; lane GO 9 / 26). Ledger ~/eta-data/sarvam-ledger/forest-runo/. No v3 calls were made.
- **Claude Opus 5.5, Bedrock** (global.anthropic.claude-opus-5-5, steward ZDR route, adaptive thinking at effort max): 3,841,233 input tokens and 12,509,947 output tokens, over the scoring runs (595 ok) and the cut check (60).
  - The two killed smoke tests (about 7 units) are not in the token log.
  - At the assumed list price of $5 / $25 per M tokens, that is about $332. Check against the Bedrock bill.
- **Jev** (jev-latest, typesafe API): 90 calls, 192,157 input and 36,000 output tokens.

## Files (sha12)
| file | sha12 |
|---|---|
| RUBRIC.md (pre-registered) | 140ac083e10f |
| CONVO.md | 434983d8a7f0 (before this DONE; re-hash after any edit) |
| TABLES.md | 18d01490842a |
| code/cc.py | eb1f28253658 |
| code/prep.py | 91fe748963f9 |
| code/score.py | 87de0696116d |
| code/jev_check.py | d878481a957f |
| code/analyze.py | 5828c1377a68 |
| code/predict.py | f1a66f520bd6 |
| code/report.py | 2a7b6f1b1468 |
| code/posthoc.py (post hoc) | ec982f89b800 |
| code/rl_stt_v4.py | 2de99f1e6465 |
| ../ft-convo-stt/DONE.md (v4 STT lane) | e6bf5fea37f8 |
| work: units.jsonl | 1e5b27e91658 |
| work: scores.jsonl | cf1906734263 |
| work: cutcheck.jsonl | b18906909c17 |
| work: jev.jsonl | f7b2fa465396 |
| work: tests.parquet | 2f609a8332ff |
| work: feats.parquet | c7e9938e2cfc |
| work: predict.json | bca5727a4b42 |
| work: extra.json | 51fac510a591 |

Work files are in ~/eta-data/forest/ft-convo/ (0700 dir, 0600 files); v4 transcripts are in ~/eta-data/forest/rl/stt_v4/. No patient rows are in this folder or in any repo.

## Headline
- Calls: a patient objection before deciding goes with non-conversion (Ale 7% vs 24%, q 0.01; holds after L0 adjustment). At the day-3 landmark nothing is flagged (67 tests).
- Consults: recovery explained goes with conversion (41% vs 9%, q 0.02), but not within doctor (q 0.80).
- No staff behaviour item is flagged.
- The rubric does not raise the forest AUC: 7 of 8 deltas are negative, and none survives Holm.
