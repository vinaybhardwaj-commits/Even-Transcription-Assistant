# nodelink

Per-node companion for ubus v3: discovers local agents (claude / opencode / codex processes, herdr panes, `lanes.tsv`), classifies their state on the node, spools events in SQLite and ships them to the hub over HTTPS. Pane text, env values and keys never leave the node.

Config `~/.ubus/nodelink.json`, key `~/.ubus/node.key` (mode 0600, refused otherwise). Service templates in `install/`; `install/install-nodelink.sh` renders them with absolute node/herdr paths and prints (never runs) the enable/bootstrap command.

## Service install notes
- **Linux (headless nodes): run `loginctl enable-linger $USER`.** Without linger the systemd user service does not start at boot and is stopped at logout. The install script checks and warns.
- **macOS:** launchd's PATH is only `/usr/bin:/bin:/usr/sbin:/sbin`, so the plist sets PATH (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, ...) and the script writes the absolute node path (Apple Silicon: `/opt/homebrew/bin/node`). Load with `launchctl bootstrap gui/$(id -u) <plist>`. The log is `~/.ubus/nodelink.log` (rotate it).
- **herdr missing:** if the `herdr` executable cannot be found (config `herdrBin`, default `herdr`), nodelink logs an error every scan interval and `ubus-node status` shows `herdr_missing` and one `herdr_missing` or `herdr_recovered` alert goes to the hub on each transition; it never silently reports zero panes.

## Clock / NTP requirement
Every request carries `X-Ubus-Ts` taken unmodified from the local clock. The hub rejects skew over 300 s and caps forward skew at 5 s, so each node MUST run NTP (chrony/systemd-timesyncd on Linux, the stock time service on macOS). A node whose clock runs ahead by more than 5 s will be refused; fix the clock, do not work around it in nodelink.

## Hub rejections
If the hub lists an event in `rejected[]`, nodelink marks it dead (rule id kept in the spool `dead` table), emits one `alert` with reason `hub_rejected`, and never resends it, so one bad event cannot block the queue.
