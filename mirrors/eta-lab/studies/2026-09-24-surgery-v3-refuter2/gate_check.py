#!/usr/bin/env python3
"""Surgery v3 selection-gate LEAKAGE check (eta-refuter-2, orders/SURGERY-REVIEW-V3.md). Prints counts and ids only.
usage: gate_check.py <gate_report.json>
The report must carry: items[] each with token_uid (and ideally individual_uid, called_at/start, completed_at/end),
wording_sha (the frozen Jev v3 wording), judge (who decided "real surgical conversation"), and the gate share.
Reference (NOT in git): ~/eta-data/refuter2/v-labelled-23.json = V's 18 distinct labelled consults (the "23 labels").
Checks: (1) token overlap with the labelled set = leakage; (2) time overlap with a labelled consult's span = review;
(3) same patient as a labelled consult = reported separately (a different consult, correlated, not leakage);
(4) presence of wording_sha and judge, and a judge that isn't the selection prompt itself."""
import json, os, sys
from datetime import datetime

def ts(s):
    return datetime.fromisoformat(str(s).replace("Z", "+00:00")) if s else None

ref = json.load(open(os.path.expanduser("~/eta-data/refuter2/v-labelled-23.json")))
lab = ref["labelled"]; lab_tok = {x["token_uid"] for x in lab}; lab_pat = {x["individual_uid"] for x in lab if x["individual_uid"]}
rep = json.load(open(sys.argv[1]))
items = rep.get("items", rep if isinstance(rep, list) else [])
items = [{"token_uid": i} if isinstance(i, str) else i for i in items]
tok_hits = [i["token_uid"] for i in items if i.get("token_uid") in lab_tok]
pat_hits = [i["token_uid"] for i in items if i.get("individual_uid") in lab_pat]
time_hits = []
for i in items:
    a, b = ts(i.get("called_at") or i.get("start")), ts(i.get("completed_at") or i.get("end"))
    if not (a and b): continue
    for x in lab:
        c, d = ts(x["called_at"]), ts(x["completed_at"])
        if c and d and a < d and c < b and i.get("token_uid") != x["token_uid"]:
            time_hits.append(i["token_uid"]); break
missing_ids = sum(1 for i in items if not i.get("token_uid"))
print(json.dumps({"items": len(items), "items_without_token_uid": missing_ids,
                  "LEAK_token_overlap_with_labelled": tok_hits,
                  "review_time_overlap_with_a_labelled_consult": time_hits,
                  "same_patient_as_a_labelled_consult(not_leakage)": len(pat_hits),
                  "wording_sha": rep.get("wording_sha"), "judge": rep.get("judge"), "gate_share": rep.get("gate_share"),
                  "items_with_times": sum(1 for i in items if (i.get("called_at") or i.get("start")) and (i.get("completed_at") or i.get("end")))}, indent=1))
