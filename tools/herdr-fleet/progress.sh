#!/bin/bash
# Read-only progress line for the room-audio backfill (fleetboard JOBS strip).
# Counts unique windows in hist/state.jsonl since START (latest state per window wins).
START="2026-10-07T13:57"
TOTAL=1008
F="$HOME/eta-data/hist/state.jsonl"
if pgrep -f 'run_[r]eal.sh --loop|run_[c]3.sh --loop' >/dev/null 2>&1; then S=running; else S=stopped; fi
python3 - "$F" "$START" "$TOTAL" "$S" <<'PY'
import json, sys
f, start, total, st = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
last = {}
try:
    with open(f) as fh:
        for ln in fh:
            try:
                r = json.loads(ln)
            except Exception:
                continue
            if r.get("t", "") >= start and r.get("win"):
                last[r["win"]] = r.get("state", "")
except Exception as e:
    print("%s · cannot read state: %s" % (st, e)); sys.exit(0)
done = sum(1 for s in last.values() if s in ("done", "no_audio"))
failed = sum(1 for s in last.values() if s == "failed")
print("%s · %s of %s windows done since %s · %d failed · box + c3 lanes" % (
    st, format(done, ","), format(total, ","), start[-5:], failed))
PY
