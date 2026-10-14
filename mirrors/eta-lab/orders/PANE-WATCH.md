# Order — pane-watch: panes never wait on Fable (23 Sep 18:55, Fable → herdr-kit, Builder)

## Goal
The moment any pane goes working → done/idle/blocked, (1) its report is captured, (2) if Fable has pre-queued its next order, that order is sent immediately, (3) anything needing Fable is flagged in one file Fable reads. No pane sits idle waiting for a Fable check-in.

## Known facts
- herdr already tracks lifecycle (idle / working / blocked / done / unknown) via the Claude Code integration hook (~/.claude/hooks/herdr-agent-state.sh). `herdr agent list`, `agent wait --until`, `agent read`, `agent prompt --wait` exist (see `herdr --skill`). Box panes appear via `herdr --machine eta-lab-t4 ...` / the [eta-lab-t4] rows.
- The old Stop hook in ~/.claude/settings.json writes ~/dev/.cc-done.log with a tmux session name → now always "unknown" under herdr. Replace its name lookup with the herdr pane/agent name (or remove it if the watcher makes it redundant) — on the Mini AND in the box's ~eta/.claude/settings.json.
- kit/hsend.sh / hread.sh / herdr-registry.json are the current send/read path.

## Build
1. `kit/pane-watch.py` (python3, stdlib only), run as a launchd agent on the Mini (`com.vinaybhardwaj.eta-pane-watch`, KeepAlive, logs to eta-lab/bus/pane-watch.log). Poll `herdr agent list` (Mini + eta-lab-t4) every 10 s; keep last state per agent in bus/pane-state.json.
2. On transition into done/idle from working: `agent read` the last ~80 lines → bus/done/<agent>/<UTC-ts>.md; append a line to bus/for-fable.jsonl: {ts, agent, state, sha(s) found, verdict word found (PASS/FAIL/PASS-WITH-FIXES), "WAITING ON" present, first 200 chars of the final report}. Never include transcript text beyond what the pane printed.
3. Queue: orders/queue/<agent>/NNN-*.md. On done/idle, if the lowest-numbered file exists, send `Fable (queued): <first line> — full order: <path>` via `herdr agent prompt`, then move the file to orders/queue/<agent>/sent/. One order per transition. Never send to an agent that is working or blocked.
4. On transition into blocked: log to for-fable.jsonl with state=blocked; do NOT answer the dialog.
5. `kit/qpush.sh <agent> <order-file>` helper for Fable to enqueue (copies with the next NNN).
6. `kit/fable-inbox.sh` prints for-fable.jsonl lines since a cursor (bus/fable-inbox.cursor) and advances it — this is what Fable runs on every check-in.

## Not allowed
No sending to minibot. No answering blocked dialogs. No killing/restarting panes. No changes to production, Vercel, or the ETA repo. Watcher must survive herdr server restarts (retry, don't crash-loop).

## Verify
Dry-run mode first (`--dry-run` logs what it WOULD send). Then live test on one pane: enqueue a trivial "reply with the word ping" order for herdr-kit's own pane... not possible while working — use `air` pane or a scratch agent. Show: state transition logged, report captured, queued order delivered within 15 s of done, moved to sent/.

## Output (≤12 lines via the bus)
Files, launchd label, test evidence (timestamps), anything UNVERIFIED. Commit to eta-lab main (shared checkout rule: main only).
