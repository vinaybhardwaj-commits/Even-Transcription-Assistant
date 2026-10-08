# fable's MCP config for eta-bus (NOT APPLIED — reference only)

The orchestrator (`fable`) runs on the MacBook Air's Claude desktop app,
not on the Mac Mini, so it reaches eta-bus the same way the Air already
reaches `MCP_DOCKER`: stdio over an SSH-invoked command. This uses the
Mini's already-installed `eta-bus` (user-scope) launcher and sets
`ETA_BUS_AS=fable` so identity resolution short-circuits to `fable`
without needing a `HERDR_PANE_ID` (fable's ssh session isn't a herdr
pane).

Add this entry to the Air's Claude desktop `claude_desktop_config.json`
(or wherever its MCP server list lives) under `mcpServers`:

```json
{
  "mcpServers": {
    "eta-bus": {
      "command": "ssh",
      "args": [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=15",
        "<user>@<MINI_TAILSCALE_IP>",
        "env", "ETA_BUS_AS=fable",
        "/bin/sh", "/Users/vinaybhardwaj/dev/eta-bus-mcp/run.sh"
      ]
    }
  }
}
```

Notes:

- `<MINI_TAILSCALE_IP>` is the Mini's Tailscale IP (same host `run_on` calls
  `mini`).
- `BatchMode=yes` fails fast instead of prompting for a password/passphrase
  if key auth isn't set up yet — fable's local SSH key must be authorized
  on the Mini (`~/.ssh/authorized_keys` for `<user>`) before this
  works.
- To target a specific named herdr session (e.g. for testing) instead of
  the live default session, pass `session` as an argument on each herdr
  tool call — no config change needed; see `README.md`'s "Session
  scoping" section.
- This file is documentation only. It was **not** applied to the Air or
  anywhere else, per instructions.
