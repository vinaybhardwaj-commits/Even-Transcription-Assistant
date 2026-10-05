# ETA fleet attention — build note, 5 Oct 2026

Branch `vinay/fleet-attention` (from `origin/main` e71bbff). Not merged, not deployed, no migration, no CHECK change. Builder: Claude Fable 5.1. First delivery ad53794; Refuter fixes F1–F7 are the second commit (section "Refuter fixes" below).

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
| `lib/room-watchdog.ts` | `recovered` needs a genuine recovery while a session is open; a room with no session closes quietly (below). `REASON_LABEL` exported. |
| `tests/unit/fleet-attention.test.ts`, `…-sql.test.ts`, `room-watchdog-genuine-recovery.test.ts` (new) | See Tests. |

## The rules

| | kind | condition | severity |
|---|---|---|---|
| R1 | `asleep` (label "Mac not capturing") | (a) a RECORDING session is open AND the Mac is screen-locked (ext `locked`, or poller `locked: true`) or unreachable AND there is no audio evidence; or (b) the poller's newest row is `unreachable`, ≥ 3 min old as a run, and the row is ≤ 10 min old | red |
| R2 | `capture_frozen` | recording session open ≥ 2 min and the last 120 s of `bench_level_sample` hold ≤ 1 distinct (peak, zero_ratio), or no sample at all | red |
| R3 | `silent_tape` | newest ≥ 2 consecutive primary chunks of the open session are ≤ 800 bytes per second (size_bytes / duration_ms) AND ≥ 150 s long | red |
| R4 | `consult_without_tape` | an `eta_encounter_windows` row is open now (t_close null/future) or opened < 15 min ago, and no `bench_chunk` for the room in 10 min | red |
| R5 | `no_session_in_clinic` | Mon–Sat 08:30–20:30 IST, the room's Mac had login/active/focused-heartbeat in the last 30 min, no open session | amber |
| R6 | `open_outbox` | newest `offline`/`degraded` outbox row (7-day look-back) with no GENUINE recovery since. R6 clears on the FIRST evidence, by spec. GATE (third commit): not an item when the room's `room_alert_state.status` is `ok` AND no session is open (the watchdog closed it, quietly or genuinely); a non-ok state, an open session or no state row keeps it | red for offline, device_missing, tape_stalled; else amber |
| R7 | `stale_start` | a `start_day` command acked `failed` in the last 60 min and no session started since | red |

**`locked` means SCREEN LOCKED, not asleep.** OPD 5 recorded all morning with `idle_s` ≈ 31,000 and `locked: true`; OPD 6, 5 and 1 were remote-started at 09:13 under locked screens. So a locked screen on its own is never an item. A Mac in DarkWake cannot be told from a locked idle Mac through `locked` / the poller flag; that needs the pmset sleep/wake events from the health daemon, which does not ship them yet (code comment in `resolveLockState`). When it does, R1 can say "asleep" again.

AUDIO EVIDENCE (clears R1 at once): the meter moved (≥ 2 distinct values in 120 s) AND a chunk landed in the last 10 min. A session younger than those windows gets the benefit of the doubt on the half it cannot have produced yet. R1(a) detail: "Screen locked and no audio since 01:36 IST." (or "Mac unreachable on the network and no audio since …").

Lock determination: `locked` (ext) and the poller's `locked`/`unreachable` = down; `login`, `active`, `encounter_open/close` and a FOCUSED heartbeat = awake; `idle`, `logout` and an unfocused heartbeat say nothing. The newest determination across ext and poller wins.

De-dup: one item per kind per room; sort red first, then oldest `since`.

## Genuine recovery (watchdog and R6 share the definition)

A chunk newer than the alert AND ≥ 2 distinct level values. The watchdog measures the values over the last 120 s and the chunk against `room_alert_state.since` (only sessions that had not ended before the alert); R6 measures both since the outbox row. `RoomRunInput.recovery_evidence` is optional: `undefined` keeps the planner's old behaviour for legacy callers; `runWatchdog` always supplies it for a room whose prior status is not ok, and a failed evidence read counts as "not genuine" (alert stays open, logged).

- A session IS open: without that evidence the alert stays open — no write (so `since` and the status stand) and no message; the eventual honest recovery names the whole outage.
- NO session is open and the poll is clean (F4): the alert is CLOSED QUIETLY — the state is written to `ok`, no message is planned, so no outbox row and no "recovered" text. A room closed for the day no longer stays offline/degraded, and its next outage is an ok → degraded edge again, so it alerts. `fleet_outage` counting is unaffected (only offline crossings count). An audit row for the quiet close would need a new outbox kind, i.e. a CHECK change on `room_alert_outbox.kind` — NOT done; for Fable if wanted.

## Refuter fixes (second commit)

