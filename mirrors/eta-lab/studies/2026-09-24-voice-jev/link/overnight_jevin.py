#!/usr/bin/env python3
"""vj-link overnight step 2 (voice-lab-1): for every Jev target link, the consults of the proposed doctor (PQM, member room-days) and the voice's core turn indices inside them. Indices only, no text.
Out: ~/vj/link/overnight/jev_in.json = [{gid, doctor_uid, doctor_name, consults:[{rd, token_uid, called_ms, completed_ms, turn_idx}]}]"""
import csv, json, os, sys
from datetime import datetime
H = os.path.expanduser("~/vj/link"); ms = lambda ts: int(datetime.fromisoformat(ts).timestamp() * 1000)
targets = json.load(open(f"{H}/overnight/jev_targets.json")); out = []
for t in targets:
    cons, name = [], None
    for rd, c in t["members"]:
        L = json.load(open(f"{H}/link-{rd}.json")); T = json.load(open(f"{H}/turns-{rd}.json")); date = L["date"]; core = L["core_turn_idx"][str(c)]
        for r in csv.DictReader(open(f"{H}/pqm-{date}.csv")):
            if r["doctor_uid"] != t["doctor_uid"] or not r["called_at"] or not r["completed_at"]: continue
            name = name or r["doctor_name"]; a, b = ms(r["called_at"]), ms(r["completed_at"])
            ti = [i for i in core if a - 30_000 <= int(T["turns"][i]["s_ms"]) <= b + 30_000]
            if len(ti) >= 2: cons.append({"rd": rd, "token_uid": r["token_uid"], "called_ms": a, "completed_ms": b, "turn_idx": ti})
    out.append({"gid": t["gid"], "doctor_uid": t["doctor_uid"], "doctor_name": name, "consults": cons})
json.dump(out, open(f"{H}/overnight/jev_in.json", "w"))
print("jev_in", len(out), "links,", sum(len(x["consults"]) for x in out), "consults")
