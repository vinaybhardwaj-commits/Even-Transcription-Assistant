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
