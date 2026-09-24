# Room Watchdog alert path — DESIGN (scribe, 24 Sep 2026, Fable ruling 128(a))

**Status: DESIGN, REVISION 2. Nothing here is built. eta-refuter refuted revision 1 (#397); this revision answers F1-F6. eta-refuter refutes it again before any build; Fable rules on the open decisions at the end.**

## Revision 3 — eta-refuter's second pass (#404) closed F1-F6 and added four items, folded in below
- **F7 (mine, B) — alert starvation, created by the F2 fix.** One list "ascending, id > after_id OR in the lookback, capped at 100" puts the already-delivered lookback rows
  FIRST, so 100+ rows in the window means every poll returns the same 100 old rows and new alerts starve, during an alert storm. **The tool now returns TWO sets:**
  `new` = `id > after_id ORDER BY id LIMIT n` (the limit bounds ONLY new rows) and `late` = `id <= after_id AND created_at > now() - lookback` (the lookback looks only where a skip can happen).
- **F9 (mine, B + relay) — absent read as healthy, one level below F4.** A body without `heartbeat_age_s`, or with null (a fresh deploy where 0119 is applied and no run
  has written the heartbeat yet, an older deploy, a bug) must be SILENT, never healthy. **The tool returns an explicit `heartbeat: { state: "ok" | "stale" | "none", age_s }`**,
  never a bare null; `none` means no run has ever recorded. The relay treats `none`, a missing field and a null as SILENT.
- **F8 (relay) — check-then-post is idempotent only under mutual exclusion.** The relay runs under a single-instance lock (pane-watch already has one).
- **F10 (relay + conductor) — SILENT has an exit.** Post a recovery when a SILENT condition clears and RE-ARM it (or a second cron death is silent about being silent).
  The edge state does NOT have to survive a relay restart: re-posting on restart is the safer default (loud beats lost). F6(c) needs an OWNER on conductor's side: the
  relay writing its last-poll time does nothing unless conductor's cycle checks it.
- Noted, not blocking: under overlapping runs the message TEXT (`status_from`, a recovery's "down for") comes from the read at run start and can be stale. The KIND is always right,
  because the gate compares EXCLUDED with the CURRENT row.

## Revision 2 — what changed and why (eta-refuter #397)
| finding | what was wrong in rev 1 | change |
|---|---|---|
| **F1** (mine, A) | Outbox fed `FROM changed` state writes. Writes and messages are NOT one-to-one: D2 first sight = 1 write / 0 messages, D9 muted = 1 write / 0 messages, D3 fleet outage = N writes / 1 message. Rev 1 would have alerted on history, alerted muted rooms, and turned one fleet outage into N alerts. | Outbox is fed FROM `plan.messages`. `changed` is ONLY the race gate. Messages carry `room_ids`. |
| **F2** (relay) | `id > after_id` on a bigserial: ids are taken at INSERT, not at COMMIT, so a poll can read a later id and skip an earlier one that commits after. | The tool returns `id > after_id` OR rows from a trailing DB-clock lookback; the relay dedupes (F3). Upsert rows are ordered by `room_id` so overlapping runs cannot deadlock. |
| **F3** (relay) | "Idempotent by bus thread id" is FALSE: `messages.thread_id` is a plain non-unique TEXT column; a thread groups, it does not dedupe. | The relay checks `bus_thread("room-alert-<id>")` before posting and the board before appending. This is also what makes F2's lookback safe. |
| **F4** (relay) | A failed read of the tool would read as "no new rows", so an app outage looks like "all rooms fine". | "Cannot read the door" (network, auth, revoked token) is its OWN silent condition, distinct from "read ok, zero rows". |
| **F5** (mine, B) | The heartbeat is a timestamp compared to the Mini's clock. | The tool returns `heartbeat_age_s`, computed by the database. The lookback is also a DB clock. |
| **F6** (Fable's call) | If the relay dies there is neither an alert nor a SILENT message. | Minimum: the relay writes its last-poll time to the board and conductor's existing cycle checks it. |
Also found: today's write has NO `IS DISTINCT FROM`, so two overlapping cron runs can already BOTH dispatch. That is a live duplicate this design fixes.
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
`(id bigserial pk, created_at, kind in ('offline','degraded','recovered','fleet_outage'), room_ids text[], room_name, status_from, status_to, subject, body)`
and one-row `room_watchdog_heartbeat (id = 1, last_run_at, last_ok, evaluated, last_error)`.

`planWatchdogRun` stays PURE and keeps every rule. Its messages only gain `kind` and `room_ids` (one id for an individual message; the
rooms that crossed into offline for a fleet_outage). `runWatchdog` then does ONE statement per run, taking the plan's writes AND messages as
arrays/JSON:
```
WITH changed AS (
  INSERT INTO room_alert_state (room_id, status, since, updated_at)
  SELECT ... FROM unnest(...) ORDER BY room_id          -- same lock order in every run
  ON CONFLICT (room_id) DO UPDATE SET ... WHERE room_alert_state.status IS DISTINCT FROM EXCLUDED.status
  RETURNING room_id
)
INSERT INTO room_alert_outbox (kind, room_ids, room_name, ..., subject, body)
SELECT ... FROM jsonb_to_recordset(<plan.messages>) m
 WHERE EXISTS (SELECT 1 FROM changed c WHERE c.room_id = ANY (m.room_ids))
```
- **The outbox is fed FROM `plan.messages`, never from the state writes** (F1). D2 (first sight: a write, no message), D9 (muted: a write,
  no message) and D3 (fleet outage: N writes, ONE message, the individual ones swallowed) are therefore exactly what the planner says.
- **`changed` is only the race gate:** an individual message is inserted iff its room actually changed in THIS statement; a fleet_outage iff at least one of its
  rooms did. Two overlapping runs cannot both alert.
- **State advances if and only if the alerts are queued.** One statement: if it fails, nothing advances and the next minute retries.
- The email/WhatsApp senders stay in the code but are gated behind `ROOM_WATCHDOG_PAGE_V` (default OFF, `parseFlag`). Marked, never deleted.

### B. A read door for the outbox (app side — mine)
A read-scope MCP tool `scribe_room_alerts(after_id, lookback_minutes = 10, limit <= 100)` returns TWO sets (F7): `new` (`id > after_id`, ascending, capped at `limit`) and
`late` (`id <= after_id AND created_at > now() - lookback_minutes`, the DATABASE's clock, uncapped by `limit` and small by construction), plus
**`heartbeat: { state: "ok" | "stale" | "none", age_s }`, computed by the database** (F5, F9). The relay never
compares a timestamp to the Mini's clock. Read-only: the relay owns its cursor, and because commits can land out of id order (F2) the lookback is what
guarantees a row is seen even if a later id was read first. Duplicates from the lookback are the relay's to drop (F3).

### C. The relay (Mini side — NOT mine; herdr-kit / pane-watch). The contract it must meet:
Every 30-60 s call the tool with its cursor.
1. **Dedupe before acting (F3).** Before posting row `<id>`, call `bus_thread("room-alert-<id>")` and skip the post if it exists; check the board for that id
   before appending. A bus thread groups and does not dedupe, so this check IS the idempotency. It is also what makes the lookback (F2) safe.
2. Post to the bus agent `conductor` (`urgent` for offline, degraded and fleet_outage; `normal` for recovered; `thread_id = room-alert-<id>`) and append one
   board line carrying the **`room_id` only**; the bus message may carry the name. Advance the cursor only after both, written atomically.
3. **Run under a single-instance lock** (F8): two relays would both see an empty thread and both post.
4. **Three distinct SILENT conditions, each posted once, edge-triggered on the relay's own side, each with an EXIT recovery message that RE-ARMS it (F10):**
   a. **cannot read the door** (network, auth failure, revoked or expired token, non-200): this must NEVER read as "no new rows" (F4);
   b. **read ok but the heartbeat is not `ok`**: `stale` (age > 300 s or `last_ok` false), OR `none`, OR the field missing or null (F9) — the watchdog cron is not running or has never run;
   c. **the relay itself** (F6, minimum): it writes its last-poll time to the board and **conductor's existing cycle checks it (owner: conductor, to confirm)**.
5. If the bus or the board is unreachable the cursor does not move; the rows wait in the database.

### D. What is deliberately not changed
Edge-trigger semantics, D2 seeding, mute, the fleet-outage threshold, the 1-minute cron, the classifier (`FLAG_REASON`).

## Tests planned (before any code is called done)
- Pure: messages carry `kind` and `room_ids`; planning output is otherwise unchanged.
- **Real postgres, the writes-to-messages mapping (F1) — the tests rev 1 lacked:**
  - a **seed** run (`prior === null`) -> 0 outbox rows and 1 state row;
  - a **muted** transition -> 0 outbox rows and the state row moved;
  - a **fleet outage** (N rooms into offline in one run) -> exactly ONE row, kind `fleet_outage`, and none of the swallowed individual ones;
  - a normal transition -> exactly one row; a **recovery** -> one row.
- **Atomicity (kept):** a trigger that raises on the outbox insert must leave `room_alert_state` on its EARLIER status; the split mutant (two statements) must FAIL it.
- **Race:** two concurrent runs over the same change -> exactly one outbox row; upsert order is by `room_id`.
- The read tool: cursor plus lookback returns a row committed out of id order; read scope only; `heartbeat_age_s` comes from the database.
- Heartbeat: written on ok, on read failure and on error; a heartbeat write failure never fails the run.
- **F7:** 100+ rows inside the lookback plus one new row -> the new row is returned in `new`. **F9:** a fresh table (no heartbeat row) reads `state: "none"`, never `ok`.
- Relay-side tests (herdr-kit's), which eta-refuter will look for: two relays over the same row post once (F8); SILENT enter, clear, re-enter posts THREE messages, not one (F10).

## Open decisions (Fable)
1. Approve outbox + pull relay. The app cannot push to the bus, so a Mini-side relay is unavoidable; the owner would be herdr-kit.
2. **Relay token.** A read-scope entry in `SCRIBE_MCP_TOKENS` is the same write-only-secret problem as the night-feeder token (herdr-kit #207).
   I propose the relay uses an EXISTING read token. Say if you want a new one instead.
3. **Room names carry a doctor's name** (slugs like `opd-N-dr-<name>`). The bus already takes them, as the emails did. The board is a file in a git
   repo, so I propose the board line carries `room_id` and the bus message carries the name. Your call.
4. Turn the V-paging channels off by default (`ROOM_WATCHDOG_PAGE_V` unset) or leave them as they are.
5. Migration 0119 is applied by an authenticated POST /api/run-migrations, as ever, never by a deploy.
6. The 5-minute "watchdog silent" threshold (now a database-computed age, F5).
7. **How far to take F6.** Minimum proposed: the relay writes its last-poll time to the board and conductor's existing cycle checks it. Anything stronger needs a
   second, independent watcher, which is a separate piece of work.

## What I need from eta-refuter
Re-try to break revision 2: a path where state advances without an alert, a duplicate alert, an alert on history, an alert to a muted room, a row the
relay can miss, or a way the heartbeat or the tool could hide a dead cron or a dead door. (#332 was an ack, not a finding; my five facts were confirmed in #397.)
