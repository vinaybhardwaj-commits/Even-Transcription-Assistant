"""AS vjscore: for V-pilot answers me / not_me, the mapped production turn's cosine to the room-day's VERIFIED doctor centroid ('best'). Counts and quantiles only."""
import json, sys, statistics as st
from collections import defaultdict
cls = json.load(sys.stdin); by = defaultdict(list)
for w, s, e, best, d, room in cls: by[w].append((s, e, best, d))
times = {(r["page"], r["clip_id"]): r for r in json.load(open("/tmp/vpt.json"))["rows"]}
B = "/srv/vj-truth/vpilot/split-speaker-pilot-%s/"
res = defaultdict(list)
for p in ("v2", "v3", "v4", "v5"):
    ans = {}
    for l in open(B % p + "answers.jsonl"):
        a = json.loads(l)
        if a.get("kind") == "clip": ans[a["id"]] = a["answer"]
    for (pg, cid), r in times.items():
        if pg != p or r["repeat_of"] or cid not in ans: continue
        spans = [tuple(x) for x in r["segs"]] if r.get("segs") else [(r["start_ms"], r["end_ms"])]
        L = sum(b - a for a, b in spans); top, tv = None, 0
        for s, e, best, d in by.get(r["window_id"], []):
            v = sum(max(0, min(b, e) - max(a, s)) for a, b in spans)
            if v > tv: tv, top = v, (best, d)
        if not top or tv < 0.5 * L: continue
        if top[0] is None: res[(p[:2] in ("v2", "v3") and "v2v3" or "v4v5", ans[cid], "no_verified_doctor")].append(0); continue
        res[("v2v3" if p in ("v2", "v3") else "v4v5", ans[cid], top[1])].append(top[0])
for k in sorted(res):
    v = res[k]
    if k[2] == "no_verified_doctor": print(k, "n", len(v)); continue
    q = sorted(v); print(k, "n", len(v), "median best", round(st.median(q), 3), "share>=0.5", round(sum(x >= 0.5 for x in q) / len(q), 2))
