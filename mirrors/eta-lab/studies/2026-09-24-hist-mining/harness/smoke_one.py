#!/usr/bin/env python3
"""smoke_one.py — first real window through the harness (one job, one router). Prints counts/flags only; the record (with text) is written 0600 to ~/eta-data/hist-mining/results/."""
import json, os, sys
from datetime import datetime, timedelta
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-surgery-review-v2"))
import run_window, lexicon
HM = os.path.expanduser("~/eta-data/hist-mining"); PAD = timedelta(minutes=3)
iso = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
S = json.load(open(f"{HM}/shortlist.json")); Q = {q["token_uid"]: q for q in json.load(open(f"{HM}/queue.json"))}
new = [t for t, v in S.items() if v["day"] <= "2026-09-17" and v["shortlist"]]
tok = min(new, key=lambda t: (iso(Q[t]["done"]) - iso(Q[t]["called"])).total_seconds())      # the shortest consult first
q, room = Q[tok], S[tok]["shortlist"][0]
start, end = iso(q["called"]) - PAD, iso(q["done"]) + PAD
ch = [c for c in q["chunks"] if c["room_id"] == room]
wid = "smoke-" + tok[:8]
rec = run_window.run_window(ch, start, end, sys.argv[1] if len(sys.argv) > 1 else ":30100", f"{HM}/results/{wid}.json", wid, room_id=room)
terms = lexicon.terms_for(q["booked_procedure"]); hits = lexicon.hits((rec["transcript_native_collapsed"] or "").lower(), terms)
print(json.dumps({"window": wid, "day": q["day"], "booked": q["booked_procedure"], "audio_s": rec.get("cut", {}).get("duration_s"), "cover": rec.get("cut", {}).get("covered_fraction"), "ok": rec["ok"], "error": rec["error"],
                  "wall_s": rec.get("wall_s"), "chars": len(rec["transcript_native"] or ""), "dominant": rec["dominant_language"], "english_dominant": rec["english_dominant"], "english_span_share": rec["english_span_share"],
                  "collapsed_units": rec["assembled_collapse"]["units_collapsed"], "booked_terms_heard": sorted(hits) if hits else []}))
