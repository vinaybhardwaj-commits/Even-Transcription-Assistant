# ft-dialog-consult DONE (20 Oct 2026 12:50 IST the lab box clock, lane ft-dialog-consult, Claude Opus 5.5 on Bedrock). D split only. DESCRIPTIVE, post hoc.
- Report: DIALOG-CONSULT.md (sha a6d1d161fdce; v1 was 41a67cf1b1b8). Act list ACTS.md (sha ef43f890b8b6, written 12:33 before tagging and before the outcome join).
- Aggregates: agreement.json aed1066acfeb; patterns_opus.json b2abd1ac5dc2; quotes.json bc7c69c3914e (English renderings, names / places / numbers masked).
- Code (code/): prep 75c81715192e, tag 4b5f04a2c980, jev_check c64dae40443f, agree 55db69fde6d5, labels 8d82fe2573f2, feats 6a74774eeec5,
  analyze 21d1926c24e0, desc fe5d8a9ce51e, patterns 7e503482d3da, quotes e34d16b3ef14, s4 28e02b218ab5.
  Rebuild: prep -> tag run -> jev_check run -> agree -> labels -> feats -> analyze (+ analyze.s3_leg_a_no_converters) -> desc -> patterns -> quotes; s4.
- Work files (texts, per-consult rows; 0600 in a 0700 dir): ~/eta-data/forest/ft-dialog-consult/. Nothing committed; no patient rows in any repo.
- Models (pinned): Haiku 5.5 global.anthropic.claude-haiku-5-5 (turn tags, quote rendering); Opus 5.5 global.anthropic.claude-opus-5-5 (pattern definition,
  aggregate tables only); Jev jev-latest = jev-1.13.0 (15% turn sample). Bedrock via the ZDR steward route (ftc_tag.client).
- Spend: Haiku tagging 1.74M in / 0.98M out tokens (4 runs incl. a 2-chunk smoke and 1 retry); Haiku quote rendering 0.009M in / 0.011M out;
  Opus 0.021M in / 0.007M out (1 request); Jev 494 requests, 3.74M in / 0.73M out. No STT, no Sarvam.
- Tests: 1,562 counted in 8 families. ALL EXPLORATORY: only ACTS.md was pre-registered. Within-family flags: recovery/stay (F1 3 cells, S2 2) and S2 pre-yes length (artefact). Pooled BH (1,554 p): only F1 leg b whole, F1 leg a post, S2 leg b whole survive; P1 recovery (q 0.069) is the one lead.
- Known gaps: 101 turns of one consult untagged (Haiku JSON failure x4). Jev via jev_client direct HTTPS (as ft-lexical), not the Mini jev_ask tool.
  Refuted by ft-refute-dconsult: CONFIRMED WITH CAVEATS (ft-refute-dconsult-REPORT.md); fixes applied 20 Oct: exploratory labelling, pooled BH demotions, within-doctor/adjusted wording, quotes.json cleaned (failed and mistranslated windows dropped).
- Never read: ft8/H, ft-h1shot/sealed. No Pulse writes, no deletes, no secrets printed. Builders on the lab box only.
