#!/usr/bin/env python3
"""plan_windows.py — HIST bulk: split each queued room-day (manifest.json) into 15-min grid windows (prod bench_window size, measured n=1158, all 15.0 min).
Grid = 15-min boundaries of the IST day's wall clock (ASSUMPTION: prod grid alignment is unverified; only used for unit sizing, not for matching prod windows).
Ids/keys/times only. Writes ~/eta-data/hist/windows_tierA.json (0600). Windows with no tape are omitted."""
import json, os, sys
from datetime import datetime, timedelta
OUT = os.path.expanduser("~/eta-data/hist"); W = timedelta(minutes=15)
p = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
tier = sys.argv[1] if len(sys.argv) > 1 else "A"
wins = []
for j in json.load(open(f"{OUT}/manifest.json"))["jobs"]:
    if j["tier"] != tier: continue
    cs = [(p(c["started_at"]), p(c["ended_at"]), c) for c in j["chunks"]]
    if not cs: continue
    t0 = min(a for a, _, _ in cs); t = t0.replace(minute=t0.minute // 15 * 15, second=0, microsecond=0)
    end = max(b for _, b, _ in cs)
    while t < end:
        ov = [c for a, b, c in cs if a < t + W and b > t]
        if ov:
            wins.append({"win_id": f"{j['job_id']}_{t.strftime('%H%M')}", "job_id": j["job_id"], "day": j["day"], "room_id": j["room_id"], "start": t.isoformat(), "end": (t + W).isoformat(),
                         "chunk_ids": [c["id"] for c in ov], "tape_s": round(sum((min(b, t + W) - max(a, t)).total_seconds() for a, b, _ in cs if a < t + W and b > t)), "state": "queued"})
        t += W
wins.sort(key=lambda w: (w["day"], w["room_id"], w["start"]))
f = f"{OUT}/windows_tier{tier}.json"; json.dump(wins, open(f, "w")); os.chmod(f, 0o600)
print(f"tier {tier}: {len(wins)} windows, {sum(w['tape_s'] for w in wins)/3600:.1f} tape-h, {sum(1 for w in wins if w['tape_s'] < 60)} with <60 s tape")
