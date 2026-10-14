#!/usr/bin/env python3
"""vj-link: the H05 candidate-anchor test, exactly as PRE-REGISTERED by vj-refuter (refute/27 + amendment in refute/28, written before any 16 Sep embedding existed) and frozen in BATCH2-RULE.md v2 (sha256 ea40f81c...).
 H05 = Manoj Kumar S, 16 Sep OPD 4 (rd_ykw2rxjj), booked right knee arthroscopy; encounter = hist-miner's bounds.json 'encounter' interval (arm_d_audio, clamped): start 1789552632000 ms, end 1789553289000 ms (10.95 min).
 Method (no free parameters): cluster the 16 Sep OPD 4 room-day's embedded turns with the SAME procedure as voicelink.py (average linkage, cosine, cut at sim 0.30, centroid = normalised mean); take the embedded turns that lie fully inside the encounter interval;
 a turn counts for its cluster only if its cos to that cluster's centroid >= 0.5; the DOMINANT cluster = the one with the most counted seconds.
 PASS iff cos(dominant centroid, OPD 4 19 Sep cluster 40) >= 0.60 AND cos(dominant centroid, at least one of {OPD 5 23 Sep cluster 62, OPD 7 23 Sep cluster 200}) >= 0.60. Otherwise FAIL and dropped, NO retry.
 The reference clusters are recomputed with the same procedure on their room-days (rd_6nwgyrpx, rd_yck5kdc2, rd_u6kdhc3b; identical to the link-*.json centroids when the cluster is a top cluster).
 RUN-ONCE GUARD: writes h05_result.json; if it exists the script prints it and exits without recomputing.   Usage: LINK_H=<tree with emb-/turns-> h05_test.py"""
import json, os, sys
import numpy as np
from scipy.cluster.hierarchy import linkage, fcluster
H = os.path.expanduser(os.environ.get("LINK_H", "~/eta-data/voice-linkage/dtree84")); OUT = os.path.expanduser("~/eta-data/voice-linkage/h05_result.json")
if os.path.exists(OUT): print("H05 ALREADY RUN (no retry):", open(OUT).read()); sys.exit(0)
ENC = (1789552632000, 1789553289000); H05_RD = "rd_ykw2rxjj"; REFS = {"OPD4_19Sep_c40": ("rd_6nwgyrpx", 40), "OPD5_23Sep_c62": ("rd_yck5kdc2", 62), "OPD7_23Sep_c200": ("rd_u6kdhc3b", 200)}
def clusters(rd):
    z = np.load(f"{H}/emb-{rd}.npz"); idx, E = z["idx"], z["emb"].astype(np.float64); Z = linkage(E, "average", metric="cosine"); lab = fcluster(Z, 1 - 0.30, "distance")
    cent = {}
    for c in set(lab):
        v = E[lab == c].mean(0); cent[int(c)] = v / np.linalg.norm(v)
    return idx, E, lab, cent
T = json.load(open(f"{H}/turns-{H05_RD}.json"))["turns"]; idx, E, lab, cent = clusters(H05_RD)
sec = {}; n_in = 0
for n, i in enumerate(idx.tolist()):
    s, e = int(T[i]["s_ms"]), int(T[i]["e_ms"])
    if s < ENC[0] or e > ENC[1]: continue
    n_in += 1; c = int(lab[n])
    if float(E[n] @ cent[c]) >= 0.5: sec[c] = sec.get(c, 0.0) + (e - s) / 1000
if not sec: res = {"verdict": "FAIL", "reason": "no counted turns in the encounter interval", "turns_in_encounter": n_in}
else:
    dom = max(sec, key=sec.get); refc = {}
    for name, (rd, c) in REFS.items():
        _, _, _, cc = clusters(rd); refc[name] = round(float(cent[dom] @ cc[c]), 3) if c in cc else None
    ok = (refc["OPD4_19Sep_c40"] is not None and refc["OPD4_19Sep_c40"] >= 0.60) and any(refc[k] is not None and refc[k] >= 0.60 for k in ("OPD5_23Sep_c62", "OPD7_23Sep_c200"))
    res = {"verdict": "PASS" if ok else "FAIL", "dominant_cluster": dom, "dominant_seconds": round(sec[dom], 1), "seconds_by_cluster": {str(k): round(v, 1) for k, v in sorted(sec.items(), key=lambda kv: -kv[1])[:5]},
           "turns_in_encounter": n_in, "cos_to_references": refc, "rule": "cos>=0.60 to OPD4_19Sep_c40 AND >=0.60 to at least one of OPD5_23Sep_c62 / OPD7_23Sep_c200"}
res["frozen_rule_sha256"] = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "BATCH2-RULE.sha256")).read().strip()
json.dump(res, open(OUT, "w"), indent=1); os.chmod(OUT, 0o600); print(json.dumps(res, indent=1))
