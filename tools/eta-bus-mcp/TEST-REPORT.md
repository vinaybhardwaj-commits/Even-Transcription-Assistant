# eta-bus test report

Built and tested 2026-09-23. All testing that posts, nudges, or controls
an agent ran against the isolated herdr session `ctl-test`, with two
throwaway `--model haiku` agents (`bt-a`, `bt-b`). The live default
herdr session (12 working agents) received **zero** input of any kind —
only read-only `herdr agent list` / `herdr status`-style calls were made
against it, purely to confirm its state was unchanged before and after.
`ctl-test` was fully torn down at the end (see "Teardown").

## Unit tests (`node test/unit.mjs`)

Run against a temp SQLite DB per test (via `openDb(tempPath)`) and
mocked `herdr agent list` / `herdr-ctl.sh` calls (`_setAgentListOverrideForTests`,
`_setRunHerdrCtlOverrideForTests`) — no live herdr session required.

```
PASS identity: ETA_BUS_AS wins
PASS identity: HERDR_PANE_ID resolves via agent list
PASS identity: no env at all -> unknown
PASS identity: unmatched pane id -> unknown
PASS bus_post + bus_inbox: basic delivery and read marking
PASS bus_ack: acks known ids, reports unknown ones
PASS bus_thread: returns full thread oldest-first
PASS bus_post: "all" expands to every live agent except sender
PASS bus_post: refuses body that looks like a secret
PASS bus_post: unidentified caller is refused
PASS bus_post: nudges an idle recipient and sends via herdr-ctl send
PASS bus_post: does not nudge a blocked recipient
PASS bus_post: does not nudge a working recipient
PASS bus_post: unknown recipient name is reported, not nudged
PASS bus_post: nudge rate-limited to one per 120s per recipient
PASS herdr_send: refuses a non-fable caller
PASS herdr_restart: refuses a non-fable caller but allows fable

17 passed, 0 failed
```

Run both locally (sandboxed Linux container, Node 22.22) and on the Mini
(Node 26) — identical results both times.

## Bug found and fixed during testing

**Server exited before finishing in-flight async tool calls.** The
initial `server.mjs` called `process.exit(0)` on stdin `close` (EOF)
unconditionally. A `tools/call` for a herdr control tool spawns a child
process (`herdr-ctl.sh`) and is therefore asynchronous; when driving the
server with a one-shot `printf ... | run.sh` pipe (as the direct
JSON-RPC test below does), stdin hits EOF as soon as the last line is
written, which raced ahead of `herdr_status`/`herdr_tag`'s still-running
child processes and killed the process before their responses were
written — those two calls simply never returned anything. A real MCP
client keeps stdin open for the life of the connection, so this would
not affect production panes, but it made this exact test pattern from
the spec fail outright. Fixed by tracking in-flight request promises and
only exiting once stdin is closed *and* all in-flight promises have
settled. Confirmed fixed (see below) and re-verified all 17 unit tests
still pass.

## Setup for end-to-end tests

- Installed `eta-bus` at Claude Code **user** scope:
  `claude mcp add --scope user eta-bus -- /bin/sh /Users/vinaybhardwaj/dev/eta-bus-mcp/run.sh`.
  `claude mcp list` confirms `eta-bus`, `even-jev`, and `MCP_DOCKER` all
  present (see "claude mcp list" section below).
- Started an isolated headless herdr session: `herdr --session ctl-test server`.
- Spawned two throwaway haiku agents into it via the mandated
  `herdr-ctl.sh spawn` subcommand (never reimplemented):
  `herdr-ctl.sh --session ctl-test spawn bt-a /tmp/eta-bus-test-a haiku --skip-permissions`
  and the same for `bt-b`. Both came up `idle` with the new user-scope
  `eta-bus` server already available to them (no per-project `.mcp.json`
  needed).

## End-to-end scenarios (all against `ctl-test`)

1. **bt-a posts to bt-b, bt-b idle → nudged → reads via bus_inbox.**
   Prompted `bt-a` (via `herdr-ctl.sh send`, never direct pane input from
   us) to call `bus_post({to:["bt-b"], subject:"ping", body:"hello from
   bt-a test 1"})`. Result: `{"bt-b":"nudged"}`. `bt-b`'s pane showed the
   injected `[bus] You have 1 unread message(s) (latest from bt-a:
   ping). Call bus_inbox to read them.` prompt, which `bt-b` acted on by
   calling `bus_inbox` and reading "hello from bt-a test 1". Audit log:
   `...bus_post...id=1 {"bt-b":"nudged"}` then
   `caller=bt-b | tool=bus_inbox | ... | result=returned=1`.

