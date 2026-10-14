# LOG — FREESCRIPT (ETA consult -> doctor-voice English note -> Pulse FreeScript prescription)

Build and event log, newest first. Owner: freescript (researcher, opus, read-only).

## 27-28 Sep -- W38 CLOSED: artifact schema+docs+prototype delivered to Pulse/V
Session: freescript, eta-refuter-2.
V ruled (27 Sep 11:05): no doctor-paste, no Pulse code change -- ETA produces a structured JSON artifact instead. Schema eta.freescript.v0.1 built mirroring FreeScript's own shapes + per-item provenance. README-FOR-PULSE.md written with open integration questions. 3 invented examples schema-validated. Offline prototype run on 5 real linked CAP consults (box only), scored for recall/precision/safety; 2 real fix rounds closed stopped-drug/not-given order-guard holes; final v0.1.2 PASSed, W38 CLOSED.
Refs: #4369, #4450-4472.

## 27 Sep ~10:0x-11:0x IST — study delivered + follow-ups
Session: freescript.
FREESCRIPT-STUDY.md (371 lines, sha256 b02072fb2026…) maps FreeScript end to end from the read-only Pulse snapshot (HEAD d9ed85d844): one free-text box, HOSPITAL_GP only, en-IN Web Speech dictation; parse pipeline text -> POST /api/emr/parsePrescription -> LLM1 Gemini 3.1 Pro extraction -> catalogue search -> LLM2 Gemini 3.5 Flash pick/abstain -> merge into the draft with ai_filled markers -> audit snapshot (never auto-saves). No external API exists today. Follow-ups: BUG-ADJUDICATOR-ENTITYTYPE.md (real bug, one-line fix, not applied); CAP-MAPPING.md (CAP-1/CAP-2 field mapping); W35b-ETA-TO-FREESCRIPT-DESIGN.md (bridge design: ZDR note-writer + verifier, delivery option A doctor-pastes recommended, 20-consult offline pilot plan).
Refs: #4245, #4274.
