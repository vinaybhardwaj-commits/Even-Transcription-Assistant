# Surgery v3 final set: selection gate, eta-refuter-2 (bus #321)

Input: `~/eta-data/surgery-review-v3/gate-report-final.json` (off git), 12 items, run with `gate_check.py`. Ids and counts only.

**Verdict: PASS.**

## Leakage against V's 18 labelled consults
- Token overlap: 0. Same patient: 0.
- Time overlap: 4 pairs (Q29 twice, W66 twice). Every one is a different doctor (checked via the queue CONSULTATION step's `routing.DOCTOR_UID`), so none is leakage.
- Q29's pairs were already cleared in set A.

## Within the set
- 12 unique tokens and 12 distinct patients, none null.
- One time overlap, Q34 with Q36: different doctors.

## Calls
- Wording sha 64ba6c7 / a29f22245670; judge eta-refuter-2, blind; share 8 of 12.
- Every item's call matches my locked verdicts.
  - Proposals: Q20, Q27, Q28 (minor), Q29, Q32, Q36 (minor), R06, W66.
  - Look-alikes: Q06, Q34, W95, W150.

## Ship bundle
- 12 consult JSONs and 12 full.mp3 files: sha256 matches the manifest.
- 110 referenced clips, 0 missing.

**Finding (low):** 25 clip files are referenced by no turn and are absent from the manifest.
- 9 of them are greyed turns before the encounter. That audio is already inside full.mp3 by design, so they add no new exposure.
- Their URLs are guessable (turn-number names).
- Seed only the referenced files, or delete the 25 first.

## Not checked
- Audio edge timing to the second.
- De-identification recall on the page text.

## Re-check after the fix (bus #323)
fleet removed the 25 orphans and made ship_v3.py copy only referenced files, asserting disk == references per folder (28b5983). I re-verified: 12 consult and 12 full.mp3 sha256 match the new manifest; 122 audio files = 12 full + 110 referenced clips; 0 orphans, 0 missing; nothing else in ship/. **The finding is closed.**

## Re-cut re-verify (fleet #475, 16:21)
PASS against the NEW manifest.
- Hashes: all 12 consults, mp3s and mp4s match.
- Files: 147 on disk, equal to the references.
- mp4 == mp3 duration (ffprobe diff 0.00 s).
- Clips: every clip is exactly encounter +-120 s. 0 visible or evidence turns lie outside their clip.
- Sizes: mp4 61.4 MB total, max 11.51 MB.
- My bounds survived: W95 178-337, W150 64-232, R06 from 80, W66 17-189.

OPEN: ship-key.json was rewritten at 16:21 and there is no earlier copy. #318 said V3-06 = Q29, but the key now maps V3-06 -> R06 and Q29 -> V3-12 (consistent with Q29's encounter length and with lx #468 for V3-03). Asked fleet to confirm the mapping is unchanged since the first ship (bus #482).

## V3-01 (Q20) re-read and the fold-fix re-ship (bus #489, #499, #501)
- **V3-01 is ONE patient across all 43.8 min.** This is a text read of the whole encounter plus fleet's judge-I windows at lx's two voice-change points.
  - At ~10:33: staff are handling reports, then the same work-up continues.
  - At ~10:43: the doctor counsels the same patient, restating his opening history.
  - lx withdrew the voice finding after a negative control showed the embeddings cannot separate patients (#495).
  - Correction: my #489 clock times were 3 min late (turn-clock 0 = 10:18:05, not 10:15:05).
- **Fold-fix re-ship: PASS.** Manifest hashes match (147 files). The 6 edge turns are unfolded. 0 before-turns remain folded while ending inside the clip.
- **Unblinding:** V rated 4/12 before the 16:21 re-cut (surg-page #493). The mapping is proven unchanged (seed + fleet's order reproduce the key; key sha 1ca9a2ec), so those ratings decode to the same consults. Whether ratings made on the longer lead-in are kept is Fable's call.
