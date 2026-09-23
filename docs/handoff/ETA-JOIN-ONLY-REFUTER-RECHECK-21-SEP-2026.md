# ETA — join-only clips, F1–F3. REFUTER RE-CHECK. 21 Sep 2026

`vinay/join-only-clips` **`3ca19d5` → `7609139`** (builder scribe), one commit. **No source change**: the diff is two test files and the build report. Own detached worktrees `/tmp/refute-joc2` and `/tmp/refute-joc-mut`; builder's worktree never written to, nothing pushed, no clip created, no write of any kind. Re-checked F1–F3 only, as ordered.

## ALL THREE FIXED — PASS

**Mutations: 15 of 15 killed** (was 12 of 15). All three survivors are dead and the other twelve stayed dead.

### F1 — the census is green, and updated deliberately

`tests/unit/room-switches.test.ts` now passes **18/18**, and the map carries `"lib/stt/join-only.ts": 1` with the reason written next to it: this is the one call site *allowed to be overruled*, by `includeTranscriptDisabled`, because joining audio is not transcribing it — and folding it into another site "would have hidden that exception inside a guard whose purpose is to have none." That is the deliberate update the order asked for, not a bumped number.

**The root cause is worth more than the fix.** The census runs `git grep`, which sees **tracked files only**. The builder ran the full suite while `join-only.ts` was still untracked, so the census counted nine and passed; committing the file is what turned it red. I verified the mechanism rather than take it on trust:

```
untracked lib/zz-refuter-probe.ts  -> git grep does NOT see it
after `git add -N`                 -> git grep DOES see it
```

So the green gate they quoted was real at the moment it ran, and blind to the very file it exists to check. **Any `git grep`-based tripwire under-reports until you stage** — that is a fleet-wide trap, not a lapse by this pane, and I have ledgered it as such.

### F2 — the seam is now genuinely executed

`tests/unit/join-clip-seam.test.ts` imports the real `joinClipForWindow` and mocks only its three collaborators (`@/lib/db`, `@/lib/r2`, `@/lib/bench-join`). It does **not** mock `@/lib/stt/room-drain`, which was the whole defect.

**Control — the same `throw` inside the real `joinClipForWindow`, run against both files:**

| test file | result with the throw | meaning |
|---|---|---|
| `join-clip-seam.test.ts` | **5 failed / 1 passed (6)** | it really executes the function (the 1 pass is the listing test, which does not call the seam) |
| `join-only.test.ts` | **20 passed (20)** | it still never executes it — exactly the F2 defect, now visible side by side |

That pair is the proof the fix is real rather than cosmetic. My three survivors now die:

| mutation | before | now |
|---|---|---|
| **K15** return `ok:true` after a failed clip-key UPDATE | GREEN | **RED** |
| **K14** drop the compensating `deleteObject` | GREEN | **RED** |
| **K12** listing `ORDER BY w.start_ms ASC` → `DESC` | GREEN | **RED** |

The test goes past the brief in one useful place: a compensating delete that *itself* fails must still return not-ok, so a failed cleanup cannot turn a failed write into a success.

### F3 — the report is corrected plainly

The addendum leads with F3 and states it without hedging: the "behaviour unchanged" claim "**is wrong for the UPDATE-failure path, and the Refuter is right**"; it names the change (threw → caught, compensated, returned as `join_failed` and counted against `DRAIN_MAX_ATTEMPTS`), says the change is an improvement but **"the claim was the defect"**, and gives the production-visible consequence — a window whose clip-key write keeps failing now burns its attempt budget to a terminal `failed` instead of throwing for the runner. It also owns F1's cause in one line: *"Run the gate after staging, not before."*

**One mislabel, substance correct:** the addendum credits the failed-UPDATE assertion to K13. In my numbering K13 was the `joined:false` flag; the UPDATE-failure mutation is **K15**. K12 and K14 are cited correctly. Noted only so the record matches.

## Gate, my run

`typecheck` exit 0. `build` `✓ Compiled successfully in 7.8s`. `npm test`: `Test Files 1 failed | 145 passed (146)`, `Tests 1 failed | 3276 passed | 1 skipped (3278)`.

The one failure is `e31b-atomicity R58`, the known ~1-in-5 flake. Three controls, not an assertion:

- `room-switches.test.ts` — the F1 test — is **18/18 green**;
- R58 alone on this commit: **3 runs, 26/26 each**;
- the diff contains **no source file at all** — two test files and a Markdown report — so it cannot reach a PIN rate limiter.

**Verdict: PASS.** F1, F2 and F3 are closed; 15 of 15 mutations die; the seam that carries production's phase 1 is executed by a test that provably reaches it. Nothing else in the branch moved.
