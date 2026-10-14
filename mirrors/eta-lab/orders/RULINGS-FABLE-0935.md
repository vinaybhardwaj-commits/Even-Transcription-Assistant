# Fable rulings 24 Sep 09:35 IST (V direction)

42. **V ruling, standing: "There is no limit to what jev can read, just try and make sure it is de-identified when the person is not a doctor."** This replaces the narrower D1b scope in ruling 35.
    - Record it verbatim next to D1b in CLAUDE.md and the ledger (fleet).
    - Rule: Jev may read any ETA text. Before any text leaves our machines for Jev, identifiers of NON-DOCTORS are removed.
      - Remove: patient and attender names, phone numbers, addresses, ID numbers (Aadhaar/PAN/UHID/MRN), email, date of birth, and the exact age of anyone over 89.
      - Doctors' names stay, from the EPI physician roster and the voiceprint roster whitelist.
      - Replace each with a typed tag: [PATIENT_NAME], [PHONE], [ID], [ADDRESS], [DOB].
43. **De-identification step** (fleet builds it; eta-refuter-2 refutes; used first by the surgery v2 pilot):
    - A local de-id pass that runs on the box, never an outside service. Use a pinned multilingual PII model (e.g. GLiNER-PII or Presidio with a multilingual NER), plus regexes for Indian phone/ID formats and the doctor whitelist.
    - It runs on the English translation AND the original script.
    - Measure it on 30 real turns hand-checked by fleet: report names missed (recall) and doctors wrongly removed.
    - The pilot uses it today. The production lib/jev gets the same step as a later train item (spec after the pilot).
44. **Nemotron fine-tune: start NOW** (diar-lab) on gcp-l4, on the pyannote.ai teacher labels, in parallel with eta-refuter-2's review of the trainer and endpoint. Lab only, so nothing reaches production before the Refuter PASS.
    - Target: speaker-count error vs V's 5 ≤ 0.2, and DER vs the teacher on bench20 below the current 0.15 median.
    - Held-out evaluation on room-days never trained on, as before.
    - Report after the first run with the same table.
