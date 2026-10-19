# ubus

ubus is a universal two-way bus for the agents Vinay runs. It is an MCP server: Streamable HTTP on the Mac Mini, plus a stdio shim (`ubus-mcp`) for Claude Code, OpenCode, and Cursor. Callers are Claude Code sessions, OpenCode, Cursor, OpenBot, and the Grok Bots. The Mini also runs the SQLite ETA bus and the tmux agent manager herdr. This repo talks to both through adapters so it can be tested without them.

Decisions D1–D12 (Vinay, 11 Oct 2026) override anything earlier in the design that conflicts. How each one is honoured is below.

## Stack

Node.js 22 and TypeScript. The server uses `node:http`, `node:sqlite`, and `node:test`. There is no MCP SDK and no runtime dependency beyond Node. `npm test` builds with `tsc` and runs the acceptance suite.

## Run locally

```sh
npm ci
npm test
npm start
```

`npm start` listens on `127.0.0.1:8790`. With no config file the data directory is `./data` under the working directory. That default does **not** write to `/Volumes/Time Machine`. Health check: `GET /health`. MCP endpoint: `POST /mcp`.

```sh
node --disable-warning=ExperimentalWarning dist/bin/ubus.js serve --root /tmp/ubus-dev
```

The Mini install is [INSTALL-MINI.md](INSTALL-MINI.md). Copy `config/ubus.example.json` to `config/ubus.json` on the Mini only. Do not commit that copy, and do not commit token files.

## Architecture

```
Claude hook / ubus-mcp (stdio) ──HTTP──▶ ubus :8790
Grok / Cursor Cloud ── Cloudflare Access or /mcp/<secret> ──▶ same server
tailnet clients ── tailscale serve /ubus ──▶ same server (prefix stripped)

ubus core
  registry (labels + machine) · threads · grants · single-use approvals
  PHI/secret filter · rate limits · audit · STOP file
  hash-chained JSONL spool ──hourly, UUID-checked──▶ cold/ubus-log/

adapters (faked in tests, command/HTTP on the Mini)
  ETA bus (SQLite fake, or post command + read-only tail)
  herdr (presence + fixed nudge)
  OpenBot · Mini Ops handoff · tailscale whois
```

A message is accepted only after it is committed to `ubus.db`. The durable log stores ids, counts, paths, and hashes. Message text stays in the database so the recipient can read it. It is not copied into the JSONL log.

Address form: `agent://<machine>/<runtime>/<session>`. Also handles (`eta-refuter`, `grok:designer`) and groups (`group:eta-leads`). Presence is `live` (heartbeat under 3 minutes), `stale` (under 24 hours), `turn-based` (Grok, until 24 hours), `poll` (Cowork), `gone` after that, or `live (discovered)` for a herdr pane that has not registered. `ehrc-*`, `vinay-orb2`, and `orb2` are denied in code.

### Tools

`ubus_register`, `ubus_heartbeat`, `ubus_unregister`, `ubus_whoami`, `ubus_directory`, `ubus_resolve`, `ubus_groups`, `ubus_send`, `ubus_reply`, `ubus_inbox`, `ubus_wait`, `ubus_thread`, `ubus_ack`, `ubus_request`, `ubus_await`, `ubus_requests`, `ubus_escalate`, `ubus_broadcast`, `ubus_handoff`, `ubus_grant`, `ubus_approval_request`, `ubus_approve`.

Agent verbs exist so the approval path can be tested: `ubus_agent_send`, `ubus_ask`, `ubus_agent_tag`, `ubus_agent_compact`, `ubus_agent_set_model`, `ubus_agent_interrupt`, `ubus_agent_spawn`, `ubus_agent_restart`, `ubus_agent_kill`, `ubus_agent_clear`, `ubus_agent_sessions`, `ubus_agent_status`, `ubus_agent_read`. Spawn, kill, and pane input are stubbed after the permission check. See below.

