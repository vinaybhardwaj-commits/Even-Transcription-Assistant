#!/usr/bin/env python3
"""v5_ctstatus_trial.py — eta-refuter-2 #641 (CT02 reads proposed_now): is that Jev answering about ANOTHER procedure in the passage (category 'operation') while the CT is history? Trial of a CT-SPECIFIC status question
next to v5's single 'status' on the six real CT fixtures (surg-deid's fixed CT01..06) and the wider CT02 window. Development only; stage (b) and v5 are NOT changed by this. Prints ids and probabilities."""
import json, os
import u9, build_consult as bc, finalize, v5

CT_STATUS = {"type": "choice", "instructions":
    "Look ONLY at CT scans (plain, or CT angiography) in this conversation and ignore every other procedure. What is the status of the CT scan for this patient? Choose the best single fit.",
    "criteria": {"advised_now": "the doctor advises or orders a CT scan for this patient now (present or near future), even if other things are decided first",
                 "conditional": "a CT scan is advised only IF something happens or does not improve ('if the pain persists', 'if no better in six weeks')",
                 "history": "a CT scan was ALREADY DONE (before this visit) and its report, film or result is discussed; no new CT is advised",
                 "mentioned_only": "a CT scan is only mentioned in general, or as another doctor's plan, or declined as unnecessary",
                 "no_ct": "no CT scan is discussed"}}

def main():
    base = os.path.expanduser("~/eta-data/hist-mining/ct-fixtures"); key = json.load(open(f"{base}/fixtures-key.json"))
    items = [(cid, f"{base}/deid/{cid}.json", key[cid]["label"]) for cid in sorted(key)] + [("CT02-wide", os.path.expanduser("~/eta-data/surgery-review-v3/v5fx2/deid/CT02W12.json"), "history_negative (63 turns)")]
    Q = {"status": v5.B["status"], "category": v5.B["category"], "ct_status": CT_STATUS}
    for cid, path, label in items:
        doc = json.load(open(path)); assert not finalize.residual_identifiers(doc["turns"]); st = bc.state_text(finalize.to_bc_turns(doc)); out = []
        for _ in range(2):
            a = u9.ask(st, Q)["answers"]; c = a["ct_status"]
            out.append(f"ct_status {c['choice']}({round((c.get('probabilities') or {}).get(c['choice'], 0), 2)}) | status {a['status']['choice']} | cat {a['category']['choice']}")
        print(f"{cid:10s} {label:32s} | " + " || ".join(out), flush=True)

if __name__ == "__main__":
    main()
