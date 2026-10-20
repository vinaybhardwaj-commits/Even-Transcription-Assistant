# ft-text2 DONE (20 Oct 2026, ~04:58 IST on the the lab box clock; refute PASS-WITH-FIXES 05:36, fixes applied ~05:45)
- **Lane model:** Claude Opus 5.5 on Bedrock (global.anthropic.claude-opus-5-5).
- **Tools used:**
  - Tagger: Haiku 5.5 (global.anthropic.claude-haiku-5-5).
  - Cross-check: Jev jev-1.13.0.
  - Model reference labeller: Opus 5.5 via the steward ZDR route.
- **Scope:** D split only. H is sealed: labels.parquet and features_D are filtered to D on load, and every input is D-only (asserted).
- **Rules:** pre-registered in PLAN.md (sha 523867e2303e, 04:35 IST), before any Jev or model reference output existed.
- **Detail:** COVERAGE.md (counts, cells, verdicts) and TABLES.md (all tables).

## Headline
1. **Bolna (layer 3) is in the forest, but it is nearly empty.**
   - 37 Bolna calls with a transcript fall in [Rx, Rx+14] before surgery, on 29 D episodes.
   - 36 of 37 calls are "call-disconnected", with a median of 5.3 s. The 15 day-0 calls are all before the consult.
   - Coverage among at-risk cohort-P episodes:
     - T=3: 18/976 (3 positives).
     - T=7: 18/926 (1 positive).
     - Cohort S: 0-1.
   - Expect null. The features are in bolna_episode_feats.parquet:
     - Columns, keyed by episode_id with _t3 and _t7 suffixes: n_bolna_calls_tT, bolna_has_tT, the Jev-filtered bolna_* tags and the raw bolna_raw_* tags.
     - Episodes with no Bolna call get NaN, which the model codes as -1.
2. **Jev cross-check.**
   - All 16 tags code acts on were checked, on 3144 calls: S1 Runo summaries 2185, S2 Runo audio transcripts 922, S3 Bolna 37. Jev answered every call.
   - Calibration on labelled sample A (177 calls): AUC 0.94-1.00, ECE <= 0.118.
   - Kappa Haiku vs Jev on all calls: 0.44 (details_to_be_sent) to 0.90 (price_quoted).
3. **Verdicts (PLAN.md rules):**
   - **DROP:** obj_cost and obj_going_elsewhere. obj_going_elsewhere clears the 20% rule by one call (34/164; 33 needed), so a Jev rerun could flip it to FLAG. obj_cost has a wide margin (100 vs 73).
   - **FLAG (9):** insurance, unreachable, wants_surgery, visit, callback, timing, undecided, second_opinion, details.
   - **KEEP:** outcome_revealed, fear, family_decision, declines, price_quoted.
   - With the spec's call-level rule (contradicted Haiku positive set to 0), precision on A rises: cost 69% -> 92%, going_elsewhere 62% -> 83%. Timing (44%) and undecided (53%) stay weak after filtering.
   - Which applies (tag DROP vs call-level filter) is forest-lead's choice. Both are delivered.
4. **Leak screen.** Jev adds 12 outcome-revealing calls (S1 6, S2 6) to Haiku's 628. They are marked in the drop-in files, and Jev never removes a Haiku "revealed".
5. **Translation (FT6).** The Bolna transcripts are English in Latin script, as delivered by Bolna (code/lang_stats.py). No Saaras and no translation by this lane.

## Caveats
- **The model reference labels are an Opus 5.5 model, not humans.** No hand-labelled call sample exists.
  - The model reference and Jev were given the same question wording.
  - Arbitration is up to 8 calls per tag per direction, so small n.
- Rare tags on A have fewer than 5 model reference positives: fear 2, second_opinion 3, declines 2.
- **The Bolna link is phone-level.** 34/37 calls are on a shared phone, and 26/29 episodes are ambiguity-flagged. Cohort P keeps them (hash-only rule); cohort S drops them all.
- Bolna time: the no-offset (Jan 2026) rows are read as UTC. This is inferred from the hour histogram, not documented.
- I did not change any ft-calltext or ft-rl-feat file. The filtered versions are separate drop-ins.
- **SQL.** I ran 8 count-only aggregate queries on db13 (Bolna volume, cohort match, timestamp format, and a dry-run count of B1). No text was pulled by me; the text came from gating-lead's pull.
  - My own B1 text pull SQL (code/b1-bolna.sql.tpl) was NOT run.

## Inputs (sha12)
| input | sha12 |
|---|---|
| labels.parquet | 0aefc00f425b |
| features_D.parquet | 8ec830bfc4d6 |
| ft-calltext episodes_D.parquet | a06fa6e0747f |
| ft-calltext calls_D.parquet | 5d2a1c72a6ec |
| ft-calltext tags_D.jsonl | d86ad5d43700 |
| ftc_tag.py | 54d97b97d0f6 |
| rl-feat tags.jsonl | 0a3f5b87abb3 |
| rl-feat texts.jsonl | 2e9a1d53c738 |
| bolna-d.tsv | 49d3780f1f48 |
| ft8-bolna.sql | 409cf84503f5 |
| hash-only f1-2026-10-19.tsv | e16e146b41c9 |
| FT-MODEL-SPEC-20OCT.md read | e88231ac72c7 |

## Outputs (the lab box ~/oc/forest-lead/ft/out/ft-text2/, 0600, sha12)
| output | sha12 |
|---|---|
| call_tags_jev.parquet | 8f51bd106acd |
| bolna_episode_feats.parquet | 68025a99cc6e |
| bolna_calls.parquet | ee5167443514 |
| tags_bolna.jsonl | e8127943bfa8 |
| tags_D_jev.jsonl | d507107e9884 |
| rlfeat_tags_jev.jsonl | fa7220dcc743 |
| jev.jsonl | d93addf2e225 |
| ref.jsonl | c49a3da62a62 |
| VERDICTS.json | 828f62d5db0e |
| TABLES.md | 219ecc5d1e3b |
| sample_A.json | 0ead39723313 |
| sample_C.json | 050652b520ef |
| sample_C_draw.json | 197212c25db9 |

Code: code/ (synced from ~/wt/ft-text2/code at commit c68778bd7233; the TABLES.md wording is reproduced byte-for-byte by code/analyze.py).

**Rebuild order:** bolna_join -> bolna_tag run -> make_sample A -> jev_run sample/all -> ref_label A -> make_sample C -> ref_label C -> analyze final -> dropin -> bolna_episode.

## Ledger
| item | volume | tokens in / out |
|---|---|---|
| Haiku (Bolna) | 30 requests | 37.6k / 10.8k |
| Jev | 3144 requests | 3.87M / 1.00M |
| Opus model reference | 372 requests | 710k / 279k |
| Metabase | 8 aggregate count queries, read-only | n/a |

## Refute
- **Verdict:** ft-text2-oref (Opus 5.5) at 6aa91f741083 gave PASS-WITH-FIXES. Tests 22/22, mutants 16/16. Report: ~/wt/ft-text2-oref/.bc/ft-text2-oref-REPORT.md.
- **Independent recount:** the refuter's own numbers match every count, kappa, precision and verdict, and its reruns reproduce every output byte- or frame-identical.
- **Fixes applied:**
  1. The obj_going_elsewhere one-call margin is now stated in the caveats.
  2. The language claims are now code: code/lang_stats.py, output lang_stats.txt.
  3. code/ is synced with the repo.
  4. The drop-in schema wording is corrected (original plus 2 keys).
  5. bolna_join.ist() now accepts an offset without a colon. The rerun output is byte-identical (sha ee5167443514).
