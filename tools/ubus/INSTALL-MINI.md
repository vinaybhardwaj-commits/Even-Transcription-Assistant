# Install ubus on the Mac Mini

This is the MiniBot runbook. Do the steps in order. Do not commit `config/ubus.json` or anything under `~/.config/ubus/` except by copying the examples and replacing the `REPLACE_` placeholders on the Mini. Do not edit the Pulse repo (`code.evenhc.in`). Do not put keys, tokens, or connection strings in this repo or in ubus messages.

## Deploy the ETA, filter, and audit follow-ups

MiniBot copies files with the repo connector. The Mini has no git credentials, so do not `git pull`. No new config keys.

1. Copy these paths into `/Users/vinaybhardwaj/dev/ubus`, keeping the same relative paths: `src/adapters.ts`, `src/filter.ts`, `src/bus.ts`, `src/http.ts`, `bin/ubus-mcp.ts`, `test/filter.test.ts`, `test/followup.test.ts`, `test/hook.test.ts`, `INSTALL-MINI.md`.
2. `cd /Users/vinaybhardwaj/dev/ubus && npm test && npm run build`
3. Restart the server: `launchctl kickstart -k gui/$(id -u)/uk.llmvinayminihome.ubus`
4. Restart open `ubus-mcp` shims so they load `dist/bin/ubus-mcp.js` and register before the next heartbeat. The LaunchAgent restart does not recycle already-running stdio clients.