Hook endpoint (counts, ids, and handles only): `POST /v1/hook` or `POST /ubus/v1/hook`, with `op` of `session-start`, `unread`, or `wait`. `ubus-hook` builds that from the MCP url: `/ubus/mcp` becomes `/ubus/v1/hook`, and `/mcp/<secret>` becomes `/v1/hook/<secret>` (also under `/ubus`). The secret is the same path secret as the MCP door.

## Decisions D1–D12

1. **Labels only.** There is no per-bot token. Origin is `[ubus:<label>]` (`grok:designer` becomes `designer`). The calling machine is recorded from tailscale whois when the peer IP is forwarded, or from the label the client sends on loopback. A label/machine mismatch is flagged, not blocked. Clients that drop `Mcp-Session-Id` (the Grok connector) repeat `handle`, `from`, or `machine`+`runtime`+`session` on every tool call. ubus resolves that against the directory. For classes `grok-platform`, `cursor-cloud`, and `fleet-cloud`, the handle must have been registered under that same class. Other doors stay on the honor system.
2. **Host is the Mac Mini.** [INSTALL-MINI.md](INSTALL-MINI.md) is the MiniBot runbook: LaunchAgents `uk.llmvinayminihome.ubus` and `uk.llmvinayminihome.ubus-archive`, `tailscale serve`, cloudflared, and the cold log folder.
3. **Grok does not poll.** `ubus_wait` from a `grok:` handle returns `grok_no_poll`. Grok reads `ubus_inbox` at turn start.
4. **Permission tiers.** Read and ask are open. Steering (`send`, `tag`, `compact`, `set_model`) needs an owner `ubus_grant` of at most 8 hours. `interrupt`, `spawn`, `restart`, `kill`, and `clear` need a single-use approval bound to the sha256 of the arguments, valid 30 minutes. A mismatched call does not consume it. A second call returns `approval_used`. Fable approves engineering-only actions. `v` and `vinay` are the elevated approvers. Grok cannot approve.
5. **Grok pane input goes to the lead.** `ubus_agent_send` and `ubus_send` from `grok:*` to a herdr pane are stored for the pane's owner with `delivery: lead_routed` and `for_pane` set. The pane is not nudged. A grant does not override this. The herdr nudge text, when a non-Grok message hits an idle pane, is only `[ubus] You have unread messages. Call ubus_inbox.`
6. **Cold log, one copy, forever.** Hot spool on the internal disk. Hourly flush to `/Volumes/Time Machine/cold/ubus-log/YYYY/MM/DD/` only after the volume UUID is `06934966-C7D8-4B5B-9326-9C91C0FDADCD`, the volume is writable, and `cold_root` is inside the mount. Otherwise the segment stays queued, the flusher backs off from 10 minutes to 1 hour, and `grok:minibot` plus handoff project `ubus-archive` are alerted once and again every 6 hours. Paths are config keys so tests use a temp directory. The default config never points at the Time Machine volume.
7. **Tailnet tag `tag:grokbox`.** The ACL (Mini, Yoga, e2e lab box) is a tailnet concern, not something this process enforces. ubus records the machine whois returns. Documented in the install guide.
8. **Claude Liason stays the ETA relay.** Guest identity `ext-evenscribe-kiosk-bot` is unchanged. The shared guest key is not in this repo.
9. **Every idle Claude Code session re-wakes.** The Stop hook starts `ubus-hook watch --max-s 3600` with `async` and `asyncRewake`. On new mail it exits 2 with ids only.
10. **Stop blocks while unread, at most once per 10 minutes.** State is `~/.cache/ubus/hook-<session>.json`. The hook fails open.
11. **Two ETA identities.** Grok-origin posts use `ext-evenscribe-kiosk-bot` and the guest allow-list (the `group:eta-leads` members). The SQLite fake prefixes those posts with `[EXT] `, which is what eta-bus does for guests. Non-Grok posts use internal identity `ubus-bridge` (Fable registers that name on the real bus). They are not prefixed `[EXT]`, and they may address a herdr pane. Liason budget defaults to 20 posts an hour; over budget, ubus queues and sends one digest per lead per hour (`[ubus] N messages for you`, ids only). `wake` is always false. Inbound, ubus tails posts tagged `[to:<handle>]` addressed to either identity and delivers them on the same ubus thread. The tail is read-only and does not write ETA receipts.
12. **Edge auth.** Cloudflare requests (they carry `CF-Ray` or `CF-Connecting-Ip`, including cloudflared on loopback) need `CF-Access-Client-Id` / `CF-Access-Client-Secret`, a verified `Cf-Access-Jwt-Assertion`, or the secret path `/mcp/<secret>` (also `/ubus/mcp/<secret>`). Access strips the client id and secret before origin, so the public door is the JWT: RS256 against `https://<team_domain>/cdn-cgi/access/certs`, audience from `edge_auth.audience`, and `common_name` matched to a client id in the token file. Loopback without those CF headers is the hook, the shim, and `tailscale serve`. Direct tailnet peers are allowed when whois knows the IP and `trust_forwarded_for` is set. Auth is off unless `edge_auth.enabled` is true, which the Mini example turns on. `REPLACE_` team domain and audience values are ignored.

