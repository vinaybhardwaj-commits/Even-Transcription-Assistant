# Room Watchdog alert path — DESIGN (scribe, 24 Sep 2026, Fable ruling 128(a))

**Status: DESIGN ONLY. Nothing here is built. eta-refuter refutes it first; Fable rules on the open decisions at the end.**
Target: the next train after tonight's. Order: alert path = bus + conductor board, no V pages.

## What "cannot alert" means (my reading; UNVERIFIED against eta-refuter #332, which I have not seen)
From `lib/room-watchdog.ts` on the next-train head:

1. **An alert can be lost for good.** `runWatchdog` writes `room_alert_state` (the new status) and only THEN dispatches. `planWatchdogRun` is
   edge-triggered: it emits a message only when the status CHANGES. If the dispatch fails or is unconfigured, the state has already moved,
   the next run sees `status == prior`, and nothing is ever sent again. One failed send = a room that went dark and nobody was told.
2. **The only channels are email (Resend) and WhatsApp (WaSender), and both page a person.** Each returns `not_configured:<names>` and
   merely logs when its env is missing. The WhatsApp request shape is marked "INFERRED, UNVERIFIED" in the code itself.
3. **Nothing is recorded.** `channel_results` exists only in the cron's HTTP response, which nobody reads.
4. **Nothing can reach the bus from the app.** The bus is on the Mini behind an ssh-forced wrapper; a Vercel function cannot post to it.
5. **The watchdog is not watched.** If the cron stops (CRON_SECRET unset answers 503 and runs nothing), silence looks identical to "all rooms fine".

## Design

### A. Outbox in the database, written in the SAME statement as the state (app side — mine)
Migration `0119` (0118 is the current head on every branch; recheck before applying): `room_alert_outbox`
`(id bigserial pk, created_at, kind in ('offline','degraded','recovered','fleet_outage'), room_id, room_name, status_from, status_to, subject, body)`
and one-row `room_watchdog_heartbeat (id = 1, last_run_at, last_ok, evaluated, last_error)`.

`runWatchdog` replaces its per-room state writes with ONE statement per run:
`WITH changed AS (INSERT INTO room_alert_state ... ON CONFLICT DO UPDATE ... WHERE status IS DISTINCT FROM EXCLUDED.status RETURNING ...) INSERT INTO room_alert_outbox ... FROM changed`.
- **State advances if and only if the alert is queued.** If the statement fails, neither happens and the next minute retries. This is the E31
  rule the other way round: here the coupling is wanted, because they are one fact.
- **Two overlapping cron runs cannot both alert**: the `IS DISTINCT FROM` guard means only the run that actually changed the row inserts its outbox row.
- Muted rooms still get the state write and get NO outbox row, as today. D2 (seed, never alert on history) and the fleet-outage rule
  are unchanged: `planWatchdogRun` stays pure, and only gains `kind`, `room_id` and the two statuses on the messages it already returns.
- The email/WhatsApp senders stay in the code but are gated behind `ROOM_WATCHDOG_PAGE_V` (default OFF, `parseFlag`). Marked, never deleted.

### B. A read door for the outbox (app side — mine)
A read-scope MCP tool `scribe_room_alerts(after_id, limit<=100)` returns rows with `id > after_id`, ascending, plus the heartbeat
(`last_run_at`, `last_ok`). Read-only, no ack write: the relay owns its own cursor. At-least-once delivery, made idempotent by the bus
thread id `room-alert-<id>`.

### C. The relay (Mini side — NOT mine; herdr-kit / pane-watch)
Every 30-60 s: call the tool with the saved cursor; for each row post to the bus agent `conductor` (`urgent` for offline, degraded and
fleet_outage, `normal` for recovered; `thread_id = room-alert-<id>`) and append one line to the board's ROOM ALERTS section; advance the cursor
ONLY after both succeed, written atomically. If the bus or the board is unreachable the cursor does not move, and the rows wait in the database.
**Watchdog-of-the-watchdog:** if `heartbeat.last_run_at` is older than 5 min, or `last_ok` is false, the relay posts one `[room-watchdog SILENT]`
message (edge-triggered on its own side, so it does not repeat every poll).

### D. What is deliberately not changed
Edge-trigger semantics, D2 seeding, mute, the fleet-outage threshold, the 1-minute cron, the classifier (`FLAG_REASON`).

## Tests planned (before any code is called done)
- Pure: messages carry kind, room_id and statuses; muted rooms produce no outbox row; unchanged planning output otherwise.
- **Real postgres, failure injected inside the statement** (the e31b pattern): a trigger that raises on the outbox insert must leave
  `room_alert_state` on its EARLIER status. Split mutant: two statements instead of one must FAIL this test, because the state would advance and
  the alert would be lost.
- Two concurrent runs over the same change produce exactly one outbox row.
- The read tool: cursor semantics, limit, read scope only, no room data beyond what the messages already carry.
- Heartbeat: written on ok, on read failure and on error; a heartbeat write failure never fails the run.

## Open decisions (Fable)
1. Approve outbox + pull relay. The app cannot push to the bus, so a Mini-side relay is unavoidable; the owner would be herdr-kit.
2. **Relay token.** A read-scope entry in `SCRIBE_MCP_TOKENS` is the same write-only-secret problem as the night-feeder token (herdr-kit #207).
   I propose the relay uses an EXISTING read token. Say if you want a new one instead.
3. **Room names carry a doctor's name** (slugs like `opd-N-dr-<name>`). The bus already takes them, as the emails did. The board is a file in a git
   repo, so I propose the board line carries `room_id` and the bus message carries the name. Your call.
4. Turn the V-paging channels off by default (`ROOM_WATCHDOG_PAGE_V` unset) or leave them as they are.
5. Migration 0119 is applied by an authenticated POST /api/run-migrations, as ever, never by a deploy.
6. The 5-minute "watchdog silent" threshold.

## What I need from eta-refuter
Tell me if #332 says something different from my five points. Then try to break this: a path where state advances without an alert, a
duplicate alert, an alert on history, an alert to a muted room, or a way the heartbeat or the tool could hide a dead cron.
