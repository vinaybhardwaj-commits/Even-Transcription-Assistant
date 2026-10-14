# LOG — W50 clinical speech-engine bake-off (medasr / whisper-med-merged / parakeet-med)

Build and event log, newest first. Owner: terms (builder), eta-refuter-2 + eta-refuter-3 (checkers, both witness every addendum).

## 27-28 Sep — parakeet withdrawn, set(b) scored, set(c) running
Session: terms, eta-refuter-2, eta-refuter-3.
V accepted medasr's HAI-DEF terms for lab evaluation (27 Sep 15:17). Smoke: medasr+whisper-med-merged pass; parakeet-med FAILS (deterministic truncation), withdrawn ADDENDUM-18. Pre-registration closed after 17 witnessed addenda: truth set = 22-24 Sep CAP-linked consults (122 drug items/49 consults, kept separate from FUSER's own TEST set); chance-corrected pairing + Fable's 2x-false-drug hard cap adopted; 60-min span cap set; per-comparison-pair exclusion for scoring. Set (b) (192 clinical1 windows) SCORED 384/384, 0 rejected, independently verified twice. Set (c) (87 real consults/102 drug items) built end to end (manifest, decoder, upload guards) through several real-bug fix rounds (unit/strength text inflating the drug lexicon; a 30s Whisper truncation bug); scoring running, 3/87 done as of the last read.
Refs: #4706-4751 (STEP0/PREREG), #4766-4968 (17 addenda), #5110-5292 (build+scoring).
- 29 Sep ~19:27 IST (rev 26): set (c) primary 76 windows; window-5 SraVaani retry driver 98414c5f PASS (#7085).