## Implemented and stubbed

Implemented: the MCP tool surface above, the stdio shim (auto-register on initialize, heartbeat, unregister on stdin EOF), the Claude hook, the filter, rate limits, the STOP file, the hash-chained archive, the ETA adapter (SQLite fake and command + read-only tail), herdr presence and the fixed nudge, approval and grant plumbing, edge auth, and the install snippets.

Stubbed on purpose for the MVP:

- herdr `spawn` / `restart` / `kill` / `clear` / `interrupt` return `{ok, stub:true, executed:false}` after a valid single-use approval. They do not touch tmux.
- `ubus_agent_send` from a non-Grok caller with a grant returns `herdr-send-not-in-mvp` and does not pass the text to herdr.
- `ubus_agent_read` returns `text_omitted` and zero bytes. Grok may call it; the text is not logged.
- OpenBot and Mini Ops handoff are HTTP adapters behind config. The default is an in-memory fake. There is no OpenBot config change in the MVP.
- Cold segments are not compressed, and the daily manifest is unsigned.
- There is no `ubus_search`, no Mini Ops `/approve` page, no Cursor Cloud follow-up relay, and no node/files/cloud tools.
- The real `bus.db` column names are assumed (`posts`: id, sender, recipient, subject, body, thread_id, reply_to, wake, identity). Outbound never writes that file. The tail opens it read-only.

## Tests

```sh
npm test
```

CI is `.github/workflows/test.yml` (Node 22, `npm ci`, `npm test`). The suite covers the design's acceptance cases: kiosk and ORB2 deny, secret and PHI bodies and secret paths absent from the log, approval bound to the request and single-use, grant expiry, Grok pane input routed to the lead with no nudge and no body in the log, ETA round trip on one thread through the fake (Liason vs `ubus-bridge`, `[to:]` inbound, receipts unchanged), bridge digest, no cold write on UUID mismatch, unmount alert and backoff, idle re-wake, and the Stop hook's 10 minute cap.

## Layout

| Path | Role |
|---|---|
| `src/` | Bus, store, filter, archive, HTTP, adapters |
| `bin/ubus.ts` | `serve`, `flush`, `verify` |
| `bin/ubus-mcp.ts` | stdio shim |
| `bin/ubus-hook.ts` | Claude Code hook |
| `registry/groups.json` | group membership |
| `snippets/` | CLAUDE.md, AGENTS.md, ETA addendum, MCP configs |
| `install/` | LaunchAgents, launch script, cloudflared template, cold-log README |
| `config/*.example.json` | Mini config and token placeholders. No live secrets |
