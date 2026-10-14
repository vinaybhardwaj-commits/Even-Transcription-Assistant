"""AS vjscore: of the usable truth turns, how many have a card? counts by source x class x label."""
import json, sys
from collections import Counter, defaultdict
by = defaultdict(list)
for w, s, e, d, carded in json.load(sys.stdin): by[w].append((s, e, d, carded))
C = Counter(); seen = set()
for src, f in (("vpilot_me", "/srv/vj-truth/vp_truth_me.jsonl"), ("e3", "/srv/vj-truth/e3_truth_r197.jsonl"), ("vpilot_voice_verified", "/srv/vj-truth/vp_truth_voiceverified_notdoctor.jsonl")):
    for l in open(f):
        r = json.loads(l); spans = [tuple(x) for x in r["segs"]] if r.get("segs") else [(r["start_ms"], r["end_ms"])]
        L = sum(b - a for a, b in spans); top, tv = None, 0
        for s, e, d, c in by.get(r["window_id"], []):
            v = sum(max(0, min(b, e) - max(a, s)) for a, b in spans)
            if v > tv: tv, top = v, (s, e, d, c)
        if not top or tv < 0.5 * L: continue
        k = (r["window_id"], top[0], top[1])
        if k in seen: continue
        seen.add(k); C[(src, "doubtful" if top[2] else "confident", "doctor" if r["is_doctor"] else "not_doctor", "CARDED" if top[3] else "NO_CARD")] += 1
        if not top[3]: C[("NO_CARD_turn_dur", "<0.8s" if (top[1]-top[0]) < 800 else (">30s" if (top[1]-top[0]) > 30000 else "0.8-30s"))] += 1
for k in sorted(C): print(k, C[k])
