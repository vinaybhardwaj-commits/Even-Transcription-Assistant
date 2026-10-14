# linker-tools (canonical source)

Canonical, reviewed source for tools deployed at `~/linker-tools/` on the box. The deployed copy is a
**plain file, not a symlink** (worktrees get cleaned up; the deployed tool must survive that) — after a
reviewed change lands here, copy it to `~/linker-tools/<name>` and post the new sha256 on the bus, same
discipline as the W49 nightly job's tag-promotion (see `studies/2026-09-27-timeline-pqm/`).

## busctl.py

Manual eta-bus JSON-RPC client for a pane whose session MCP is dead (fallback path). Used directly by
`lab-mover`'s `mirror_daily.sh` for alerting when its own bus tools aren't available. Exit code contract
(0 confirmed / 1 failed / 2 unconfirmed-do-not-retry) is documented in the file's own module docstring —
read that before changing anything, `mirror_daily.sh` depends on it (eta-refuter #5075).

History: found undocumented and untracked (predates this session's HANDOVER chain) 27 Sep 2026; fixed for
a fail-open exit-0-on-failure defect (eta-refuter #5048, eta-refuter-2 #5050) and two further gaps -
server-error replies reported as success, and `inbox`'s silent-consume-on-timeout risk (eta-refuter-2
#5069) - same day. Diagnosed the underlying id=2 reply-latency variance directly (not guessed); ruled out
both a stderr-redirection theory and an inline-herdr-wake theory (eta-refuter #5066) with live timing
tests before concluding the cause is unidentified server-side/SSH latency, not a fixable local bug.
