# ft-refute-dconsult: refute of ft-dialog-consult (DIALOG-CONSULT.md sha 41a67cf1b1b8, ACTS.md sha ef43f890b8b6). Served by Claude Opus 5.5 (claude-opus-5-5). 20 Oct 2026
VERDICT: CONFIRMED WITH CAVEATS. P1 (recovery/stay explained, leg b) reproduces exactly and survives every stress test. Two of the six flags fail pooled BH, and the summary's corroboration is overstated.
No new model calls. My numbers came first (work/recompute.py, work/mine.json, written before any lane code was read). Lane code was read afterwards only to trace quote sources (quotes.py definitions, no render calls).
## (1) Split: PASS
- split_guard (pin 52959278edd8…): 191/191 consults are D, 0 H (156 via 10b.tsv; all 191 via 10/10b/10d plus clusters or the ft-audio cluster_key).
- I did not read ft8/H or ft-h1shot/sealed, and no lane code path references them.
## (2) Pre-registration: ACTS PASS; TEST FAMILIES NOT PRE-REGISTERED
- File times (birth): ACTS.md 12:33:40; first tags 12:34:38; tag.py last change 12:35:15; outcome join (labels.parquet) 12:36:27; tagging done 12:40:18. So the acts, yes-point rule, legs and tagger prompt were fixed before the outcome join, and Haiku never saw outcomes.
- ACTS.md does NOT fix the features, the 8 families, the tests or BH. feats.py (12:38) and analyze.py (12:47) were edited after the join; S3 was built at 12:47 after the main results; S4 is ad hoc (the report says so).
- feats.parquet (12:38:30) and results_*.parquet (12:39:37) were born BEFORE tagging finished, so outcome results were seen mid-tagging. Low impact because the prompt was frozen, but "before any outcome join" covers only the act list.
## (3) Recompute (tags + turns + Ale from ft-audio features_ale + labels v2): ALL MATCH
- Cohorts: Ale 134 labelled / 24 positive; leg a 50 vs 44 (20 converters); leg b 20 vs 36; S2 24 vs 47. Yes point in 91/191 (29 by commitment). Turns 24,712; tagged 24,611.
- F1 leg b whole recovery 18/20 vs 12/36 (p 5.5e-5); F1 leg a post 21/28 vs 3/19 (p 8.8e-5); F1 leg a whole 29/50 vs 10/44 (p 7.3e-4).
- S2 leg b whole 20/24 vs 17/47 (p 1.7e-4); S2 post 14/16 vs 11/30 (p 0.0015); S2 pre-yes length median 4.44 vs 8.58 min (MW p 0.0021); pre-yes recovery leg b 12/20 vs 6/36 (p 0.0022).
- Labels: Ale matches the lane on 191/191; Ale vs labels v2 h14 agree on 80/81. On v2 h14, P1 is 10/12 vs 11/35 (p 0.003).
- Minor: 1 Ale=1 converter has surgery at day 20 (breaks the yes_ep identity). P8's text mixes the F1 medians (5.0 vs 8.6) with the S2 q.
## (4) Multiple testing: lane BH reproduced exactly (|dq| 1e-16; total 1,562)
- F3, F4, S1, S2 and S3 re-test the same F1 features on overlapping consults, so BH within each family understates the burden.
- Pooled BH over all 1,554 BH-tested p values:
  - Survive: F1 leg b whole (q 0.069), F1 leg a post (0.069), S2 leg b whole (0.090).
  - Fail: F1 leg a whole (0.23), S2 post (0.27), S2 pre-yes length (0.28).
- OVERSTATED: summary item 1 says P1 "holds within doctors (p 0.013)" and "after adjusting (p 0.002)", but the best q in those families is 0.996 (F3) and 0.474 (F4). The role-certain check (15/15 vs 10/20) has q 0.103.
- OVERSTATED: DONE.md lists the S2 pre-yes length as Flagged, without the ARTEFACT label it gets in P8 (F1 q 0.21). P2 is called a LEAD at q 0.77; P3 and P4 are q >= 0.21. Treat all three as hypotheses.
## (5) Leakage: no hard leak; leg b entry is asymmetric
- Consult text comes before the outcome. Only 1 converter had surgery on the consult day; dropping converters with surgery at day <= 1 gives 12/14 vs 12/36 (p 0.0013).
- Converters enter leg b through the outcome itself. 6/36 non-converters enter only through the consult's own act 15. 9/36 are "yes" only through outcome_revealed calls with no wants_surgery call ever, and 4/36 have a declines call. Across all calls, outcome_revealed is wants_surgery in only 147/623.
- P1 holds with symmetric entry: yes via call for both groups 11/12 vs 11/30 (p 0.0017); strict yes (wants_surgery or commitment) 18/20 vs 9/29 (p 4e-5).
- Leg a: having a post-yes part does not track the outcome (28/50 vs 19/44, p 0.30). Post-yes admin talk is outcome-adjacent; P5 treats it as descriptive, which is fair.
## (6) Quotes: 24 windows in quotes.json, traced with the lane's own selection rule (all 8 n_eligible match) and compared by me
- Verbatim English (only masking or punctuation): 9, one of which adds "[n]" where the source has no number. Lightly condensed English: 5. Faithful translations (Hindi, Kannada, Tamil): 8. Mistranslated: 1 (Kannada "months" rendered as "things"; not in the report). Render failed: 1 (P4 example 3).
- Report: 11 quote blocks, all traced and faithful in content. 3 drop a backchannel or join lines with no ellipsis (P2 #1, P3 #2, P4 #2).
- Masking: no names, places or digit runs leak; word-form numbers can survive ("one [n] night"). P4 #1 recasts a question addressed to a third person as one to the doctor. P3 #1 is a thin example of a "substantive answer".
## Bottom line
P1 is real in this sample, and robust to split, labels (Ale and v2), symmetric yes, same-day surgery and pooled BH. It is still post hoc, with 20 converters and 5 doctors.
Downgrade the within-doctor and adjusted claims to "same direction, not significant after correction"; drop the S2 length flag as an artefact; everything else is hypothesis.
