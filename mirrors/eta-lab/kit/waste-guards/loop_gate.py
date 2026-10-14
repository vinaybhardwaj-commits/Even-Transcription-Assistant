#!/usr/bin/env python3
"""loop-gate.py -- 455.A.2: the shared change-check helper loops call BEFORE any model call.

A loop computes the inputs its model call depends on (a snapshot, a digest source,
a file set), hashes them, and calls:

    loop-gate.py check <loop-name> <sha256-of-inputs>

Exit 0 = inputs CHANGED since the last model call (or first sight) -> the loop may
spend. Exit 3 = same inputs already served within --min-minutes (default 30) ->
the loop MUST skip the model call this round. Exit 0 also when --force.

    loop-gate.py record <loop-name> <sha256>   # after a successful spend
    loop-gate.py status                        # table

State: one json file per loop under ~/dev/eta-lab/scratch/loop-gates/ (ts of last
spend + last hash). No model calls, no bus posts, lock-free (atomic rename).
The 30-minute floor is the 455 order; a loop may pass --min-minutes to RAISE it,
never to lower it below 30.
"""
import argparse, hashlib, json, os, sys, time

STATE_DIR = os.path.expanduser("~/dev/eta-lab/scratch/loop-gates")
FLOOR_MIN = 30.0

def path_for(loop):
    os.makedirs(STATE_DIR, exist_ok=True)
    return os.path.join(STATE_DIR, "%s.json" % hashlib.sha256(loop.encode()).hexdigest()[:16])

def check(loop, digest, min_minutes):
    eff = max(min_minutes, FLOOR_MIN)
    try:
        st = json.load(open(path_for(loop)))
    except Exception:
        print("OPEN first-sight -> spend allowed")
        return 0
    age_min = (time.time() - st.get("ts", 0)) / 60.0
    if st.get("hash") == digest and age_min < eff:
        print("SKIP same inputs %.1f min ago (< %.0f min floor)" % (age_min, eff))
        return 3
    print("OPEN inputs changed or stale (%.1f min) -> spend allowed" % age_min)
    return 0

def record(loop, digest):
    tmp = path_for(loop) + ".tmp"
    json.dump({"hash": digest, "ts": time.time()}, open(tmp, "w"))
    os.replace(tmp, path_for(loop))
    print("recorded", digest[:12])

def status():
    if not os.path.isdir(STATE_DIR):
        print("(no gates)"); return
    for f in sorted(os.listdir(STATE_DIR)):
        try:
            st = json.load(open(os.path.join(STATE_DIR, f)))
            age = (time.time() - st.get("ts", 0)) / 60.0
            print("%s hash=%s age_min=%.0f" % (f[:16], st.get("hash", "?")[:12], age))
        except Exception:
            print("%s (unreadable)" % f[:16])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["check", "record", "status"])
    ap.add_argument("loop", nargs="?")
    ap.add_argument("digest", nargs="?")
    ap.add_argument("--min-minutes", type=float, default=FLOOR_MIN)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    if a.cmd == "status":
        status(); return
    if not a.loop or not a.digest:
        ap.error("loop and digest required")
    if a.cmd == "check":
        if a.force:
            print("FORCE -> spend allowed"); sys.exit(0)
        sys.exit(check(a.loop, a.digest, a.min_minutes))
    if a.cmd == "record":
        record(a.loop, a.digest)

if __name__ == "__main__":
    main()
