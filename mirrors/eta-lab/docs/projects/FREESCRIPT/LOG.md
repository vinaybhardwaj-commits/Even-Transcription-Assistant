# LOG — FREESCRIPT (ETA consult -> doctor-voice English note -> Pulse FreeScript prescription)

Build and event log, newest first. Owner: freescript (researcher, opus, read-only).

## 27 Sep ~10:0x-11:0x IST — study delivered + follow-ups
Session: freescript.
FREESCRIPT-STUDY.md (371 lines, sha256 b02072fb2026…) maps FreeScript end to end from the read-only Pulse snapshot (HEAD d9ed85d844): one free-text box, HOSPITAL_GP only, en-IN Web Speech dictation; parse pipeline text -> POST /api/emr/parsePrescription -> LLM1 Gemini 3.1 Pro extraction -> catalogue search -> LLM2 Gemini 3.5 Flash pick/abstain -> merge into the draft with ai_filled markers -> audit snapshot (never auto-saves). No external API exists today. Follow-ups: BUG-ADJUDICATOR-ENTITYTYPE.md (real bug, one-line fix, not applied); CAP-MAPPING.md (CAP-1/CAP-2 field mapping); W35b-ETA-TO-FREESCRIPT-DESIGN.md (bridge design: ZDR note-writer + verifier, delivery option A doctor-pastes recommended, 20-consult offline pilot plan).
Refs: #4245, #4274.
