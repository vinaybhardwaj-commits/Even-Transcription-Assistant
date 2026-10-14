# ORDER — ETA-Refuter: refute the speech gate (Fable, 2026-09-21)
You are the Refuter. You did the root-cause work on noise-as-speech; you did NOT build this. Your job is to break it.

Target: branch `vinay/speech-gate` @ f245547 (builder: scribe). Check it out in your OWN fresh worktree (e.g. `git worktree add /tmp/refute-gate vinay/speech-gate`). Never edit scribe's worktree, never push, never merge, and never restart the production router on :8083.

What the build claims (verify each claim, don't trust any):
1. A Silero speech gate sits in front of diarizer segment storage, behind a flag that defaults OFF. It FLAGS segments; it doesn't drop them.
2. `roomEnergyFloor` (lib/stt/window-measure.ts:124) now uses the room, instead of ignoring it.
3. A `/vad` route was added to the router (speech spans only, no transcription), with a client `fetchWindowSpeech`. It fails safe: no endpoint or error → `vad_unavailable`, which judges nothing.
4. Tests 3279 pass / 1 skipped; 13 mutations, 12 red. The builder concedes one mutation can't be killed (the `if (!base)` guard in fetchWindowSpeech).
5. Measurement on held-out closed-hours segments: separation −34.4pp at the 1 s floor, −33.5pp at Silero 0.3, plus a clinic-hours cost figure.
6. D15: window assembly from the covering pieces the join refusal returns. Verify this is the documented behaviour (file:line), not a workaround.

Do:
- Rerun the full test suite and typecheck yourself. Run your OWN mutations on the gate decision, the flag default, the floor-per-room change and the fail-safe path. Report how many you killed.
- Recompute the separation figure from the builder's evidence files: are the held-out segments actually held out (not the ones the threshold was tuned on)? Does the clinic-hours cost count real doctor speech wrongly flagged?
- Confirm that flag OFF means byte-identical behaviour to production 45eedda on the drain path.
- Test /vad on a SECOND router instance on a spare port only, if you need it live.
Report ≤30 lines: PASS / PASS-WITH-FIXES / FAIL, each finding with file:line and a failure scenario. Add one `[speech]` ledger line with your verdict number (cat >> only).
Queue after this one (don't start until this report is in): `vinay/join-only-clips` @ 3ca19d5. I'll send a separate order.
