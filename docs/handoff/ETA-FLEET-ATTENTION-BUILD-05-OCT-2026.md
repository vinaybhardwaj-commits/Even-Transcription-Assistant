# ETA fleet attention — build note, 5 Oct 2026

Branch `vinay/fleet-attention` (from `origin/main` e71bbff). Not merged, not deployed, no migration. Builder: Claude Fable 5.1.

## Why

`/admin/bench` printed "Nothing needs attention." while OPD 4 had recorded nothing for four days and OPD 3's microphone was dead. The room watchdog is edge-triggered, its `recovered` fires when a session closes (false recoveries at 04:36 on 5 Oct while the Macs sat in DarkWake), and nothing consumes its outbox. This build adds a STATE-based attention list — an item exists while its condition holds, re-evaluated on every call — and stops the watchdog announcing recoveries it cannot prove.

## What changed

| File | Change |
|---|---|
| `lib/fleet-attention.ts` (new) | Pure `computeAttention(inputs)` for R1–R7, plus `loadAttentionInputs` / `getFleetAttention` (read-only SELECTs, bound params). |
| `lib/fleet-attention-format.ts` (new) | Browser-safe types, kind labels, `fmtFor` ("for 3 h 12 m"), `fmtIst`. No DB import. |
| `app/api/admin/fleet-attention/route.ts` (new) | `GET` → `{generated_at, items, rooms_checked, degraded?}`. Admin cookie (`benchAdminGuard`), `no-store`, force-dynamic. |
| `components/admin/FleetAttentionPanel.tsx` (new) | `useFleetAttention` (30 s poll, skips hidden tab), the panel, the per-room badge. |
| `components/admin/BenchRoomsLive.tsx` | The bare "Nothing needs attention." line is replaced by the panel; each room card shows a red/amber badge. The older browser-computed "Needs your attention" list is kept. |
| `lib/room-watchdog.ts` | `recovered` needs a genuine recovery (below). `REASON_LABEL` exported. |
| `tests/unit/fleet-attention.test.ts`, `…-sql.test.ts`, `room-watchdog-genuine-recovery.test.ts` (new) | See Tests. |

## The rules

| | kind | condition | severity |
|---|---|---|---|
| R1 | `asleep` | newest power-determining event is `locked` (ext), or the newest poller row is locked/unreachable, with nothing newer saying awake. Any hour. | red |
| R2 | `capture_frozen` | recording session open ≥ 2 min and the last 120 s of `bench_level_sample` hold ≤ 1 distinct (peak, zero_ratio), or no sample at all | red |
| R3 | `silent_tape` | newest ≥ 2 consecutive primary chunks of the open session are ≤ 230,000 bytes | red |
| R4 | `consult_without_tape` | an `eta_encounter_windows` row is open now (t_close null/future) or opened < 15 min ago, and no `bench_chunk` for the room in 10 min | red |
| R5 | `no_session_in_clinic` | Mon–Sat 08:30–20:30 IST, the room's Mac had login/active/focused-heartbeat in the last 30 min, no open session | amber |
| R6 | `open_outbox` | newest `offline`/`degraded` outbox row (7-day look-back) with no GENUINE recovery since | red for offline, device_missing, tape_stalled; else amber |
| R7 | `stale_start` | a `start_day` command acked `failed` in the last 60 min and no session started since | red |

Power determination (R1): `locked` = asleep; `login`, `active`, `encounter_open/close` and a FOCUSED heartbeat = awake; `idle`, `logout` and an unfocused heartbeat say nothing. The 5 Oct DarkWake kept sending unfocused heartbeats, so a heartbeat alone never clears a lock. The newest determination across ext and poller wins.

De-dup: one item per kind per room; sort red first, then oldest `since`.

## Genuine recovery (watchdog and R6 share the definition)

A chunk newer than the alert AND ≥ 2 distinct level values. The watchdog measures the values over the last 120 s and the chunk against `room_alert_state.since`; R6 measures both since the outbox row. When the planner would announce `recovered` without that evidence it does nothing: no write (so `since` and the status stand) and no message, and the eventual honest recovery names the whole outage. `RoomRunInput.recovery_evidence` is optional: `undefined` keeps the planner's old behaviour for legacy callers; `runWatchdog` always supplies it for a room whose prior status is not ok, and a failed evidence read counts as "not genuine" (alert stays open, logged).

## Tests

- `fleet-attention.test.ts` — 54 tests, pure. Every rule, with the 5 Oct fixtures (DarkWake at 01:36:50 with continuing unfocused heartbeats and a `locked`; 48 identical samples with `frozen_since` 01:36:52; 212,378-byte chunks; the 04:40 state after the 04:36 false recovery; OPD 4 with no session since 1 Oct; a failed start "tapewriter exited with status 1").
- `room-watchdog-genuine-recovery.test.ts` — 11 tests: the 04:36 case withheld, chunk-but-frozen withheld, null evidence withheld, the honest recovery sent with the full outage duration, offline recovery, legacy callers, muted rooms.
- `fleet-attention-sql.test.ts` — 13 tests against a real postgres:16 (Docker, the s1-pg harness, bound untyped params like the Neon driver): every SELECT, the hostname normalisation (curly apostrophe and `(2)`), poller raw-hostname match, `frozen_since`, the outbox DISTINCT ON/unnest, `degraded` naming.
- Existing `room-watchdog*.test.ts` unchanged and green.

The fixtures use IST wall clock for the 5 Oct times (01:36:50 IST = 20:06:50Z on 4 Oct). The brief gave the times without a zone; IST is the zone the clinic and the bench use, but see UNVERIFIED.

## Live read-only probe

`getFleetAttention` was run once against the live Neon database through SELECTs only (no writes; connection string never printed): 838 ms, 11 rooms, no degraded sources, 7 items — OPD 4 raised four kinds, matching the 5 Oct facts (consult with no tape, no session in clinic, failed start, open watchdog alert).

## Decisions where the spec was silent (follow existing patterns)

1. Types and wording live in `lib/fleet-attention-format.ts`, not `fleet-attention.ts`, so the client never bundles the Postgres driver. `fleet-attention.ts` re-exports the types.
2. The response may carry an optional `degraded: string[]` naming sources that could not be read; the panel then never shows "Nothing needs attention". A failed route answers 500 and the panel says the check failed.
3. R2 skips a session open under 2 minutes; R4 skips when the tape started under 10 minutes ago (no first 5-minute piece can exist yet) and ignores an unclosed window older than 4 hours (a resolver leftover; the resolver itself caps at 90 min).
4. R3 reads the PRIMARY mic only; the backup mic is ignored.
5. "Open session" = `recording` or `paused` for R5/R7; R2/R3 need `recording`.
6. R1 `since` uses the earlier of the two sources when both say asleep; the poller's start is the first row of the current unbroken locked/unreachable run (3-day look-back).
7. R5 `since` = later of 08:30 today and the first genuine activity in the last 30 min.
8. The older browser-computed "Needs your attention" list stays; the new panel shows "Nothing needs attention" only when that list is empty too.

## Not done / for the orchestrator

- Nothing pushes to `main`; this branch is the only thing pushed.
- R1 is red at any hour, as specified. Overnight, a Mac that sleeps after clinic will show red until it wakes; if that is too loud, restrict R1 to hours from 07:30 or to machines with an open session the day before.
- The watchdog still has no human consumer for its outbox; R6 puts the open alerts on the bench page, it does not page anyone.
