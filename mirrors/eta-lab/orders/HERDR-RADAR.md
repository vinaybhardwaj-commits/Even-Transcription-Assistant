# HERDR-RADAR: agent-row decorations on every herdr machine (ruling 145)

V asked for this on 24 Sep. Install herdr-radar (github hhdebb/herdr-radar, v1.3.12 @ aff4838; reviewed by Fable at 16:55: no network, local unix sockets only, read-only herdr queries plus pane/workspace `report-metadata`). V's condition: rows must also be decorated for panes on the cloud machines, and nothing that works in herdr today may be lost. Code changes are allowed.

Builder: **radar-kit** (Sonnet, Mini pane). Refuter: **eta-refuter** (Opus). Fable owns every verdict.

## Hard constraints (breaking any one = stop and report)
- NEVER `herdr server stop`, never kill or restart a herdr server or client, never re-add or remove a machine.
- Never rename or close any agent, pane, workspace or tab.
- The JSON that `herdr agent list` and `pane list` return must keep every field the kit depends on (name, agent_status, pane_id). kit/hsend.sh, kit/pane-watch.py and kit/herdr-ctl.sh must keep working; prove it with a no-op hsend.
- **Mini (production host):** nothing is installed or run there before 21:15 IST. Fable does the Mini step with you at 21:15. Until then, work only on the remote machines.
- **Scope:** only machines that host Claude Code agent panes (today: eta-lab-t4; check the others with `herdr --machine X agent list`). Do NOT install on orbox3 or ehrc-audiometry, which are clinical machines. Monitor-only machines don't need it.
- Before touching any host, back up its `~/.config/herdr/config.toml`.
- No sudo on the Mini. On remotes, Node 18+ goes into ~/.local (tarball); leave the system node alone.

## Step 1: investigate (report to Fable before any install; max 12 lines)
Read https://herdr.dev/llms.txt, the plugin source (clone to /tmp), and `herdr plugin --help` and its subcommands. Settle, with evidence:
1. Is `pane report-metadata` set on a REMOTE machine's server rendered by the Mini client's sidebar? Prove it on voice-lab-1: it is idle and safe, and only its monitor pane exists. Set a harmless token there, read it back via `herdr --machine voice-lab-1 pane get`, and also check the local aggregated view.
2. Are the sidebar/tab-bar/theme blocks read client-side (the Mini's config.toml) or per server?
3. Does `herdr plugin install` or `plugin link` work on a remote server, and do its [[startup]] and [[events]] hooks run there?
4. Where do V's herdr clients run? Check with `herdr status` and herdr-client.sock on each host.

## Step 2: design (Fable picks)
- **Option A (expected):** run the radar daemon on each agent-hosting remote server against its own local socket, and put the config blocks where the client reads them. No cross-machine polling.
- **Option B:** one daemon on the Mini iterating `herdr --machine X`. Rejected up front unless Step 1 proves A impossible, because 150 ms polling over ssh × N machines is too costly.
- **Fork either way.** Vendor the code into eta-lab `kit/herdr-radar/`, forked at aff4838 with a CHANGES.md, and install with `herdr plugin link <path>` so we run code we've reviewed rather than live GitHub.
- **Required change:** make POLL_MS, FRAME_FLOOR_MS and the spinner configurable. Default is 1000 ms on the Mini; remotes may keep 150 ms.

## Step 3: roll out, in this order
1. voice-lab-1 (test only).
2. eta-lab-t4 (the box, 20+ live panes): after eta-refuter passes the diff and the voice-lab-1 test.
3. The Mini at 21:15 with Fable.

After each host, check:
- agent list is identical, with the same names and count;
- hsend no-op delivered, and pane-watch still logging;
- `herdr config check` is clean;
- daemon CPU averaged over 5 min.

**Rollback per host:** unconfigure, uninstall-font, `plugin unlink/uninstall`, restore the config backup.

## Report
To the bus via conductor, with the tag RADAR. Findings from Step 1 go straight to Fable.
