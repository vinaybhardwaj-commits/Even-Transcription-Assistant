"""vj-refuter independent scorer: written from COMBINE_RULE.md text only, no import of arms/ code."""
import json, sys
from math import comb
def rj(p): return [json.loads(l) for l in open(p) if l.strip()]
def doubtful(r):  # Phase 0 + D1 gaps
    if r.get("speaker_basis") == "diarization_only": return True
    if r.get("margin") is None or r["margin"] < 0.10: return True
    n, p = r.get("nemotron_n"), r.get("pyannote_n")
    return n is not None and p is not None and n != p
arm1_in, truth_p, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
a1 = {r["turn_id"]: r for r in rj(arm1_in)}
tr = {r["turn_id"]: (r["is_doctor"] if "is_doctor" in r else r["label"] == "doctor") for r in rj(truth_p)}
def ans(arm, o):
    if o is None or "error" in o: return None
    if arm == 4:
        return {"marked_middle_speaker": True, "not_marked_middle_speaker": False}.get(o.get("answer"))
    q = o.get("q1") or {}
    if q.get("choice") in (None, "cannot_tell") or (q.get("confidence") or 0) < 0.70: return None
    return q["choice"] == "doctor"
res = {}
for arm in (1, 2, 3, 4):
    outs = {}
    if arm > 1:
        for o in rj(f"{outdir}/arm{arm}.jsonl"):
            if arm == 4 and o.get("kind") != "l1": continue
            outs[o["turn_id"]] = o
    D = [0, 0]; Cn = [0, 0]; b = c = 0
    for t, truth in tr.items():
        r = a1[t]; d = doubtful(r); p1 = r["label"] == "doctor"
        f = p1 if (arm == 1 or not d) else ans(arm, outs.get(t))
        ok = f is not None and f == truth
        (D if d else Cn)[0] += ok; (D if d else Cn)[1] += 1
        if d and arm > 1: b += ok and p1 != truth; c += (not ok) and p1 == truth
    n = b + c; p = min(1, 2 * sum(comb(n, i) for i in range(min(b, c) + 1)) / 2 ** n) if n else 1
    res[arm] = f"doubtful {D[0]}/{D[1]} confident {Cn[0]}/{Cn[1]} +{b}/-{c} p={p:.4f}"
for k, v in res.items(): print(f"arm{k}: {v}")
