#!/usr/bin/env python3
"""Seed for the Compare Transcripts (A/B) page from indic-mt's rows JSON {"rows":[{id, n, lang, text_A, text_B}]}.

  python3 build_seed.py --rows <indic-mt rows.json> --out <dir> [--expect 106]

Refuses: any field beyond id/n/lang/text_A/text_B (engine, model, version, key, flag, score, timing ...), an empty text, identical A/B outside --identical-controls,
a duplicate id or n, a count of identical-A/B rows different from --identical-controls (default 0; indic-mt's 106-row sheet has 10 on purpose: position-bias controls), an id that carries meaning (only P### style opaque ids are accepted). Writes <out>/seed_docs.json = {"rows":[...]} in
order of n, mode 0600 (dir 0700), box only, never in git. The A-is-old / B-is-new mapping stays in indic-mt's private key."""
import argparse, collections, json, os, re, stat, sys
ap = argparse.ArgumentParser()
ap.add_argument("--rows", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--expect", type=int)
ap.add_argument("--identical-controls", type=int, default=0, help="exact number of rows whose A and B are identical ON PURPOSE (position-bias controls); any other count fails")
a = ap.parse_args()
d = json.load(open(a.rows, encoding="utf-8"))
rows = d["rows"] if isinstance(d, dict) else d
allowed = {"id", "n", "lang", "text_A", "text_B"}
bad, same_ids = [], []
for r in rows:
    if set(r) != allowed:
        bad.append(f"{r.get('id')}: fields {sorted(set(r) ^ allowed)}")
    if not re.fullmatch(r"P\d{3}", str(r.get("id", ""))):
        bad.append(f"{r.get('id')}: id is not opaque P###")
    for k in ("text_A", "text_B"):
        if not isinstance(r.get(k), str) or not r[k].strip():
            bad.append(f"{r.get('id')}: empty {k}")
    if r.get("text_A", "").strip() == r.get("text_B", "").strip():
        same_ids.append(r.get("id"))
if len(same_ids) != a.identical_controls:
    bad.append(f"{len(same_ids)} rows have identical A and B, expected exactly {a.identical_controls} (--identical-controls)")
if len({r.get("id") for r in rows}) != len(rows) or len({r.get("n") for r in rows}) != len(rows):
    bad.append("duplicate id or n")
if a.expect is not None and len(rows) != a.expect:
    bad.append(f"{len(rows)} rows, expected {a.expect}")
if bad:
    sys.exit("FAIL:\n  " + "\n  ".join(sorted(set(bad))[:20]))
rows = sorted(rows, key=lambda r: r["n"])
os.makedirs(a.out, mode=0o700, exist_ok=True)
os.chmod(a.out, 0o700)
p = os.path.join(a.out, "seed_docs.json")
with open(p, "w") as f:
    json.dump({"rows": rows}, f, ensure_ascii=False, indent=1)
os.chmod(p, stat.S_IRUSR | stat.S_IWUSR)
print(f"wrote {len(rows)} rows ({len(same_ids)} identical-A/B controls) to {p}; claimed languages {dict(collections.Counter(r['lang'] for r in rows).most_common())}")
