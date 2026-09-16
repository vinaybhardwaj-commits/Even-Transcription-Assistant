# ETA-F1 — Refutation of 836188f (E22 R3: a room is served when its slot is OFFERED; F2 and F6 tests) · 16 Sep 2026 · Refuter (Builder pane)

Branch `vinay/s1-auto-drain`, head `836188f`. The subject commits are `9a5c282` (R3, the F1 fix; `lib/stt/auto-drain.ts`
plus two test files) and `f9a0740` (the F2 and F6 tests). `836188f` itself is the container-name cherry-pick.
Everything below ran in a `git archive` copy of `836188f` under the session scratchpad. I did not enter main, -e16 or
-e20. Nothing was fixed, committed, pushed or migrated; R3 adds no migration. Process inspection: `pgrep -l` only.

## 1. Verdict — MERGE-READY. It clears R19 for promotion to production.

F1 is fixed, and the fix is proven where it has to be: the shipped SQL, against a real postgres:16. The one surviving
mutant (§6, B3) is a gap in the F6 test, not in the F1 fix, and not in the shipped guard, which is correct. It does not
block promotion; it is the next round's item.

## 2. Priority 1 — the S2 scenario, rerun by me

`tests/unit/s1-auto-drain.test.ts`, "E22 R3 … S2: one room refuses every offer", run on its own against postgres:16
(Docker 29.7.2), where the drain's outcome is faked but the selector SQL, the offer loop and the refusal stamp are the
shipped ones:

```
[E22 S2] slots per room 19/19/19/20/20/20 of 117; room_s5 refuses every offer
```

**Before this commit the same scenario gave 3/3/3/4/4/100 of 117.** The spread is now 1. All five R3 cases pass
(`5 passed | 53 skipped`).

I also drove the real `orderAutoDrainOffers` through my own harness, written independently of the repo's model
(§7 evidence, `tail-sim.mjs`): clinic hours **17/17/17/18/18/18**, and the refusing room's share of the whole day is
**25.0%**, against **83.6%** under the pre-R3 rule on the same harness.

**Full gate, rerun in the copy:** `npm run typecheck` exit 0 · `npm test` `Test Files 111 passed (111)`,
`Tests 2675 passed (2675)` with Docker up and no skip variable (s1-auto-drain 58, c2-e2e-runner 48,
s1-emotion-zero-scored 21, s1-fix2-migrations 8) · `npm run build` exit 0 · `npm run check:silent` exit 1 with the
accepted 9. Swift is untouched by this diff and was not run.

## 3. Priority 2 — every pre-claim path, enumerated from the code

`drainRoomWindow` (lib/stt/room-drain.ts:424-560) has twelve exits. Eleven are non-`enqueued`, and the loop
(auto-drain.ts:216-233) stamps `auto_drain_refused_at` on every one of them; `enqueued` is marked by the
`room_window` job the submit wrote. Both marks feed the `offered` CTE.

| Exit | Marked served by |
|---|---|
| `no_actor`, `flag_off`, `wrong_state` (state, not_grid_aligned, claim_lost), `no_room_day`, `too_long`, `join_failed`, `engine_failed` (both, incl. the catch) | the refusal stamp |
| `enqueued` | the `room_window` job row |
| **`not found` (`return out`, step `not_found`)** | **nothing — see A** |

- **A. The one unmarked path.** If the window row is gone by the time the loop stamps, the UPDATE matches no row and
  the room is not marked. It needs the row to be deleted between the scan and the stamp inside one tick. Self-limiting:
  the room loses one window from its own pool, and the next tick offers it again.
- **B. A throw before the stamp.** `enqueueSubject` (line 218) or the stamping UPDATE itself can throw; the tick then
  aborts and the room is unmarked. Both are database failures that hit every room alike, and the next tick re-offers.
- Neither is starvation: a room can lose its turn-marker at most one tick at a time, and only by losing that tick's work.

**Mutants confirm the marks are load-bearing:** A6 (flag_off clears instead of stamps), A7 (stamped one cooldown in the
past), A8 (never stamped) and A9 (an enqueue stamps instead of clearing) are all caught — 3 to 5 tests each.

## 4. Priority 3 — does "served on offer" break anything that read the old signal?

**No. The commit changes one SELECT; it writes nothing new.** `auto_drain_refused_at` and `auto_drain_refused_reason`
were already written by this same loop (0092), and a repo-wide grep over `lib`, `app` and `components` finds no reader
or writer of either column outside `lib/stt/auto-drain.ts`. Inside it there are now two: the eligibility cooldown, and
the `offered` CTE. The "served" signal is computed in SQL and consumed only by `orderAutoDrainOffers`.

Two couplings worth stating:
- **One column, two meanings.** "Do not offer this window for 60 minutes" and "this room had its turn" are now the same
  fact. The enqueue branch clears it, which erases that window's evidence — but the submit's job row is a fresher mark,
  so the room stays served. The only way to lose both is for the `scribe_job` row to disappear inside the 6 h horizon;
  no code deletes from `scribe_job` (no `DELETE FROM scribe_job` in lib, app or scripts), so that cannot happen today.
- **A room that only ever refuses now waits its turn like everyone else.** That is the ruling, and `flag_off` and
  `join_service_not_configured` counting as turns are pinned by a Postgres case that walks all six refusal steps.

## 5. Priority 6 — the tail, with a control

scribe3 states the refusing room takes tail slots once nobody else is waiting. **Confirmed, and harmless — measured,
not argued.** My harness, whole day (24 h), six rooms, one refusing every offer:

