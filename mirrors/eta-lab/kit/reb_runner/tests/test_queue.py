#!/usr/bin/env python3
"""Tests for reb_runner.task_queue: claim-once (token-based), lease expiry steal, concurrent claim
race, done/failed state, release-for-immediate-retry, and the fencing/staleness fixes eta-refuter-2/3
found (#4797/#4807): a stale token can't release/mark_done/mark_failed someone else's live claim, an
empty/corrupt claim file is stealable (not immortal), and is_done() can't be flipped back by a late
zombie failure."""
import multiprocessing
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from reb_runner import task_queue as q

ROOT = tempfile.mkdtemp(prefix="reb-queue-test-")
Q = "box-whisper"

# 1. basic claim-once: second claimant loses; a claim returns a truthy token
t1 = q.claim(ROOT, Q, "w1", "worker-a")
assert t1 and isinstance(t1, str)
assert q.claim(ROOT, Q, "w1", "worker-b") is None
print("1/9 basic claim-once OK: a token comes back, a second claimant is refused")

# 2. mark_done requires the right token; is_done -> True; a DONE window can never be (re)claimed
assert q.mark_done(ROOT, Q, "w1", t1) is True
assert q.is_done(ROOT, Q, "w1") is True
assert q.claim(ROOT, Q, "w1", "worker-c") is None, "a done window must never be reclaimed"
print("2/9 mark_done OK: is_done true, no further claims accepted")

# 3. a live (non-expired) claim on an UNFINISHED window blocks a steal attempt
t2 = q.claim(ROOT, Q, "w2", "worker-a")
assert t2 and q.claim(ROOT, Q, "w2", "worker-b", lease_s=1800) is None
print("3/9 live claim OK: not stealable before its lease expires")

# 4. an EXPIRED claim (worker presumed dead) is stealable, and the steal is logged
t3 = q.claim(ROOT, Q, "w3", "worker-dead", lease_s=0.2)
assert t3
time.sleep(0.3)
t3b = q.claim(ROOT, Q, "w3", "worker-alive", lease_s=0.2)
assert t3b and t3b != t3, "an expired claim must be stealable, with a NEW token"
state_lines = [l for l in open(os.path.join(ROOT, "_runner", "state.jsonl")) if '"w3"' in l]
assert any("stole_from" in l for l in state_lines), "a steal must be visible in the state log"
print("4/9 lease-expiry steal OK: a dead worker's claim is reclaimed with a fresh token, logged")

# 5. release() lets the SAME window be claimed again immediately (no lease wait)
t4 = q.claim(ROOT, Q, "w4", "worker-a")
assert q.release(ROOT, Q, "w4", t4) is True
t4b = q.claim(ROOT, Q, "w4", "worker-b")
assert t4b, "release() must allow an immediate re-claim"
print("5/9 release OK: immediate re-claim without waiting out the lease")

# 6. FENCING: a stale token can never release/mark_done/mark_failed someone else's LIVE claim
# (eta-refuter-2 #4807 Q2 / eta-refuter-3 #4797 B2)
t5 = q.claim(ROOT, Q, "w5", "worker-dead", lease_s=0.2)
time.sleep(0.3)
t5b = q.claim(ROOT, Q, "w5", "worker-alive", lease_s=0.2)  # steals it
assert t5b != t5
assert q.release(ROOT, Q, "w5", t5) is False, "the zombie's stale token must not release the live claim"
assert q.mark_failed(ROOT, Q, "w5", t5, "zombie tried to fail this") is False, "stale token must not log a fake failure"
assert q.mark_done(ROOT, Q, "w5", t5, x=1) is False, "stale token must not log a fake completion"
# the live owner's own token still works fine
assert q.mark_done(ROOT, Q, "w5", t5b) is True
assert q.is_done(ROOT, Q, "w5") is True, "the zombie's rejected mark_done/mark_failed must not have corrupted state"
print("6/9 fencing OK: a stale token can't touch the claim a live worker holds; the live owner's own calls still work")

