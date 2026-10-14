# LOG — ORBOX (OT recorder upgrade for robotic surgery)

Build and event log, newest first. Owner to propose. This project is new (V, 26 Sep).

## 26 Sep — project named; requirements listed
Session: roadmap (this pane); V's brief.
Goal: upgrade the OT recorder (Linux orbox3 in ORB3) to capture robotic surgeries. Requirements from V: separate USB webcam recording its AUDIO and VIDEO separately; DUAL AUDIO = TONOR mic + webcam mic; webcam VIDEO recorded; more microphones around the room (V wrote "speakers" — likely microphones, to confirm); possibly WIRELESS DIRECTIONAL mics.
Refs: brief (programme 16).

## Open items (all decisions for V — see DECISIONS D-2..D-5)
1. Confirm "speakers" = microphones.
2. Video of patients in the OT: consent / PHI policy (V's call).
3. Hardware purchase list + purchase (V).
4. Linux capture software: multi-device sync, a timebase, storage per hour, retention.
5. How video joins the pipeline: storage, viewer, PHI handling.
6. Test plan: run SELFTEST stimuli in the empty OT.
7. Phased delivery plan.
Refs: brief.

## Relevant existing facts
orbox3 is a 12-core CPU Linux box (no GPU), herdr machine, off-hours worker (r415.7: user-local Node install, no sudo). It already runs the OT recorder app. Never change its recorder app without a ruling.
Refs: r415.7; orders/LANES.md; HANDOVER-scribe.md §(b)6.
