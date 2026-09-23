# ETA — herdr-kit's kit changes (pane-watch, yoga-test host picker). REFUTER VERDICT. 23 Sep 2026

`~/dev/eta-lab/kit/pane-watch.py` and `~/dev/eta-lab/yoga-test.sh` (17 991 bytes; it was 12 276 when I ran my U6 gate a few hours ago — live infrastructure under active change). Read-only review; I ran nothing against the hosts and took no locks.

## PASS-WITH-FIXES — answering Fable's three questions

### 1. Can a gate silently run nowhere? — **Not silently. But it can be sent to a dead host while a working one sits free.**

**The dual-shard combine is correct, checked exhaustively rather than read.** `wait` captures both rcs and the precedence `9 > 1 > 0` holds for all nine (A,B) pairs; an unexpected rc (ssh's 255, say) still propagates non-zero. So a half that failed cannot be reported as a clean gate. The obvious "ran nothing" path is closed too: no `--passWithNoTests` anywhere, and vitest's own default is to exit 1 when no files match.

**The gap is in the slot probe.** `host_is_free()` sshes in and tries `flock -n`, and its own comment says *"any probe failure (host down, ssh hiccup) is treated as 'not free'"*. So **busy** and **unreachable** collapse into one bit, and the tie-break cannot tell them apart:

```
A free      -> A
A not free, B free -> B
otherwise   -> A        # "both slots busy — queuing on slot A as usual"
```

The `otherwise` branch is right when both are *busy* and wrong when A is *down*. **Slot A down + slot B busy ⇒ the run is dispatched to the dead host**, fails at ssh as a runner error, and slot B — merely busy, which is the normal state a lock exists to handle — is never tried. The comment's stated worst case, *"we fall back to slot A's normal queuing behavior"*, is only harmless if A is alive.

It fails loudly rather than silently, so nothing green is ever wrong. But on a night when one gate decides a train, a slot-A outage turns every default full-suite call into a runner error instead of a queued, successful run.

**Fix:** have the probe answer three states, not two — free / busy / unreachable — and prefer a *reachable busy* host over an *unreachable* one. The information already exists and is thrown away: ssh failure and `flock -n` failure arrive on different paths and are both swallowed by `>/dev/null 2>&1 && `. This is the same shape as every "absence of evidence" finding today: a one-bit answer cannot distinguish *no* from *no reply*.

### 2. Can two gates share a lock slot? — **No, and they cannot deadlock either.**

Each host serialises its own runs through `/tmp/eta-ci.lock` **on that host**, so "slot A's lock" and "slot B's lock" are the same path on two different machines — nothing is shared and nothing needs building. A caller pinning `CI_HOST` is respected, and the probe is explicitly only a scheduling hint: *"the run's own flock is the actual correctness guarantee."* That is the right division.

I also checked the case the design invites: two concurrent `--dual-shard` runs, each wanting both hosts. No deadlock, because **each child invocation holds exactly one lock and waits on none** — run 2's children simply queue behind run 1's. Deadlock needs a process holding one lock while waiting for another, and no process here ever holds two.

### 3. Can pane-watch send to a working or blocked pane? — **Yes, through a TOCTOU race.**

The intent is right and stated plainly: send only to `idle`/`done`, never to `working` or `blocked`, never to minibot, *"never answers a blocked dialog."* The guard matches the intent — `if status not in ("done", "idle"): return` — and the default is fail-safe (`a.get("agent_status", "unknown")`, and `unknown` fails the check). Single-instance is held properly: an flock on `bus/pane-watch.lock` for the process's whole lifetime, second instance logs and exits, which closes the much worse double-send.

But `status` is sampled **once per poll cycle** by `agent_list(machine)` and then carried through the loop; `maybe_send_queued` re-checks that stale value and never re-verifies before firing. An agent that is idle at listing time and starts working while pane-watch is sending to the agents ahead of it in the loop **receives its order mid-task** — precisely what the component exists to prevent.

The window is seconds and the consequence is an interrupted pane rather than lost data, so this is a fix, not a blocker. **Fix:** re-read that one agent's status immediately before `send_queued`, or make the ordering deterministic and send to the freshest reading. A per-agent re-check costs one call and closes the gap the loop opens.

## Verdict lines
- **`yoga-test.sh` host picker / two slots — PASS-WITH-FIXES.** Locks and the dual-shard combine are correct; the probe's two-state answer misroutes a run to a dead slot A while a busy slot B is available.
- **`kit/pane-watch.py` — PASS-WITH-FIXES.** Single-instance, fail-safe default and blocked handling are all right; the idle check reads a value sampled earlier in the cycle and is not re-verified at send time.