| | status |
|---|---|
| F1 | R1 rewritten as above. Locked screen with no session: no item. Audio evidence clears it immediately. Kept red. |
| F2 | `POLLER_LEGACY_KEYS` (consul4–7, echo, discussion, audiometry → full hostnames); the poller queries match `machine IN (canonical, raw hostname, legacy)` for the newest row and for both look-backs (3 days). Verified against `~/dev/eta-presence-poller` on the Mini (HOSTS.md and `make_event(host["machine"], …)`): from the 5 Oct 04:44Z cutover every poller row, `unreachable` included, keys on the full hostname; earlier rows use the short key. |
| F3 | Every `bench_level_sample` read is `room_id = ANY($ids)` with an `ist_date` and `sampled_at` bound (or per-room); every `bench_chunk` read goes through the room's sessions (`bench_session (room_id, started_at DESC)`) then `(session_id, source, idx)`. The false "index use" comment is fixed. EXPLAIN (ANALYZE) on the statements the loader actually sends, at ≈110k level samples + ≈30k chunks, asserts no Seq Scan on `bench_level_sample` or `bench_chunk`, and that `bench_level_sample_room_day_time_idx` and `bench_chunk_session_source_idx_key` are used. `bench_session` itself is Seq Scanned in the test at 300 sessions (tiny table; the planner's choice, not asserted). |
| F4 | Quiet close, above. Both paths tested, plus persistPlan against postgres (state to ok, zero outbox rows, next outage queues). |
| F5 | R3 by rate: ≤ 800 B/s AND duration ≥ 150,000 ms, ≥ 2 consecutive. |
| F6 | Accepted; one-line comment that R6 clears on first evidence by spec. |
| F7 | Stale `loadRecoveryEvidence` comment fixed; its chunk EXISTS also excludes sessions that ended before the alert. |

## Tests

- `fleet-attention.test.ts` — 69 tests, pure. Every rule, the 5 Oct fixtures, the locked-screen-is-not-asleep cases, audio-evidence clearing, R1(b) timing, rate-based R3.
- `room-watchdog-genuine-recovery.test.ts` — 18 tests: the 04:36 case withheld (session open), chunk-but-frozen, null evidence, honest recovery with the full outage duration, quiet close (degraded, offline, null evidence, muted, next outage alerts again), `fleet_outage` counting with quiet closes in the same run, legacy callers, muted rooms.
- `fleet-attention-sql.test.ts` — 24 tests against a real postgres:16 (Docker, the s1-pg harness, bound untyped params like the Neon driver): every SELECT, hostname normalisation, poller raw/legacy keys across the cutover, R1(a)/(b), R3 rate, R6 session filter, `loadRecoveryEvidence`, quiet close through `persistPlan`, and the EXPLAIN test.
- Existing `room-watchdog*.test.ts` unchanged and green.

## Live read-only probe (SELECTs only; 5 Oct 10:47 IST after the R6 gate, 11 rooms, nothing degraded, 4 items)

| room | session | items now |
|---|---|---|
| OPD 4 | none | red stale_start (failed start 10:13), red consult_without_tape, amber no_session_in_clinic |
| OPD 5 | recording, screen locked 550 min, audio moving | none (not asleep) |
| OPD 3 | recording, audio moving | none (its 10:38 alert closed by the watchdog state) |
| Dietary Room | none | none (state ok, nothing open: R6 gate) |
| Home Office | none | red open_outbox (state still degraded since 08:22, missing input device) |
| the other six rooms | recording, audio moving | none |

Before the gate (10:41 IST) the same probe showed 7 items: Dietary Room and OPD 4 also carried an old open_outbox, and OPD 3 an amber one, all with watchdog state `ok`.

## Decisions where the spec was silent (follow existing patterns)

1. Types and wording live in `lib/fleet-attention-format.ts`, not `fleet-attention.ts`, so the client never bundles the Postgres driver.
2. The response may carry an optional `degraded: string[]`; the panel then never shows "Nothing needs attention". A failed route answers 500.
3. R2 skips a session open under 2 minutes; R4 skips when the tape started under 10 minutes ago and ignores an unclosed window older than 4 hours.
4. R3 reads the PRIMARY mic only.
5. "Open session" = `recording` or `paused` for R5/R7; R1(a)/R2/R3 need `recording`.
6. R1(a) `since` = the later of the lock start and the no-audio start. R1(b) `since` = the first row of the current unreachable run (3-day look-back).
7. R5 `since` = later of 08:30 today and the first genuine activity in the last 30 min.
8. ADDED beyond the ruling for R1(b): a poller row older than 10 minutes is ignored (the poller itself may be down), and a recording session demonstrably delivering audio suppresses it (the poller failing to reach the Mac is then a network fact, not a capture fact).
9. The older browser-computed "Needs your attention" list stays.

## Open for the orchestrator

- R6 is gated on the watchdog state (third commit, coordinator ruling): once the F4 watchdog is deployed, a room closed for the day clears when its alert is closed quietly. Caveat: with the CURRENT production watchdog the false `recovered` still sets the state to `ok`, so an alert the old code wrongly closed is hidden while no session is open; R1(a)/R2/R3 catch it as soon as a session opens, and an open session keeps R6 standing.
- Nothing pushes to `main`; this branch is the only thing pushed.
- The watchdog still has no human consumer for its outbox; R6 puts the open alerts on the bench page, it does not page anyone.