2. **Nudge NOT sent while bt-b is working.** Prompted `bt-b` with a long
   free-form task (count 1–20 with a sentence each) to put it in
   `working` state (confirmed via `herdr-ctl.sh status`), then
   immediately had `bt-a` call `bus_post` to `bt-b` again. Result:
   `{"bt-b":"not_nudged_working"}`; audit log confirms
   `not_nudged_working` and no second `herdr-ctl.sh send` was issued.
   `bt-b`'s pane transcript shows its counting task ran to completion
   with no `[bus]` interruption injected mid-task — the message was
   still stored (`bus_roster` later showed `unread: 1` for `bt-b`).

3. **Non-fable caller refused on `herdr_restart`.** Prompted `bt-a`
   (real identity, resolved via its own `HERDR_PANE_ID` → `bt-a`, not
   `ETA_BUS_AS`) to call `herdr_restart({name:"bt-b"})`. Its own reply:
   `herdr_restart is orchestrator-only (caller must be 'fable', got
   'bt-a')` — refused before any herdr-ctl.sh call was made; `bt-b` was
   never touched.

4. **`ETA_BUS_AS=fable` via a direct JSON-RPC pipe → `herdr_status` and
   `herdr_tag` against `ctl-test`.** Ran
   `ETA_BUS_AS=fable /bin/sh run.sh` on the Mini, feeding it
   `initialize` → `tools/call herdr_status {session:"ctl-test"}` →
   `tools/call herdr_tag {name:"bt-a", task:"e2e-tagged-by-fable",
   session:"ctl-test"}` over stdin. Both succeeded (`exit=0`); a
   follow-up `herdr_status` call showed `bt-a`'s task column updated to
   `e2e-tagged-by-fable`, proving the write actually landed via
   `herdr-ctl.sh tag` against the named session, not the live one.

5. **Extra spot checks** (not explicitly required but exercised):
   `herdr_transcript({name:"bt-a", tail:10, session:"ctl-test"})`
   correctly ran `herdr-ctl.sh transcript`, then read and returned the
   markdown file it produced. `bus_roster` (via `HERDR_SESSION=ctl-test`)
   returned both agents with correct state/model/task and a correct
   per-agent `unread` count (`bt-b: 1`, matching the working-state
   message that was stored but never read).

## `claude mcp list` (Mini, after install)

```
even-jev: /Users/vinaybhardwaj/dev/even-jev-mcp/run.sh  - ✔ Connected
MCP_DOCKER: docker mcp gateway run --profile mini-claude - ✘ Failed to connect — ENOENT: Executable not found in $PATH: "docker"
eta-bus: /bin/sh /Users/vinaybhardwaj/dev/eta-bus-mcp/run.sh - ✔ Connected
```

`MCP_DOCKER`'s failure is pre-existing (no `docker` binary in `PATH` on
this Mini) and unrelated to eta-bus; it was already failing before this
work and is listed here only to confirm it's still present per
instructions, not newly broken.

## Teardown and live-session safety

- `/tmp/eta-bus-test-a`, `/tmp/eta-bus-test-b`, and other scratch temp
  files were removed.
- `herdr session stop ctl-test` — confirmed `stopped ctl-test`;
  `herdr session list` afterward shows only `default: running`,
  `ctl-test: stopped`, no lingering process.
- Live default session's `herdr agent list` was called twice (before
  starting work and after teardown), read-only both times: the same 11
  named agents (`eta-refuter`, `fleet`, `lx`, `scribe`, `scribe3`,
  `split-speaker`, `yoga-drain`, `minibot`, `minibot-2`, `refuter-gate`,
  `eta-assistant`) plus one unnamed agent were present both times, with
  only ordinary organic lifecycle-state drift between the two reads
  (e.g. `eta-refuter` idle→done) — nothing this work did caused that;
  no `send`/`prompt`/keys/restart/compact/clear/model call was ever
  issued against any of them.
- No file outside `/Users/vinaybhardwaj/dev/eta-bus-mcp/`,
  `/Users/vinaybhardwaj/dev/_fable/bus/`,
  `/Users/vinaybhardwaj/dev/_fable/scratch/`, `/tmp/eta-bus-test-*`, and
  the Claude Code user config (`~/.claude.json`, for the `mcp add`) was
  touched.

## Known limitations (by design, documented in README.md)

- Identity resolution deliberately bypasses `herdr-ctl.sh status` (uses
  `herdr agent list` directly) to avoid shared-scratch-file races across
  ~13 concurrent processes on a 60s-cached, very-high-frequency path.
  Every mutating/control action still goes through `herdr-ctl.sh`
  unmodified.
- `herdr_status`/`bus_roster` *do* use `herdr-ctl.sh status`'s shared
  scratch file as specified; a true race between two simultaneous
  callers is possible in principle but not observed in testing.
- `test/unit.mjs` writes real lines to the shared audit log
  (`scratch/eta-bus.log`) since it doesn't override `AUDIT_LOG_PATH`;
  harmless (metadata only) but visible when reading that log.
- The `session` argument on herdr tools is a spec-adjacent addition
  needed to make the given test plan (targeting `ctl-test` from an
  orchestrator identity with no pane) possible — see README.md.
