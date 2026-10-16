PASS
# REFUTE Part X: buddy relay shadow reach. Refuter cloud-buddy-l2 (cloudpane), 16 Oct 2026
Served by: claude-opus-5-5. Target: origin/consult/buddy-shadow-reach @ 9cd8a055 (32e0652b relay + C3 pg test), base 40afe070. PR #162 not touched.
Pre-flight: `git rev-parse origin/consult/buddy-shadow-reach` = 9cd8a055de7b8cf7013cc314eb67bca25524968d (matches).

## Gate lines (Linux cloud container, Node v22.22.0, TZ=Asia/Kolkata)
- `npm ci`: NOT POSSIBLE. `EUSAGE ... can only install with an existing package-lock.json`. Repo tracks no lockfile. Used the repo's own gate.yml recipe instead: `npm install` + `npm install --no-save vitest@2.1.9`.
- `npm run typecheck`: rc=0.
- `npx tsc --noEmit -p tsconfig.tests.json`: rc=0 (with vitest installed; before that, TS2307 'vitest' because vitest is not a declared dep).
- `npx vitest run tests/unit/buddy-relay.test.ts tests/unit/no-identity-literals.test.ts`: `Test Files 2 passed (2)`, `Tests 71 passed (71)`.
- `npx vitest run tests/unit/buddy-relay-pg.test.ts` (Docker 29.8.2, postgres:16 via tests/support/s1-pg): **RUN, not skipped.** `Test Files 1 passed (1)`, `Tests 8 passed (8)`, including:
  - `✓ ... shadow (window:false, live:true) on an ACTIVE 0.1.43 install lands one ref row and one command, args exactly {opaque_id, window:false, live:true} as JSON booleans`
  - `✓ ... shadow on a 0.1.42 install lands no ref row and no command`
  - `✓ ... consult_ended after a shadow open lands its command`
- `npm test` (full): `Test Files 442 passed | 1 skipped (446)`, `Tests 9191 passed | 6 skipped (9255)`, `Errors 7 errors`, exit 1. Every error is `[vitest-worker]: Timeout calling "onTaskUpdate"` (threads pool under load; ci.yml:29 documents the same). 0 tests failed. The 3 files that did not report (nemo-sweeper-pg, s1-emotion-zero-scored, s7-rubric-pg; none touch lib/buddy) re-run alone with `--pool=forks`: `Test Files 3 passed (3)`, `Tests 97 passed (97)`.
- `npm run check:silent`: `Found 9 silent-failure handler(s)`: the 9 accepted pre-existing findings; 0 in lib/buddy/relay.ts.

## C3 test check (release note)
tests/unit/buddy-relay-pg.test.ts:112-123 asserts `c.args` toEqual `{opaque_id, window:false, live:true}`, keys exactly `["live","opaque_id","window"]`, and `jsonb_typeof` of both = `"boolean"`; :125-128 asserts outcome `decide_false` and counts `{refs:0, started:0, ended:0}` on 0.1.42; :130-137 asserts consult_ended lands with args `{opaque_id}` after a shadow open. All behavioural, all ran green. The harness PREPAREs with untyped $n and sends values as strings (s1-pg.ts:72-81, 134-155), the same way the Neon driver does. So the builder's `::boolean` assumption is tested, not just assumed (see M5).

