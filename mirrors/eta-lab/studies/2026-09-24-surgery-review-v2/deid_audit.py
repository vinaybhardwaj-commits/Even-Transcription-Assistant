#!/usr/bin/env python3
"""deid_audit.py — measure the de-identification on the REAL pilot (ruling 43). Counts and WORDS only; no turn text is printed.
  handcheck : the 30 hand-checked turns (labels in ~/eta-data/deid/handcheck-30-labels.json): turns changed, tags fired, doctors kept, uncertain removed,
              places wrongly removed.
  survivors : across ALL de-identified turns, the capitalised mid-sentence words that survived (unique words + counts) for a hand review of missed names.
  tags      : per consult tag counts (from the [TAG] markers in the de-identified files).
"""
import json, os, re, sys
from collections import Counter

OUT = os.path.expanduser("~/eta-data/surgery-review-v2")
LAB = os.path.expanduser("~/eta-data/deid/handcheck-30-labels.json")
TAG = re.compile(r"\[(PATIENT_NAME|PHONE|ID|ADDRESS|DOB|EMAIL|AGE)\]")
STOP = set("i i'm i'll i've i'd okay ok yes no so and but the a an we you he she it they this that these those there here what when where why how who which then now well just also my your his her our their mr mrs ms dr doctor sir madam".split())


def load(kind, pid):
    return json.load(open(f"{OUT}/{kind}/{pid}.json"))


def handcheck():
    labels = json.load(open(LAB)); changed = 0; fired = Counter(); dk = du = pw = miss_id = 0; n_doc = n_unc = n_pl = 0
    for key, lab in labels.items():
        pid, i = key.split("#"); i = int(i)
        raw, de = load("staging", pid)["turns"][i], load("deid", pid)["turns"][i]
        if raw["en"] != de["en"] or raw["orig"] != de["orig"]:
            changed += 1
        fired.update(TAG.findall(de["en"]))
        for w in lab["identifiers"]:
            miss_id += w in de["en"]
        for w in lab["doctors"]:
            n_doc += 1; dk += w in de["en"]
        for w in lab["uncertain"]:
            n_unc += 1; du += w not in de["en"]
        for w in lab["places"]:
            n_pl += 1; pw += w not in de["en"]
    print(f"30 hand-checked turns | changed by de-id: {changed} | tags in output: {dict(fired)}")
    print(f"clear identifiers still present: {miss_id} (of {sum(len(v['identifiers']) for v in labels.values())} labelled) | doctor mentions kept: {dk}/{n_doc} "
          f"| uncertain name removed: {du}/{n_unc} | places wrongly removed: {pw}/{n_pl}")


def survivors():
    c = Counter(); n_turns = 0
    for f in sorted(os.listdir(f"{OUT}/deid")):
        if not f.endswith(".json"):
            continue
        for t in json.load(open(f"{OUT}/deid/{f}"))["turns"]:
            n_turns += 1
            toks = re.findall(r"[A-Za-z][A-Za-z'\-]+", TAG.sub(" ", t["en"]))
            for k, w in enumerate(toks):
                if k > 0 and w[0].isupper() and w.lower() not in STOP and len(w) > 2:
                    c[w] += 1
    print(f"turns audited: {n_turns} | distinct surviving capitalised mid-sentence words: {len(c)}")
    print(sorted(c.items(), key=lambda x: (-x[1], x[0])))


def tags():
    for f in sorted(os.listdir(f"{OUT}/deid")):
        if f.endswith(".json"):
            d = json.load(open(f"{OUT}/deid/{f}"))
            raw = json.load(open(f"{OUT}/staging/{f}"))
            ch = sum(1 for a, b in zip(raw["turns"], d["turns"]) if a["en"] != b["en"])
            print(f[:-5], "turns", len(d["turns"]), "| changed", ch, "| tags", dict(Counter(TAG.findall(" ".join(t["en"] for t in d["turns"])))))


if __name__ == "__main__":
    {"handcheck": handcheck, "survivors": survivors, "tags": tags}[sys.argv[1]]()