| Run | Clinic slots | Tail slots | Windows actually drained per room |
|---|---|---|---|
| One room refuses (R3) | 17/17/17/18/18/18 | 7/7/7/6/6/**22** | 24/24/24/24/24/**0** |
| **Control: nobody refuses** | 17/17/17/18/18/18 | 7/7/7/6/6/6 | 24/24/24/24/24/24 |
| Pre-R3 rule, one room refuses | 3/3/3/4/4/**88** | 2/2/3/2/2/55 | 5/5/6/6/6/0 |

**The five working rooms drain exactly 24 windows each whether or not a sixth room refuses everything.** The refuser's
extra tail slots cost the others nothing: they are ticks the others had no eligible window for. Under the pre-R3 rule
the same rooms drained 5-6 each. Capacity itself is unchanged and still the binding constraint (cap 1 per tick against
~24 windows an hour arriving), which is E17's standing note, not this commit's.

## 6. Priority 5 — my mutation check: 16 caught of 17 run

Seven suites per mutant (s1-auto-drain, e17-drain-fairness, e11-silent-room-window, e11-silent-room-window-real-client,
room-drain, c1b-room-window-job, hotfix-silent-window), Docker up, baseline 185 of 185. Each mutation was applied by an
exact string matched once and restored under a sha256 check.

**Caught (16):** A1 refusal branch dropped, the pre-R3 rule (3) · A2 refusals with no horizon (1) · A3 MAX→MIN (1) ·
A4 jobs no longer a turn (4) · A5 offer time = closed_at (1) · A6 flag_off clears (4) · A7 refusal stamped a cooldown
in the past (3) · A8 no refusal stamped (5) · A9 enqueue stamps instead of clearing (3) · A10 never-offered ranks last
(28) · A11 served key dropped (23) · A12 cooldown filter dropped (4) · A13 one-per-room dropped (2) · **B1 (F2) queued
and running no longer count as a turn (3)** · **B2 (F6) speech guard → `!window_recorded` (1)** · B4 speech guard
removed (2).

**B1 and B2 are the two survivors of the earlier rounds (E17-10 and E11-11). Both are dead here, and I killed them
myself rather than taking the report's word.**

**Survivor (1), and the real value that separates it:**
- **B3 — the SPEECH-path cue guard changed to `counts.failed > 1`.** A spoken window with **exactly one turn**
  separates it: `failed` is 1, the mutant treats the refusal as success, and a window whose single turn was rolled back
  is marked transcribed — the E11-11 defect, one shape narrower. The F6 fixture's Whisper answer carries two segments,
  so `failed` is 2 there, and the test asserts `failed >= 1` rather than an exact count. The shipped guard
  (`cueWriteFailed`, `complete !== true`) is correct; this is a test gap, not a defect.

## 7. Priority 4 — rule 21 on the new tests

- **The model mirrors the rule it tests, and its header says so.** `tests/unit/e17-drain-fairness.test.ts` computes
  `last_served_ms` from its own copy of the R3 rule; the SQL never runs there. scribe3 flagged this, and **my mutants
  prove the consequence precisely: every SQL-level mutant (A1-A9, A12, B1) was caught only by `s1-auto-drain`, the
  Postgres suite. The model caught only the pure-function mutants (A10, A11, A13).** So the model is commentary on the
  ordering, the Postgres S2 is the proof of the fix, and the model's "served: job" control is what keeps it honest.
- **What the fixtures still cannot express** (nothing broken today):
  - a room that refuses *sometimes* — every case is all-refuse or all-enqueue, so a room alternating between refusal
    and enqueue is unmodelled;
  - two or more refusing rooms at once (only the all-rooms global refusal and the single refuser exist);
  - a drain that fails *after* the submit wrote the job, so a room carries both marks in the same tick;
  - `AUTO_DRAIN_BATCH_LIMIT > 1` combined with refusals — the cap is exercised, but not with a refusing room;
  - the unmarked paths of §3 (a window deleted mid-tick; a throw before the stamp);
  - a spoken window with exactly one turn (§6, B3);
  - clock skew between the app and the database: every mark is `NOW()` on the database, and the horizon comparison is
    too, so this is safe by construction rather than by test.

## 8. Findings

- **The fix works, on the shipped SQL:** S2 gives 19/19/19/20/20/20 of 117 against 3/3/3/4/4/100 before.
- **Every pre-claim refusal marks the room served**, except a window deleted mid-tick, or a throw before the stamp; both cost one tick and self-correct.
- **No reader of the refusal column exists outside `auto-drain.ts`**, so marking on offer breaks nothing downstream.
- **The tail is harmless, with a control:** the other five rooms drain 24 windows each whether or not a sixth refuses everything.
- **B1 and B2, the two survivors of the earlier rounds, are dead** — reproduced and killed here.
- **B3 survives:** a one-turn spoken window separates `cueWriteFailed` from `failed > 1`; the F6 fixture uses two segments. A test gap, not a defect.
- **The E4 model proves nothing about the SQL** — confirmed by attribution: every SQL mutant was caught by the Postgres suite alone.

## 9. Anything unrun
- `swift build` / `swift test`: not run. This diff touches no Swift, and the last full Swift run on this machine
  tonight passed 600 of 600.
- No migration was applied anywhere; R3 adds none.
- The R11 index round is out of scope by the brief and was not looked at.

## 10. Scratch evidence (session scratchpad, not committed)
`f1fix/test-full.log`, `typecheck.log`, `silent.log`, `build.log`, `baseline.log`, `mutate.mjs`,
`mutation-results.json`, `tail-sim.mjs` with `order.mjs` (the real `orderAutoDrainOffers`, extracted with esbuild).

## 11. Subagents
None.