## Items
1. Args shape: PASS. relay.ts:274 `jsonb_build_object('opaque_id', opaque_id, 'window', ${window}::boolean, 'live', ${live}::boolean)`; consult_ended relay.ts:290 `jsonb_build_object('opaque_id', opaque_id)` is unchanged. Tests: buddy-relay.test.ts:140 (keys exactly), :655 (window:true carries window:true, live true/false), pg :66-73 and :112.
2. Enqueue rule: PASS. relay.ts:250-264: `!window && !live` -> decide_false; `!window && live && !appVersionAtLeast(v,"0.1.43")` -> decide_false; otherwise write. window:true is never version-checked beyond the pre-existing 0.1.22 floor. window:false + live:false is not enqueued: test :697 (on 0.1.43). window:true on 0.1.30: test :664 and pg :66.
3. Version compare: PASS. bench-bus-constants.ts:864-878 `/^\d+(\.\d+){0,3}$/`, numeric per part. I probed it directly against "0.1.43": 0.1.9 F, 0.1.42 F, 0.1.43 T, 0.1.43.1 T (4-part), 0.1.43.0 T, 0.1.44.0.1 F (5-part fails closed), "0.1.43-beta" F, "" F, " " F, null F, undefined F, "garbage" F, 0.1.430 T, 0.2 T, 1.0 T, " 0.1.43 " T (trimmed). Every non-parse fails closed (`if (!a || !b) return false`).
4. ACTIVE install only: PASS. relay.ts:142 `WHERE room_id = ANY(...) AND retired_at IS NULL AND enrolled_at IS NOT NULL`. The version comes from that same row (:147); migration 0075:190 uq_room_install_active_room makes the active row unique per room. The unit mock ignores retired/enrolled (buddy-relay.test.ts:31-33), so I ran my own real-pg probe (not committed). A room with a RETIRED 0.1.43 install and an ACTIVE 0.1.42 install with the same hostname gives `decide_false` and 0 rows. A room whose only 0.1.43 install is unenrolled gives `skipped`. 3/3 passed.
5. One statement: PASS. relay.ts:266-276: one data-modifying CTE (INSERT ref ... RETURNING) feeding INSERT bench_command. pg :78 (forced trigger fault on the command insert rolls the ref row back; a retry lands both) and the concurrency test both pass.
6. Metrics: PASS (not wrong). A skipped shadow increments decide_false and decide_shadow_skipped_version (relay.ts:257-260). skipped_version is a subset of decide_false, which matches the RelayOutcome "decide_false" returned. An enqueued shadow counts only in decide_shadow_enqueued (not decide_true). So decide_true + decide_false + decide_fault + decide_shadow_enqueued = decisions, each counted once, and the log guard (:325) sums exactly those. SHOULD: say "skipped_version ⊂ decide_false" in the header comment.
7. No uid/text: PASS. The only new log content is two integer counters on the existing line relay.ts:326. The other log lines (:329, :332, :335) are unchanged and counts-only. The new args are only the two booleans. Test :713 checks args and logs against consult_uid, doctor_uid, opaque_id, room id, key, host and version string.
8. Mutations (run in a separate worktree; target untouched). Each was killed:
   - M1 `>=` to `>` (strict, so 0.1.43 is excluded): 3 fail. `shadow + 0.1.43: one ref row and one command ...`, `consult_ended after a shadow enqueue is sent`, `no consult_uid, doctor_uid, text or token ...`.
   - M2a drop the window guard (`if (!window)` to `if (false)`): 8 fail, incl. `decide false: nothing is written`, `shadow + room on 0.1.42 ...`, `window:false + live:false: nothing, even on 0.1.43`.
   - M2b drop the live guard only: 1 fails. `window:false + live:false: nothing, even on 0.1.43`.
   - M3 (extra) drop the shadow version gate: 2 fail. `shadow + room on 0.1.42 ...`, RELAY-NR `a shadow decision {... 'fleet_off'} writes nothing`.
   - M5 (extra) drop both `::boolean` casts: pg test fails with `ERROR: could not determine data type of parameter $7` (window:true, rollback, concurrency and close cases all fail).
9. Scope: PASS. `git diff --stat 40afe070..9cd8a055`: lib/buddy/relay.ts 54, tests/unit/buddy-relay-pg.test.ts 46, tests/unit/buddy-relay.test.ts 125; `3 files changed, 197 insertions(+), 28 deletions(-)`. `..32e0652b`: the same 3 files, `157 insertions(+), 26 deletions(-)`.

Contract 3 (fresh read, no cache): PASS. resolveRoom runs on every call (relay.ts:201); there is no cache.
Contract 4 (BUDDY_RELAY_ROOMS first): PASS. relay.ts:198-199 runs before any read; test :688 shows no fetch and no write for an ungated room.
Contract 6 (reason_code null + window true): PASS. relay.ts:52-54 `window ? reason === null : ...`, enforced at :72; test buddy-relay.test.ts:724; a68423fb is an ancestor of 40afe070.

## MUST findings
- None.

## SHOULD findings
- S1 (test strength): the test `null, unknown and garbage version: no shadow enqueue` (buddy-relay.test.ts:670) does not exercise the new shadow gate. Every one of those values is already refused by resolveRoom's 0.1.22 floor (relay.ts:146), so M3 (removing the shadow gate) leaves that test green. The code still fails closed, but the test proves the older floor. Retitle it, or assert outcome `skipped` with no decide call.
- S2 (semantics to confirm): the RELAY-NR test `a shadow decision {window:false, live:true, reason_code:'fleet_off'} writes nothing` (:571) now passes only because the fixture room is 0.1.30. On a room at 0.1.43 or later, the relay would enqueue a shadow consult_started while newcat says fleet_off; the relay does not look at reason_code. That matches contract item 2 as written. buddy-lead should confirm that newcat never sends live:true together with fleet_off, or pin the test to a 0.1.43 room and decide which behaviour is intended.
- S3 (coverage): no committed test covers a retired or unenrolled 0.1.43 install next to an active older one; my probe (item 4) did, and it passed. Suggest adding it to buddy-relay-pg.test.ts.
- S4 (coverage): the PR has no test for 0.1.9 or a 4-part version; my direct probe (item 3) covers both.

## Not run
- Part Y (Swift recorder, buddy/l3-shadow-reach @ c464c613): out of scope for this brief. `swift build` and `swift test` were not run (Linux, no Swift toolchain).
- `npm run build`: not run (not in the brief's commands).
- `npm ci`: impossible, no lockfile (see gate). Neon over the real network: not run (no secrets, no network DB). The Neon binding behaviour is covered only through the s1-pg untyped-PREPARE emulation.
- The refuter probe and mutation edits were not committed.

Model serving this report: claude-opus-5-5
