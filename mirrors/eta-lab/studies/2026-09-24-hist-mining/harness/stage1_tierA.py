#!/usr/bin/env python3
"""stage1_tierA.py — ruling 271: HIST-MINING stage 1 on the finished Tier A transcripts (truth-anchored, all rooms, no new transcription).
For each historical anchor that has tape (queue.json, V-labelled tokens already excluded): every ok window record (hist/out, hist/runs, hist-mining/runs, results) whose window overlaps the consult's
called..done +-PAD, in EVERY room; the router segments (not refused) that overlap the span are pooled per room and heard-checked with fleet's lexicon (booked procedure -> specific spoken terms).
Decision per anchor: located (term heard in exactly one room), heard_several_rooms, not_heard (rooms transcribed, no term), no_terms (lexicon has no specific term), no_coverage (no ok record covers the span).
MINING ONLY (ruling 146). Writes ids, rooms, terms and counts (NO text) to ~/eta-data/hist-mining/tierA-stage1/decisions.json (0600).   python3 stage1_tierA.py [PAD_MIN] [--selftest]"""
import glob, json, os, sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta
sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/studies/2026-09-24-surgery-review-v2"))
import lexicon
H = os.path.expanduser("~/eta-data"); HM = f"{H}/hist-mining"; OUT = f"{HM}/tierA-stage1"
P = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))

def records():
    seen = {}
    for pat in (f"{H}/hist/out/*/*.json", f"{H}/hist/runs/*/*/*/*.json", f"{HM}/runs/*/*/*/*.json", f"{HM}/results/*.json"):
        for f in glob.glob(pat):
            if ".attempt" in f: continue
            try: r = json.load(open(f))
            except Exception: continue
            if isinstance(r, dict) and r.get("ok") and r.get("start") and r.get("segments") is not None and r.get("state") != "no_signal":
                seen.setdefault(r.get("window_id") or os.path.basename(f)[:-5], r)
    return list(seen.values())

def span_text(recs, lo, hi):
    """Text of the non-refused segments that overlap [lo, hi], and the number of seconds of segment coverage."""
    parts = []
    for r in recs:
        ws = P(r["start"])
        for s in r["segments"]:
            a, b = ws + timedelta(seconds=s["start_s"]), ws + timedelta(seconds=s["end_s"])
            if b > lo and a < hi and not s.get("refused") and s.get("text"): parts.append(s["text"])
    return " ".join(parts)

def decide(anchor, byroom, terms, pad):
    lo, hi = P(anchor["called"]) - timedelta(minutes=pad), P(anchor["done"]) + timedelta(minutes=pad)
    rooms = {}
    for room, recs in byroom.items():
        cov = [r for r in recs if P(r["end"]) > lo and P(r["start"]) < hi]
        if not cov: continue
        rooms[room] = sorted(lexicon.hits(span_text(cov, lo, hi), terms))
    heard = sorted(r for r, h in rooms.items() if h)
    if not terms: dec = "no_terms"
    elif not rooms: dec = "no_coverage"
    elif len(heard) == 1: dec = "located"
    elif len(heard) > 1: dec = "heard_several_rooms"
    else: dec = "not_heard"
    return dec, {"rooms_transcribed": sorted(rooms), "rooms_heard": heard, "terms_heard": {r: rooms[r] for r in heard}}

def main(pad):
    q = json.load(open(f"{HM}/queue.json")); byroom = defaultdict(list)
    for r in records(): byroom[r["room_id"]].append(r)
    out = []
    for a in q:
        if a["n_chunks"] <= 0: continue
        terms = lexicon.terms_for(a["booked_procedure"]); dec, d = decide(a, {rm: rs for rm, rs in byroom.items() if rm in set(a["rooms"])}, terms, pad)
        out.append({"token_uid": a["token_uid"], "day": a["day"], "called": a["called"], "done": a["done"], "booked_procedure": a["booked_procedure"], "n_terms": len(terms), "tape_rooms": a["rooms"], "decision": dec, **d})
    p = f"{OUT}/decisions.json"; json.dump(out, open(p, "w"), indent=1); os.chmod(p, 0o600)
    print("anchors with tape:", len(out), "| decisions:", dict(Counter(o["decision"] for o in out)), "| pad", pad, "min | ok records", sum(len(v) for v in byroom.values()))

def selftest():
    ws = "2026-09-10T05:00:00+00:00"; r = {"start": ws, "end": "2026-09-10T05:15:00+00:00", "ok": True, "segments": [{"start_s": 0, "end_s": 30, "text": "hernia repair talk"}, {"start_s": 300, "end_s": 330, "text": "hernia", "refused": True}, {"start_s": 600, "end_s": 630, "text": "other"}]}
    a = {"called": "2026-09-10T05:00:00+00:00", "done": "2026-09-10T05:02:00+00:00"}
    assert decide(a, {"room_x": [r], "room_y": [dict(r, segments=[{"start_s": 0, "end_s": 30, "text": "nothing"}])]}, ["hernia"], 0)[0] == "located"
    assert decide(a, {"room_x": [r], "room_y": [r]}, ["hernia"], 0)[0] == "heard_several_rooms"
    assert decide(a, {"room_y": [dict(r, segments=[{"start_s": 0, "end_s": 30, "text": "nothing"}])]}, ["hernia"], 0)[0] == "not_heard"
    assert decide(a, {}, ["hernia"], 0)[0] == "no_coverage" and decide(a, {"room_x": [r]}, [], 0)[0] == "no_terms"
    a2 = dict(a, called="2026-09-10T05:10:00+00:00", done="2026-09-10T05:11:00+00:00")   # only the refused segment (300 s) and the 600 s one overlap: refused text never counts
    assert decide(a2, {"room_x": [r]}, ["hernia"], 0)[0] == "not_heard"
    print("selftest ok")

if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest()
    else: main(int((sys.argv[1:] or ["5"])[0]))
