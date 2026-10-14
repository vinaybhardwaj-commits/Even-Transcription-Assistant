#!/usr/bin/env python3
"""vj-link (box, venv-gpu): negative control for anchored identity (ruling 182 spirit: a doctor's voice vs ANOTHER doctor's stored print must stay low).
For each anchored group (anchors.py) and each stored-print doctor: the cos of the group's member voices to that print (non-enrolment days for the group's own doctor; all member days for other doctors' prints).
Also the base rate: how many of the 122 voice groups have >= 2 member voices >= 0.60 to ANY stored print (the anchored ones) vs to a print of a DIFFERENT doctor than the anchored one (should be ~0).
Out: console numbers; dtree_ext/overnight/anchor-negative-control.json."""
import base64, collections, csv, glob, json, os, re, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tiering as T
E = os.path.expanduser("~/eta-data/voice-linkage/dtree_ext"); ANCH_DIR = "/tmp/anch"; P = os.path.expanduser("~/eta-data/voice-linkage/pilot")
norm = lambda n: " ".join((n or "").lower().replace("dr.", "").replace("dr ", "").replace(".", " ").split())
name2uid = {}
for f in glob.glob(f"{P}/pqm-2026-09-*.csv"):
    for r in csv.DictReader(open(f)): name2uid[norm(r["doctor_name"])] = r["doctor_uid"]
anch = collections.defaultdict(dict)
for f in sorted(glob.glob(f"{ANCH_DIR}/*.json")):
    b = os.path.basename(f)
    if any(w in b for w in ("payload", "meta", "raw", "match")) or b.startswith("ankit-pwa"): continue
    try: j = json.load(open(f))
    except Exception: continue
    k = j.get("embedding_base64") or j.get("centroid_base64")
    if not k: continue
    v = np.frombuffer(base64.b64decode(k), dtype="<f4").astype(float)
    if v.size != 192: continue
    uid = j.get("pulse_uid") or name2uid.get(norm(j.get("display_name") or j.get("full_name"))) or (b.split("-")[-1][:-5] if len(b.split("-")[-1][:-5]) == 20 else None)
    if uid: anch[uid][b[:26]] = v / np.linalg.norm(v)
g = {x["gid"]: x for x in json.load(open(f"{E}/overnight/glinks-complete.json"))}
A = json.load(open(f"{E}/overnight/anchored-groups.json")); rds = sorted({m[0] for x in g.values() for m in x["members"]}); L = T.load(rds, E); V = T.voices(L)
cent = lambda rd, c: V[(rd, c)]["centroid"] / np.linalg.norm(V[(rd, c)]["centroid"])
docs = sorted(anch); print("stored-print doctors:", [d[:5] for d in docs])
mat = {}
print("anchored group x stored print: median / max cos over the group's member voices (own doctor marked *)")
for a in A:
    x = g[a["gid"]]; row = {}
    for d in docs:
        s = [max(float(cent(rd, c) @ p) for p in anch[d].values()) for rd, c in x["members"]]
        row[d[:5]] = {"median": round(float(np.median(s)), 2), "max": round(max(s), 2), "n_ge_0.60": int(sum(v >= 0.60 for v in s)), "own": d == a["anchor_doctor_uid"]}
    mat[a["gid"]] = row
    print(f"  {a['gid']} ({a['anchor_doctor_uid'][:5]}):", "  ".join(f"{d}{'*' if r['own'] else ''} {r['median']}/{r['max']}" for d, r in row.items()))
other_max = max((r["max"] for row in mat.values() for r in row.values() if not r["own"]), default=None)
# base rate over ALL groups: >= 2 member voices >= 0.60 to one print
hits = collections.Counter()
for gid, x in g.items():
    for d in docs:
        n = sum(max(float(cent(rd, c) @ p) for p in anch[d].values()) >= 0.60 for rd, c in x["members"])
        if n >= 2: hits[d[:5]] += 1
own_pairs = {(a["gid"], a["anchor_doctor_uid"][:5]) for a in A}
off = [(gid, d) for gid, x in g.items() for d in docs if sum(max(float(cent(rd, c) @ p) for p in anch[d].values()) >= 0.60 for rd, c in x["members"]) >= 2 and (gid, d[:5]) not in own_pairs]
print("groups (of", len(g), ") with >= 2 member voices >= 0.60 to a print:", sum(hits.values()), "| of which NOT the anchored (group, doctor) pairs:", len(off), off[:6])
print("highest cos of any anchored group to ANOTHER doctor's print (max over members):", other_max)
json.dump({"matrix": mat, "groups_total": len(g), "matches_ge2_per_doctor": dict(hits), "off_anchor_matches": off, "max_other_doctor_cos": other_max}, open(f"{E}/overnight/anchor-negative-control.json", "w"), indent=1)
