#!/usr/bin/env python3
"""Tests for reb_runner.task_queue: claim-once, lease expiry steal, concurrent claim race, done/failed
state, release-for-immediate-retry."""
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

# 1. basic claim-once: second claimant loses
assert q.claim(ROOT, Q, "w1", "worker-a") is True
assert q.claim(ROOT, Q, "w1", "worker-b") is False
print("1/6 basic claim-once OK: second claimant is refused")

# 2. mark_done -> is_done True, and a DONE window can never be (re)claimed
q.mark_done(ROOT, Q, "w1")
assert q.is_done(ROOT, Q, "w1") is True
assert q.claim(ROOT, Q, "w1", "worker-c") is False, "a done window must never be reclaimed"
print("2/6 mark_done OK: is_done true, no further claims accepted")

# 3. a live (non-expired) claim on an UNFINISHED window blocks a steal attempt
assert q.claim(ROOT, Q, "w2", "worker-a") is True
assert q.claim(ROOT, Q, "w2", "worker-b", lease_s=1800) is False
print("3/6 live claim OK: not stealable before its lease expires")

# 4. an EXPIRED claim (worker presumed dead) is stealable, and the steal is logged
assert q.claim(ROOT, Q, "w3", "worker-dead", lease_s=0.2) is True
time.sleep(0.3)
assert q.claim(ROOT, Q, "w3", "worker-alive", lease_s=0.2) is True, "an expired claim must be stealable"
state_lines = [l for l in open(os.path.join(ROOT, "_runner", "state.jsonl")) if '"w3"' in l]
assert any("stole_from" in l for l in state_lines), "a steal must be visible in the state log"
print("4/6 lease-expiry steal OK: a dead worker's claim is reclaimed and logged")

# 5. release() lets the SAME window be claimed again immediately (no lease wait)
assert q.claim(ROOT, Q, "w4", "worker-a") is True
q.release(ROOT, Q, "w4")
assert q.claim(ROOT, Q, "w4", "worker-b") is True, "release() must allow an immediate re-claim"
print("5/6 release OK: immediate re-claim without waiting out the lease")

# 6. real concurrency: N processes race for the SAME window, exactly one wins
def _racer(win, idx, results_path):
    won = q.claim(ROOT, Q, win, f"worker-{idx}")
    with open(results_path, "a") as f:
        f.write(f"{idx}:{won}\n")

results_path = os.path.join(ROOT, "race_results.txt")
procs = [multiprocessing.Process(target=_racer, args=("w_race", i, results_path)) for i in range(10)]
[p.start() for p in procs]
[p.join(timeout=15) for p in procs]
lines = open(results_path).read().splitlines()
wins = [l for l in lines if l.endswith(":True")]
assert len(wins) == 1, f"exactly one racer must win a fresh claim, got {wins}"
print("6/6 concurrency OK: 10 real processes race for one window, exactly one wins the claim")

shutil.rmtree(ROOT, ignore_errors=True)
print("ALL QUEUE TESTS OK")
