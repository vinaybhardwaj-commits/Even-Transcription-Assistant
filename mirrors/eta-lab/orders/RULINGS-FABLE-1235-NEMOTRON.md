# Fable ruling 94 — Nemotron fine-tune next steps (24 Sep 12:35 IST; V asked)

The state (diar-lab d117d9a): fine-tuning on teacher labels makes Nemotron UNDER-count, and a lower lr only delays that. The step-25 checkpoint is the only clean gain (V5 DER 0.414→0.342, count vs V 0.4 unchanged). Blind lr/crop tuning is STOPPED. The problem is structural. Test these, in this order, in parallel where GPUs allow (gcp-l4 L4 + box T4; the hist-gpu nodes stay on HIST).

1. **Diagnose first (diar-lab, ≤45 min, no training):**
   - (a) The architecture's max-speaker ceiling. If the Sortformer head has a fixed number of output slots (e.g. 4), a 5-speaker window like maaacrdh CANNOT be counted, and no fine-tune fixes that. Cite the model config line.
   - (b) The count distribution of the train windows vs V5/bench20 (histogram of teacher speaker counts). The hypothesis is that train is dominated by 2-speaker doctor–patient windows, so the model learns a low-count prior.
   - (c) The teacher's own count error vs V on V5. If pyannote.ai itself is off vs V, the teacher caps what any fine-tune toward it can reach.
2. **Then trainer variants** (each diff refuted by eta-refuter-2 BEFORE launch; one variant per GPU):
   - A. **Encoder frozen, head-only** (least forgetting). Cheapest; first.
   - B. **Count-balanced data:** oversample windows with ≥3 and ≥4 speakers to match the test distribution. Instead of skipping the 4 windows with >8 teacher speakers, crop them into sub-windows under the ceiling.
   - C. **Count-aware auxiliary loss** (penalise the predicted active-speaker count vs the teacher's). Only if A/B leave a gap.
   - Keep the clean split, stop on val count error, and score every checkpoint.
3. **If (1a) shows a ceiling below the counts we see: STOP fine-tuning for counts** and test the hybrid instead. Nemotron does segmentation (where speech/turns are); the speaker COUNT comes from pyannote.ai or our embedding clustering. Score the hybrid on V5 + bench20.
4. **Adoption bar:**
   - V5 count error vs V ≤0.2, AND bench count error below the teacher's, AND DER no worse than step-25.
   - The step-25 checkpoint stays a SHADOW candidate only.
   - pyannote.ai stays primary for counts.
5. **Human truth is the real limit:** V5 is 5 windows. Fable proposes to V a 30-window "how many different people speak?" page (≈1 min each; Sandhya can also rate).
   - diar-lab prepares 30 candidate windows (stratified by teacher count 1–6+, disjoint from train/val by room-day) so the page is ready if V says yes.
6. Report the diagnosis (1a–c) on the bus by 13:30, then the variant results as they land.

## Addendum 12:50: V said YES to the speaker-count page
**Page: "Speaker count"** (new artifact, published by Fable; raters V + Sandhya, both PHI-cleared).

- **diar-lab: 30 windows.**
  - Stratified by teacher count (1, 2, 3, 4, 5, 6+; ~5 each), each 60–90 s, disjoint by room-day from train/val/V5/bench20.
  - Each window is an MP3 (32 kbps mono) + a JSON of {id, room, date, duration_s, teacher_count (HIDDEN from raters), nemotron_count, pyannote_count}.
  - Box `~/eta-data/speaker-count-30/`. Due 15:30.
- **surg-page, after the surgery v3 hand-off:** a lean page. One window at a time with a play/scrub bar, then the rater answers:
  - "How many different people speak?" (0–8+);
  - "Confidence: sure / unsure";
  - an optional note.
  - Also: progress 0/30, autosave to db `counts/<rater id>`, and phone-first.
  - No machine counts are shown.
  - Reuse the surgery page's db/user/audio code. Due 16:30.
- **Launch:** Fable publishes after the surgery v3 link goes out (~17:00).
- **Scoring:**
  - Agreement V vs Sandhya.
  - Abs count error per engine (pyannote.ai, stock Nemotron, step-25, and each ruling-94 variant) against the human consensus.
  - This becomes THE count benchmark (V5 → V35).
