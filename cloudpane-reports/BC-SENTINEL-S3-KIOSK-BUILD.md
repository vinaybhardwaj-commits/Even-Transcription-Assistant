# BC-SENTINEL-S3-KIOSK-BUILD (lane bc-s3k)
Sentinel S3 kiosk side: parse consult_live (control wire form 3) in the room-guardian killswitch. Base a769f4d2 (Guardian R16e build A). Branch bc/sentinel-s3-kiosk.

## What changed (2 files)
- tools/room-guardian/kiosk/lib/killswitch.sh: form-3 peel before the existing consult_open split. A line starting `{"consult_live": ` is split by searching the kill member region anchored at the line end (only the real one can be well-formed to the end) and crediting the consult_open member only when well-formed, so the remainder re-enters the existing parser as an exact form-1 or form-2 payload: kill, modes, ts, skew, stale and the consult hold parse identically with or without the field. The live map is then resolved by the same well-formedness bar as the consult hold (exact shape, strictly ascending keys, this room's key exactly once): `true` -> live, `false` -> not_live, everything else (absent room, malformed, over the 64-room cap, old forms, kill, stale, invalid room name) -> unknown. New constants CONTROL_LIVE_PFX, CONTROL_KILL_RE, CONTROL_OPEN_FAG_RE (no CONTROL_RE widening). New function consult_live_state -> live|not_live|unknown (nothing consumes it yet; S4 will).
- tools/room-guardian/kiosk/tests/t_sentinel_control.sh: 11 functions, 78 assertions (form-3 valid true/false/absent/kill-true; 15 malformed-consult_live variants all leaving kill/modes/hold unchanged; old-form byte-identity table with live=unknown; stale/skew still apply; room-named keys do not move boundaries; 200 KB, trailing junk, duplicate kill/ts/modes-key, 65-room and 4096-byte-cap kills; NUL and high bytes via the raw check; the consult_live_state function). Reuses t_control.sh helpers (same pattern as t_shadow_all.sh); needs t_control.sh sourced first, as the default t_*.sh glob order guarantees.

## Gates
- New tests: TFILES="t_control.sh t_sentinel_control.sh": `tests: 83 functions, 497 assertions passed, 21 failed (0 leaked sandbox dirs)`; the 21 failures are the same t_control.sh Linux-platform functions that fail at base (per-function diff below: zero status changes).
- Whole kiosk suite, same host/shims as base: base `tests: 345 functions, 1355 assertions passed, 875 failed (7 leaked sandbox dirs)`; branch `tests: 356 functions, 1434 assertions passed, 874 failed (7 leaked sandbox dirs)`. Per-function comparison of all 345 shared functions: 345/345 identical status, 0 regressions, 0 new passes; 7 CRASH functions identical in both. The 1-assertion raw-failure delta is inside an already-failing platform test (assertion-count flake, not a status change).
- shellcheck -x (0.11.0) on lib/killswitch.sh and tests/t_sentinel_control.sh: rc 0. Static no-perl/python/osascript/jq test: ok (1). scripts/steward/scrub.sh --staged (gitleaks 8.30.1, installed to ~/.local/bin for this run): rc 0 clean.
- Linux UNPROVEN: the suite is macOS-shaped; run used a test-only BSD `date`/`sqlite3` shim on PATH (outside the repo), identically for base and branch. Run the full suite on the Mini for the real verdict.

## Mutants EXECUTED (applied to the real file, real tests, then reverted; git diff back to 59+/3-)
- (a) absent room -> not_live (CTRL_LIVE default flipped): 5 functions red, e.g. `FAIL: other rooms only: absent = unknown (mutant a: not not_live): expected [0|on|heal|ok|clear|unknown] got [0|on|heal|ok|clear|not_live]`. KILLED.
- (b) malformed consult_live kills the line: 4 functions red, e.g. `FAIL: malformed live 1: kill/modes/consult_open unchanged, live unknown: expected [0|on|heal|ok|clear|unknown] got [1|on|heal|unparseable|clear|unknown]` and `FAIL: a malformed live never engages (mutant b...): rc expected 1 got 0`. KILLED.

## Push
- `git push -u origin bc/sentinel-s3-kiosk` FAILED: no credentials in this environment (https remote, "could not read Username"). Commits are local (tip after this commit); push from an authenticated host.

## Documented residual (design, not a defect)
An unclosed consult_open D holding a well-formed consult_live plant could credit the plant for the HOLD (clear only on the exact new form, same bar as the live read). Kill is always safe; the live read itself is exact-form-only.
