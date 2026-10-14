# ORDER — move Claude Code panes onto the E2E box (Fable, 23 Sep 15:25) — owner: herdr-kit, after the CI flip
Why: the Mini is at ~1.4 GB free swap with 12 Claude panes on it; the box has 45 GB RAM and is now signed in to Claude (V's Max account, /home/eta/.claude/.credentials.json exists — never print or copy it).
Closed panes stay closed: scribe3, minibot-2, refuter-gate, eta-assistant were relaunched ~15:05 by a restore run and are closed again; herdr-restore.sh lines are commented CLOSED. Find what relaunched them and make sure it cannot happen again.

Stage 1 (lab panes, now): diar-lab, indic-mt, yoga-drain.
1. On the box: install herdr (same version as the Mini, 0.9.1) and run it as a persistent server under user eta; or, if herdr supports it cleanly, attach the box as a herdr remote machine so V sees the panes in the Mini's herdr sidebar. V MUST be able to see the moved panes from the Mini's herdr — that is the requirement; pick the mechanism that meets it.
2. Give the box's Claude Code the same user settings the Mini panes rely on (permissions/additionalDirectories adapted to Linux paths, eta-bus MCP if it can run there or reach the Mini's bus; say which).
3. Move each pane with its conversation: copy its session transcript jsonl to the box's ~/.claude/projects/<cwd-slug>/ and `claude --resume <id> -n <name> --model <same> --permission-mode <same>` in a cwd that exists on the box (clone repos under /home/eta/dev). Verify each pane answers a one-line ping, THEN stop the Mini copy. One pane at a time.
4. Update herdr-registry.json / herdr-restore.sh / hsend+hread so Fable can still dispatch to and read moved panes by name (a `--machine` flag or ssh wrapper is fine).

Stage 2 (builders, after Stage 1 works): fleet, split-speaker, lx, scribe, eta-refuter, lab-mover. These need gh auth, the Vercel CLI login and each worktree's .env.local on the box — list exactly what each needs and STOP for Fable's ruling before moving them.
Stays on the Mini: minibot (MiniBot owns the shim).

Do NOT: move a pane mid-task (wait until it is idle/done), copy any secret by printing it, touch production, run lab compute on the Mini.
Report: ≤12 lines appended to bus/E2E-LAB-BOX-REPORT.md, then stop.

## Stage 2 — RULED by Fable 23 Sep 17:35 (V: "how do we save memory on the mini?")
Mini at 0.85 GB free swap. Move the builders NOW, one at a time, each only when idle/done: lab-mover, scribe, split-speaker, lx, fleet, eta-refuter (last; it reviews). minibot stays.
Allowed for the move: gh auth on the box (device-flow login under V's account is fine, or a deploy key per repo), `vercel login` token copied by FILE (never argv/print) from the Mini's ~/Library/Application Support/com.vercel.cli or equivalent, each worktree's .env.local copied by scp (0600). Clone worktrees under /home/eta/dev. Ship/deploy panes (scribe) must verify a dry-run `vercel ls` works on the box before their Mini copy stops.
Also trim per-pane MCP servers: every Claude pane on the Mini spawns pdf, desktop-commander and the docker-mcp gateway (~100 MB per pane) that no pane uses — remove those three from the panes' config (keep eta-bus and even-jev), taking effect as each pane restarts/moves. Do NOT touch V's Claude desktop app config.
Report per pane moved + Mini swap free after each.
