# ft-text2 COVERAGE (counts only, D split only). 20 Oct 2026, ~04:55 IST (the lab box clock)

## 1. Bolna transcripts (layer 3, calls)
- **Source.** gating-lead's FT8 pull ~/eta-data/forest/ft8/bolna/bolna-d.tsv (sha 49d3780f1f48; SQL ft8-bolna.sql sha 409cf84503f5).
  - 604 rows = 303 Bolna calls with a transcript, on 150 D Rx. The phone link is made inside db13.
  - My own count-only query (ft-text2 B0, aggregates) gave the same 604 / 150.
- **Window.** Same as ft-calltext: IST calendar day, 0 <= day_from_rx <= 14, call day < surgery day.
  - 321 rows are before the Rx and 207 are after day 14. 2 rows fall on/after the surgery day and are dropped.
  - 37 rows were duplicates (one per matching phone record) and were removed.
  - Result: **37 calls on 29 episodes.**
  - Each call maps to exactly 1 episode.
  - 34/37 calls are on a shared phone (n_uhid_on_phone > 1). 26/29 episodes carry an ft-calltext ambiguity flag.
- **Time.**
  - Rows with an offset are converted to IST.
  - The 2026-01 rows have no offset and are read as UTC: their hour histogram in db13 matches the +00:00 rows.
  - gating-lead's days_from_rx is floor(24-hour periods since the Rx timestamp). It differs from the calendar day in 446/604 rows. The calendar day (ft-calltext rule) is used.
- **What the calls are.**
  - 36/37 have status call-disconnected and 1 completed. Median conversation is 5.3 s; median transcript is 455 chars.
  - All 15 day-0 calls are BEFORE the consult time, so they cannot be about the advised surgery. They are kept (not leaky), but they are noise for the question.
- **Haiku tags.**
  - Model: global.anthropic.claude-haiku-5-5. 30 requests, 37 calls tagged, 0 parse failures, 0 unverified quotes.
  - Tokens: 37,627 in / 10,761 out.
  - Outcome-revealing: 0.
  - Positive tags: obj_unreachable 6, next_visit_or_consult_scheduled 11. Every other tag is 0.
- **Language / translation (FT6 ruling).**
  - The Bolna transcripts are delivered by Bolna as English text in Latin script: 13,043 Latin vs 3 non-Latin characters over the 37 calls. Median English stop-word share is 0.44 (fixed 32-word list), and a fixed 17-word romanized-Hindi marker list matched 0 tokens (code/lang_stats.py; output lang_stats.txt).
  - No Saaras and no translation by this lane. They are used "as delivered" (spec layer 3).
  - Whether Bolna's agent spoke English or Bolna translated the call is not recorded in the data.
- **Episode features.** bolna_episode_feats.parquet: 1233 D rows, 62 columns.
  - Per T in {3, 7}: n_bolna_calls_tT, bolna_has_tT, n_bolna_dropped_outcome_tT (QC, not a predictor), 13 Jev-filtered tag columns bolna_* and 13 raw columns bolna_raw_*.
  - The Jev-filtered tags equal the raw ones here: no Bolna positive was contradicted.

### Landmark cells (at risk = surgery > T; Rx >= 1 Jan 2026; cohort P = hash-only F1 ambiguity dropped, S = every ambiguity flag dropped)
| label | T | cohort | at-risk episodes (n / pos) | with >= 1 usable Bolna call (n / pos) | Bolna calls used |
|---|---|---|---|---|---|
| h14 | 3 | all D | 983 / 96 | 18 / 3 | 19 |
| h14 | 3 | P | 976 / 92 | 18 / 3 | 19 |
| h14 | 3 | S | 550 / 56 | 0 / 0 | 0 |
| h14 | 7 | all D | 930 / 43 | 19 / 2 | 23 |
| h14 | 7 | P | 926 / 42 | 18 / 1 | 22 |
| h14 | 7 | S | 519 / 25 | 1 / 0 | 1 |
| h90 | 3 | all D | 578 / 94 | 18 / 3 | 19 |
| h90 | 3 | P | 572 / 90 | 18 / 3 | 19 |
| h90 | 3 | S | 302 / 57 | 0 / 0 | 0 |
| h90 | 7 | all D | 548 / 64 | 18 / 2 | 22 |
| h90 | 7 | P | 545 / 63 | 17 / 1 | 21 |
| h90 | 7 | S | 286 / 41 | 0 / 0 | 0 |
| ale | 3 | all D | 1012 / 106 | 18 / 3 | 19 |
| ale | 3 | P | 1005 / 102 | 18 / 3 | 19 |
| ale | 3 | S | 572 / 64 | 0 / 0 | 0 |
| ale | 7 | all D | 951 / 45 | 19 / 2 | 23 |
| ale | 7 | P | 947 / 44 | 18 / 1 | 22 |
| ale | 7 | S | 535 / 27 | 1 / 0 | 1 |

**Reading.**
- Bolna reaches 18 of 976 at-risk P episodes at T=3 (3 positives) and 18 of 926 at T=7 (1 positive). In cohort S it reaches 0-1.
- This layer can carry no measurable signal. It is in the forest per the V order, with bolna_has_tT, and the expected result is null.

