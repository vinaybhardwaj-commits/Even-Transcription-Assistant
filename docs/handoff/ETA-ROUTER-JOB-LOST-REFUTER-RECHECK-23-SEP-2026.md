# ETA — router_job_lost, the clock fix. REFUTER RE-CHECK. 23 Sep 2026

`vinay/router-job-lost` **@ `18accb1`** (builder scribe), two commits on `206acbf`. Worktree `/tmp/refute-rjl2`, HEAD asserted, clean after every run. typecheck **rc=0**, `router-job-lost.test.ts` **18/18** (was 10). **6 mutations, 6 killed, 0 survived.**

## PASS — my finding is closed by a better fix than the one I proposed, and my proposal was wrong

### scribe corrected a premise of mine, and it mattered

I recommended bounding the **running** time, using the `queued` vs `running` distinction the adapter already surfaces. That would not have worked, and scribe says why:

> *"The router's `run_job` writes `running` the moment its thread starts and then WAITS on its single window semaphore still saying `running`; `queued` is only the instant before."*

So `queued` is momentary and `running` covers both working and waiting. My fix would have changed almost nothing — I had reasoned from the adapter's vocabulary without checking what the router actually does with it.

**Their signal is the right one: progress.** `progress.done` moves only once a job gets the semaphore; a job file a restart left behind never moves. The clock now resets whenever the router's answer **changes** (state or `progress.done`), giving three regimes:

| router says | bound |
|---|---|
| `queued` | **never lost on time** |
| `running`, no sub-window done — i.e. waiting its turn | `routerJobMaxWaitingMs` = **4 ×** the running bound (2 h for a 900 s window) |
| progressed, then stopped changing | the running bound (30 min) — *"what a job file a restart left behind looks like"* |

**Their arithmetic is better than mine.** I counted one drain batch of 5 and got ~43 min. They counted the batch **plus the overnight driver plus a night-drain** — ~75 min — and set 2 h to clear it with margin. They also note Python's semaphore is not fair, so one job can hold it for a whole window while others sit at `done: 0`. That is the real worst case and I had understated it.

| mutation | result |
|---|---|
| **W2** the clock reverted to submit-time — my original finding | **killed** |
| **W5** waiting jobs given the tight running bound — my finding at the new anchor | **killed, 2** |
| **W6** progress no longer resets the clock | **killed, 3** |
| **W4** a `queued` job can be lost on time | **killed** |
| **W1** wait factor 4 → 1 | **killed, 3** |
| **W3** wait factor 4 → 100 (nothing waiting ever lost) | **killed, 2** |

W1 and W3 together are the boundary: too tight dies and too loose dies, so the factor is pinned rather than merely present. W4 confirms the `queued` exemption is a tested property, not a comment.

### A contamination in my own harness, disclosed

My first attempt at W4–W6 reported **4 and 4** failures. Those numbers were wrong. An earlier call died on a shell-quoting error **before its restore step**, leaving W4's mutation in the tree; the next call then captured that mutated file as its "clean" backup, so W5 and W6 ran on a contaminated baseline and their restores put the contamination back. I caught it only because I check the worktree is clean after a run — `CLEAN: 1 dirty` is what exposed it.

Reset, with the baseline re-verified at 18/18 first, the true counts are **2, 3 and 1**. The contamination inflated them. The conclusions are unchanged, but the numbers I would have reported were not the numbers.

This is the fifth harness failure I have found in myself today and the first where a **partial** failure poisoned later runs rather than merely wasting one. The rule that caught it is the cheap one: assert the worktree is clean *after* every mutation, not just before the set.

## Verdict: PASS
The finding is closed, by a mechanism I did not propose and could not have, because it rests on what the router does rather than on what its adapter reports. Six mutations kill, including both directions on the new constant and the `queued` exemption my own suggestion would have leaned on wrongly.
