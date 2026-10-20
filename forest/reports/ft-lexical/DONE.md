# ft-lexical DONE (20 Oct 2026 11:55 IST, lane ft-lexical, Claude Opus 5.5 on Bedrock). D split only. DESCRIPTIVE, post hoc.
- Report: LEXICAL.md v2 (242 lines, sha afc19669aae7); appendix LEXICAL-TERMS.md (top 25 each way, Haiku-rendered snippets, names masked, sha 7735e4ac2313); PLAN.md pre-registered 11:21 IST (sha c2aec8cd35b7).
- Code: code/ (prep, tag, jev_check, lex, themes, other, names, quotes, report). Rebuild order: prep -> tag run (SCH=4 retry) -> jev_check run -> lex -> themes -> sens_lex -> other -> quotes -> report.
- Work files (texts, 0700): ~/eta-data/forest/ft-lexical/.
- Spend: Haiku 5.5 theme coding 4.80M in / 3.23M out tokens (projected 3.35M; consult native-script text cost more than projected; under the 5M cap per run). Haiku snippets/gloss ~0.03M. Jev 399 requests, 0.58M in / 0.12M out.
- Never read: ft8/H, ft-h1shot/sealed. All 1,233 episodes and 198 consults passed split_guard = D.

- Refute: ft-lexical-oref (Opus 5.5, Bedrock) PASS-WITH-FIXES, report ~/wt/ft-lexical-oref/.bc/ft-lexical-oref-REPORT.md. Fixes applied 12:30 IST:
  - F1 matched-window and day-3 landmark sensitivities (themes.py modes, sens_lex.py); F2 drop_decided mode + caveat; F3 name masking (report.mask) and appendix regenerated;
  - F4 PLAN BH family primary for themes; F5 per-corpus kappa; F6 caa-weak consults out of speaker cells (lex rerun); F7 deviations section; F8 wording.
