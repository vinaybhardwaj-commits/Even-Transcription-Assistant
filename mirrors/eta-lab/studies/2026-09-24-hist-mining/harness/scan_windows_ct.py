#!/usr/bin/env python3
"""scan_windows_ct.py — plain-CT post-pass over HIST window records (ruling 164; no engine load). Input dirs of record JSONs written by run_window (default: my stage-1 results/ and hist-bulk's ~/eta-data/hist/out/*/).
Runs ct_cues.scan on transcript_native_collapsed. Writes ids + flags + cue KINDS (NO text) to ~/eta-data/hist-mining/ct_windows.json (0600). Records are MINING ONLY: a hit here is a CANDIDATE that still needs the Jev status stage and,
before anything reaches a rater or a label, a re-transcription on the production room path (ruling 146). English-dominant windows (the known parity miss) are flagged so recall on them is read with care.
  python3 scan_windows_ct.py [dir ...]     |     python3 scan_windows_ct.py --selftest"""
import glob, json, os, sys, tempfile
from collections import Counter
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import ct_cues
HM = os.path.expanduser("~/eta-data/hist-mining")

def scan_dirs(dirs):
    rows = []; seen = set()
    for d in dirs:
        for f in sorted(glob.glob(os.path.join(d, "*.json"))):
            try: rec = json.load(open(f))
            except Exception: continue
            if not isinstance(rec, dict) or "transcript_native_collapsed" not in rec: continue
            s = ct_cues.scan(rec.get("transcript_native_collapsed") or "")
            cat = "candidate" if s["candidate"] else "history_only" if s["plain_ct"] else "weak_scan" if s["weak_scan"] else "angio_only" if s["ct_angio"] else None
            if ".attempt" in f or (rec.get("window_id") or "") in seen: continue
            seen.add(rec.get("window_id") or os.path.basename(f)[:-5])
            rows.append({"window_id": rec.get("window_id") or os.path.basename(f)[:-5], "ok": bool(rec.get("ok")), "english_dominant": rec.get("english_dominant"), "cat": cat,
                         "hint": s["proposal_hint"], "declined_cue": s["declined_cue"], "angio": s["ct_angio"], "contrast": s["contrast_mentioned"], "kinds": sorted({h["kind"] for h in s["hits"]})})
    return rows

def main(dirs):
    rows = scan_dirs(dirs)
    json.dump(rows, open(f"{HM}/ct_windows.json", "w"), indent=1); os.chmod(f"{HM}/ct_windows.json", 0o600)
    ok = [r for r in rows if r["ok"]]
    print(json.dumps({"windows": len(rows), "ok": len(ok), "by_category": dict(Counter(r["cat"] for r in ok if r["cat"])), "candidates_english_dominant": sum(1 for r in ok if r["cat"] == "candidate" and r["english_dominant"]),
                      "contrast_flagged": sum(1 for r in ok if r["contrast"])}))

def selftest():
    with tempfile.TemporaryDirectory() as d:
        for n, t in (("a", "we will do a ct scan of your head tomorrow"), ("b", "the ct scan was done last week and the report was normal"), ("c", "take the tablet after food"), ("d", "get a scan of the abdomen done")):
            json.dump({"window_id": n, "ok": True, "english_dominant": True, "transcript_native_collapsed": t}, open(f"{d}/{n}.json", "w"))
        json.dump({"window_id": "e", "ok": False, "transcript_native_collapsed": ""}, open(f"{d}/e.json", "w")); json.dump({"not": "a record"}, open(f"{d}/f.json", "w"))
        r = {x["window_id"]: x for x in scan_dirs([d])}
        assert r["a"]["cat"] == "candidate" and r["b"]["cat"] == "history_only" and r["c"]["cat"] is None and r["d"]["cat"] == "weak_scan" and "f" not in r and r["e"]["ok"] is False, r
    print("selftest OK: candidate / history_only / none / weak_scan, failed window kept but not counted, non-record files skipped")

if __name__ == "__main__":
    if "--selftest" in sys.argv: selftest()
    else: main(sys.argv[1:] or [f"{HM}/results"] + sorted(glob.glob(os.path.expanduser("~/eta-data/hist/out/*/"))) + sorted(glob.glob(os.path.expanduser("~/eta-data/hist/runs/*/*/*/"))) + sorted(glob.glob(os.path.expanduser("~/eta-data/hist-mining/runs/*/*/*/"))))      # old layouts + the vault layout (runs/<run>/<room>/<date>/)
