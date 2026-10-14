#!/usr/bin/env python3
"""validate_consults.py — check consults/<id>.json against the lane contract (orders/SURGERY-REVIEW-V2-PARALLEL.md). Counts and ids only."""
import json, os, re, sys
OUT = os.path.expanduser("~/eta-data/surgery-review-v2")
Q = {"discussed": {"yes", "no"}, "kind": {"recommendation_now", "history", "referral", "staff_talk", "none"}, "proposer": {"this_doctor", "another_doctor", "patient", "unclear"},
     "firmness": {"suggested", "advised", "strongly_advised", "scheduled", "not_applicable"}, "patient_response": {"agreed", "will_think", "declined", "not_stated"},
     "cost": {"yes", "no"}, "second_opinion": {"yes", "no"}, "procedure": None}
LEAK = re.compile(r"(?<!\d)\d{10,}(?!\d)|@[\w-]+\.\w|\b[A-Za-z]{4}-\d{3,6}\b")
bad = []
for f in sorted(os.listdir(f"{OUT}/consults")):
    if not f.endswith(".json"):
        continue
    d = json.load(open(f"{OUT}/consults/{f}")); pid = f[:-5]
    def chk(ok, msg):
        if not ok: bad.append(f"{pid}: {msg}")
    chk(d.get("id") == pid and re.fullmatch(r"P\d\d", pid), "id shape")
    chk(d.get("bucket") in ("lead", "flag", "neither") and d.get("quality") in ("ok", "poor"), "bucket/quality")
    chk(all(k in d for k in ("date", "room", "doctor", "turns", "jev")), "top-level keys")
    chk("token_uid" not in json.dumps(d) and "individual_uid" not in json.dumps(d), "a patient link id leaked into the file")
    idx = [t["i"] for t in d["turns"]]
    chk(idx == list(range(len(idx))), "turn i is not 0..n-1")
    for t in d["turns"]:
        chk(all(k in t for k in ("i", "start_s", "end_s", "speaker", "lang", "orig", "en")), f"turn {t.get('i')} keys")
        chk(t["speaker"] in ("doctor", "other", "A", "B", "C", "D", "E", "F"), f"turn {t['i']} speaker {t['speaker']}")
        chk(not LEAK.search(t["orig"] + " " + t["en"]), f"turn {t['i']} identifier-shaped text")
    n_clips = 0
    for t in d["turns"]:
        for rel in (t.get("audio") or []):
            n_clips += 1
            chk(os.path.exists(f"{OUT}/{rel}") and rel.startswith(f"audio/{pid}/") and rel.endswith(".mp3"), f"turn {t['i']} audio path {rel}")
    ev_turns = {e for a in d["jev"].values() for e in a["evidence"]}
    chk(all((t.get("audio") for t in d["turns"] if t["i"] in ev_turns)) or not ev_turns, "an evidence turn has no audio (allowed only if audio is deferred)")
    valid = set(idx)
    chk(set(d["jev"]) == set(Q), "jev keys")
    for q, a in d["jev"].items():
        chk(set(a) >= {"answer", "conf", "evidence"}, f"{q} fields")
        chk(Q[q] is None or a["answer"] in Q[q], f"{q} answer {a['answer']}")
        chk(0 <= a["conf"] <= 1, f"{q} conf")
        chk(all(e in valid for e in a["evidence"]), f"{q} evidence index outside turns[].i")
    print(pid, f"audio clips {n_clips} |", "OK" if not [b for b in bad if b.startswith(pid)] else "PROBLEMS", "| turns", len(d["turns"]), "| bucket-hidden id:", pid, "| speakers", sorted({t["speaker"] for t in d["turns"]}))
print("\nPROBLEMS:", bad if bad else "none")
