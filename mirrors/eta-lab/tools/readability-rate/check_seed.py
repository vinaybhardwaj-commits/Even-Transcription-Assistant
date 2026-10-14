#!/usr/bin/env python3
"""Check a readability seed before Fable publishes it: python3 check_seed.py <seed dir> [--expect 20]
Refuses: an id twice, a doc key other than id/lines, a line key other than t/lang/text/en, an empty or null text,
a time that is not HH:MM:SS, a room/window/run/engine word anywhere in a doc, and a seed/key mismatch. Counts only; never prints text."""
import json, os, re, sys

d = sys.argv[1]
exp = int(sys.argv[sys.argv.index("--expect") + 1]) if "--expect" in sys.argv else None
docs = json.load(open(os.path.join(d, "seed_docs.json")))["excerpts"]
key = json.load(open(os.path.join(d, "key.json")))
bad = []
ids = [x.get("id") for x in docs]
if len(set(ids)) != len(ids):
    bad.append("duplicate ids")
if set(ids) != set(key):
    bad.append("seed ids and key ids differ")
if exp is not None and len(docs) != exp:
    bad.append(f"{len(docs)} docs, expected {exp}")
for x in docs:
    if set(x) != {"id", "lines"}:
        bad.append(f"{x.get('id')}: keys {sorted(x)}")
    if not x["lines"]:
        bad.append(f"{x['id']}: no lines")
    for l in x["lines"]:
        if not set(l) <= {"t", "lang", "text", "en"} or not {"t", "lang", "text"} <= set(l):
            bad.append(f"{x['id']}: line keys {sorted(l)}")
        if not isinstance(l.get("text"), str) or not l["text"].strip():
            bad.append(f"{x['id']}: empty text")
        if not re.fullmatch(r"\d\d:\d\d:\d\d", l.get("t", "")):
            bad.append(f"{x['id']}: time {l.get('t')!r}")
    blob = json.dumps(x, ensure_ascii=False)
    for w in ("room_", "run_id", "window_id", "hist-bulk", "stt-parity", "hist-miner", "bs_"):
        if w in blob:
            bad.append(f"{x['id']}: contains {w!r}")
print(f"{len(docs)} docs, {sum(len(x['lines']) for x in docs)} lines, mostly-Indic {sum(k['indic'] for k in key.values())}, with English {sum(k['has_en'] for k in key.values())}")
if bad:
    print("FAIL:", *sorted(set(bad))[:20], sep="\n  ")
    sys.exit(1)
print("PASS")
