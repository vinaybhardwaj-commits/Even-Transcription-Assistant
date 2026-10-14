"""AS vjscore: ruling 214. v2/v3 'not_me' answers (non-repeat) whose clip maps (>= 50% of clip) to a production turn on a room-day with a
VERIFIED PRESENT doctor (classification186 verified_doctor set; ruling 187) -> is_doctor=false, source 'vpilot_voice_verified'. Counts only."""
import json, sys, hashlib
from collections import defaultdict, Counter
cls = json.load(sys.stdin); by = defaultdict(list)
for w, s, e, best, d, room in cls: by[w].append((s, e, d))
times = {(r["page"], r["clip_id"]): r for r in json.load(open("/tmp/vpt.json"))["rows"]}
B = "/srv/vj-truth/vpilot/split-speaker-pilot-%s/"; out = []; C = Counter()
for p in ("v2", "v3"):
    ans = {}
    for l in open(B % p + "answers.jsonl"):
        a = json.loads(l)
        if a.get("kind") == "clip": ans[a["id"]] = a["answer"]
    for (pg, cid), r in times.items():
        if pg != p or r["repeat_of"] or ans.get(cid) != "not_me": continue
        a0, b0 = r["start_ms"], r["end_ms"]; top, tv = None, 0
        for s, e, d in by.get(r["window_id"], []):
            v = max(0, min(b0, e) - max(a0, s))
            if v > tv: tv, top = v, (s, e, d)
        if not top or tv < 0.5 * (b0 - a0): C["unmapped"] += 1; continue
        if not top[2]: C["no_verified_doctor"] += 1; continue
        C[top[2]] += 1
        out.append({"page": p, "window_id": r["window_id"], "start_ms": a0, "end_ms": b0, "is_doctor": False, "source": "vpilot_voice_verified", "rule": "ruling 214", "room_day_doctor": top[2]})
b = ("\n".join(json.dumps(x, sort_keys=True) for x in out) + "\n").encode(); open("/srv/vj-truth/vp_truth_voiceverified_notdoctor.jsonl", "wb").write(b)
print("added not-doctor", len(out), dict(C), "sha12", hashlib.sha256(b).hexdigest()[:12])
