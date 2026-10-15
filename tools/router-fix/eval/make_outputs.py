#!/usr/bin/env python3
"""From the label200 old/new runs write (a) clarity_fixed.json (lab-viewer shape, NEW router) and
(b) per-window route JSONLs for linker's S3: {id, route_lang, shares, engine} for old and new.
usage: make_outputs.py RUN_ID   -> ~/eta-data/router-fix/<RUN_ID>/{clarity_fixed.json,route_old.jsonl,route_new.jsonl}"""
import json, os, sys, collections, hashlib
OUT = "/home/eta/oc/router-fix/eval-out"; RUN = sys.argv[1]
D = os.path.expanduser(f"~/eta-data/router-fix/{RUN}"); os.makedirs(D, mode=0o750, exist_ok=True)
load = lambda f: {json.loads(l)["id"]: json.loads(l) for l in open(f)} if os.path.exists(f) else {}
old = {**load(f"{OUT}/old-label200-r.jsonl"), **load(f"{OUT}/old-label200.jsonl")}
new = load(f"{OUT}/new-label200.jsonl")

def summ(row):
    segs = [s for s in row.get("segments", []) if s.get("text")]
    if not segs:
        return "und", {}, None
    ch, eng = collections.Counter(), collections.Counter()
    for s in segs:
        ch[s["lang"]] += len(s["text"]); eng[s["engine"]] += len(s["text"])
    tot = sum(ch.values())
    return ch.most_common(1)[0][0], {k: round(v / tot, 2) for k, v in ch.most_common()}, eng.most_common(1)[0][0]

rows = {}
for i, r in sorted(new.items()):
    if "error" in r:
        continue
    tag, sh, eng = summ(r)
    row = {"tag": tag}
    alts = [k for k in sh if k != tag][:2]
    if alts:
        row["alt"] = alts
    note = eng or "no speech"
    if len(sh) > 1:
        note += " mixed " + "/".join(f"{k} {int(v*100)}" for k, v in sh.items())
    row["note"] = note[:80]
    rows[i] = row
man = "/home/eta/eta-data/readability/label200-audio/MANIFEST.tsv"
code = hashlib.sha256(open("/home/eta/oc/router-fix/repo/router_server.py", "rb").read()).hexdigest()
json.dump({"schema": 1, "run_id": RUN, "code_sha256": code, "clips_sha256": "d3bd5a8e2e4686980396ec56d1ed1b4c81e470261061ad25e0d1bac893ff4897", "rows": rows},
          open(f"{D}/clarity_fixed.json", "w"), indent=1)
for name, d in (("old", old), ("new", new)):
    with open(f"{D}/route_{name}.jsonl", "w") as f:
        for i, r in sorted(d.items()):
            if "error" in r:
                continue
            tag, sh, eng = summ(r)
            f.write(json.dumps({"id": i, "route_lang": "none" if tag == "und" else tag, "shares": sh, "engine": eng}) + "\n")
for fn in os.listdir(D):
    os.chmod(f"{D}/{fn}", 0o640)
print(len(rows), "rows in clarity_fixed.json;", D)
