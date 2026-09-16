# ETA-E17 — the drain must not starve a room · REPORT · 14 Sep 2026 · Builder (`scribe3`)

**SHA `e925901`** on `vinay/s1-auto-drain`, parent `ccd12b0`. Committed, **not pushed**, no PR.
`ROOM_AUTO_DRAIN_ENABLED`, `AUTO_DRAIN_BATCH_LIMIT` and `AUTO_DRAIN_MAX_AGE_HOURS` are untouched; so are
`room.transcript_enabled`, `lib/emotion/` and `room-drain.ts`. **No migration: 0098 stays free.**

**This is not a throughput fix.** Fairness redistributes the one slot per tick; it creates no capacity. The
drain is still 12 windows/h at cap 1, and emotion's one job per tick (12/h system-wide) still binds downstream.

## Diff (`git show --stat e925901`)
| file | lines | what |
|---|---|---|
| `lib/stt/auto-drain.ts` | +79 −7 | SQL returns eligible windows plus room, slot and last-served; pure `orderAutoDrainOffers` ranks and caps |
| `tests/unit/e17-drain-fairness.test.ts` | +211 (new) | V1–V4 and one-per-room on the real function, each with an old-order control; E4 model |
| `tests/unit/s1-auto-drain.test.ts` | +72 −12 | cap test made behavioural; seam test; Docker tests rewritten and extended |

Total: 3 files, +362 −19. Nothing outside those three moved.

## The design, and the "last served" choice
- **Filters:** the SQL keeps every filter byte-identical — the Transcript join before selection (C8), the refusal cooldown (C6), the queued/running job exclusion, the age bound. The `ORDER BY closed_at DESC LIMIT n` is gone. The scan returns all eligible windows, bounded by `AUTO_DRAIN_MAX_AGE_HOURS`, not by the backlog.
- **`orderAutoDrainOffers` (pure):**
  - per room, the newest **grid slot** (`end_ms`, then `start_ms`; `closed_ms` and `id` only break an exact tie, such as two lanes of one slot);
  - rooms **least recently served first**, with never-served rooms before served ones; then the newer slot; then `room_id`;
  - **one window per room**, then the unchanged cap.
- **R6 key:** `end_ms` is cut from the recorder's own chunk timestamps (`lib/bench-window.ts:231,354-360`). `closed_at` is `NOW()` at verify (`:379`), so a late verify can no longer reorder anything.
- **Last served — derived, not a column.** It is `MAX(scribe_job.created_at)` over `room_window` jobs, joined through `args->>'window_id'` to the room, inside `AUTO_DRAIN_MAX_AGE_HOURS`.
  - **Why this source:** `drainRoomWindow`'s submit already writes that row for every served window (`room-drain.ts:504-506`), including the admin doors. So nothing new is written, there's no migration, and there's no second source of truth.
  - **Bounded scan:** jobs inside the horizon, not the backlog. `status IN (…)` lists 0082's five CHECKed states so the `(status, created_at)` index can bound it.
  - **Cost:** a room served before the horizon counts as never served, which is harmless — it ranks first. A sixth job status added later would need adding to that list (flag 2).

## Verify
- **V1 PASS — the §2 property, behavioural.**
  - **Live shape:** two backlogged rooms (76 / 113 windows, newest 13 vs 12 Sep), 25 ticks. **0** grids where a room is served twice while the other waits; slots split **13 / 12**. Control: old order **25 / 0**, with violations — the live result, reproduced.
  - **Six-room day at ±0 s:** 0 violations, every room served in clinic.
  - **Repeat:** 20 phase sets at 6 and 9 rooms, 0 violations.
- **V2 PASS** — see the table below. Also run in TypeScript on the **real function**: 30 phase sets × 6–9 rooms × ±0/30/150 s, **0 starved rooms**. Control: the same model under `closed_at DESC` starves in 30 of 30 sets at ±0 s.
- **V3 PASS.** A window recorded 18 h ago but verified 1 minute ago loses to one recorded 15 minutes ago, within a room and across rooms. **Both tests fail under `closed_at DESC`** (the controls assert it). The Docker SQL version was also written, but not run.
- **V4 PASS.** One room served tick after tick is offered `w3, w2, w1, w0`, newest slot first — not FIFO. Lane ties break deterministically.
- **V5 — structurally preserved; the SQL proof is UNRUN.**
  - **Structure:** the WHERE clause and the C8 join are unchanged in the diff. The ranking only ever sees rows the SQL already filtered, so a Transcript-off window never reaches it and costs no tick.
  - **Tests:** the Docker suites proving C8, C6 and C1 are kept unmodified. The two order tests are rewritten, and three last-served / R6 SQL tests were added. **None ran: Docker is down.**
  - **The seam:** proven on the recording fake — string numerics are converted, and `last_served_ms` reaches the ranking.
