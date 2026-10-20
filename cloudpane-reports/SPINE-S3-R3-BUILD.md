# SPINE-S3-R3-BUILD (spine/s3-artefacts, on 26a17057 + merge of origin/spine/s2-merge a813683b)
## Changed
- NEW lib/room-access/readers/spine-artefacts.ts: all room-table SQL of S3 (reb_track_index, diarize_nemotron_window, catalog dup/blind probes), explicit FROM/JOIN. Blind ids (room-access blindWindowIds) bound as $2; rows of a blind window come back `blind=true`.
- lib/spine/artefacts.ts: imports the reader's defs; no room-table SQL left; planner counts `blind_excluded` (checked first, nothing mapped); L1 nemotron object_key = row id (`s.id` selected); `sourceParams`.
- lib/spine/artefacts-store.ts: `opts.blindIds` (default blindWindowIds, dynamic import); a throwing lookup stops the run before any source read; off still makes 1 query.
- L2: catalog page key = consult_uid || chr(31) || kind ('c' clip, 'l'+chr(31)+layer). N9: dup_source = consult_index match, or reb row of a NON-blind window with an ACTIVE link to the SAME encounter; as hashed LEFT JOINs (A8 page: 67 ms, was 483 ms).
- tests/support/room-access-allowlist.ts: pin for lib/spine/artefacts.ts REMOVED. Gate scanner untouched.
- Tests: refute's 9 adv tests ported (spine-artefacts-r2-oref), new spine-artefacts-r3 (G1 blind pg, off/throw, L1, L2 boundary, N9), spine-artefacts-default-blind (no docker). Existing 2 files updated (NO_BLIND opt, columns, nemotron key, positional-param driver now maps $n).
## Tests (own runs)
- spine-artefacts* + room-access-gate: "Tests 58 passed" (room-access-gate passes WITHOUT the pin).
- .bc/gate.log: typecheck, typecheck:tests ok. vitest "Test Files 2 failed | 459 passed | 1 skipped (462)", "Tests 2 failed | 9473 passed | 5 skipped (9480)". The 2 failures are e11-silent-room-window and no-identity-literals, the same 2 as base (S3 R2 refute: base 2 failed); new failures 0. gate=1 only because of those, so build/silent ran separately: build=0 "Compiled successfully"; check:silent finds the 9 accepted findings, 0 in lib/spine. swift: N/A on Linux. vitest on c3 needs --minWorkers=1.
## Mutants (all reverted; sources diffed against saved copies)
- Killed: N1-N16 (N9 now in the reader), N9c (same-encounter dropped), B1 reb blind col, B2 nemotron blind col, B3 catalog blind, B4 reader bypassed, B5 planner ignores blind, B7 default lookup fails open, L1 revert (checked by hand: 1/2 keys), L2 revert.
- Equivalent: B6 (catalog dup probe not excluding blind windows): a blind key already wins via the blind column, planner checks blind first. Kept as defence. M14 stays the documented equivalent.
## Assumptions
- BLIND_ROOM_DAYS is empty (lifted 10 Oct), so blindWindowIds returns []: the pg test injects ids. The filter is by window id (reb_track_index/nemotron carry window_id).
- The harness mutation script was SIGTERMed once mid-run; the leftover mutation was found and reverted before the gate.
## Open
- Scanner blind spot for SQL held in strings: not touched (fable). Re-sweep cost on real counts unmeasured. blindWindowIds is session-wide and may be large on the real DB.
