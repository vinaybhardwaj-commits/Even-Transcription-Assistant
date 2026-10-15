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

Tests: `mini/tests/run.sh` (shellcheck, then the unittest suite; clock injected).

## Flags (not settled by the kickoff)
1. Mini-detected alerts (`guardian_quiet`, `heal_escalated`) go from the subscriber straight to the router, never the server outbox (R2 ruling 2). Their case ids are `>= 10^12` (`LOCAL_ID_BASE`) so they cannot collide with outbox ids; the page body says `source=mini`.
2. Control topic `guardian/control` accepted by gating-lead. The read form `ssh -p PORT host sub <topic>` is unverified; pipe topic wildcards unverified, so the room list comes from `rooms.json`.
3. Heal record shape is inferred: `result == "escalated"` opens `heal_escalated`, `"ok"`/`"healed"` closes it. C1 must match.
4. Router V-notice state and the digest day and the month of the last size line sit in `data/router-local.json`. Only the relay's router writes it; the subscriber's router has none.
5. A `recovered` outbox row closes every open case of that room; coverage unverified.
6. Bus message shape from `bus_thread` (`from`, `subject`, `body`) is inferred.
7. Two processes (relay, subscriber) share the SQLite file. WAL plus a 10 s busy timeout; the unique open-case index settles a race (loser counts as a duplicate).