The tail now reads `recipients_json` (gating-lead's Mini fix). A `recipient` column is still used when it is non-empty.

## Deploy the 12 Oct fixes on a Mini that is already running

Access strips `CF-Access-Client-Id` / `CF-Access-Client-Secret` before origin. ubus now accepts `Cf-Access-Jwt-Assertion` and maps `common_name` to the client id in the token file. Stateless Grok calls must pass `handle` (or `from`, or `machine`+`runtime`+`session`) on every tool. No new process and no new plist.

1. `cd /Users/vinaybhardwaj/dev/ubus && git pull && npm ci && npm test && npm run build`
2. In `config/ubus.json`, inside `edge_auth`, add:
   - `team_domain`: the Cloudflare Access team host only, for example `<team>.cloudflareaccess.com`
   - `audience`: the AUD tag of the Access application for `bus.llmvinayminihome.uk`
3. In `~/.config/ubus/cf-service-tokens.json`, the `id` for class `grok-platform` (and `cursor-cloud` if used) must be the service-token client id. That is the JWT `common_name`. Leave the secret in the file for the loopback header check. Do not commit this file.
4. Restart the server: `launchctl kickstart -k gui/$(id -u)/uk.llmvinayminihome.ubus`
5. Secret paths keep working. After one successful JWT call you can leave the Grok and HF Spaces paths in place or remove them.
6. If a Grok bot still gets `not_registered`, it has to `ubus_register` once through that same door (so the directory stores the class) and pass `handle` on later calls. See `snippets/grok-connector.md`.

Assumptions that a human must confirm are marked **HUMAN**. Everything else is a command.

## 0. What you need first

### Placeholders used in this file
- `<mini-tailnet-host>`: the Mini's full tailnet hostname (host name plus your tailnet domain). Set the short name as `UBUS_MINI_HOST` in the environment of any process that maps hostnames to the `mini` machine; unset turns that mapping off. Extra hostname mappings (for example the Air) go in `UBUS_HOST_MAP` as a JSON object such as `{"<air-host>":"air"}`; unset means none.
- `<secret>`: the path secret from the token files (see section 3). It is never written in this repo.

**HUMAN**

- Node.js 22 or newer on the Mini (`node -v`). Apple Silicon Homebrew node is `/opt/homebrew/bin/node`.
- The repo at `/Users/vinaybhardwaj/dev/ubus`.
- Port **8790** free. It is not in the Mini Ops probe list yet. Add it to `/stack` after the server is up.
- The Time Machine volume mounted, and `diskutil info -plist "/Volumes/Time Machine"` showing `VolumeUUID` = `06934966-C7D8-4B5B-9326-9C91C0FDADCD`.
- Fable has registered the internal ETA bus name `ubus-bridge`. Until that exists, non-Grok bridge posts will be rejected by eta-bus. Grok traffic keeps using `ext-evenscribe-kiosk-bot`.
- The live ETA table is `posts` at `~/dev/_fable/bus/bus.db`. It has no `recipient` column. Recipients are a JSON array in `recipients_json`. The tail prefers `ubus-bridge` or `ext-evenscribe-kiosk-bot` from that array. Do not checkpoint or copy the WAL.
- Cloudflare Access service tokens for classes `grok-platform` and `cursor-cloud`, created in the dashboard. They never go in git.

## 1. Build

```sh
cd /Users/vinaybhardwaj/dev/ubus
npm ci
npm test
npm run build
```

`npm test` must be green before you load the LaunchAgent.

## 2. Server config

```sh
cp config/ubus.example.json config/ubus.json
chmod 600 config/ubus.json
```

`config/ubus.json` is gitignored. Edit it on the Mini if a path differs. Leave `host` as `127.0.0.1` and `port` as `8790`. `trust_forwarded_for` stays true because `tailscale serve` and cloudflared both connect from loopback and pass the client in `X-Forwarded-For`.

`cold_root` must stay inside `volume_mount`. The example already sets:

- `volume_mount`: `/Volumes/Time Machine`
- `cold_root`: `/Volumes/Time Machine/cold/ubus-log`
- `expected_volume_uuid`: `06934966-C7D8-4B5B-9326-9C91C0FDADCD`

The outbound ETA command is `scripts/eta-post.template.sh`, which **exits 1** until you wire it. The server still boots. Bridge posts fail until step 6. The herdr template returns an empty fleet until you wire it. That is safe: registered agents still work; discovered panes appear after step 7.

## 3. Token files (no secrets in git)

```sh
mkdir -p /Users/vinaybhardwaj/.config/ubus
cp config/cf-service-tokens.example.json /Users/vinaybhardwaj/.config/ubus/cf-service-tokens.json
cp config/secret-paths.example.json /Users/vinaybhardwaj/.config/ubus/secret-paths.json
cp config/client.example.json /Users/vinaybhardwaj/.config/ubus/config.json
chmod 600 /Users/vinaybhardwaj/.config/ubus/*.json
```

**HUMAN:** replace every `REPLACE_` value in the two secret files with the Access token and, if you need D12, a long random path secret. Values that still start with `REPLACE_` are ignored by the server, so a half-edited file cannot authenticate.

Client `config.json` on the Mini keeps `"url": "http://127.0.0.1:8790/mcp"`. Other machines set `url` to `https://<mini-tailnet-host>/ubus/mcp`. `UBUS_DOOR=cloudflare` selects `cf_url`. `cf_token_file` is only needed on machines that call the public hostname.

## 4. Cold log folder

**HUMAN:** confirm the UUID before creating the directory.

```sh
diskutil info -plist "/Volumes/Time Machine" | grep -A1 VolumeUUID
sudo mkdir -p "/Volumes/Time Machine/cold/ubus-log"
sudo chown vinaybhardwaj:staff "/Volumes/Time Machine/cold/ubus-log"
cp install/cold-ubus-log-README.md "/Volumes/Time Machine/cold/ubus-log/README.md"
```

If the volume is not mounted, skip the copy. ubus will spool on internal disk and alert `grok:minibot`. Do not point `cold_root` at any other disk.

## 5. Smoke test before launchd

```sh
/bin/zsh install/ubus-launch.zsh serve
```

In another terminal:

```sh
curl -sS http://127.0.0.1:8790/health
```

Expect `"ok": true` and `"service": "ubus"`. `archive` may be `degraded` until the volume check passes; that is the unmount path, not a crash. Stop the foreground process with Ctrl-C.

Create the kill switch later with `touch /Users/vinaybhardwaj/dev/ubus/STOP`. While that file exists, every tool except `ubus_whoami` and `ubus_inbox` returns `paused`. Remove the file to resume.

## 6. Wire the ETA poster

**HUMAN:** Fable registers `ubus-bridge` on the ETA bus before this step.

Copy `scripts/eta-post.template.sh` to a script you will edit, or edit a private copy and point `eta.post_command` at it. The contract:

- stdin: one JSON object `{as, to, subject, body, thread_id, reply_to, wake}`
- stdout: one JSON object `{id, thread_id}`
- environment: `ETA_BUS_AS` is set to `ext-evenscribe-kiosk-bot` or `ubus-bridge`. `HERDR_*` is unset.
- `wake` is always false. Do not add a key to the script.

Use the existing eta-bus poster (`~/dev/eta-bus-mcp/run.sh` or the guest post path it already uses). ubus does not write `bus.db` itself. The inbound tail opens `tail_db_path` read-only and must not checkpoint or replace WAL/SHM files.

If the live table is not named `posts`, set `eta.table` to the real name. The tail selects `id > ?`.

Liason (Kiosk Bot, not this repo) should skip ETA posts whose subject starts with `[to:]`. Those are for ubus to deliver.

## 7. Wire herdr presence and the nudge

`scripts/herdr-ubus.template.sh status` prints `[]`. Replace it so `status` prints a JSON array of panes:

```json
[{"name":"eta-refuter","machine":"mini","runtime":"claude-code","state":"idle","busy":false,"owner":"consult-lead","herdrSession":"default"}]
```

`nudge` is called as `nudge <machine> <name> <text>`. The text is always `[ubus] You have unread messages. Call ubus_inbox.` Send that string only, and only when the pane is idle or done and not busy. ubus already rate-limits nudges to one per 120 seconds and skips them for Grok-origin mail.

The fleet map's herdr machine ids are prefixes. Pass the label ubus has; if remote herdr needs the full hex id, map it inside this script. Do not invent ids in the repo.

Point `herdr.command` at your script. Suggested backing command is `herdr-ctl.sh`, checked by herdr-lead in `--session ctl-test` before it touches a live pane.

## 8. LaunchAgents

```sh
cp install/local.env.example install/local.env   # then set UBUS_MINI_HOST (gitignored)
install/install-plists.sh   # substitutes __UBUS_MINI_HOST__; refuses if unset
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/uk.llmvinayminihome.ubus.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/uk.llmvinayminihome.ubus-archive.plist
curl -sS http://127.0.0.1:8790/health
```

The server agent is KeepAlive. The archive agent runs `ubus flush` at load and every hour. Logs:

- `~/Library/Logs/ubus.log`
- `~/Library/Logs/ubus-archive.log`

Reload after a config edit:

```sh
launchctl kickstart -k gui/$(id -u)/uk.llmvinayminihome.ubus
```

## 8b. v3 hub (UBUS_V3=1)

The v3 hub is a separate service (`dist/bin/ubus-hub.js`, config `~/.ubus/hub.json`: `dbPath`, `listen` as `127.0.0.1:7377`, `keyDir`, `laneOwnersPath`, `allowlistPath`). It refuses a wildcard listen address and refuses to start unless `UBUS_V3=1`. The board is a separate process (`dist/bin/ubus-board.js`, read-only, 127.0.0.1:7378); it was not mounted in the hub because it takes its own listener and reads the hub over HTTP.

1. Provision a key per node (writes `<keyDir>/<node>.key` at 0600 plus a 0600 copy to move to that node; prints only paths):
   ```sh
   scripts/hub-provision-node.sh asus /tmp/asus.key.out   # repeat per node: mini air t4 c3 c4 asus yoga
   ```
2. Render the plists (needs `install/local.env`, see section 8): `install/install-plists.sh` also installs `uk.llmvinayminihome.ubus-hub.plist`.
3. Build and bootstrap:
   ```sh
   npm ci && npm run build
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/uk.llmvinayminihome.ubus-hub.plist
   ```
4. Smoke check: `curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7377/api/v3/health` should print 200.
5. Nodelink on asus: copy the provisioned key to asus (mode 0600), then start `ubus-node` there as described in `nodelink/`.
6. Set `UBUS_MINI_HOST` (short Mini host name) and, where needed, `UBUS_HOST_MAP` (JSON such as `{"<air-host>":"air"}`) in the environment of Mini panes, the Claude Code hooks, and the Air, so hostnames map to `mini` and `air`.

## 9. Tailscale serve

Flags are the ones in the design. **HUMAN:** confirm them against `tailscale serve --help` on this Mini before relying on the public URL.

```sh
tailscale serve --bg --set-path /ubus http://127.0.0.1:8790
tailscale serve status
curl -sS https://<mini-tailnet-host>/ubus/health
```

`tailscale serve` strips the `/ubus` prefix, so the backend also accepts `/mcp`, `/health`, and `/v1/hook`. ubus additionally accepts `/ubus/mcp`, `/ubus/health`, and `/ubus/v1/hook` when the prefix is left on. `ubus-hook` keeps that prefix: a client url of `https://<mini-tailnet-host>/ubus/mcp` posts to `/ubus/v1/hook`, not `/v1/hook` on the host root. A url of `/mcp/<secret>` posts to `/v1/hook/<secret>` (and `/ubus/mcp/<secret>` to `/ubus/v1/hook/<secret>`), using the same path secret. Tailnet ACL is the gate on this door (D1, D7). There is no bearer token. Tag the Grok box `tag:grokbox` and allow the Mini, the Yoga, and the e2e lab box in the tailnet policy. That policy is not in this repo.

## 10. Cloudflare tunnel and Access

Add the ingress block from `install/cloudflared-ingress.yml.template` to `/etc/cloudflared/config.yml`, above the catch-all. Hostname: `bus.llmvinayminihome.uk` → `http://127.0.0.1:8790`. Do not copy tunnel credentials into the repo.

**HUMAN:** create the Access application for `bus.llmvinayminihome.uk` with Service Auth, and the two service tokens whose ids and secrets you wrote in step 3. Restart cloudflared the way the Mini already restarts it.

A request that carries `CF-Ray` or `CF-Connecting-IP` must present the service-token headers or the secret path. Loopback clients without those headers (the hook, the shim, tailscale serve) stay allowed.

D12 path fallback, if Grok or Cursor Cloud cannot send headers:

- URL `https://bus.llmvinayminihome.uk/mcp/<secret>`
- the same secret in `secret-paths.json` with class `grok-platform` or `cursor-cloud`
- an Access policy that lets that path through without a service token

That path is weaker than the header. Prefer the header when the client can send it.

Check from a machine that holds the token file:

```sh
curl -sS -D- https://bus.llmvinayminihome.uk/health \
  -H "CF-Access-Client-Id: ..." \
  -H "CF-Access-Client-Secret: ..."
```

Do not paste the secrets into a shell history you commit.

## 11. Shim, hooks, and instructions on the Mini

```sh
mkdir -p /Users/vinaybhardwaj/.local/ubus-mcp/bin
ln -sf /Users/vinaybhardwaj/dev/ubus/install/bin/ubus-mcp /Users/vinaybhardwaj/.local/ubus-mcp/bin/ubus-mcp
ln -sf /Users/vinaybhardwaj/dev/ubus/install/bin/ubus-hook /Users/vinaybhardwaj/.local/ubus-mcp/bin/ubus-hook
ln -sf /Users/vinaybhardwaj/dev/ubus/install/bin/ubus /Users/vinaybhardwaj/.local/ubus-mcp/bin/ubus
chmod 755 /Users/vinaybhardwaj/dev/ubus/install/bin/ubus-mcp \
          /Users/vinaybhardwaj/dev/ubus/install/bin/ubus-hook \
          /Users/vinaybhardwaj/dev/ubus/install/bin/ubus \
          /Users/vinaybhardwaj/dev/ubus/install/ubus-launch.zsh
```

If a copy step clears the executable bit, the hook command can be `/bin/zsh /Users/vinaybhardwaj/.local/ubus-mcp/bin/ubus-hook` instead. The snippets use the direct path from the design.

Claude Code, both config dirs:

```sh
/Users/vinaybhardwaj/.local/bin/claude mcp add --scope user ubus -- /Users/vinaybhardwaj/.local/ubus-mcp/bin/ubus-mcp
CLAUDE_CONFIG_DIR=/Users/vinaybhardwaj/.claude-personal /Users/vinaybhardwaj/.local/bin/claude mcp add --scope user ubus -- /Users/vinaybhardwaj/.local/ubus-mcp/bin/ubus-mcp
```

Merge `snippets/claude-settings-hooks.json` into both `~/.claude/settings.json` and `~/.claude-personal/settings.json`. Append `snippets/CLAUDE.md` to both `~/.claude/CLAUDE.md` and `~/.claude-personal/CLAUDE.md`.

OpenCode: merge `snippets/opencode.json` into `~/.config/opencode/opencode.json`, and append `snippets/AGENTS.md` to the global AGENTS.md.

Cursor on the Mini: merge `snippets/cursor-mcp.json` into `~/.cursor/mcp.json`.

Running Claude Code processes do not reload MCP config. Restarting a live herdr pane resumes the session and, under D4, needs the pane owner or Fable's approval. Hooks are picked up by the settings watcher; the `ubus_*` tools appear only after restart. Plan restarts when the pane is idle and not busy.

## 12. Other machines (not this MiniBot pass, listed so nothing is forgotten)

| Who | What |
|---|---|
| Air Bot | shim, hooks, CLAUDE.md, Claude Desktop config `snippets/claude-desktop-mcp.json` for Cowork |
| Yoga Encounter STT | shim, hooks, OpenCode AGENTS.md |
| herdr-lead / fable | the same files on t4, c3, ASUS; orbox-lead for orbox3 |
| Fable / gating-lead | append `snippets/ETA-UBUS.md` to the ETA project file and lead worktree CLAUDE.md. Do not touch Pulse |
| V | Grok connector from `snippets/grok-connector.md`, and each bot's "check ubus_inbox at turn start" line |
| Kiosk Bot | Liason skips `[to:…]` posts; ubus delivers them |

Cursor Cloud: `snippets/cursor-cloud-mcp.json`, secrets from Cursor's store, or the D12 path.

## 13. Done when

1. `curl -sS http://127.0.0.1:8790/health` returns `"ok": true` from launchd, and it is still up after a reboot.
2. `https://<mini-tailnet-host>/ubus/health` answers on the tailnet.
3. `https://bus.llmvinayminihome.uk/health` answers with the service token and rejects a bare request.
4. A new Claude Code session on the Mini prints `ubus: registered as …` from the SessionStart hook.
5. `ubus flush` writes a segment under `cold/ubus-log/YYYY/MM/DD/` only while the UUID matches. Unmounting the volume leaves the spool in place and alerts minibot.
6. A Grok send to a herdr pane shows up for that pane's lead and does not nudge the pane.
