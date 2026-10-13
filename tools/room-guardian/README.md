# Room Guardian: Mini side (FR-1 C4)

Spec: FR-1 section 5 (R4), A0, A6. Code is under `mini/`. Nothing here is installed, loaded or started by this repo. Config, keys and hosts live only in `~/oc/fleet-access/guardian/` (examples in `mini/config/`).

| Part | Path | What it is |
|---|---|---|
| Pipe server | `mini/pipe/` | `build-pipe.sh` (pico at 40c2ba8, needs Go), `run-pipe.sh` (checks host key 0600, DB url from a 0600 file, refuses port 22), `pipe-server.plist.template`, `authorize-key.sh` (key rows) |
| Subscriber | `mini/subscriber/` | JSONL per day (30-day prune), quiet > 120 s edge alert, control snapshot (kill switch, modes) |
| Alert router | `mini/router/alert_router.py` | case open / re-page / ack / close, V rule, 21:00 unacked list |
| Successor relay | `mini/router/router_relay.py` | subclasses the kit `Relay` by path; the kit file is not edited |
| Relay watcher | `mini/router/relay_watcher.py` | pages if the relay's last-poll is older than 10 min |
| Migration | `db/migrations/0166_room_alert_case.sql` | table `room_alert_case` (not `room_alert_state`, which is the watchdog's) |

Tests: `mini/tests/run.sh` (shellcheck, then 21 unittest cases; clock injected).

## Flags (not settled by the kickoff)
1. No production case store. The Mini has no writer for the app database. `SqliteStore` is dev/test only; `router_relay.main()` refuses to start. Needs a ruling: authenticated server endpoint, or a Scribe MCP tool.
2. No server entry point for `guardian_quiet`. The subscriber spools to `data/spool/guardian-alerts.jsonl`. Same ruling as 1.
3. Control topic `guardian/control` and the read form `ssh -p PORT host sub <topic>` are my choices; C1 must match. Pipe topic wildcards unverified, so the room list comes from `rooms.json`.
4. Router V-notice state and the digest day sit in a local JSON file, not the table (the columns were fixed by the order). Losing it repeats a V notice.
5. `recovered` closes every open case of that room. Which kinds a recovery row really covers is unverified.
6. Bus message shape from `bus_thread` (`from`, `subject`, `body`) is inferred.
