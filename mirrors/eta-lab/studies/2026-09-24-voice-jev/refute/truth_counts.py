"""AS vjscore: map truth rows to classified production turns (largest overlap, >= 50% of the clip / segs sum), count by source x class x is_doctor. Counts only."""
import json, sys
from collections import Counter, defaultdict
cls = json.load(sys.stdin); by = defaultdict(list)
for w, s, e, d, st, room in cls: by[w].append((s, e, d))
def ov(a, b, s, e): return max(0, min(b, e) - max(a, s))
def best(w, spans):
    L = sum(b - a for a, b in spans); top = None; tv = 0
    for s, e, d in by.get(w, []):
        v = sum(ov(a, b, s, e) for a, b in spans)
        if v > tv: tv, top = v, (s, e, d)
    return top if top and tv >= 0.5 * L else None
C = Counter(); seen = set()
for src, f in (("vpilot_me", "/srv/vj-truth/vp_truth_me.jsonl"), ("e3", "/srv/vj-truth/e3_truth_r197.jsonl"), ("vpilot_voice_verified", "/srv/vj-truth/vp_truth_voiceverified_notdoctor.jsonl")):
    for l in open(f):
        r = json.loads(l); spans = [tuple(x) for x in r["segs"]] if r.get("segs") else [(r["start_ms"], r["end_ms"])]
        t = best(r["window_id"], spans)
        if not t: C[(src, "unmapped")] += 1; continue
        k = (r["window_id"], t[0], t[1])
        if k in seen: C[(src, "dup_turn")] += 1; continue
        seen.add(k); C[(src, "doubtful" if t[2] else "confident", "doctor" if r["is_doctor"] else "not_doctor")] += 1
for k in sorted(C): print(k, C[k])
