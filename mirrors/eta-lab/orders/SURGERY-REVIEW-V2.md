# SURGERY-REVIEW-V2: rebuild the surgery review (V feedback, 24 Sep 09:05). Owner: fleet. Refuter: eta-refuter-2

## What V said about v1 (surgery-30 page), after labelling all 18
- "I can't tell who's speaking."
- "The STT is garbled."
- "All you're doing is picking up on the word 'surgery'."
- "I have no way of telling what procedure was discussed."
- "Not enough context to figure out any useful labelling."

He asked for Jev to find whether a conversation includes a surgery discussion, which procedure, and whether it is named.

His labels are at ~/eta-data/surgery-30/v-labels-2026-09-24.json on the box (copy from the Mini: ~/dev/_private/surgery-30/). What they show:
- 7 of 18 keyword hits were NOT surgery discussions (S04, S05, S13, S14, S17, S18 junk; S08 an ENT symptom).
- S12 was a historical surgery.
- S09 was staff talk.
- S10 was a referral.
- Only 6 were real recommendations.

That is the finding: keyword selection is ~50% noise.

His rulings: **R1 = default (v2 wording), R2 = default (a bare negation is 'no')**. Both are final; apply them.

## v2 design (settled; build exactly this)

1. **Selection by truth, not keyword.** Pick 20 consults from 23–24 Sep with a matched room window:
   - 10 whose patient has a surgery_cases lead created within 48 h of the consult (linked via queue_tokens.metadata INDIVIDUAL_UID), so a recommendation almost certainly happened;
   - 5 with a prescription_surgery_recommendation flag but no surgery_case;
   - 5 random consults with neither.

   Record which bucket each came from. Hide the bucket from reviewers.
2. **The whole consult, not snippets.** Show the full consult from the PQM called_at to completed_at (E-7 boundaries), as speaker-labelled turns: "Doctor" / "Patient or attender" / "Other" from the diarize hybrid's voiceprint attribution. Where attribution is missing, show "Speaker A/B" rather than guessing.
3. **English alongside.** Put the Gemini 3.8 Flash translation beside each non-English turn, with the original on hover or tap.
4. **Jev reads first; the doctor confirms.** Run Jev U9 on the full English consult and put its answers at the top of each card, each with the quoted evidence turns (clickable, scrolls to the turn):
   - Is a procedure discussed at all?
   - Is it a recommendation now, history, a referral, or staff talk?
   - Which procedure, named or described?
   - Who proposed it?
   - How firmly (R1 wording)?
   - What was the patient's response?
   - Was cost discussed?
   - Was a second opinion offered?

   The reviewer marks each answer **Agree / Correct it**, and only edits what's wrong. This makes review fast and measures Jev directly.
5. **Audio for garbled text.** Each evidence turn gets a ▶ play of that turn's audio (±3 s) from R2, so a doctor can listen when STT fails. Build it as the artifact `assets` capability (org-internal only) or short-lived signed R2 URLs, whichever the artifact CSP allows. Say which.
6. **Quality flag per consult:** "transcript too poor to judge" as a first-class answer, so bad STT is counted, not guessed around.

## Delivery
- **Pilot:** 5 consults as a local page on the box first. Fable opens it on V's Air for a 5-minute look at the design before any scale-up. Target 16:00.
- **After V approves:** Fable republishes the shared claude.ai page (artifact RajYseogAgBuVaF7xN5dNH, same URL) with the 20. Fable seeds the db. fleet hands Fable the data as JSON files (one per consult) in ~/eta-data/surgery-review-v2/.
- **Compute:** Jev and translation calls go through OpenRouter/Jev (not Mini whisper), so they're fine in clinic hours. NO transcription or diarization re-runs on the Mini during 08:00–20:30.

## Don't
- Put patient text in git.
- Show the bucket to reviewers.
- Let Jev's answers pre-select the form. The reviewer sees them as proposals with Agree / Correct buttons.
