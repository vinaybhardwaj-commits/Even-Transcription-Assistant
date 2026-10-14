#!/usr/bin/env python3
"""build_stage1b_turns.py — turns files for the Tier A stage-1 items (ruling 271), in fleet's hist-stage1 contract (see build_stage1_handoff.py).
Input: ~/eta-data/hist-stage1b/{items.json,key.json,bounds.json} + the finished Tier A window records of the located room that overlap called_at-10 min .. completed_at+10 min.
turns/<item_id>.json: turns = non-refused router segments overlapping that span, seconds since called_at (negative = before). MINING ONLY (ruling 146). Refuses to overwrite. Counts only on stdout.
    python3 build_stage1b_turns.py"""
import json, os, sys
from datetime import timedelta
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import stage1_tierA as s1
HS = os.path.expanduser("~/eta-data/hist-stage1b"); KNOWN = {"en", "hi", "kn", "te", "ta", "ml", "mr", "bn"}

def build(item, key, bounds, recs):
    called = s1.P(item["called_at"]); lo, hi = called - timedelta(minutes=10), s1.P(item["completed_at"]) + timedelta(minutes=10)
    room = [r for r in recs if r["room_id"] == key["room_id"] and s1.P(r["end"]) > lo and s1.P(r["start"]) < hi]
    room.sort(key=lambda r: r["start"]); turns = []
    for r in room:
        ws = s1.P(r["start"])
        for s in r["segments"]:
            a, b = ws + timedelta(seconds=s["start_s"]), ws + timedelta(seconds=s["end_s"]); t = (s.get("text") or "").strip()
            if not t or s.get("refused") or b <= lo or a >= hi: continue
            lang = (s.get("lang") or "").lower(); lang = lang if lang in KNOWN else "und"
            turns.append({"i": len(turns), "start_s": round((a - called).total_seconds(), 2), "end_s": round((b - called).total_seconds(), 2), "speaker": "other", "lang": lang, "orig": t, "en": t})
    prov = [(r.get("provenance") or {}) for r in room]
    return {"item_id": item["item_id"], "turns": turns, "meta": {"window": {"start": lo.isoformat(), "end": hi.isoformat(), "called_at": item["called_at"], "completed_at": item["completed_at"]}, "encounter_bounds": bounds,
            "source_windows": [r.get("window_id") for r in room], "run_ids": sorted({p.get("run_id") for p in prov if p.get("run_id")}), "producer": "hist-bulk (Tier A)", "stack_id": sorted({p.get("stack_id") for p in prov if p.get("stack_id")}),
            "stack_versions_sha256": sorted({p.get("stack_versions_sha256") for p in prov if p.get("stack_versions_sha256")}), "temperature_fallback": "on (ruling 196)", "english_dominant_windows": [r.get("window_id") for r in room if r.get("english_dominant")],
            "mining_only": True, "limits": ["speaker is 'other' on every turn: no diarizer in the route harness", "en == orig: translate=false (production room path), no English field", "lang is the router's per-segment tag and is noisy",
            "refused segments (english_hallucination_guard etc.) are dropped, as in the production collapse", "the window spans several 15-min Tier A windows; segments are clipped to called-10 min .. done+10 min at segment level"]}}

def main():
    items = json.load(open(f"{HS}/items.json")); key = json.load(open(f"{HS}/key.json")); B = {b["item_id"]: b for b in json.load(open(f"{HS}/bounds.json"))}; recs = s1.records()
    os.makedirs(f"{HS}/turns", mode=0o700, exist_ok=True)
    for it in items:
        out = f"{HS}/turns/{it['item_id']}.json"
        if os.path.exists(out): print(it["item_id"], "already written"); continue
        doc = build(it, key[it["item_id"]], B.get(it["item_id"]), recs)
        with open(out, "x") as h: json.dump(doc, h, ensure_ascii=False)
        os.chmod(out, 0o600); print(it["item_id"], "written:", len(doc["turns"]), "turns from", len(doc["meta"]["source_windows"]), "windows | langs", sorted({t["lang"] for t in doc["turns"]}))

if __name__ == "__main__": main()
