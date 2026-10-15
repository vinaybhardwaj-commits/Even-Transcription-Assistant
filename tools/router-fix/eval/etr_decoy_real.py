#!/usr/bin/env python3
"""ETR decoy SWEEP on REAL audio texts (lid-debug #4539): unlike etr_decoy.py (which excludes each
clinical1 dialogue's own genuinely-spoken values from a truth.json), real label200 clips have no
clinical_items schema. Every value 1-1000 that anchors here is, by construction, evidence of the
mechanism's false-anchor RATE on ordinary real speech (which has plenty of "one/two/ten"-like words) --
there is no ground truth to net out a "real" match against.
Patient-derived text: run locally, keep counts only, delete raw output after reporting (COMMON rule).
usage: etr_decoy_real.py IDS_JSON SRAVAANI_JSONL
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/..")
import router_server as rs  # noqa: E402

IDS_JSON, SRAVAANI = sys.argv[1], sys.argv[2]
ids = set(json.load(open(IDS_JSON))["ids"])
sra = {}
for l in open(SRAVAANI):
    d = json.loads(l)
    if d["id"] in ids:
        sra[d["id"]] = d.get("text", "")


def band(v):
    return "1-10" if v <= 10 else ("11-99" if v <= 99 else "100+")


def main():
    band_checks = {"1-10": 0, "11-99": 0, "100+": 0}
    band_false = {"1-10": 0, "11-99": 0, "100+": 0}
    false_list = []
    for cid, text in sra.items():
        if not text:
            continue
        for v in range(1, 1001):
            for kind in ("dose", "follow_up"):
                band_checks[band(v)] += 1
                span = rs.find_value_anchor(text, v, kind=kind)
                if span is not None:
                    band_false[band(v)] += 1
                    false_list.append({"id": cid, "value": v, "kind": kind})  # id only, no text
    print(f"real clips with text checked: {sum(1 for t in sra.values() if t)}")
    for b in ("1-10", "11-99", "100+"):
        print(f"  band {b}: {band_false[b]}/{band_checks[b]} false anchors")
    for fa in false_list[:50]:
        print(" ", fa)
    return sum(band_false.values())


if __name__ == "__main__":
    sys.exit(1 if main() else 0)
