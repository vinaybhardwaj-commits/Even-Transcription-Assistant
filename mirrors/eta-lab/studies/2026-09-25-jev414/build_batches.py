#!/usr/bin/env python3
"""r414.2 batch builder v2: PAGE SEEDS (what V sees, #2834) + gloss map -> batch files.
NO text printed; outputs to a 0700 dir (never git).
  build_batches.py --set label200 --gloss <json> --out <dir>
Keys = seed ids: label200 L001..L200, ba106 P001..P106, rate20 R01..R20.
Gloss shapes (settle with herdr-kit, both accepted):
  label200 {L###: str}; ba106 {P###: {"A": str, "B": str}} (lab-viewer shape) or [gA,gB];
  rate20 {R##: str} excerpt-grain (preferred) or {R##: [line glosses in NON-EN line
  order]} line-grain — joined with newlines into one excerpt string, same lines the
  page serves. Coverage must be exact; misses abort naming the key.
"""
import argparse, json, os, sys
from jevcfg414 import SETS, BATCH, questions_for, batches

SEEDS = {
    "label200": "/home/eta/eta-data/readability/r1/label-page-seed/seed_docs.json",
    "ba106": "/home/eta/eta-data/pair-label/ba106/seed_docs.json",
    "rate20": "/home/eta/eta-data/readability-rate/seed2/seed_docs.json",
}
EXPECT = {"label200": 200, "ba106": 106, "rate20": 20}


def excerpt_from_lines(lines, g):
    non_en = [l for l in lines if l.get("lang") != "en"]
    if isinstance(g, str):
        return "\n".join(l["text"] for l in non_en), g
    if isinstance(g, list) and len(g) == len(non_en):
        return "\n".join(l["text"] for l in non_en), "\n".join(x for x in g if x)
    sys.exit(f"rate20 gloss shape unusable for {len(non_en)} non-en lines")


def load_items(setname, seed_path, gloss):
    doc = json.load(open(seed_path))
    items = []
    if setname == "label200":
        for r in doc["rows"]:
            k = r["id"]
            if k not in gloss:
                sys.exit(f"label200 gloss miss {k}")
            items.append((k, {"claimed_lang": r["lang"], "text": r["text"],
                              "gloss_en": gloss[k]}))
    elif setname == "ba106":
        for r in doc["rows"]:
            k = r["id"]
            g = gloss.get(k)
            if isinstance(g, dict):
                ga, gb = g["A"], g["B"]
            elif isinstance(g, list) and len(g) == 2:
                ga, gb = g
            else:
                sys.exit(f"ba106 gloss miss or bad shape {k}")
            items.append((k, {"claimed_lang": r["lang"], "text_A": r["text_A"],
                              "text_B": r["text_B"], "gloss_A": ga, "gloss_B": gb}))
    else:
        for e in doc["excerpts"]:
            k = e["id"]
            if k not in gloss:
                sys.exit(f"rate20 gloss miss {k}")
            txt, gl = excerpt_from_lines(e["lines"], gloss[k])
            items.append((k, {"langs": sorted({l["lang"] for l in e["lines"] if l.get("lang") != "en"}),
                              "text": txt, "gloss_en": gl}))
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", required=True, choices=sorted(SETS))
    ap.add_argument("--seed", help="override the frozen seed path (tests only)")
    ap.add_argument("--gloss", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    items = load_items(a.set, a.seed or SEEDS[a.set], json.load(open(a.gloss)))
    if len(items) != EXPECT[a.set]:
        sys.exit(f"{a.set}: {len(items)} items, expected {EXPECT[a.set]}")
    wording = SETS[a.set]
    os.makedirs(a.out, mode=0o700, exist_ok=True)
    keys = [k for k, _ in items]
    for bi, chunk in enumerate(batches(keys, BATCH), 1):
        state = {k: dict(d) for k, d in items if k in chunk}
        doc = {"set": a.set, "batch": bi, "version": wording["version"],
               "seed_sha_hint": None,
               "state": state, "questions": questions_for(wording, chunk)}
        with open(os.path.join(a.out, f"{a.set}_b{bi:02d}.json"), "w", 0o600) as f:
            json.dump(doc, f, ensure_ascii=False, sort_keys=True)
    print(f"{a.set}: {len(items)} items -> {len(batches(keys, BATCH))} batch files")


if __name__ == "__main__":
    main()
