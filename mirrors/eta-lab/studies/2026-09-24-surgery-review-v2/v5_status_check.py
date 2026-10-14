#!/usr/bin/env python3
"""v5_status_check.py — ruling 172: the new status value `conditional`. Invented consults with the status the rule says (conditional / proposed_now / mentioned_only / history), then the six real CT fixtures. 2 runs each. Development only."""
import json, os
import u9, build_consult as bc, finalize, v5
from v5_synthetic import consult

FX = {
 "conditional_ct": ("conditional", ["The pain has settled a bit.", "Yes, much better with the tablets.", "If the pain persists after six weeks, we will do a CT scan.", "Okay.", "Otherwise no scan is needed. Come back in six weeks."]),
 "conditional_operation": ("conditional", ["How is the knee?", "The tablets help a little.", "Continue the exercises. If it does not improve in three months, we will plan a knee arthroscopy.", "Alright.", "Come back then."]),
 "conditional_injection": ("conditional", ["The shoulder is painful again.", "Yes, at night.", "Take the tablets for now. If it comes back next month I will give you a steroid injection into the joint.", "Fine.", "See me then."]),
 "proposed_now_ct": ("proposed_now", ["The cough has been there six weeks.", "Yes.", "I want a CT scan of the chest, please do it this week.", "Okay, tomorrow."]),
 "proposed_now_operation": ("proposed_now", ["The hernia is bigger now.", "Yes, it hurts.", "You need a hernia repair, I will book you for Thursday.", "Alright."]),
 "mentioned_only_ct": ("mentioned_only", ["What tests do people usually do for this?", "Sometimes a CT scan is used in such patients, in general.", "But that is not for you.", "I see."]),
 "history_ct": ("history", ["You had a CT scan last month.", "Yes here is the report.", "It is normal.", "So nothing more?", "Nothing more is needed."]),
 "history_operation": ("history", ["You had the gallbladder surgery two years ago.", "Yes.", "The scar has healed well.", "Good."]),
}
def main():
    for name, (exp, lines) in FX.items():
        st = consult(lines); r = []
        for _ in range(2):
            a = u9.ask(st, {"status": v5.B["status"]})["answers"]["status"]; r.append(a["choice"])
        print(f"{name:24s} expect {exp:14s} | v5 status {r} {'ok' if all(x == exp for x in r) else 'MISS'}", flush=True)
    base = os.path.expanduser("~/eta-data/hist-mining/ct-fixtures"); key = json.load(open(f"{base}/fixtures-key.json"))
    for cid in sorted(key):
        doc = json.load(open(f"{base}/deid/{cid}.json")); assert not finalize.residual_identifiers(doc["turns"])
        st = bc.state_text(finalize.to_bc_turns(doc)); r = []
        for _ in range(2):
            a = u9.ask(st, {"status": v5.B["status"]})["answers"]["status"]; r.append((a["choice"], round((a.get("probabilities") or {}).get(a["choice"], 0), 2)))
        print(f"{cid} {key[cid]['label']:22s} | v5 status {r}", flush=True)
if __name__ == "__main__":
    main()
