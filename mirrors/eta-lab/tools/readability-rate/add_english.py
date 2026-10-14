#!/usr/bin/env python3
"""Add the English from 337b translation annotations to an existing readability seed WITHOUT re-sampling: the excerpts stay exactly as in the
pinned seed (same windows, same segments); only `en` is added to lines that have a translation.

  python3 add_english.py --seed ~/eta-data/readability-rate/seed1 --out ~/eta-data/readability-rate/seed2 [--vault ...] [--roots ...] [--report]

Each line is matched to its segment in the window's run record by exact text (index i = position in the record's full segment list, refused
segments included, as the annotation grammar counts them). Translations are read from <vault>/annotations/translation/*/*/*.json (items {k,i,en,q,src_sha256};
k = record key without runs/ and .json). A line with no translation is left without `en` (the page says "No English for this line yet.").
A translation is kept and written as-is whatever its q (ok / garbled source / untranslatable / mt_failed): the rater judges what a reader would see; the non-ok q values are recorded in the key, not on the page.
--report prints coverage only (Indic lines with English / total) and writes nothing. Output is 0700/0600, box only."""
import argparse, glob, hashlib, json, os, stat, sys

INDIC = {"kn", "hi", "ta", "ml", "bn", "gu", "te", "mr", "pa", "or", "as", "ur"}
DEFAULT_ROOTS = ["~/eta-data/hist-mining", "~/eta-data/hist", "~/eta-data/lab-vault/staged"]

ap = argparse.ArgumentParser()
ap.add_argument("--seed", required=True)
ap.add_argument("--out")
ap.add_argument("--vault", default="~/eta-data/lab-vault/staged")
ap.add_argument("--roots", nargs="+", default=DEFAULT_ROOTS)
ap.add_argument("--report", action="store_true")
a = ap.parse_args()
vault = os.path.expanduser(a.vault)
roots = [os.path.expanduser(r) for r in a.roots]
docs = json.load(open(os.path.join(a.seed, "seed_docs.json")))["excerpts"]
key = json.load(open(os.path.join(a.seed, "key.json")))

tr = {}  # (k, i) -> (en, q, src_sha256)
for f in glob.glob(os.path.join(vault, "annotations", "translation", "*", "*", "*.json")):
    d = json.load(open(f))
    for it in d.get("items", []):
        if isinstance(it.get("en"), str) and it["en"].strip():
            tr[(it["k"], it["i"])] = (it["en"].strip(), it.get("q"), it.get("src_sha256"))

def record(run_key):
    for r in roots:
        p = os.path.join(r, run_key)
        if os.path.exists(p):
            return json.load(open(p))
    return None

tot = have = 0
qn = 0
out_docs, out_key = [], {}
for d in docs:
    k = key[d["id"]]
    rec = record(k["run_key"])
    if rec is None:
        sys.exit(f"{d['id']}: record not found")
    segs = rec.get("segments")
    if segs is None:
        segs = (rec.get("payload") or {}).get("segments") or []
    kk = k["run_key"][len("runs/"):-len(".json")]
    idx, used = {}, set()
    lines, qs = [], []
    for ln in d["lines"]:
        i = next((j for j, s in enumerate(segs) if j not in used and (s.get("text") or "").strip() == ln["text"]), None)
        if i is None:
            sys.exit(f"{d['id']}: a line does not match its record (record changed?)")
        used.add(i)
        new = dict(ln)
        new.pop("en", None)
        if ln["lang"] in INDIC:
            tot += 1
            t = tr.get((kk, i))
            if t:
                new["en"] = t[0]
                have += 1
                if t[1] and t[1] != "ok":  # q is "ok" or a flag (garbled source, untranslatable, mt_failed)
                    qn += 1
                qs.append({"i": i, "q": t[1]})
        lines.append(new)
    out_docs.append({"id": d["id"], "lines": lines})
    nk = dict(k)
    nk["has_en"] = any(l.get("en") for l in lines)
    nk["translation_q"] = [x for x in qs if x["q"] and x["q"] != "ok"]
    out_key[d["id"]] = nk
print(f"{len(docs)} excerpts; Indic lines {tot}; with English {have}; with a machine-translation quality flag {qn}; excerpts with any English {sum(k['has_en'] for k in out_key.values())}")
if a.report or not a.out:
    sys.exit(0)
os.makedirs(a.out, mode=0o700, exist_ok=True)
os.chmod(a.out, 0o700)
for name, obj in (("seed_docs.json", {"excerpts": out_docs}), ("key.json", out_key)):
    p = os.path.join(a.out, name)
    with open(p, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)
print("wrote", a.out)