# 7. is_done() can't be flipped back by a late zombie failure (eta-refuter-2 #4807 Q2, other half)
t6 = q.claim(ROOT, Q, "w6", "worker-dead", lease_s=0.2)
time.sleep(0.3)
t6b = q.claim(ROOT, Q, "w6", "worker-alive", lease_s=0.2)
assert q.mark_done(ROOT, Q, "w6", t6b) is True
assert q.is_done(ROOT, Q, "w6") is True
# even with a VALID-looking (but stale) token this can't happen per test 6; this test checks the
# is_done() semantics directly: a "failed" line logged AFTER a "done" line must not un-done it.
q.log_state(ROOT, Q, "w6", "failed", reason="simulated late zombie write, bypassing fencing on purpose")
assert q.is_done(ROOT, Q, "w6") is True, "is_done must be 'done was EVER logged', not 'latest state == done'"
print("7/9 is_done OK: a done window stays done even if a later failed line appears in the log")

# 8. Q1: an empty/corrupt claim file (crash between O_CREAT|O_EXCL and writing the body) is stealable,
# not immortally fresh
claims_dir = os.path.join(ROOT, "_runner", "claims", Q)
os.makedirs(claims_dir, exist_ok=True)
empty_claim = os.path.join(claims_dir, "w7")
open(empty_claim, "w").close()  # simulate the crash: file exists, zero bytes
old_mtime = time.time() - 100
os.utime(empty_claim, (old_mtime, old_mtime))
t7 = q.claim(ROOT, Q, "w7", "worker-rescuer", lease_s=10)
assert t7, "an empty claim file older than the lease (by mtime) must be stealable"
print("8/9 Q1 OK: an empty/corrupt claim file falls back to mtime for staleness, not an immortal age=0")

# 9. real concurrency: N processes race for the SAME window, exactly one wins
def _racer(win, idx, results_path, lease_s=q.DEFAULT_LEASE_S):
    token = q.claim(ROOT, Q, win, f"worker-{idx}", lease_s=lease_s)
    with open(results_path, "a") as f:
        f.write(f"{idx}:{bool(token)}\n")

results_path = os.path.join(ROOT, "race_results.txt")
procs = [multiprocessing.Process(target=_racer, args=("w_race", i, results_path)) for i in range(10)]
[p.start() for p in procs]
[p.join(timeout=15) for p in procs]
lines = open(results_path).read().splitlines()
wins = [l for l in lines if l.endswith(":True")]
assert len(wins) == 1, f"exactly one racer must win a fresh claim, got {wins}"
print("9/10 concurrency OK: 10 real processes race for one window, exactly one wins the claim")

# 10. B1: concurrent STEAL race (not just fresh-claim race) -- an expired claim, then N processes race
# to steal it simultaneously; exactly one must win (eta-refuter-3 #4797 B1: the fresh-create path used
# to skip the lock entirely, so a stealer and a fresh claimant could both win).
t8 = q.claim(ROOT, Q, "w_steal_race", "worker-dead", lease_s=0.2)
time.sleep(0.3)
results_path2 = os.path.join(ROOT, "steal_race_results.txt")
procs2 = [multiprocessing.Process(target=_racer, args=("w_steal_race", i, results_path2, 0.2)) for i in range(10)]
[p.start() for p in procs2]
[p.join(timeout=15) for p in procs2]
lines2 = open(results_path2).read().splitlines()
wins2 = [l for l in lines2 if l.endswith(":True")]
assert len(wins2) == 1, f"exactly one stealer must win a lease-expired claim, got {wins2}"
print("10/10 B1 OK: 10 real processes race to STEAL one expired claim, exactly one wins")

shutil.rmtree(ROOT, ignore_errors=True)
print("ALL QUEUE TESTS OK")
