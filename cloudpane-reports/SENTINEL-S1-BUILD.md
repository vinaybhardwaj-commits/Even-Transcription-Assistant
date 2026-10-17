# SENTINEL-S1-BUILD — device-aware repair copy on Rooms Live (cloud-sentinel-s1, branch cloudpane/cloud-sentinel-s1/s1 from bffc52f7)

## Files changed
- lib/steward/device-class.ts:1-16 (new): WEBCAM_RE / TONOR_RE moved here verbatim, plus `deviceClass(name)` -> tonor | webcam | unknown (TONOR tested first).
- lib/steward/input-failover.ts:38-39: imports and re-exports the two regexes (behaviour unchanged; input-failover imports node:crypto, so the client copy cannot import it directly).
- lib/rooms-live/present.ts:63-80: MUTED_STEP / UNPLUGGED_STEP per class; `stepsFor(state, device = "unknown")`. Webcam strings are the old ones byte for byte.
- lib/rooms-live/read.ts:16,45,50: `expected_device_name` added to the existing readInstalls SELECT on room_install. No new table, no new query.
- lib/rooms-live/snapshot.ts:12,59,286: RoomRow.device.kind = deviceClass(expected_device_name ?? input_device_name).
- Surfaces: components/rooms-live/RoomTile.tsx:46 (card first step), components/rooms-live/RoomDetail.tsx:26 ("How to fix" list).
- Terminal board PROBLEMS line: not in this repo (only mirrors/eta-lab python scripts use the word, none read stepsFor). Unchanged.

## Deviations (for fable)
- D1: the brief says expected_device_name was already read at read.ts:45-50; it was not (that SELECT read input_device_name only). I added the column to that same statement. SQL INFERRED: `room_install.expected_device_name` per migration 0081 (cited in lib/bench-commands.ts:711).
- D2: fallback to input_device_name when expected_device_name is null (a room that never reported an expected device but is live on a TONOR gets the TONOR text).
- D3: unknown-class unplugged line (brief said "equivalent"): "The computer cannot find the microphone. Check the microphone's USB cable at the back of the room computer." The unplugged follow-up lines (wait 30 s, STILL_NOT_WORKING) are kept for every class.
- D4: tests/unit/rooms-live-present.test.ts:31 banned "mute button" in present.ts; it now strips exactly MUTED_STEP.tonor before the check and asserts webcam/unknown copy never says it.

## Tests
- tests/unit/rooms-live-repair-copy.test.ts (new, 8): class mapping; TONOR silent; TONOR unplugged; C270 silent and C270 unplugged (equal to the bffc52f7 strings plus inline snapshots); unknown silent; unknown unplugged; other states device-independent.
- tests/unit/rooms-live-api.test.ts:80 (new): snapshot sets device.kind tonor / unknown / webcam from expected_device_name, else input name.
- tests/unit/rooms-live-present.test.ts:15,21,117: existing webcam assertions now pass "webcam" explicitly.

## Gate
- typecheck: `tsc --noEmit` rc 0.
- vitest full: `Tests  55 failed | 8081 passed | 1164 skipped (9300)`. Baseline origin/main in the same container: `Tests  55 failed | 8072 passed | 1164 skipped (9291)`. The failing-test name sets are identical (diff empty); all are "REQUIRED PROOF NOT RUN ... needs Docker" / "Docker is not available". +9 = new cases, all green.
- vitest is not in package.json devDependencies; installed vitest@3.2.4 with --no-save to run it. No lockfile committed.
- build: `✓ Compiled successfully`, `✓ Generating static pages (21/21)`, rc 0.
- check:silent: `Found 9 silent-failure handler(s)`; the 9 accepted pre-existing, none in changed files.
- swift build / swift test: UNPROVEN, no Swift toolchain in this Linux container (no Swift files touched).
- scrub: `bash scripts/steward/scrub.sh origin/main..HEAD` rc 0 (gitleaks 8.28.0 fetched to scratch, GITLEAKS env).

## Mutant (deviceClass forced to return "webcam")
```
× device class from the expected device name > TONOR, C270/webcam, and anything else (or nothing) is unknown 7ms
× repair copy by device > TONOR silent 3ms
× repair copy by device > TONOR unplugged 1ms
✓ repair copy by device > C270 silent: byte-identical to the old webcam text 4ms
✓ repair copy by device > C270 unplugged: byte-identical to the old webcam text 1ms
× repair copy by device > unknown silent 1ms
× repair copy by device > unknown unplugged 1ms
✓ repair copy by device > other states do not depend on the device 1ms
Tests  5 failed | 3 passed (8)
```
Restored; repair-copy suite back to `Tests  8 passed (8)`.

## FIX (refute PASS-WITH-FIXES, SENTINEL-S1-VERDICT.md): tests only, no code change
- F1 tests/unit/rooms-live-repair-copy.test.ts:57: RoomTile rendered with renderToStaticMarkup; muted TONOR markup contains "mute button on the mic", muted webcam markup does not (and contains the webcam USB line).
- F2 tests/unit/rooms-live-repair-copy.test.ts:25: deviceClass("TONOR webcam") === "tonor".
- M6 (RoomTile.tsx:46 stepsFor(row.state, row.device.kind) -> stepsFor(row.state)): `× F1 ... > a muted TONOR card says to press the mute button on the mic`, `AssertionError: expected '<section aria-label="OPD 3: Mic silen…' to contain 'mute button on the mic'`, `Tests  2 failed | 9 passed (11)`.
- M2 (TONOR/webcam check order swapped in device-class.ts): `× ... > F2: a name matching both regexes is TONOR (the mute-button text wins)`, `AssertionError: expected 'webcam' to be 'tonor'`, `Tests  1 failed | 10 passed (11)`.
- Both mutants restored (git checkout); diff after restore is the test file only.
- vitest repair-copy + present + api: `Test Files  3 passed (3)`, `Tests  56 passed (56)`. tsc (typecheck and typecheck:tests) rc 0.
- scrub.sh origin/main..HEAD: rc 0.
