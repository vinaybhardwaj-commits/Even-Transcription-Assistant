# ft-docstyle DONE (20 Oct 2026, lane ft-docstyle, Claude Sonnet 5.5 on the lab box). D split only; DESCRIPTIVE, post hoc.
- Report: DOCSTYLE.md (sha fa810fb37467, v2 after refute); tables.md (f623b8fd8c7e), tables_noweak.md, results*.json, OPUS_TYPES.md, ACTS.md (written before tagging).
- Code (code/): prep, tag (Haiku), build, analyse, jev_check, quotes, opus_types, followup. Order: prep -> tag run -> build -> jev_check -> analyse [--noweak] -> opus_types -> followup. No git repo here, so shas are file sha256 prefixes.
- Work files (0700, patient text and the doctor mapping): ~/eta-data/forest/ft-docstyle/. Never read ft8/H or ft-h1shot/sealed; 191 consults all from ft-lexical (split_guard = D).
- Spend: Haiku 5.5 1.30M in / 0.36M out; Opus 5.5 4.0k / 1.6k; Jev 29 requests, 0.10M in / 5k out.
- Deviations: own act list (ft-dialog-consult not ready); own Pulse baseline OOF (sealed L0 unreadable; AUC 0.60); leg (a) is a proxy (room yes or call-summary intent or surgery done); leg (b) = Ale 14 d (no h90 for consults); pauses coarse.
- Not done: Haiku per-turn tags on call transcripts (not requested here); per-counsellor effects (no agent ids).

- Refute ft-refute-descr: PASS-WITH-FIXES, report ft-refute-descr-REPORT.md. Fixes applied (no new model calls): only ACTS.md was pre-registered, the 77-test family is post hoc and all flags exploratory (stated in DOCSTYLE.md header); type flag (q 0.085) demoted, doctor-level p 0.22; handoff wording softened; quotes made verbatim with "..." for cuts. DOCSTYLE.md sha now fa810fb37467.