- **V6 — mutation check: 8 of 8 killed.** Each applied by exact string (anchor count 1); restore verified by sha256 match. Evidence: `scratch/E17-MUTATIONS-*`. Each separates:
  - **M1** most recently served first — fair rotation vs same-room repeat: **18 tests**;
  - **M2** never-served rooms last — waiting room first vs served room first: **18**;
  - **M3** one-per-room removed — one per room vs the big room takes the batch: **1**;
  - **M4** within room oldest first — newest slot vs FIFO: **7**;
  - **M5** within room on `closed_at` — recorded time vs verify time (R6): **2**;
  - **M6** cap ignored — cap vs all rooms at once: **5**;
  - **M7** room tie-break removed — newer material vs arbitrary room: **2**;
  - **M8** last served dropped at the SQL seam — derived rotation vs always tied: **1**. It survived at first; the seam test was added and it now fails.

## The E6 §7 table, re-run
`scratch/E17-MODEL-FAIRNESS-14-SEP-2026.py.txt` loads E4 verbatim and E6's loop exactly, with only the order swapped (output `…-OUT-…`). Same seeds and 300 phase sets per row. **The old rows reproduce E6 §7 digit for digit**, which proves the harness identical.

| Rooms (windows) | drained · aged out (±0 s) | rooms with 0 in clinic ±0 / ±30 / ±150 s: **old** | **E17** | sets with a starved room ±0 / ±30 / ±150 (of 300): old → E17 | worst room ±0 s: old → E17 |
|---|---|---|---|---|---|
| 6 (216) | 144 · 72 → 144 · 72 | 3 / 2 / 0 | **0 / 0 / 0** | 300 / 268 / 0 → **0 / 0 / 0** | 12 → **24**/36 |
| 7 (252) | 148 · 104 → 148–149 · 103–104 | 4 / 2 / 0 | **0 / 0 / 0** | 300 / 289 / 0 → **0 / 0 / 0** | 10 → **21**/36 |
| 8 (288) | 153 · 135 → 153–154 · 134–135 | 5 / 3 / 0 | **0 / 0 / 0** | 300 / 296 / 1 → **0 / 0 / 0** | 9 → **19**/36 |
| 9 (324) | 156 · 168 → 156 · 168 | 6 / 4 / 0 | **0 / 0 / 0** | 300 / 298 / 1 → **0 / 0 / 0** | 8 → **17**/36 |

The totals do not move (144 → 156 across 6–9 rooms, as before). **What changes is the rooms getting nothing: from R − 3 at ±0 s to zero, at every room count and every jitter.**

## Gate (run on the tree of exactly these three files)
- `npm run typecheck` — exit 0.
- `npm test` — **4 failed | 2553 passed | 97 skipped.** The 4 are REQUIRED PROOF NOT RUN, Docker down: `c2-e2e-runner`, `s1-auto-drain`, `s1-emotion-zero-scored`, `s1-fix2-migrations`. **Unrun, not green.** With `ETA_ALLOW_SKIP_E2E=1`: 110 files passed, 2557 passed, 97 skipped.
- `npm run build` — exit 0.
- `npm run check:silent` — the 9 pre-existing findings accepted at `1193083`; none in these files.
- `swift build` — "Build complete!".
- `swift test` — "Test run with 600 tests in 48 suites passed". F5's test-target failure did not recur on this run.

## Flags
1. **Branch not named.** Committed on `vinay/s1-auto-drain` because this worktree is shared with `scribe`, and switching branches would have moved the tree under them. The HEAD before the commit was `ccd12b0`, and only these three files were dirty at gate and commit.
2. **Status list.** The derived last-served lists 0082's five job statuses to use the index. A new status would need adding there.
3. **Age filter unchanged.** It still reads `closed_at`, not the slot. A window verified 18 h late is eligible for 6 h, but it ranks by its old slot. I did not change it: the spec pins `AUTO_DRAIN_MAX_AGE_HOURS`.
4. **Evidence kept off the commit.** Scratch evidence (model script and output, mutation script and output) and this report were not committed, following the global rule on bus documents.
5. **No subagents** this round.
