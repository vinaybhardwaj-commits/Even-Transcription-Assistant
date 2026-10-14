# VP-AUTO pre-registration rev9 — consult-lead, 06 Oct 2026 ~19:00 IST — FROZEN at the sha256 in ORDERS-vp-auto-01

Goal: mint a doctor's voiceprint automatically from presence consult windows (extension login + consult open/close, consulting doctor from the warehouse) and room tape, with V's ear needed only for doctors the rules cannot decide.

## Inputs (unchanged from vp-fast-01)
Closed windows from the daily export, tape from the box mirror, blind room-days excluded (union f07171dc via heldout.py, start day and end-minus-1 s day). pyannote 3.1 diarization; ECAPA speechbrain/spkrec-ecapa-voxceleb 192-d, L2-normalised. Mint line: cluster cos >= 0.55 to the doctor's running centroid (as vp-fast-01).

## Mint
The print is the centroid of the doctor's mint-matching clusters across windows (multi-centroid allowed as in vp-fast). Secondary mint-matching clusters in a window are pooled into the same print; absorption (P4b) is REPORTED ONLY and never blocks (06 Oct ear check: it blocked 5 doctors who were all confirmed).

## Gates (all computed per doctor; numbers fixed now)
- G-thin: >= 5 windows with an embedded mint-matching cluster, on >= 2 days, >= 60 s total mint-matching speech. Fail -> WAIT (re-run when more data accrues), no listening.
- G-sex: F0 median vs name sex; 145-185 Hz is inconclusive (not a fail). Clear contradiction -> REJECT.
- G-loo (identity stability): leave-one-window-out. Rebuild the print without window w; take w's best-matching cluster; it must rank top-1 against the doctor's own print vs every other print in the comparison set (all other prints from this run + provisional prints + production prints in the same model) in >= 90% of windows, with median margin >= 0.30.
- G-distinct: cos(print, every other print in the comparison set) < 0.60. A pair at >= 0.60 -> both go to EAR.
- G-presence: the mint cluster is present in >= 80% of windows that have any embedded speech.

## Routing
- AUTO: every gate passes.
- EAR: G-loo, G-distinct or G-presence fails but G-thin and G-sex pass; or F0 is in the dead zone AND the name sex is uncertain.
- WAIT: G-thin fails.
- REJECT: G-sex contradicts.

## Dev set (rules may be checked, not tuned further)
The 6 ear-confirmed doctors of 06 Oct. Expected: none REJECT. Report each doctor's route. A doctor not routed AUTO is reported with the failing gate; the thresholds above are NOT changed after this.

## Test set
Every doctor in the export who is not one of the 6, with tape. As of 06 Oct: Manoj C, Manoj Kumar S, Shankar Kurpad, Shilpa Nadig, Animesh Banerjee, Prashanth Nagaraj (only if OPD 4 tape exists). Data through the latest export at run time.

## Acceptance test (V's ear, blind)
Listening set = every AUTO and EAR doctor of the test set: 5 mint clips (>= 2 days where possible) + 2 decoys (another doctor's print from the same room, else a non-mint recurring voice), shuffled, key kept on the box. Per-doctor result as in vp-fast-01: CONFIRMED if yes to >= 4 of 5 mint clips and no to both decoys.
- PASS for the method: zero AUTO doctors REJECTED by V, and every decoy across the set answered no.
- The method runs unattended (nightly, AUTO -> provisional print with no ear) only after 10 consecutive AUTO doctors are ear-confirmed, counted across this test and later runs. Until then every AUTO mint still goes to V's ear.
- Any AUTO doctor REJECTED by V stops the method; consult-lead revises the rules as rev10 and the count restarts.
