#!/usr/bin/env python3
"""link3_coverage.py — linker #682 (b): for each blind link-3 item, per-ROOM audio coverage of the consult span [start, end] (share of the span inside that room's recorded chunks; union of chunk intervals, any source/state),
from Neon bench_chunk (read-only, chunk TIMES only, no audio). Also keeps the chunk inventory for window [start-10 min, end+10 min] in every room, for the energy step. Items are the linker's neutral ids (c001..); no class, no patient id.
Out: ~/eta-data/hist-mining/link3_coverage.json (0600): {item: {day, span_s, rooms: {room_id: coverage 0..1}, ...}} + link3_chunks.json (chunk inventory, ids/keys/times). Prints counts only."""
import json, os, subprocess
from collections import Counter, defaultdict
from datetime import datetime, timedelta
HM = os.path.expanduser("~/eta-data/hist-mining")
NEON = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs"); ETA = os.path.expanduser("~/dev/Even-Transcription-Assistant")
PAD = timedelta(minutes=10)
iso = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
def neon(q):
    r = subprocess.run(["node", NEON, q], cwd=ETA, capture_output=True, text=True, timeout=300)
    if r.returncode: raise SystemExit(f"neon-select rc={r.returncode}")
    return json.loads(r.stdout)
items = json.load(open(os.path.expanduser("~/eta-data/surgical-chain/p1/link3_inputs_blind.json")))
byday = defaultdict(list)
for it in items: byday[it["day"]].append(it)
chunks_of, cov = {}, {}
for day, its in sorted(byday.items()):
    cond = " OR ".join(f"(c.started_at < '{(iso(i['end']) + PAD).isoformat()}' AND c.ended_at > '{(iso(i['start']) - PAD).isoformat()}')" for i in its)
    rows = neon(f"SELECT c.id, c.session_id, bs.room_id, c.idx, c.r2_key, c.started_at, c.ended_at, c.upload_state, c.source FROM bench_chunk c JOIN bench_session bs ON bs.id=c.session_id WHERE {cond}")
    for it in its:
        a, b = iso(it["start"]), iso(it["end"]); lo, hi = a - PAD, b + PAD
        ch = [x for x in rows if iso(x["started_at"]) < hi and iso(x["ended_at"]) > lo]
        chunks_of[it["item"]] = ch
        span = max(1.0, (b - a).total_seconds()); rooms = defaultdict(list)
        for x in ch:
            s, e = max(iso(x["started_at"]), a), min(iso(x["ended_at"]), b)
            if e > s: rooms[x["room_id"]].append((s, e))
        r = {}
        for room, iv in rooms.items():
            iv.sort(); tot, cur_s, cur_e = 0.0, None, None
            for s, e in iv:
                if cur_e is None or s > cur_e:
                    if cur_e is not None: tot += (cur_e - cur_s).total_seconds()
                    cur_s, cur_e = s, e
                else: cur_e = max(cur_e, e)
            tot += (cur_e - cur_s).total_seconds(); r[room] = round(min(1.0, tot / span), 2)
        cov[it["item"]] = {"day": day, "span_s": round(span), "rooms": r, "n_chunks_window": len(ch)}
json.dump(cov, open(f"{HM}/link3_coverage.json", "w"), indent=1); os.chmod(f"{HM}/link3_coverage.json", 0o600)
json.dump(chunks_of, open(f"{HM}/link3_chunks.json", "w")); os.chmod(f"{HM}/link3_chunks.json", 0o600)
n50 = {k: [r for r, v in c["rooms"].items() if v >= 0.5] for k, c in cov.items()}
print("items:", len(cov), "| with ANY audio in the +-10 min window:", sum(1 for c in cov.values() if c["n_chunks_window"]), "| with a room >=50% of the consult:", sum(1 for v in n50.values() if v),
      "| rooms>=50% per item (dist):", dict(sorted(Counter(len(v) for v in n50.values()).items())), "| items with >=90% in some room:", sum(1 for c in cov.values() if c["rooms"] and max(c["rooms"].values()) >= 0.9))
print("by day (items / with a >=50% room):", {d: (len(its), sum(1 for i in its if n50[i["item"]])) for d, its in sorted(byday.items())})
