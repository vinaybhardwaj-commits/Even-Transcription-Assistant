# Fable ruling 166: VJ uses V's existing labels and the stored doctor centroids (18:00 IST, 24 Sep)

V, 17:55: he has ALREADY labelled who spoke and how many voices for the diarizer (the split-speaker pilot pages and listen sessions, 9–23 Sep), and stored centroids of known doctors exist. This amends ruling 165. Where they conflict, 166 wins.

## What exists (Fable checked, 17:58)
Mini `~/dev/even-scribe-centroids/` (65 MB), copied to voice-lab-1 `~/vj/centroids/`:
- **ECAPA centroids.** `speechbrain/spkrec-ecapa-voxceleb`, 192-d, base64 in `*.json`, with meta, holdouts and enrol WAVs:
  - Dr Animesh Banerjee (ENT, OPD 3, TONOR);
  - Dr Prabhudev Salanki (Urology, OPD 5, C270; V-verified by listening, holdout conf 0.78);
  - Dr Ankit Bhojani (OPD 7 TONOR, plus a separate PWA centroid);
  - Dr Dibyendu Majumdar (Meet source);
  - Dr Poornima Parasuraman (Meet source).
- **V-verified listening clips.** `ankit-listen/` (5), `newdoc-listen/` (7: Prashanth OPD 4, Prerana OPD 6 / Room 4.1, Darshana OPD 7), and `identify/`. Each is a doctor-voice clip V confirmed by ear.
- **split-speaker pilot answers.** split-speaker locates these by 18:15 (answers.jsonl per page_v1..v6 / listen5 / roll-call).
- Centroids are source-conditioned: a room-mic centroid is not expected to match Meet or PWA audio at the same bar (Salanki note).

<!-- VJ-ADDENDUM-166-BEGIN -->
## A. Embedding model (replaces 165 C "wespeaker")
- Margin = cosine in **ECAPA space** (speechbrain/spkrec-ecapa-voxceleb), the same model as the stored centroids.
- **Doctor with a stored room-mic centroid for that room:** use it; with the multi-centroid rule, take the max over that doctor's centroids.
- **Doctor without one:** use the 165 profile, built with ECAPA.
- Runner-up = best other cluster in the window. A missing margin is still DOUBTFUL.

## B. Truth, in priority order (replaces 165 B)
1. V's existing labels: the split-speaker pilot answers, the V-verified listening clips and the Salanki verified turns. They are mapped to turns by time overlap ≥ 50%.
2. Speaker counts: V's and Sandhya's counts on the speaker-count page, plus V's V5 counts.
3. The new "Who is speaking" page: ONLY as a top-up, if (1) gives fewer than 60 labelled doubtful turns. Its size is then set by Fable to the shortfall plus 20%, not a fixed 150.

The blinding rules of 165 are unchanged. vj-data may inventory WHICH turns carry V labels (ids, counts). The label VALUES go only to `~/vj/truth/` for the scorer.

## C. Test-set priority
Windows from rooms with a stored room-mic centroid come first: OPD 3, OPD 5, OPD 7. Then OPD 4, OPD 6 and Room 4.1, where V's listening clips exist.
<!-- VJ-ADDENDUM-166-END -->

## D. Now
- **vj-data (by 19:00):**
  - inventory truth sources 1 (ids and counts only), using split-speaker's report;
  - recompute margins in ECAPA space against the stored centroids;
  - report the n of labelled doubtful turns per room. Fable then sizes or cancels the new page.
- **surg-page:** the page build stays on HOLD until Fable sizes it.
- **vj-refuter:** check the centroid provenance (holdouts, source-conditioning) and the label-to-turn mapping.
- Stamp three hashes on every result: b961291ae64c, 9c335c59c5be (165) and this one.

VJ-ADDENDUM-166 sha256 (first 12): **87b8cdac4330**