## 2. Jev cross-check of every call tag code acts on
- **Tags checked: 16** (PLAN.md).
- **Sources:**
  - S1 Runo summaries: ft-calltext tags_D.jsonl sha d86ad5d43700, 2185 calls.
  - S2 Runo call-audio transcripts: ft-rl-feat tags.jsonl sha 0a3f5b87abb3, 922 calls (1197 rows; last row per call).
  - S3 Bolna: 37 calls.
- **Jev:** jev-1.13.0 (jev-latest).
  - 3144/3144 calls answered: 3144 requests, 0 errors, 0 retries.
  - Tokens: about 3.87M in / 1.00M out (sample + all runs).
- **Model reference labels:** Claude Opus 5.5 (global.anthropic.claude-opus-5-5), blind (text and definitions only).
  - Sample A: 177 calls = 80 S1 + 60 S2 + 37 S3; seed 20. 0 failures, 0 unverified quotes.
  - Arbitration sample C: 195 calls (206 draws); seed 21. 0 failures, 5 unverified tag quotes, excluded.
  - Tokens: 710k in / 279k out.
  - **These are model reference labels, not human labels.**
  - Opus and Jev were given the same question wording, so they may share a reading that differs from Haiku's prompt.
- **Jev calibration on A:**
  - AUC 0.94-1.00 for every tag.
  - ECE 0.044-0.118: no tag is above the 0.15 rule.
  - Brier 0.006-0.094.
- **Agreement, all calls (kappa Haiku vs Jev >= 0.5):**
  - 0.90 price_quoted, 0.82 insurance, 0.79 second_opinion, 0.74 family_decision, 0.74 callback, 0.70 outcome_revealed, 0.69 fear, 0.67 wants_surgery, 0.64 unreachable, 0.63 cost, 0.62 declines, 0.60 going_elsewhere, 0.59 timing, 0.59 visit, 0.49 undecided, 0.44 details_to_be_sent.
  - On A: see TABLES.md section A (kappa Haiku-Jev, Haiku-ref, Jev-ref, and agree / contradict / unsure per tag).

### Verdicts (pre-registered rules, PLAN.md 04:35 IST; VERDICTS.json)
| verdict | tags |
|---|---|
| DROP | obj_cost (100/365 Haiku positives have Jev p<0.2; the model reference sides with Jev in 8/8 arbitrated), obj_going_elsewhere (34/164; model reference with Jev in 6/8) |
| FLAG | obj_insurance, obj_unreachable, intent_wants_surgery, next_visit_or_consult_scheduled, next_callback_agreed (all: Haiku under-tags); obj_timing, intent_undecided (Haiku precision on A 36% and 46%); obj_second_opinion, next_details_to_be_sent (both reasons) |
| KEEP | outcome_revealed, obj_fear, obj_family_decision, intent_declines, price_quoted |

- **Close calls under the rule:**
  - obj_timing: the model reference sides with Jev in 8/8, but Haiku-positive contradictions are 17% of its positives (the rule needs 20%). It is FLAG, not DROP.
  - intent_undecided: same pattern, 7/8 and 17%.
  - obj_going_elsewhere: DROP clears the 20% rule by ONE call (34/164 contradicted; 33 needed). 11 of its positives have Jev p in [0.13, 0.2), and the refuter's Jev rerun on 12 calls moved p by up to 0.07. A Jev rerun could flip it to FLAG. obj_cost has a wide margin (100 vs 73 needed).
- **Call level (spec layer 3: "a Haiku tag that Jev contradicts is set to 0").** Jev-filtered precision on A (TABLES.md section D):
  - cost 69% -> 92%, going_elsewhere 62% -> 83%, timing 36% -> 44%, undecided 46% -> 53%.
  - Recall is unchanged except undecided (100% -> 77%) and details (62% -> 54%).
- **Structural note.** Haiku's intent and next_step are single-choice per call; Jev answers each value independently. Part of the "Haiku under-tags" result for visit vs callback is this schema difference, not an error.
- **Leak screen (outcome_revealed).**
  - A Jev contradiction never removes a Haiku "revealed".
  - Jev p >= 0.8 adds 12 calls (S1 6, S2 6) to the 628 Haiku verified/unverified revealed calls. In arbitration the model reference confirmed 2/8 of these.
  - The drop-in files mark them (outcome_revealed_jev_added).

## Files (0600)
- call_tags_jev.parquet: one row per (src, call_id), 3144 rows. Per tag: h_ (Haiku), j_ (Jev p), r_ (model reference, sampled calls only), js_ (agree / contradict / unsure / no_jev), hf_ (Jev-filtered). Also leak_union.
- tags_D_jev.jsonl (S1) and rlfeat_tags_jev.jsonl (S2): Jev-filtered drop-in copies: the original schema plus 2 keys (jev_changed, outcome_revealed_jev_added). The quotes of removed tags are kept in `quotes`; the code reads only the tag fields.
  - Changed rows: S1 264/2185, S2 219/1197.
  - ftc_model.py and rlf_assemble.py can be rerun on them unchanged.
- bolna_calls.parquet, tags_bolna.jsonl, bolna_episode_feats.parquet.
- jev.jsonl, ref.jsonl, sample_A.json, sample_C.json, sample_C_draw.json, TABLES.md, VERDICTS.json, PLAN.md, code/.
