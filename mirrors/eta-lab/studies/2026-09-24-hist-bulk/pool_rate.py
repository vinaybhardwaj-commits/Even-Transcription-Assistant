#!/usr/bin/env python3
"""pool_rate.py — hist-bulk pool rate from state.jsonl (ids/counts only): windows started ('running') and finished ('done'/'no_audio'/'failed') in the last N minutes, tape-hours done (windows_tierA + priority lists), routers running, Tier A left."""
import json, os, sys, collections
from datetime import datetime, timedelta
N = int(sys.argv[1]) if len(sys.argv) > 1 else 60
TIER = sys.argv[2] if len(sys.argv) > 2 else "A"
HD = os.path.expanduser("~/eta-data/hist"); now = datetime.now(); cut = now - timedelta(minutes=N)
tape = {w["win_id"]: w["tape_s"] for w in json.load(open(f"{HD}/windows_tier{TIER}.json"))}
last = {}; started = done = other = 0; tape_done = 0.0; by = collections.Counter()
for l in open(f"{HD}/state.jsonl"):
    r = json.loads(l); last[r["win"]] = r
    if datetime.fromisoformat(r["t"]) < cut: continue
    if r["state"] == "running": started += 1
    elif r["state"] == "done": done += 1; tape_done += tape.get(r["win"], 0) / 3600; by[r["run"][-7:]] += 1
    elif r["state"] in ("failed", "no_audio", "no_signal"): other += 1
left = sum(1 for w in tape if last.get(w, {}).get("state") not in ("done", "no_signal"))
print(f"last {N} min: started {started}, done {done}, failed/no_audio {other}; Tier A tape-h done {tape_done:.1f} (=> {tape_done*60/N:.1f} tape-h per wall-h); "
      f"running now {sum(1 for x in last.values() if x['state']=='running')}; Tier A left {left}/{len(tape)}")
