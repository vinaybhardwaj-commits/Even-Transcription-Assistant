#!/usr/bin/env python3
"""build_stage1_handoff.py — turn the +-10 min HIST window records of the LOCATED stage-1 anchors into fleet's hist-stage1 contract: ~/eta-data/hist-stage1/turns/<item_id>.json.
Input: ~/eta-data/hist-stage1/{items.json,key.json,bounds.json} + the window record h1-<item_id> (found by window_id under ~/eta-data/hist/runs and ~/eta-data/hist-mining/runs; the first ok one wins).
Turn = one router segment: {i, start_s, end_s (seconds since the consult's called_at, so negative before it), speaker, lang, orig, en}. HONEST LIMITS (also written in each file's meta): speaker is 'other' for every turn (the route harness runs NO diarizer);
en == orig (translate=false, the production room path: there is no English field); lang is the router's per-segment tag (noisy: Bengali/Malayalam tags appear in a Kannada-speaking clinic). MINING ONLY (ruling 146): fleet de-identifies on the box, and anything a rater sees is re-transcribed on the production path first.
Writes 0600 into the 0700 dir; refuses to overwrite. Prints counts only.   python3 build_stage1_handoff.py [--selftest]"""
import glob, json, os, sys
from datetime import datetime
HS = os.path.expanduser("~/eta-data/hist-stage1")
KNOWN = {"en", "hi", "kn", "te", "ta", "ml", "mr", "bn"}
iso = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))

def turns_from_record(rec, called_at):
    """Segments -> contract turns; times are seconds since called_at."""
    off = (iso(rec["start"]) - iso(called_at)).total_seconds()
    out = []
    for s in rec.get("segments") or []:
        t = (s.get("text") or "").strip()
        if not t: continue
        lang = (s.get("lang") or "").lower(); lang = lang if lang in KNOWN else "und"
        out.append({"i": len(out), "start_s": round(off + float(s["start_s"]), 2), "end_s": round(off + float(s["end_s"]), 2), "speaker": "other", "lang": lang, "orig": t, "en": t})
    return out

def find_record(window_id):
    for pat in ("~/eta-data/hist/runs/*/*/*/{w}.json", "~/eta-data/hist-mining/runs/*/*/*/{w}.json"):
        for f in sorted(glob.glob(os.path.expanduser(pat.format(w=window_id)))):
            try: r = json.load(open(f))
            except Exception: continue
            if r.get("ok"): return r, f
    return None, None

def main():
    items = {i["item_id"]: i for i in json.load(open(f"{HS}/items.json"))}; B = {b["item_id"]: b for b in json.load(open(f"{HS}/bounds.json"))} if os.path.exists(f"{HS}/bounds.json") else {}
    os.makedirs(f"{HS}/turns", mode=0o700, exist_ok=True); n_ok = n_wait = 0
    for iid, it in sorted(items.items()):
        out = f"{HS}/turns/{iid}.json"
        if os.path.exists(out): print(iid, "already written"); continue
        rec, f = find_record(f"h1-{iid}")
        if not rec: print(iid, "waiting: window record h1-%s not found (or not ok)" % iid); n_wait += 1; continue
        turns = turns_from_record(rec, it["called_at"]); pv = rec.get("provenance") or {}
        doc = {"item_id": iid, "turns": turns, "meta": {"window": {"start": rec["start"], "end": rec["end"], "called_at": it["called_at"], "completed_at": it["completed_at"]},
               "encounter_bounds": B.get(iid), "run_id": pv.get("run_id") or rec.get("run_id"), "producer": pv.get("producer"), "served_by": pv.get("served_by") or rec.get("router"), "stack_id": pv.get("stack_id"), "stack_versions_sha256": pv.get("stack_versions_sha256"), "temperature_fallback": pv.get("temperature_fallback"),      # the PROVENANCE run id: a hist-bulk stamp leaves the record's top-level run_id at the harness default
               "source_record": os.path.relpath(f, os.path.expanduser("~/eta-data")),
               "english_dominant": rec.get("english_dominant"), "dominant_language": rec.get("dominant_language"), "mining_only": True,
               "limits": ["speaker is 'other' on every turn: no diarizer in the route harness", "en == orig: translate=false (production room path), no English field", "lang is the router's per-segment tag and is noisy"]}}
        with open(out, "x") as h: json.dump(doc, h, ensure_ascii=False)
        os.chmod(out, 0o600); n_ok += 1; print(iid, "written:", len(turns), "turns | langs", sorted({t["lang"] for t in turns}))
    print(f"done: {n_ok} written, {n_wait} waiting")

def selftest():
    rec = {"start": "2026-09-10T11:00:00+05:30", "segments": [{"start_s": 5.0, "end_s": 20.0, "lang": "en", "text": " hello "}, {"start_s": 20.0, "end_s": 30.0, "lang": "bn", "text": "x"}, {"start_s": 31.0, "end_s": 32.0, "lang": "kn", "text": "   "}]}
    t = turns_from_record(rec, "2026-09-10T11:10:00+05:30")      # window starts 10 min BEFORE called_at: the first turn is at -600+5
    assert [x["i"] for x in t] == [0, 1] and t[0]["start_s"] == -595.0 and t[0]["end_s"] == -580.0 and t[0]["orig"] == "hello" and t[0]["en"] == "hello" and t[0]["speaker"] == "other", t
    assert t[1]["lang"] == "bn" and turns_from_record({**rec, "segments": [{"start_s": 1, "end_s": 2, "lang": "xx", "text": "y"}]}, "2026-09-10T11:00:00+05:30")[0]["lang"] == "und"
    assert turns_from_record({"start": "2026-09-10T05:30:00Z", "segments": [{"start_s": 0, "end_s": 1, "lang": "en", "text": "z"}]}, "2026-09-10T11:00:00+05:30")[0]["start_s"] == 0.0, "Z and +05:30 timestamps must agree"
    print("selftest OK: times are seconds since called_at (negative before it), empty segments dropped, unknown lang -> und, Z and offset timestamps agree, speaker other, en == orig")

if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
