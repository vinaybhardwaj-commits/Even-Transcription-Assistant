#!/usr/bin/env python3
"""v5_fixtures.py — eta-refuter-2 #607: v5 draft answers on REAL CT fixtures from hist-miner's v2 plain-CT sample (de-identified by deid_gpu first; no speaker labels exist in the sample, so every
turn is 'Other'). Per fixture, 2 runs: named / described (noul) + status / raised_by / category (v5.B). Prints ids, probabilities and choices only. Development trial, no freeze."""
import json, os, sys
import u9, build_consult as bc, finalize, v5

V3 = os.path.expanduser("~/eta-data/surgery-review-v3")
EXPECT = {"F02": "positive: CT advised now (proposed_now)", "F11": "positive: CONDITIONAL plain CT (proposed / conditional)", "F06": "history negative", "F07": "history negative", "F10": "history negative", "F15": "history negative"}


def main_ct():
    """Same trial on surg-deid's FIXED de-identification of hist-miner's staged files (CT01..CT06; tool fix for a capitalised-phrase false positive). CT04 (= pool #11) has its named
    procedure word redacted (an ASR garble read as a name): reported SEPARATELY and excluded from the bar (eta-refuter-2 #633)."""
    key = json.load(open(os.path.expanduser("~/eta-data/hist-mining/ct-fixtures/fixtures-key.json")))
    Q = {"named": v5.A["named"], "described": v5.A["described"], **v5.B}
    for cid in sorted(key):
        doc = json.load(open(os.path.expanduser(f"~/eta-data/hist-mining/ct-fixtures/deid/{cid}.json")))
        assert not finalize.residual_identifiers(doc["turns"]), cid
        st = bc.state_text(finalize.to_bc_turns(doc)); runs = []
        for _ in range(2):
            a = u9.ask(st, Q)["answers"]
            runs.append((round(a["named"]["noul"], 2), round(a["described"]["noul"], 2), a["status"]["choice"], round((a["status"].get("probabilities") or {}).get(a["status"]["choice"], 0), 2), a["category"]["choice"]))
        print(cid, "pool", key[cid]["pool_n"], key[cid]["label"], "| " + " || ".join(f"named {r[0]} desc {r[1]} status {r[2]}({r[3]}) cat {r[4]}" for r in runs), flush=True)


def main():
    Q = {"named": v5.A["named"], "described": v5.A["described"], **v5.B}
    for fid in ("F02", "F11", "F06", "F07", "F10", "F15"):
        doc = json.load(open(f"{V3}/v5fx/deid/{fid}.json"))
        assert not finalize.residual_identifiers(doc["turns"]), fid
        st = bc.state_text(finalize.to_bc_turns(doc)); runs = []
        for _ in range(2):
            a = u9.ask(st, Q)["answers"]
            runs.append({"named": round(a["named"]["noul"], 2), "described": round(a["described"]["noul"], 2),
                         "status": (a["status"]["choice"], round((a["status"].get("probabilities") or {}).get(a["status"]["choice"], a["status"].get("confidence") or 0), 2)),
                         "raised_by": a["raised_by"]["choice"], "category": a["category"]["choice"]})
        print(fid, EXPECT[fid], "|", " || ".join(f"run{i+1}: named {r['named']} desc {r['described']} status {r['status'][0]}({r['status'][1]}) by {r['raised_by']} cat {r['category']}" for i, r in enumerate(runs)), flush=True)


if __name__ == "__main__":
    main_ct() if sys.argv[1:] == ["ct"] else main()
