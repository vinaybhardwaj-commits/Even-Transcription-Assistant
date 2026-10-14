# Pane rules

Short, standing rules every pane (agent) in this fleet should know. Not a
kickoff, not a one-off order — read once, keep in mind.

## Never use Claude Code cross-session messages between panes

The `SendMessage` tool (Claude Code's own cross-session messaging) is NOT a
pane-to-pane channel here. Two problems, both confirmed live (23 Sep 2026):

1. **It needs the recipient's human to approve it.** A message sent this way
   sits pending until someone at that session's terminal accepts it.
2. **It can expire before anyone answers.** A real cross-session message to
   ETA-Refuter was held for approval and then expired, undelivered, with no
   error surfaced to the sender.

A pane that uses `SendMessage` to reach another pane has no way to know
whether the message ever arrived. Don't use it for pane-to-pane traffic.

**Use `hsend`/`eta-bus` instead — always.**

- `hsend.sh "<message>" <agent1> [agent2 ...]` (in `kit/`) — fire-and-forget,
  logs to `scratch/hsend.log`, tries the local herdr session first and falls
  back to known remote machines (e.g. `eta-lab-t4`) by agent name.
- The `eta-bus` MCP tools (`bus_post`, `bus_inbox`, `bus_ack`, `bus_thread`,
  `bus_roster`) — for anything that needs a durable, ack-able, threaded
  message rather than a one-line nudge. `bus_post` to `"all"` reaches every
  known agent on every known machine.

Both deliver immediately, need no human approval, and never silently expire.
If a send fails, you get an error back — you actually know.

## Why this matters for you specifically

If you're waiting on a reply from another pane and used `SendMessage` to ask,
assume it may never arrive. Re-ask over `hsend`/`eta-bus` rather than waiting
on a channel that can swallow the message without telling you.
