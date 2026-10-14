# Room Guardian: Mini side (FR-1 C4)

Spec: FR-1 section 5 (R4), A0, A6. Code is under `mini/`. Nothing here is installed, loaded or started by this repo. Config, keys and hosts live only in `~/oc/fleet-access/guardian/` (examples in `mini/config/`).

| Part | Path | What it is |
|---|---|---|
| Pipe server | `mini/pipe/` | `build-pipe.sh` (pico at 40c2ba8, needs Go), `run-pipe.sh` (checks host key 0600, DB url from a 0600 file, refuses port 22), `pipe-server.plist.template`, `authorize-key.sh` (key rows) |
| Subscriber | `mini/subscriber/` | JSONL per day (30-day prune), quiet > 120 s edge alert, control snapshot (kill switch, modes) |
| Alert router | `mini/router/alert_router.py` | case open / re-page / ack / close, V rule, 21:00 unacked list |
| Successor relay | `mini/router/router_relay.py` | subclasses the kit `Relay` by path; the kit file is not edited |
| Relay watcher | `mini/router/relay_watcher.py` | pages if the relay's last-poll is older than 10 min |
| Case store | `alert_router.SqliteStore` | Mini-local SQLite `<GUARDIAN_HOME>/data/cases.sqlite`, WAL, nightly copy to `backup/` (14 kept). No app-DB table, no migration (R2 ruling 1) |

Tests: `mini/tests/run.sh` (shellcheck, then 26 unittest cases; clock injected).

## Flags (not settled by the kickoff)
1. Mini-detected alerts (`guardian_quiet`, `heal_escalated`) go from the subscriber straight to the router, never the server outbox (R2 ruling 2). Their case ids are `>= 10^12` (`LOCAL_ID_BASE`) so they cannot collide with outbox ids; the page body says `source=mini`.
2. Control topic `guardian/control` accepted by gating-lead. The read form `ssh -p PORT host sub <topic>` is unverified; pipe topic wildcards unverified, so the room list comes from `rooms.json`.
3. Heal record shape is inferred: `result == "escalated"` opens `heal_escalated`, `"ok"`/`"healed"` closes it. C1 must match.
4. Router V-notice state and the digest day sit in `data/router-local.json`. Only the relay's router writes it; the subscriber's router has none.
5. A `recovered` outbox row closes every open case of that room; coverage unverified.
6. Bus message shape from `bus_thread` (`from`, `subject`, `body`) is inferred.
7. Two processes (relay, subscriber) share the SQLite file. WAL plus a 10 s busy timeout; the unique open-case index settles a race (loser counts as a duplicate).

## Phase 0 live deployment (14 Oct 2026, FR-1 C4 on the Mini)
The code the Mini actually runs is in this tree. The Mini copies it into `~/oc/fleet-access/guardian/{app,scripts}` (layout in `mini/ops/check-deployed.sh`, which diffs the two). Config, keys, data and logs stay only under `~/oc/fleet-access/guardian/` (G7); examples are in `mini/config/`.
Changes over 5574b09, in one list:
- **Pipe**: `pipe/run-pipe.sh` binds the tailnet address read from `tailscale ip -4` at start, refuses port 22 and `PICO_PIPE_ENABLED` anything but false, redacts `DATABASE_URL` from pico's log. New: `init-schema.sh` (pico migrations the pipe touches), `add-key.sh` (idempotent app_users + public_keys rows), `grant-admin.sh` (pico `admin` feature for the subscriber only), `pipe-ssh.sh`, `run-postgres.sh` (own cluster, loopback only), `outbound-check.sh` (pipe process makes no outbound TCP).
- **Pico topics are per user.** A room key `<room>` publishing `kiosk/<room>/health` lands on `<room>/kiosk/<room>/health`; the admin subscriber reads `/<room>/kiosk/<room>/<stream>` and publishes `/<room>/guardian/control`. Publishers must send newline-terminated JSON and use `pub -c -b=false`.
- **Router**: opening and closing a case only writes the store (no bus); `tick()` makes ONE ubus send per tick on the day thread `room-alert-batch-<day>`, each stage isolated; ACK accepts several ids per message, one line listing ids, and `Re:` replies; `router.json` is refused if an acker is not in `to`. Bus is ubus (`router/ubus_bus.py`, `router/run_router.py`), not the eta-bus. `router_relay.py` and `relay_watcher.py` are unchanged and NOT run.
- **Subscriber**: reconnecting readers (`sub -c -k`), per-room control publish, rooms from `rooms.json`; rotated days are moved to `data/_to_delete/`, never deleted.
- **Backups**: `ops/pgdump.sh` writes to the internal `backup/` (14 kept; older and failed runs move to `backup/_to_delete/`), a failure opens a `backup_failed` case (`ops/backup-case.py`). The Air Drive copy is deferred (no Full Disk Access).
- **Kill switch**: file `etc/kill-switch`; `off` = actions allowed, anything else or missing = killed. Consumers treat no control message for more than 90 s as kill=true.
Tests: `mini/tests/run.sh` (shellcheck, then 60 unittest cases; one needs `lib/alerts/clinic-hours.ts` from this repo).
