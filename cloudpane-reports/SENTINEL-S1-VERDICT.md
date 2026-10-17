# SENTINEL-S1-VERDICT (cloud-sentinel-s1-refute)
Serving model: claude-sonnet-5-5. Target origin/cloudpane/cloud-sentinel-s1/s1 (dd997d7d) vs base bffc52f7.

## Verdict: PASS-WITH-FIXES
Production code is correct on every point in the brief. Two test gaps (F1, F2) let mutants survive. No code change required to ship.

## Gate (rerun by me)
- tsc --noEmit: rc 0.
- vitest full (vitest@3.2.4, --no-save): branch `55 failed, 8081 passed, 9300 total`; base bffc52f7 `55 failed, 8072 passed, 9291 total`. Failing-name sets diffed by JSON reporter: identical (empty diff). All Docker-required.
- build: `Compiled successfully in 38.7s`, static pages generated, no errors.
- check:silent: `Found 9 silent-failure handler(s)`; the accepted 9.
- scrub.sh origin/main..HEAD (gitleaks 8.28.0): rc 0, no output.
- swift build/test: UNPROVEN, no toolchain, no Swift touched.

## Webcam strings (item 2)
Scratch test read bffc52f7:lib/rooms-live/present.ts, extracted the old muted and unplugged-first literals, and asserted equality with stepsFor(state,"webcam")[0]: pass. Follow-up lines (wait 30 s, STILL_NOT_WORKING) are untouched in the diff. notrec/off steps equal for tonor vs webcam.

## Deviations (item 3)
- D1 SAFE. db/migrations/0081_room_states_and_verbs.sql:51 `ADD COLUMN IF NOT EXISTS expected_device_name text NULL`. Same table (room_install), same WHERE, no new query. Already selected by lib/room-install.ts:2043 and lib/steward/loop.ts:473, so it exists in prod. read.ts maps `?? null`. Builder was right that read.ts did not read it before.
- D2 RIGHT in the cases that occur. Failover and desk switches go through set_audio_input, whose ack rewrites expected_device_name (bench-commands.ts recordExpectedDevice), so expected follows the live mic. Null expected (pre-0081 row) falls back to the live input name. Residual: expected=TONOR but live input is the webcam (device drifted, DEVICE_CHANGED) shows TONOR text. Acceptable, that state has its own handling; noted, not a defect.
- D3 FINE. Unknown unplugged text is neutral and keeps both follow-up lines.
- D4 FINE. The present.test ban on "mute button" now strips exactly MUTED_STEP.tonor and still asserts webcam and unknown never say it.

## Real names (item 4)
"TONOR TM20 Audio Device" -> tonor (/tonor/i). "C270 HD WEBCAM" -> webcam (/c270|webcam/i). Empty, null, undefined -> unknown. Verified by executing deviceClass in a scratch test (removed).

## Other surfaces (item 5)
grep of webcam / "USB cable" / "mute button" across app components lib: the only webcam repair text is present.ts MUTED_STEP/UNPLUGGED_STEP. stepsFor has exactly two callers (RoomTile.tsx:46, RoomDetail.tsx:26), both pass row.device.kind. app/api/rooms-live/now/route.ts:49 builds a degraded row with no kind, which resolves to the neutral text. lib/bench-bus-constants.ts:258 START_FAILED_HINT is already generic. No surface left that shows webcam text to a TONOR room.

## Mutants (item 6; run on rooms-live-repair-copy, -api, -present: 53 tests)
- M1 muted step forced to webcam: KILLED (2 failed).
- M2 regex order swapped (webcam tested first): SURVIVED, 53 pass.
- M3 drop input_device_name fallback: KILLED (1 failed).
- M4 unplugged step forced to webcam: KILLED (2 failed).
- M5 ignore expected_device_name, use input only: KILLED (1 failed).
- M6 RoomTile drops row.device.kind: SURVIVED, 53 pass.
All mutants reverted; working tree clean.

## Findings
- F1 (test gap, low). M6: no test renders RoomTile with a TONOR row, so the card's first-step line (the main surface) could regress to the webcam text unnoticed. Repro: sed `stepsFor(row.state, row.device.kind)[0]` -> `stepsFor(row.state)[0]` in components/rooms-live/RoomTile.tsx, rerun the three suites, all green. Fix: in tests/unit/rooms-live-steward-log.test.ts style (renderToStaticMarkup of RoomTile) add a muted TONOR row asserting the markup contains "mute button on the mic" and a webcam row asserting it does not.
- F2 (test gap, trivial). M2: the "TONOR tested first" comment in lib/steward/device-class.ts is untested. Fix: assert deviceClass("TONOR webcam") === "tonor".
- F3 (note). vitest is not in package.json; the suite needs a manual install. Pre-existing, not this change.
