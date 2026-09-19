# ETA — Room Watchdog — REPORT — 19 Sep 2026

## 1. Commits

- Merge: `52698d9` — `origin/vinay/s1-auto-drain` (1f03aa2) into `bench/device-missing-row-state`, one manual conflict resolved (§2).
- Feature: `3d3e225` — the Room Watchdog.

Branch `bench/device-missing-row-state`. Not pushed. `main` untouched.

## 2. Pre-flight and the merge

`pwd`/`git remote -v`/`git fetch`/`git rev-parse` all matched the order. `bench/device-missing-row-state` existed locally at exactly `efed7ae` as stated. Untracked `docs/handoff/*` (including a new `.writetest`) matched this kickoff's wording; `tmp-e31c-mutation.json` is the same 0-byte stray from 16 Sep that V told me on 17 Sep to leave alone — not re-flagged.

**The order's premise "zero conflicts" did not hold.** The merge produced one conflict, in `lib/room-install-view.ts`, on the exact `state:` line 8968b71 touches. `origin/vinay/s1-auto-drain` carries an independent, unrelated fix for the same line — an "ETA-DELIVERY-EVIDENCE" mechanism (`notDelivering`, derived from `isBenchStalled` over `bench_chunk` delivery, D-6) — whose own comment states its author did not know 8968b71 existed ("that commit is not an ancestor of this branch's base... see the Builder's report for the flag"). The two signals are not in conflict, they are additive: `state_flags` degradation is what the Mac's own poll says about its capture; `notDelivering` is whether bytes are actually landing in `bench_chunk`, computed independently so an absent Mac's absence can be noticed by something other than the absent Mac. I resolved the conflict by OR-ing both conditions together (a room needs attention if either fires) rather than choosing one over the other. **Flagged for the Orchestrator's ruling**: this OR-combination is the Builder's merge resolution, not something either commit specified.

## 3. Gate, after the merge and after the feature

- `npm run typecheck` — clean both times.
- `npm test` — after merge: 129 files / 2977 tests. After the feature: **130 files / 2994 tests**, all green.
- `npm run check:silent` — **9 findings**, unchanged, all pre-existing at `1193083`, none in touched files.
- `npm run build` — clean; both new routes (`/api/admin/room-watchdog`, `/api/admin/room-watchdog/mute`) present in the manifest.
- `cd apps/room-recorder && swift build && swift test` — clean, 600/600 (the `TestingMacros` plugin failure from the 17 Sep report did not recur — looks like it was a transient toolchain/cache state, not a real regression; not investigated further since no Swift file changed).

## 4. Migration DDL (`db/migrations/0103_room_alert_state.sql`, not run)

```sql
CREATE TABLE IF NOT EXISTS room_alert_state (
  room_id      text        PRIMARY KEY REFERENCES room(id),
  status       text        NOT NULL DEFAULT 'ok',
  since        timestamptz NOT NULL DEFAULT now(),
  muted_until  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_alert_state_status_chk CHECK (status IN ('ok', 'offline', 'degraded'))
);
```

## 5. Every SQL string — INFERRED, verify before merging

Read from `db/migrations/0041_room_bench.sql` (`room.id`, `room.name`, `room.disabled_at`) and `0075`/`0081_room_states_and_verbs.sql` (`room_install` columns, `state_flags` jsonb shape). I could not run any of these against a real database.

Fleet read (`runWatchdog`):
```sql
SELECT
  r.id AS room_id, r.name AS room_name,
  ri.last_seen_at, ri.tape_advancing, ri.session_open, ri.disk_free_bytes,
  COALESCE(ri.state_flags -> 'flags', '[]'::jsonb) AS state_flags,
  ras.status AS prior_status, ras.since AS prior_since, ras.muted_until AS muted_until
FROM room_install ri
JOIN room r ON r.id = ri.room_id
LEFT JOIN room_alert_state ras ON ras.room_id = r.id
WHERE ri.retired_at IS NULL AND ri.enrolled_at IS NOT NULL AND r.disabled_at IS NULL
```
State write, per room: `INSERT INTO room_alert_state (room_id, status, since, updated_at) VALUES (...) ON CONFLICT (room_id) DO UPDATE SET status = EXCLUDED.status, since = EXCLUDED.since, updated_at = now()`.
Mute write: `INSERT INTO room_alert_state (room_id, status, since, muted_until, updated_at) VALUES (${roomId}, 'ok', now(), ${mutedUntil}, now()) ON CONFLICT (room_id) DO UPDATE SET muted_until = EXCLUDED.muted_until, updated_at = now()` — never touches `status`/`since` on an existing row.

## 6. The four message shapes (exact text; `%s`/`{n}` are the only variables)

- **Offline** — subject `EvenScribe watchdog: {room} is offline`; text `{room} has not polled in over 5 minutes, as of {iso}. Nothing is being recorded until it reconnects.`
- **Degraded** — subject `EvenScribe watchdog: {room} capture is degraded`; text `{room} is polling but its capture looks degraded — a missing device, silence, clipping, a stalled encoder, a stalled tape, or critically low disk — as of {iso}. Go and look.`
- **Recovery** — subject `EvenScribe watchdog: {room} is back`; text `{room} recovered after being {offline|degraded} for {duration}. It is recording normally again as of {iso}.`
- **Fleet-wide** — subject `EvenScribe watchdog: {n} rooms went offline at once`; text `{n} of {total} enabled rooms went offline in the same run, as of {iso}. This looks like a network or platform outage, not {n} separate room failures. Individual offline alerts are suppressed for this event.`

## 7. Deviations and flags

- **§2's merge resolution** is the biggest one — see above.
- **A bug my own tests caught**: "more than half" as a bare fraction fires on a single room (1 offline of 1 enabled is >50%), and would have fired for a lone *muted* room's transition too. Fixed with an `offlineTransitions >= 2` guard alongside the fraction check — not specified by D3, added because the fraction check alone is wrong at small fleet sizes.
- **`DEGRADED_STATE_FLAGS` (8968b71) is duplicated, not imported.** It isn't exported, and this build's file contract forbids editing `lib/room-install-view.ts` to export it. The duplicate is named and comment-linked to its source; nothing enforces that they stay in sync if 8968b71's set changes.
- **Two destination env vars the order didn't name**: `WATCHDOG_ALERT_EMAIL_TO` (email) and `WASENDER_ALERT_TO` (WhatsApp number) — D8 named the *credentials* but not where alerts go. Both follow the same "missing → log by name, send nothing" rule as the credentials.
- **WaSender's request shape is UNVERIFIED** — no existing code or docs to read. I built the conventional gateway shape (`POST {WASENDER_BASE_URL}/api/send-message`, bearer auth, JSON `{to, text}`); confirm against WaSender's actual API before this fires for real.
- **"Enabled rooms" (D3's denominator) = rooms with an active, non-retired, enrolled install and `room.disabled_at IS NULL`** — a room with no Mac at all isn't part of the fleet the watchdog can say anything about.
- **Muted rooms count toward the D3 fleet-wide numerator and denominator** but never get an individual message — a real mass outage shouldn't be undercounted just because one of the affected rooms happened to be muted for an unrelated reason.

## 8. Migration or manual step

`db/migrations/0103_room_alert_state.sql` has not been run. V runs it by hand; no other step needed to merge. Deploying activates the cron only once `CRON_SECRET` is set (already true, per the jobs/run pattern) and does nothing until then — `GET` returns 503 with an unset secret.

## 9. Subagents

None. Single-session read-then-write work throughout; no parallelizable research or disjoint-file edits that would have justified one.
