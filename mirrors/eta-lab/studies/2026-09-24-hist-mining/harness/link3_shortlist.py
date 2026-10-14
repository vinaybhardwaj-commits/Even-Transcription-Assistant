#!/usr/bin/env python3
"""link3_shortlist.py — linker #682 (a)+(c) for the 37 blind link-3 items. Rooms considered = those with >=50% of the consult span in recorded audio (link3_coverage.json; a room below that cannot test link 3). For each such room the SAME
energy feature as energy_shortlist.py (share of in-span seconds above 3x that room's own p20 floor, over the +-10 min window); rank -> shortlist top-3. NOTE: validated at top-1 6/15, top-3 14/15 on consults with median ~9 min; these consults are shorter
(median ~5 min), so the ranking is NOISIER: a shortlist, not a placement. (c): for every candidate room-day: hist-bulk manifest tier/queue, production-transcribed windows (inventory), and hist-bulk windows finished so far (out/<job>/).
Out: link3_shortlist.json (0600; item -> {candidate_rooms with coverage, activity, shortlist, hist rows}); prints counts only. Run: ~/.venv-r2/bin/python link3_shortlist.py"""
import glob, json, os, sys
from collections import Counter, defaultdict
from datetime import datetime
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-encounter-first"))
import r2audio, run_window
HM = os.path.expanduser("~/eta-data/hist-mining"); r2audio.CACHE = f"{HM}/audio"; K, TOPN = 3.0, 3
iso = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
items = {i["item"]: i for i in json.load(open(os.path.expanduser("~/eta-data/surgical-chain/p1/link3_inputs_blind.json")))}
cov = json.load(open(f"{HM}/link3_coverage.json")); chunks = json.load(open(f"{HM}/link3_chunks.json"))
man = {j["job_id"]: j for j in json.load(open(os.path.expanduser("~/eta-data/hist/manifest.json")))["jobs"]}
inv = {f"{d['day']}_{d['room_id']}": d for d in json.load(open(os.path.expanduser("~/eta-data/hist/inventory.json")))}
out, todo_chunks = {}, {}
for k, c in sorted(cov.items()):
    cand = {r: v for r, v in c["rooms"].items() if v >= 0.5}
    out[k] = {"day": c["day"], "span_s": c["span_s"], "candidate_rooms": cand, "activity": {}, "shortlist": []}
    for x in chunks[k]:
        if x["room_id"] in cand: todo_chunks[x["r2_key"]] = x
print("candidate-room chunks to read:", len(todo_chunks), "| cached already:", sum(1 for x in todo_chunks if os.path.exists(os.path.join(r2audio.CACHE, x.replace('/', '__')))), flush=True)
with run_window._fetch_lock():
    paths = r2audio.fetch(list(todo_chunks), 4)
series = {}
for n, k in enumerate(sorted(out), 1):
    a, b = iso(items[k]["start"]).timestamp() * 1000, iso(items[k]["end"]).timestamp() * 1000
    byroom = defaultdict(list)
    for x in chunks[k]:
        if x["room_id"] in out[k]["candidate_rooms"]: byroom[x["room_id"]].append({"r2_key": x["r2_key"], "started_at": x["started_at"]})
    for room, cs in byroom.items():
        s = r2audio.energy_series(cs, workers=4); inn = [p for t, p in s if a <= t <= b]
        if len(inn) < 30: continue
        allp = sorted(p for _, p in s); floor = max(allp[int(0.2 * len(allp))], 1e-4)
        out[k]["activity"][room] = round(sum(1 for p in inn if p > K * floor) / len(inn), 3)
    rank = sorted(out[k]["activity"], key=lambda r: -out[k]["activity"][r]); out[k]["shortlist"] = rank[:TOPN]
    hist = []
    for room in out[k]["candidate_rooms"]:
        jid = f"{out[k]['day']}_{room}"; j = man.get(jid); d = inv.get(jid)
        hist.append({"room_id": room, "in_hist_manifest": bool(j), "tier": j["tier"] if j else None, "prod_windows": (d or {}).get("prod_windows"), "prod_transcribed": (d or {}).get("prod_transcribed"),
                     "hist_windows_done": len(glob.glob(os.path.expanduser(f"~/eta-data/hist/out/{jid}/*.json")))})
    out[k]["hist"] = hist
    print(n, "/", len(out), k, "rooms", len(byroom), flush=True)
json.dump(out, open(f"{HM}/link3_shortlist.json", "w"), indent=1); os.chmod(f"{HM}/link3_shortlist.json", 0o600)
nr = Counter(len(v["candidate_rooms"]) for v in out.values())
print("DONE items", len(out), "| candidate rooms per item:", dict(sorted(nr.items())), "| items with a shortlist:", sum(1 for v in out.values() if v["shortlist"]))
top1 = [v["activity"][v["shortlist"][0]] for v in out.values() if v["shortlist"]]
print("median top-1 activity", sorted(top1)[len(top1) // 2] if top1 else None, "| items where top-1 beats runner-up by >=0.1:", sum(1 for v in out.values() if len(v["shortlist"]) > 1 and v["activity"][v["shortlist"][0]] - v["activity"][v["shortlist"][1]] >= 0.1))
