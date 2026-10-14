#!/usr/bin/env python3
"""Seed for the Segment Label page (ruling 337c, the 200-row blind label sample) from split-speaker's blind sheet.

  python3 build_seed.py --sheet ~/eta-data/readability/r1/sample200_sheet_v2.tsv --out ~/eta-data/readability/r1/label-page-seed [--expect 200]

The sheet (columns n, id, lang, start_s, end_s, text, label) is already shuffled and carries no engine/flag/score.
Docs written to <out>/seed_docs.json = {"rows":[{id:"L001", n, lang, dur_s, text}]}: the window id / segment index (`id` column)
never enters a doc; <out>/key.json (0600) maps each doc id to it so the labels can be joined to split-speaker's private key
off the page. Docs go in the order of n; the page shows them in that order. Mode 0700/0600, box only, never in git."""
import argparse, csv, json, os, stat, sys

ap = argparse.ArgumentParser()
ap.add_argument("--sheet", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--expect", type=int, default=200)
a = ap.parse_args()
csv.field_size_limit(10**7)
rows = list(csv.DictReader(open(a.sheet, encoding="utf-8", newline=""), delimiter="\t", quoting=csv.QUOTE_NONE))
need = {"n", "id", "lang", "start_s", "end_s", "text"}
if not rows or not need <= set(rows[0]):
    sys.exit("sheet columns missing: need " + ",".join(sorted(need)))
if len(rows) != a.expect:
    sys.exit(f"{len(rows)} rows, expected {a.expect}")
docs, key = [], {}
for r in rows:
    n = int(r["n"])
    text = (r["text"] or "").strip()
    if not text:
        sys.exit(f"row {n}: empty text")
    did = f"L{n:03d}"
    dur = round(max(0.0, float(r["end_s"]) - float(r["start_s"])), 1)
    docs.append({"id": did, "n": n, "lang": r["lang"] or "und", "dur_s": dur, "text": text})
    key[did] = r["id"]
if len({d["n"] for d in docs}) != len(docs):
    sys.exit("duplicate n")
os.makedirs(a.out, mode=0o700, exist_ok=True)
os.chmod(a.out, 0o700)
for name, obj in (("seed_docs.json", {"rows": docs}), ("key.json", key)):
    p = os.path.join(a.out, name)
    with open(p, "w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)
import collections
print(f"wrote {len(docs)} rows to {a.out}; claimed languages {dict(collections.Counter(d['lang'] for d in docs).most_common())}")
