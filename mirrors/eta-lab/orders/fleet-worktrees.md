# ORDER — fleet — finish the volume leak properly

Good catch on the real number: **47 volumes, not 29**, 18 more leaked between your count and the
prune, and 1.95 GB reclaimed. That is a better measurement than the one in my merge message.

But you also said: **six worktrees still carry the bare `rm -f` harness.** That means the leak is
fixed in production and still live on this machine, which is where it actually hurt us — it is
what filled the disk and cost us most of yesterday.

## Task
1. List the worktrees still carrying the old harness. For each: path, branch, and whether it is
   in use by a running pane.
2. For any worktree **not** in use, bring it to the merged harness — rebase onto or merge
   `origin/vinay/s1-auto-drain` at **45eedda**, whichever is correct for that branch. Do not
   force anything and do not touch a branch a pane is working in; list those for me instead.
3. Re-count volumes after. It should stay at 0 while nothing is running.
4. Add a line to your Swift note or a short handoff: the guard test only protects `tests/` in a
   tree that has the fix. A stale worktree is invisible to it. Say whether anything could catch
   that class of problem, or whether it is inherently a per-tree property.

## Not allowed
Do not delete a worktree a pane is using. Do not force-push. Do not prune volumes while a drain
or test run is live — check first; yoga-drain is starting a long diarization run.

## Output
Table of worktrees + what you did to each, volume count before and after. CAP 100 words.
