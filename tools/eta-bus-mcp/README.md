# eta-bus

A stdio MCP server giving the `fable` orchestrator and the Claude Code
agents running inside `herdr` on the Mac Mini a shared message bus, plus
read-only/orchestrator herdr control tools. No npm dependencies — pure
Node ESM using `node:sqlite` (`DatabaseSync`) and `node:child_process`.

## Layout

```
eta-bus-mcp/
  server.mjs          stdio JSON-RPC 2.0 loop (initialize/tools-list/tools-call)
  run.sh              launcher (sets PATH, execs node)
  lib/
    constants.mjs      paths, limits, protocol versions
    db.mjs             SQLite schema + queries (WAL, busy_timeout=5000)
    identity.mjs        caller identity resolution (60s cache)
    herdrctl.mjs        wrappers around `herdr agent list` and herdr-ctl.sh
    secrets.mjs         heuristic secret sniffing for bus_post bodies
    audit.mjs           metadata-only audit log
    tools.mjs           tool schemas + handlers
  test/
    unit.mjs            unit tests against a temp DB + mocked herdr calls
  README.md, FABLE-CONFIG.md, PANE-PROTOCOL.md, TEST-REPORT.md
```

## Storage

SQLite at `/Users/vinaybhardwaj/dev/_fable/bus/bus.db`, WAL mode,
`busy_timeout=5000` so the ~13 concurrent processes (fable + ~11 panes,
plus test agents) can share the file safely.

Tables: `messages`, `receipts` (composite PK `message_id,recipient`),
`nudges` (last-nudge timestamp per recipient, for the 120s rate limit).

## Caller identity

1. `ETA_BUS_AS` env var, if set (the orchestrator runs with
   `ETA_BUS_AS=fable`).
2. Otherwise `HERDR_PANE_ID` (herdr injects this into every pane it
   manages) matched against `herdr agent list` for **this process's own
   herdr session** — see "Session scoping" below — resolved to that
   agent's live name.
3. Otherwise `'unknown'`. Every tool refuses an unknown caller.

Resolution is cached 60s per server process (each pane/orchestrator runs
its own eta-bus child process, so this is a per-process cache, not
shared).

**Deliberate deviation from the spec's "herdr-ctl.sh reuse" instruction:**
identity resolution calls `herdr agent list` directly (read-only JSON,
no shared-file side effects) instead of shelling out to
`herdr-ctl.sh status`, which writes to shared scratch files
(`scratch/agent_list.json`, `scratch/herdr-status.json`). Identity
resolution runs on effectively every tool call from up to ~13 concurrent
processes; routing it through the shared-file `status` command would
make those races far more frequent than the occasional
human/orchestrator-invoked `herdr_status`/`bus_roster` call, which *do*
call `herdr-ctl.sh status` as specified. This is the only place the
server bypasses herdr-ctl.sh; every control/mutation action goes through
it.

## Session scoping

herdr injects `HERDR_SESSION` into every pane it manages (e.g.
`ctl-test`, or unset/`default` for the live session). All herdr calls
this server makes (identity resolution, nudge sends, `bus_roster`) use
that process's own `HERDR_SESSION` unless overridden. Every herdr control
tool additionally accepts an optional `session` argument so the
orchestrator (running outside any pane, over SSH) can target a specific
named session — this is how `ETA_BUS_AS=fable` calls were tested against
`ctl-test` without ever touching the live default session. Omitting
`session` targets the live default session, matching production use.

This `session` argument is **not** in the original spec's tool tables;
it was added because the spec's own test plan requires calling
`herdr_status`/`herdr_tag` "against ctl-test" from an orchestrator
identity that has no pane (and thus no `HERDR_SESSION`) of its own.

## Nudge behavior

`bus_post` nudges a recipient (via `herdr-ctl.sh send NAME "MSG"`) only
when: `wake` is true, the recipient is a live agent, its herdr state is
`idle` or `done` (not `blocked`, `working`, or `unknown`), and it hasn't
been nudged in the last 120s. A message is **always stored** regardless
of nudge outcome; the `per_recipient` status word explains why a nudge
did or didn't go out. A recipient rate-limited within the 120s window is
reported as `stored` (the enum in the spec has no distinct "rate
limited" value).

## Secret sniffing

`bus_post` refuses a body matching: `sk-...` style keys, `Bearer ...`
headers, `-----BEGIN ... PRIVATE KEY-----` / `CERTIFICATE` PEM blocks, or
a bare run of 40+ hex or base64-alphabet characters. This is a heuristic,
not a guarantee — see `PANE-PROTOCOL.md` for the actual rule agents
should follow (never put secrets or transcript text on the bus at all).

## Audit log

Every tool call appends one line to
`/Users/vinaybhardwaj/dev/_fable/scratch/eta-bus.log`:
`TIMESTAMP | caller=X | tool=Y | target=Z | result=R` — metadata only,
never a message body. Best-effort (a logging failure never fails the
tool call). Note: running `test/unit.mjs` also writes to this real log
file (it doesn't isolate the audit log the way it isolates the DB),
since the fake `bt-a`/`bt-b`/`fable` identities used there look
indistinguishable from real ones in the log — harmless (metadata only)
but worth knowing when reading the log.

## Install

```sh
/Users/vinaybhardwaj/.local/bin/claude mcp add --scope user eta-bus -- /bin/sh /Users/vinaybhardwaj/dev/eta-bus-mcp/run.sh
/Users/vinaybhardwaj/.local/bin/claude mcp list   # confirm eta-bus, even-jev, MCP_DOCKER all present
```

Running Claude Code processes do not reload MCP config — this only
affects panes that start (or restart) after the install.

### Machine list (`KNOWN_MACHINES`)

`lib/tools.mjs` keeps a `KNOWN_MACHINES` list of other herdr machines
whose agents must be reachable from the bus (`bus_post` resolution +
nudge via `--machine`, and `bus_roster` listing). As of Fable W27/W28
(26 Sep 2026) it contains:

- `eta-lab-t4` — the GPU box.
- `85baa2e0f8428b0b03a3e8606f826e43` — eta-ci-c3 (a labeled machine, so
  posts must use the machine id, not the label; before this was added, posts
  to c3 panes like `cap`/`stt-bench` came back `unknown_agent`).
- `6481ba9074c9fa50c5ebf1a2de931786` — asus-ubuntu (i7 16GB, no GPU;
  vp-asus/chronicle). Added per Fable 28 Sep, same labeled-machine rule:
  post by the machine id, not the label.
- The Yoga machine (`0901f12e74544272161d0b45a4bae75b`) is deliberately
  NOT in the list: its only pane (`yoga-free`) has never used the bus.
  Add its machine id the same way if a Yoga pane starts posting.

**Note for operators:** a running eta-bus server process (each pane has
its own) keeps serving the code it was started with until its MCP
connection reconnects (pane restart or MCP re-auth). So after editing
`KNOWN_MACHINES`, panes that are already running keep behaving under
the old list — e.g. posts from a stale pane to a newly added machine's
agents still return `unknown_agent` until that pane reconnects. Nothing
is lost: the message is still stored for readers on the new code.

## Testing

```sh
node test/unit.mjs                 # unit tests, temp DB + mocked herdr calls, no live session needed
```

See `TEST-REPORT.md` for the full unit + end-to-end run (including the
isolated `ctl-test` herdr session scenarios) and results.
