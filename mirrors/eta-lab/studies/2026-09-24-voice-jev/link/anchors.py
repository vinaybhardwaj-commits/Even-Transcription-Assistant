#!/usr/bin/env python3
"""vj-link (box, venv-gpu): (1) which voice groups are ANCHORED by a stored, V-verified voiceprint (>= 2 member room-days at cos >= 0.60 to one doctor's print), (2) how often the timing-based best doctor equals the
anchor doctor (independent truth, chance ~ 1/median candidates), (3) a group-level VOTE rule for the doctor (plurality; k >= 3 of n >= 4 days, binomial tail vs 12.5% chance < 0.01).
Inputs: dtree_ext (70 room-days: link-*.json, glinks-complete.json), stored prints from voice-lab-1 ~/vj/centroids (json files copied to /tmp/anch first: rsync --include='*.json' --exclude='*'), PQM csvs for name -> uid.
Out: dtree_ext/overnight/anchored-groups.json and console (ids and numbers only; the prints themselves are never written)."""
import base64, collections, csv, glob, json, math, os, statistics, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tiering as T
E = os.path.expanduser("~/eta-data/voice-linkage/dtree_ext"); P = os.path.expanduser("~/eta-data/voice-linkage/pilot"); ANCH_DIR = os.environ.get("ANCH_DIR", "/tmp/anch"); COS = 0.60; P0 = 0.125
norm = lambda n: " ".join((n or "").lower().replace("dr.", "").replace("dr ", "").replace(".", " ").split())
name2uid = {}
for f in glob.glob(f"{P}/pqm-2026-09-*.csv"):
    for r in csv.DictReader(open(f)): name2uid[norm(r["doctor_name"])] = r["doctor_uid"]
anch = collections.defaultdict(dict)
for f in sorted(glob.glob(f"{ANCH_DIR}/*.json")):
    b = os.path.basename(f)
    if any(w in b for w in ("payload", "meta", "raw", "match")): continue
    if b.startswith("ankit-pwa"): continue   # vj-refuter #1240: the PWA print was enrolled from a heuristic "Patient"-labelled dominant speaker; it must not anchor room audio
    try: j = json.load(open(f))
    except Exception: continue
    k = j.get("embedding_base64") or j.get("centroid_base64")
    if not k: continue
    v = np.frombuffer(base64.b64decode(k), dtype="<f4").astype(float)
    if v.size != 192: continue
    uid = j.get("pulse_uid") or name2uid.get(norm(j.get("display_name") or j.get("full_name"))) or (b.split("-")[-1][:-5] if len(b.split("-")[-1][:-5]) == 20 else None)
    if uid: anch[uid][b[:26]] = v / np.linalg.norm(v)
import re
ENROL = collections.defaultdict(set)
for f in glob.glob(f"{ANCH_DIR}/*.json"):
    b = os.path.basename(f)
    try: txt = open(f).read()
    except Exception: continue
    sess = set(re.findall(r"bs_[a-z0-9]{8}", txt))
    if not sess: continue
    for uid, d in anch.items():
        if any(b.startswith(k[:len(b.split(".")[0])]) or k.startswith(b.split(".")[0][:20]) for k in d): ENROL[uid] |= sess
def sessions_of(rd): return {"bs_" + w["window_id"].split("_")[1] for w in json.load(open(f"{E}/turns-{rd}.json"))["windows"]}
g = {x["gid"]: x for x in json.load(open(f"{E}/overnight/glinks-complete.json"))}
rds = sorted({m[0] for x in g.values() for m in x["members"]}); L = T.load(rds, E); V = T.voices(L)
cent = lambda rd, c: V[(rd, c)]["centroid"] / np.linalg.norm(V[(rd, c)]["centroid"])
A = []
for gid, x in g.items():
    per = collections.defaultdict(list)
    for rd, c in x["members"]:
        v = cent(rd, c)
        for doc, d in anch.items(): per[doc].append((rd, max(float(v @ a) for a in d.values())))
    for doc, l in per.items():
        l = [(rd, s) for rd, s in l if not (sessions_of(rd) & ENROL[doc])]      # refuter #1231: enrolment sessions are circular, excluded
        hit = [(rd, s) for rd, s in l if s >= COS]
        if len({rd for rd, _ in hit}) >= 2:
            A.append({"gid": gid, "anchor_doctor_uid": doc, "matching_room_days": len({rd for rd, _ in hit}), "members": len(x["members"]), "members_non_enrolment": len(l), "enrolment_sessions_excluded": sorted(ENROL[doc]), "cos_min": round(min(s for _, s in hit), 2), "cos_max": round(max(s for _, s in hit), 2),
                      "doctors_named_by_timing": len(x["doctors_named"]), "tier_201": x["tier_pre_jev"]})
json.dump(A, open(f"{E}/overnight/anchored-groups.json", "w"), indent=1)
print("anchored groups:", [(a["gid"], a["anchor_doctor_uid"][:5], a["matching_room_days"], a["members"], a["cos_min"], a["cos_max"], a["tier_201"]) for a in A])
tot = hit = 0; cand = []; ranks = []
for a in A:
    for rd, c in [m for m in g[a["gid"]]["members"] if not (sessions_of(m[0]) & ENROL[a["anchor_doctor_uid"]])]:
        tot += 1; hit += V[(rd, c)]["best"] == a["anchor_doctor_uid"]; cand.append(len({p["doctor_uid"] for p in V[(rd, c)]["pairs"]}))
        ps = sorted(V[(rd, c)]["pairs"], key=lambda p: -p["excess"]); r = [i + 1 for i, p in enumerate(ps) if p["doctor_uid"] == a["anchor_doctor_uid"]]; ranks.append(r[0] if r else None)
have = [r for r in ranks if r]
print(f"timing label == anchor doctor: {hit}/{tot} = {hit / tot:.0%}; chance ~ {1 / statistics.median(cand):.0%} (median {statistics.median(cand)} candidates); scoreable {len(have)}/{len(ranks)}, median rank {statistics.median(have)}, top-3 {sum(r <= 3 for r in have) / len(have):.0%}")
def vote(x):
    c = collections.Counter(V[(rd, cl)]["best"] for rd, cl in x["members"] if V[(rd, cl)]["best"]); n = sum(c.values())
    if not n: return None
    d, k = c.most_common(1)[0]; return d, k, n, sum(math.comb(n, i) * P0 ** i * (1 - P0) ** (n - i) for i in range(k, n + 1))
for a in A:
    d, k, n, p = vote(g[a["gid"]]); print("  vote", a["gid"], a["anchor_doctor_uid"][:5], "->", d[:5], f"{k}/{n} p={p:.4f}", "CORRECT" if d == a["anchor_doctor_uid"] else "wrong")
ok = [(x["gid"],) + vote(x)[1:] for x in g.values() if x["xday"] and vote(x) and vote(x)[1] >= 3 and vote(x)[2] >= 4 and vote(x)[3] < 0.01 and vote(x)[1] / vote(x)[2] >= 0.4]
print("cross-day groups passing the strict vote rule:", [(o[0], o[1], o[2], round(o[3], 4)) for o in ok], "| anchored among them:", sum(1 for o in ok if o[0] in {a["gid"] for a in A}))
