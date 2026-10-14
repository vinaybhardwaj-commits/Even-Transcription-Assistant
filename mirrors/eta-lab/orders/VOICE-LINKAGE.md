# VOICE-LINKAGE: find each doctor's voice from PQM + prescriptions + recordings, V agrees or disagrees, then mint centroids (ruling 183)

V asked for this on 24 Sep at 18:40. It is part of the VJ queue (VOICE-JEV-BUILD), as Phase L. Fable owns all verdicts. V's standing voiceprint rules apply: harvest only, multi-centroid, all proxies allowed, and the room recorder has no interface. Known trap: the warehouse has no room dimension, so a room is never bound to a doctor by assumption; it is inferred from evidence.

## Why
The stored centroids fail on current audio (ruling 182; median 0.22). New centroids must come from current room audio and be tied to the right doctor by evidence that V confirms.

## The linkage (per room-day, then per speaker cluster)
For each room-day with recordings (start: 1 Aug–24 Sep, the rooms with the most audio first):
1. **PQM timing.** For each doctor D, take D's consult calls that day (Metabase db 13, queue_token_steps CONSULTATION called_at/completed_at). Measure how well they line up with the encounter starts/ends detected in room R's audio. Reuse lx's E-7 PQM truth alignment; do not rebuild it.
   Output: the best doctor for the room-day, with n consults matched, median offset and runner-up.
2. **Recurring voice.** Within the matched consults, the doctor is the speaker cluster present in most consults, while patients change. Output: the share of consults that contain the cluster.
3. **Prescription content.** For patients in those consults, take D's prescription items (drugs, doses, tests; the Rx.consult_uid = calendar event uid join from mb-rx). Count how many are spoken by that cluster versus by others.
4. **Jev.** On that cluster's transcript turns (guarded text), ask: Q1 of the frozen card, "who is speaking", and a new frozen question LQ: "Do these turns contain the doctor's instructions or the prescription items listed below?" (yes/no). Freeze LQ with a hash before any real run.
5. **Cross-day check.** Embed the cluster (ECAPA, the same pipeline as the ruling 182 controls). Compare it with D's clusters on other room-days, which should match, and with other doctors' clusters, which should not.
- **Confidence tier:**
  - HIGH = PQM matched on ≥ 3 consults, recurring ≥ 70%, Rx items spoken ≥ 1, Jev doctor ≥ 0.70, and cross-day agreement;
  - MED = 3 or 4 of these;
  - LOW = the rest.

## The artifact: "Doctor voice check" (V agrees or disagrees)
- **One card per proposed link:** room, date, proposed doctor.
- **Evidence in plain words:** e.g. "PQM: 9 of 11 consults line up, within 40 s; this voice is in 10 of 11; says 6 of 8 prescribed items; Jev: doctor, 0.86; matches Dr X's voice on 3 other days".
- **Audio:** 3 short clips (4–8 s each) of the proposed doctor voice from different consults, plus 1 clip of another speaker in the room for contrast.
- **Buttons:** Agree / Disagree / Not sure. On Disagree: "Who is it?", from the doctor list or unknown. An optional note.
- **A second card type, "Same person?":** pairs of clips from the same doctor on different days or rooms. Agree / Disagree.
- **Page mechanics:** phone-first. Built by surg-page, reusing the speaker-count page pattern: db `links` (read view, write admin), `verdicts` (read/write interact), user. Fable publishes.
- **V's time:**
  - first batch: 40 cards (about 20 min), stratified: 20 HIGH, 12 MED, 8 LOW;
  - if V agrees with ≥ 95% of the HIGH sample, the remaining HIGH links are accepted without review;
  - MED and LOW always need a human.

## Minting
- A centroid is minted ONLY from links V agreed with, or from accepted HIGH links.
- Minting is per doctor × room/mic source (multi-centroid), from ≥ 60 s of clean non-overlap speech taken from ≥ 2 consults, with a held-out day.
- The ruling 182 positive control must reach ≥ 0.70 on the held-out day. Disagreed links become negatives in the VJ truth.
- These centroids feed VJ's margin (ruling 182 step 3) and Nemotron's silver labels (Phase 4, only on Fable's go).
- Nothing is written to production voice_print.

## Roles
- **vj-link** (NEW, Sonnet builder, box pane; compute on voice-lab-1): steps 1–5, the tiers and the card data. Metabase and Neon read-only.
- **lx:** hands over its E-7 PQM alignment code and outputs (read-only reuse).
- **mb-rx:** the Rx item join for the matched consults.
- **surg-page:** builds the page.
- **vj-refuter:** refutes the tiering, the LQ freeze, the clip selection (no patient-only clips as "doctor"), the HIGH auto-accept rule and the minting controls.
- **Fable:** publishes the page, reads V's verdicts, rules on minting.

## Deadlines
- By 21:00: the pilot on the 5 best-recorded room-days, 10 cards, to Fable.
- Tomorrow 12:00: the first 40-card batch published for V.

## Hard rules
- No production writes.
- PHI stays in eta-lab, the box and voice-lab-1 (private).
- LQ wording is frozen by hash before any real run.
- Never two builders on the same files: vj-link owns `studies/2026-09-24-voice-jev/link/` only.

## Addendum 18:50 (V)
- V can rate MORE than 40. The first batch is **60 cards** (30 HIGH, 18 MED, 12 LOW), then rolling batches of 40 as new links are proposed.
- HIGH auto-accept needs >= 95% agreement on >= 30 rated HIGH cards.
- Data residency: V says patient data may be stored in any region. The R2 buckets stay where they are.
