#!/usr/bin/env python3
"""python3 check_seed.py <seed dir> [--expect 200]: doc keys are exactly id/n/lang/dur_s/text, ids and n unique, no empty text,
no window/run word or '#' segment reference in any doc, key covers every doc. Counts only; never prints text."""
import json, os, re, sys
d = sys.argv[1]
exp = int(sys.argv[sys.argv.index("--expect") + 1]) if "--expect" in sys.argv else None
docs = json.load(open(os.path.join(d, "seed_docs.json")))["rows"]
key = json.load(open(os.path.join(d, "key.json")))
bad = []
if exp is not None and len(docs) != exp:
    bad.append(f"{len(docs)} docs, expected {exp}")
if len({x["id"] for x in docs}) != len(docs) or len({x["n"] for x in docs}) != len(docs):
    bad.append("duplicate id or n")
if set(key) != {x["id"] for x in docs}:
    bad.append("key and docs differ")
for x in docs:
    if set(x) != {"id", "n", "lang", "dur_s", "text"}:
        bad.append(f"{x['id']}: keys {sorted(x)}")
    if not x["text"].strip():
        bad.append(f"{x['id']}: empty text")
    if re.search(r"room_|bs_[a-z0-9]{6}|hist-bulk|stt-parity|hist-miner|[a-z0-9]#\d+\b", json.dumps({k: v for k, v in x.items() if k != "text"})):
        bad.append(f"{x['id']}: identifier-like value outside text")
print(f"{len(docs)} docs")
if bad:
    print("FAIL:", *sorted(set(bad))[:20], sep="\n  ")
    sys.exit(1)
print("PASS")
