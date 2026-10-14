#!/usr/bin/env python3
"""scan_pool.py — SURGERY-REVIEW-V3: the two-stage Jev scan over the de-identified candidate pool (pool/deid/Q##.json), with the FROZEN wording only.

  * v3.check_frozen() runs first: a changed question or cut REFUSES to score.
  * a de-identified file is refused if finalize.residual_identifiers finds an identifier shape, Indic script or an empty translation: Jev only sees clean text.
  * output pool/scan.json (0600): ids, source, booked procedure name, probabilities and labels. NO text.
"""
import json, os
from collections import Counter
import finalize, build_consult as bc, v3

V3 = os.path.expanduser("~/eta-data/surgery-review-v3")
P = f"{V3}/pool"


def main():
    v3.check_frozen()
    idx = json.load(open(f"{P}/index.json")); res = {}
    for qid, m in sorted(idx.items()):
        meta = {k: m.get(k) for k in ("source", "booked_procedure", "day", "placed_by", "turns")}
        dp = f"{P}/deid/{qid}.json"
        if not os.path.exists(dp):
            res[qid] = {**meta, "status_note": "no_deid_file"}; continue
        doc = json.load(open(dp))
        bad = finalize.residual_identifiers(doc["turns"])
        if bad:
            res[qid] = {**meta, "status_note": f"refused_{len(bad)}_identifier_or_script_hits"}; continue
        sc = v3.scan(bc.state_text(finalize.to_bc_turns(doc)))
        b = sc["b"]
        res[qid] = {**meta, "recall_p": round(sc["recall_p"], 3), "passed": sc["passed"],
                    "status": b["status"] if b else None, "raised_by": b["raised_by"] if b else None, "category": b["category"] if b else None}
    p = f"{P}/scan.json"; json.dump(res, open(p, "w"), indent=1); os.chmod(p, 0o600)
    ok = {k: v for k, v in res.items() if "recall_p" in v}
    print("scanned", len(ok), "of", len(res), "| not scanned:", dict(Counter(v["status_note"] for v in res.values() if "status_note" in v)))
    print("by day:", dict(Counter(v["day"] for v in res.values())), "| by source:", dict(Counter(v["source"] for v in res.values())))
    print("recall_p>=0.5:", sum(v["recall_p"] >= .5 for v in ok.values()), "| passes cut:", sum(v["passed"] for v in ok.values()), "| below cut:", sum(not v["passed"] for v in ok.values()))
    print("status among passing:", dict(Counter(str(v["status"][0] if isinstance(v["status"], (list, tuple)) else v["status"]) for v in ok.values() if v["passed"])))
    for qid, v in sorted(ok.items()):
        print(f"  {qid} {v['day']} {v['source'][:5]} recall={v['recall_p']} st={v['status'] if not isinstance(v['status'], (list, tuple)) else v['status'][0]} "
              f"cat={v['category'] if not isinstance(v['category'], (list, tuple)) else v['category'][0]} booked={(v['booked_procedure'] or '-')[:38]}")


if __name__ == "__main__":
    main()
