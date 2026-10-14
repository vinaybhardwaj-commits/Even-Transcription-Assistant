#!/usr/bin/env python3
"""v5_gate_trial.py — eta-refuter-2 #652: CT02 is clinician-to-clinician case talk about an ABSENT patient, not a consult. Trial of a GATE question (stage a0: is a doctor talking WITH a present patient / family?) so pre-op
handovers and staff case talk are not counted as proposals. Items: the 12 shipped consults (real consults: expected yes; REGRESSION CHECK only, leakage rule cc237d6), known staff case talk (W90, W76, Q19: eta-refuter-2 judged them
'neither / not a single consult: staff talk'; CT02 + its wide window), the CT fixtures (CT05 is a consult). 2 runs each. Development only."""
import json, os
import u9, build_consult as bc, finalize

V3 = os.path.expanduser("~/eta-data/surgery-review-v3")
GATE = {"type": "noul", "instructions":
    "Is this a consultation in which a doctor is talking WITH a patient (or the patient's family or attender) who is present in the room, about that patient's own problem? "
    "Answer NO if it is clinicians or staff talking among themselves about a patient who is not present (a case presentation, a pre-operative or ward handover, a discussion of a booking or theatre list, staff chat) "
    "even if it mentions operations, tests or scans."}

def state(path):
    doc = json.load(open(path)); inn = [t for t in doc["turns"] if "phase" not in t]
    assert not finalize.residual_identifiers(inn), path
    return bc.state_text(finalize.to_bc_turns({"turns": inn}))

def main():
    key = json.load(open(f"{V3}/ship-key.json")); items = []
    for n, k in sorted(key.items()):
        items.append((n, f"{V3}/{k['dir']}/deid/{k['working_id']}.json", "yes (real consult, regression check)"))
    for q, d in (("W90", "final-wide"), ("W76", "final-wide"), ("Q19", "final-cand")):
        items.append((f"staff-{q}", f"{V3}/{d}/deid/{q}.json", "no (staff case talk, judged by eta-refuter-2)"))
    base = os.path.expanduser("~/eta-data/hist-mining/ct-fixtures"); ck = json.load(open(f"{base}/fixtures-key.json"))
    for cid in sorted(ck):
        items.append((cid, f"{base}/deid/{cid}.json", "no (staff case talk)" if cid == "CT02" else "unknown (excerpt)"))
    items.append(("CT02-wide", f"{V3}/v5fx2/deid/CT02W12.json", "no (staff case talk)"))
    rows = []
    for nid, path, exp in items:
        st = state(path); r = [u9.ask(st, {"gate": GATE})["answers"]["gate"]["noul"] for _ in range(2)]
        rows.append((nid, exp, round(sum(r) / 2, 2), round(max(r) - min(r), 2))); print(f"{nid:11s} expect {exp:44s} | present-patient P(yes) {rows[-1][2]:.2f} (noise {rows[-1][3]:.2f})", flush=True)

if __name__ == "__main__":
    main()
