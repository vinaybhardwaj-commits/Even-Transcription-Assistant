# ETA B2-S BUILD REPORT — fleet server half — 11 Sep 2026

**Commits** (local, not pushed): `a503da0` code, tests, 0079, kickoff; this report in the next docs commit.

**Stat.** 11 files, +1513/−60: 0079, `room-install.ts`, `room-install-view.ts`, both routes, `BenchInstallFleet.tsx`, kickoff, four `room-install*` tests. Nothing outside the contract.

**Gate.** `npm test`: 1572 → `Tests 1618 passed (1618)`. `typecheck`, `build`: exit 0.

**D4.** Route, `cleanPollFields`, COALESCE and fleet SELECT all carried the sentence (the route test asserts `row.install.last_update_error` and passed before the fix). The drop was `lib/room-install-view.ts:534`: `UPDATE_FAILURE_REASON[failure]`, never `last_update_error`. Before: `Received: "…The new version did not verify once it was in place…"`, 2 failed. After: 2 passed. The receipt's sentence now leads; the stock sentence is the fallback. Two `room-install-update` tests changed to cover both.

**0079:**
```
ALTER TABLE room_install
  ADD COLUMN IF NOT EXISTS assigned_channel text NULL CHECK (assigned_channel IN ('stable')),
  ADD COLUMN IF NOT EXISTS peak real, ADD COLUMN IF NOT EXISTS zero_ratio real,
  ADD COLUMN IF NOT EXISTS input_devices jsonb;
```
New SQL: `UPDATE room_install SET assigned_channel = $1 WHERE install_id = $2 AND retired_at IS NULL RETURNING …`; `SELECT assigned_channel FROM room_install WHERE install_id = $1 AND retired_at IS NULL LIMIT 1`.

**Fixture render:** `rows=9 disclosures=6 earlier_total=12 unassigned=1 move_to_stable=2`.

**Flags.**
- Migrations live in `db/migrations/`; `migrations/` does not exist.
- Deployed before 0079, poll writes and the fleet read fail (fail-open, logged). Apply 0079 before promote.
- `assigned_channel` is never cleared, so 0.1.20 would move a Mac put on `test` by hand back to `stable`. Needs a ruling before B2-A.
- uid ≤64 drops the whole list: 0077's TONOR UID is 81 characters.
- `assigned_channel` costs one SELECT per native poll; `bench-commands.ts` is outside the contract.
- The fleet was already one row per room (nine bound, not seven).
- Addendum uncommitted. Built by Opus.

## Fix-up

Commit: the one carrying this section (sha in the chat reply). `npm test` `Tests 1621 passed (1621)`; typecheck and build exit 0.
- (3) `lib/room-install.ts:1024`: `assigned_channel = CASE WHEN …update_channel = 'stable' THEN NULL …`; route test assign → `test` → `stable` → row null.
- (4) `lib/room-install.ts:904-905`: name ≤128, uid ≤256; TONOR's 81-char id tested.
- (5) `lib/bench-commands.ts:172,286`: `assigned_channel` from `applyInstallPoll`'s `RETURNING`; lookup removed.
- (8) Addendum committed.

## Production

0079 applied 12:42:49Z via the preview's `/api/run-migrations`. Promoted 12:47Z; `/api/health` sha `e908b84`. Fleet http=200, 9 rows, `degraded: []`: seven `0.1.19 / ok`, OPD 1 and OPD 4 on 0.1.8. Every `last_update_error` and `assigned_channel` null. 28 earlier installs; 1 Unassigned (retired, `room_not_on_card`).
