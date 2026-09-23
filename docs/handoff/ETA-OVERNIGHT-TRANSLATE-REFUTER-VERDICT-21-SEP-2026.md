# ETA — overnight translate. REFUTER VERDICT. 21 Sep 2026

`vinay/overnight-translate` @ **`dcf7f9a`** (builder scribe3), base `45eedda`, 21 files, +3,097 lines, **no migration**. Refuted from my own detached worktrees `/tmp/refute-ot` and `/tmp/refute-ot-mut`; the builder's worktree was never written to, nothing pushed, nothing deployed, the driver was never started.

## PASS — one flag for V, no defect found

**Mutations: 19 of 19 killed.** Every item the order names is defended by tests. This is the strongest suite I have refuted this session.

### 1. `switch_override` requires WRITE scope — CONFIRMED, and it is the only door

The ruling is met, and more importantly the path cannot be walked around. Four independent checks:

- **Enforcement point.** `lib/jobs/submit.ts:74-77` checks `kind.scopeForArgs?.(args)` on the **parsed** args, after `parseArgs`, before `insertJob`. `room-window.ts` returns `{ scope: "write", arg: "switch_override" }` only for the literal `true`.
- **No second insertion path.** `insertJob` has exactly **one** caller in the whole repo — `submitJob`. There is no way to queue a job that skips the check.
- **No privileged internal caller.** All three internal submitters pass a minimal set: `room-drain.ts:512`, `diarize-job.ts:166` and `emotion/enqueue.ts:76` each pass `new Set(["invoke"])`. None can set the override even if it tried.
- **No coercion.** `optionalBool` (`room-window.ts:58-64`) **throws** `JobArgsError` on any non-boolean rather than coercing, so `"true"`, `"false"`, `1` and `0` are all refused at submit. The flag is stored only when `true`, so a job that asks for neither has byte-identical args to before.

Mutations P1 (return null), P2 (`invoke` instead of `write`), P3 (delete the check in `submitJob`) and P4 (coerce instead of throw) all die.

**The HTTP route is independently guarded**, so the scope rule is not the only thing standing there: `parseSwitchOverride` (`app/api/brain/cues/route.ts:160-166`) accepts only the literal `true`, only on a **`replay` batch**, and only with non-empty `cues` — the documented delete-only shape is refused by name (`switch_override_requires_cues`). P5–P8 all die. I checked the two other holders of `BRAIN_SERVICE_TOKEN`: the kiosk proxy (`app/api/bench/brain-proxy/route.ts`) is room-cookie gated, type-whitelisted to `live_sink_stats`/`consult_mark`, and builds its own body; `postBrainCue` (`lib/mcp/tools/brain.ts:265`) is typed single-cue with no `cues` array. Neither can form a replay batch, so neither can carry the override.

**The room setting is never written.** The only writes to `room.transcript_enabled` in the tree are the pre-existing admin route (`app/api/admin/bench/processing/route.ts:80,126`), untouched by this diff. The selector only ever **SELECTs** `transcript_enabled`; the cue route only **reads** it via `isTranscriptEnabled` and skips the 409. Verified by grepping the whole diff for writes: none.

**Least privilege per job:** the driver sets `switch_override` only for a window whose room is off (`driver.ts:92`); P19 (send it on every window) dies.

**One deployment note, not a defect.** Scopes are a **flat set**, not a hierarchy (`lib/mcp/auth.ts:30-49`) — a `write`-only token would fail the kind's own `invoke` check. The driver's token must list **`["read","invoke","write"]`**, which `door.ts` already documents. Separately, the legacy single `MCP_TOKEN` fallback is granted `ALL_SCOPES` (`auth.ts:93`), so that token satisfies the new requirement by construction; the rule binds map-issued tokens.

### 2-5. The other four items — all confirmed

- **07:10 IST stop and the clock gate** (`hours.ts`): pure epoch arithmetic on a fixed +05:30, nothing reads the machine timezone. Submit allowed 21:30 → 07:10, closed hours 21:30 → 07:30, the 20-minute gap sized against the longest measured router run (613 s) because the router has no cancel endpoint. P11 (07:30 stop), P12 (inclusive bound), P13 (start at 21:00) all die.
- **The gates** (`gate.ts`): fail closed on every unknown — unparseable line, non-finite `diarize_ms`, bad timestamp, a line older than 120 s, unreadable disk. `free_pct` is deliberately never read, which matches the standing finding that it is dishonest on this box. P14 (stale check), P15 (disk fails open), P16 (off-by-one on the diarize limit) all die.
- **The canary**: after each `done` job the store is asked whether the window has text but no English; `missing` counts as a failure and 5 consecutive stop the run. P17 (limit 50) and P18 (drop the branch) die. Measured: with a working check and no English produced, the run stops at **5 windows**, `fatal: too_many_failures`.
- **The deploy-order guard**: there is **no explicit one** — the canary *is* it. A deploy predating this branch drops `translate` silently (`parseArgs` at 45eedda returns only four keys), and the canary is what turns that into a stop. That makes the flag below matter more than it otherwise would.

## FLAG for V — the canary fails open, alone among the gates

`driver.ts:264-269`: if `englishCheck` **throws**, the window is recorded `done` and `consecutiveFailures` is reset to 0. It is deliberate, documented and tested (`overnight-translate-driver.test.ts:456`, asserting `done: 1, failed: 0`). I am not calling it a defect — but every other gate in this branch fails closed, and this one does not, so V should rule rather than inherit it.

Measured on 40 candidate windows, same absence of English in both arms:

| English check | outcome |
|---|---|
| working | `done=0 failed=5 stop=fatal too_many_failures` — stops after **5** |
| throwing | `done=40 failed=0 stop=backlog_empty` — **all 40**, plus 40 unread `english_check_unavailable` lines |

**Failure scenario:** the app is under load at 02:00, the `englishCheck` read fails the way any database read can, and the bound that exists to cap the damage at 5 windows is silently switched off for the night. The production backlog is 2,388 windows. The cheapest fix is to count consecutive `english_check_unavailable` toward a stop — its own limit if 5 is too tight.

## Gate, my run

- `typecheck` exit 0. `build` `✓ Compiled successfully in 8.5s`. `check:silent` at the accepted 9, **0 in any file this branch touches**.
- `npm test`, **clean run with nothing else on the machine**: `Tests 1 failed | 3469 passed | 1 skipped (3471)`, 325 s. The one failure is `e31b-atomicity R58`, the known flake.
- An earlier run showed a second failure (`c3-emotion` "Test timed out in 5000ms" on a trivial flag-parser test). That was **my own contention** — I had the 19-mutation harness running against the same machine. It is not a branch finding, and the clean re-run is the one above.

**Verdict: PASS.** The write-scope ruling is implemented at the only place it can be enforced and cannot be routed around; the hours, gates, canary, least-privilege override and the never-written room setting all hold under mutation. The canary's failure posture is the one thing worth a ruling before this runs a night.