## Phase 0 live deployment (14 Oct 2026, FR-1 C4 on the Mini)
The code the Mini actually runs is in this tree. The Mini copies it into `~/oc/fleet-access/guardian/{app,scripts}` (layout in `mini/ops/check-deployed.sh`, which diffs the two). Config, keys, data and logs stay only under `~/oc/fleet-access/guardian/` (G7); examples are in `mini/config/`.
Changes over 5574b09, in one list:
- **Pipe**: `pipe/run-pipe.sh` binds the tailnet address read from `tailscale ip -4` at start, refuses port 22 and `PICO_PIPE_ENABLED` anything but false, redacts `DATABASE_URL` from pico's log. New: `init-schema.sh` (pico migrations the pipe touches), `add-key.sh` (idempotent app_users + public_keys rows), `grant-admin.sh` (pico `admin` feature for the subscriber only), `pipe-ssh.sh`, `run-postgres.sh` (own cluster, loopback only), `outbound-check.sh` (pipe process makes no outbound TCP).
- **Pico topics are per user.** A room key `<room>` publishing `kiosk/<room>/health` lands on `<room>/kiosk/<room>/health`; the admin subscriber reads `/<room>/kiosk/<room>/<stream>` and publishes `/<room>/guardian/control`. Publishers must send newline-terminated JSON and use `pub -c -b=false`.
- **Router**: opening and closing a case only writes the store (no bus); `tick()` makes ONE ubus send per tick on the day thread `room-alert-batch-<day>`, each stage isolated; the 21:00 unacked list and the monthly `backup/_to_delete` size line ride in that same send (one block; it waits if the body is full or the send fails); the already-paged check reads today's and yesterday's day thread (no repeat page across IST midnight); ACK accepts several ids per message, one line listing ids, and `Re:` replies; `router.json` is refused if an acker is not in `to`. Bus is ubus (`router/ubus_bus.py`, `router/run_router.py`), not the eta-bus. `router_relay.py` and `relay_watcher.py` are unchanged and NOT run.
- **Subscriber**: reconnecting readers (`sub -c -k`), per-room control publish, rooms from `rooms.json`; rotated days are moved to `data/_to_delete/`, never deleted.
- **Backups**: `ops/pgdump.sh` writes to the internal `backup/` (14 kept; older and failed runs move to `backup/_to_delete/`), a failure or a TERM / INT kill leaves no `.part` (files move to `backup/_to_delete/*.bad`) and opens a `backup_failed` case (`ops/backup-case.py`). **Owner of every `_to_delete` folder: fleet / herdr-lead review them (no automatic prune; no hard deletes).** The router adds size lines for `backup/_to_delete`, `data/_to_delete` and `logs/_to_delete` to the 21:00 list on the first run of each month. The case-store copy rotation (`SqliteStore.backup_to`, used by the relay) moves its oldest files to `_to_delete/` too; nothing in these tools deletes a file. The Air Drive copy is deferred (no Full Disk Access).
- **Deploy**: `mini/ops/deploy.sh` copies this tree to the live Mini layout, writes `app/SOURCE-SHA` (the tree's git sha, `+dirty` if uncommitted) and runs `ops/check-deployed.sh`. It restarts no job: restart only the job whose code changed.
- **Kill switch**: file `etc/kill-switch`; `off` = actions allowed, anything else or missing = killed. Consumers treat no control message for more than 90 s as kill=true.
Tests: `mini/tests/run.sh` (shellcheck, then the unittest suite; one test needs `lib/alerts/clinic-hours.ts` from this repo).

## Kiosk Guardian: threat model (R12, R13, R14)
- The kiosk `guardian.conf` is data. `lib/conf.sh` reads allow-listed `KEY=value` lines and nothing else; it is never sourced. An unknown key, a bad value, a duplicate or any other line makes the agent run KILLED (shadow, no actions, health still published, the line number and key name audited).
- The code and the root helper are the trust boundary. Whoever can write the agent directory (code, `lib/`, the plist) or the root helper controls the kiosk; the conf cannot.
- The safety numbers are readonly constants in `lib/common.sh`: the 90 s control limit, the 30 s skew, the 4096 byte caps, the fetch period. They are not conf keys and the environment cannot set them.
- `guardian.sh run` and `check` read no test seam (`GUARDIAN_TESTMODE`, `GUARDIAN_FAKE_NOW`, `GUARDIAN_PS`, `GUARDIAN_FLAG_CMD`, `GUARDIAN_CONF`) and no tunable from the environment. A variable set on the launchd plist, or by `launchctl setenv`, changes nothing in the agent. The plist runs `bash -p` and sets only `GUARDIAN_HOME`; `run` and `check` re-exec once under `bash -p` if started without it. `GUARDIAN_TEST_ENTRY` is honoured only when `tests/run.sh` sits next to the script tree, which the installer never copies.
- Every child that runs a conf command (publish, subscribe, control subscribe, the sudo path) is started with `/usr/bin/env -i` and only HOME, USER, LOGNAME, TMPDIR, a fixed PATH (`/usr/bin:/bin:/usr/sbin:/sbin` only, R14: a conf command that needs another tool names it by absolute path), `GUARDIAN_HOME` and `GUARDIAN_PIPE_SSH` (from the conf), then `/bin/bash -p -c`. `BASH_ENV`, `ENV`, `BASH_FUNC_*`, `SHELLOPTS`, `BASHOPTS`, `PS4` and `IFS` from outside never reach those children. The pid probe (`sh -c 'echo $PPID'`, the one other shell the agent starts) runs under the same `env -i` (R14).
- The conf must be a regular file (not a symlink), owned by root or the agent's uid, not group- or world-writable, and carry no ACL entry (`ls -led` shows none). Its directory, and `GUARDIAN_HOME`, must be owned by root or the agent, not group- or world-writable, and carry no ACL (R14). The file is opened once and every check runs on that in-memory copy. Otherwise nothing is read: the agent runs KILLED and audits `conf rejected: <symlink|not regular|owner|mode|acl|dir>`. `install.sh` creates `GUARDIAN_HOME` 0700, writes the conf 0600 with ACLs stripped (`chmod -N`), and repairs an existing conf that fails these checks by writing a temp file in the same directory and `mv` over the name (never through a symlink).
- Accepted: `POSIXLY_CORRECT` in the agent's environment makes bash reject `bin/guardian.sh` (`< <(...)` is a syntax error in POSIX mode): the agent exits with an error and nothing acts. It fails closed.
- Production needs `GUARDIAN_CONTROL_SUB_CMD`. Empty or missing means killed. The old flag-command path is not used in run mode.
- Accepted: `GUARDIAN_HOME`, `RR_*` and `HOME` still come from the environment. Both are inside the trust boundary above (an attacker who can set them can already write the agent directory).
