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

## Kiosk Guardian: threat model (R12, R13)
- The kiosk `guardian.conf` is data. `lib/conf.sh` reads allow-listed `KEY=value` lines and nothing else; it is never sourced. An unknown key, a bad value, a duplicate or any other line makes the agent run KILLED (shadow, no actions, health still published, the line number and key name audited).
- The code and the root helper are the trust boundary. Whoever can write the agent directory (code, `lib/`, the plist) or the root helper controls the kiosk; the conf cannot.
- The safety numbers are readonly constants in `lib/common.sh`: the 90 s control limit, the 30 s skew, the 4096 byte caps, the fetch period. They are not conf keys and the environment cannot set them.
- `guardian.sh run` and `check` read no test seam (`GUARDIAN_TESTMODE`, `GUARDIAN_FAKE_NOW`, `GUARDIAN_PS`, `GUARDIAN_FLAG_CMD`, `GUARDIAN_CONF`) and no tunable from the environment. A variable set on the launchd plist, or by `launchctl setenv`, changes nothing in the agent. The plist runs `bash -p` and sets only `GUARDIAN_HOME`; `run` and `check` re-exec once under `bash -p` if started without it. `GUARDIAN_TEST_ENTRY` is honoured only when `tests/run.sh` sits next to the script tree, which the installer never copies.
- Every child that runs a conf command (publish, subscribe, control subscribe, the sudo path) is started with `/usr/bin/env -i` and only HOME, USER, LOGNAME, TMPDIR, a fixed PATH, `GUARDIAN_HOME` and `GUARDIAN_PIPE_SSH` (from the conf), then `/bin/bash -p -c`. `BASH_ENV`, `ENV`, `BASH_FUNC_*`, `SHELLOPTS`, `BASHOPTS`, `PS4` and `IFS` from outside never reach those children.
- The conf must be a regular file (not a symlink), owned by root or the agent's uid, and not group- or world-writable (`install.sh` writes it 0600). Otherwise nothing is read: the agent runs KILLED and audits `conf rejected: <symlink|not regular|owner|mode>`.
- Production needs `GUARDIAN_CONTROL_SUB_CMD`. Empty or missing means killed. The old flag-command path is not used in run mode.
- Accepted: `GUARDIAN_HOME`, `RR_*` and `HOME` still come from the environment. Both are inside the trust boundary above (an attacker who can set them can already write the agent directory).
