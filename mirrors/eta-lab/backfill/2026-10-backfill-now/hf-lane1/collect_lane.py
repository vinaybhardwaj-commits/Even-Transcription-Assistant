#!/usr/bin/env python3
"""collect_lane.py — HF-1 collector: turn a PULLED out-bucket directory of finished lane-1 jobs (<win_id>.json = {manifest_stub, tracks}) into REB track files via reb.writer.write_track
(write-once: TrackExistsError is a skip, never an overwrite; schema validated by write_track/validate_track; config_hash recomputed and checked).
  collect_lane.py --day 2026-09-28 --src <dir with the pulled <win_id>.json files> --reb-root ~/eta-data/reb          DRY RUN (default): validates and counts, writes nothing
  collect_lane.py ... --write                                                                                       actually writes (only after a later order)
Pulling the bucket is a separate, explicit read: `hf buckets sync hf://buckets/vrbeven/reb-whisper3-<DDmon>-out <src>` (not done here). Blind windows are refused again here (heldout.py pin) and never written.
Only the three lane-1 engines with the lane's OWN hashes (producer fields in the config; the box hashes a2131b2d/c7bd317b/4b67551a are rejected) are accepted; a track with status failed, a wrong hash, a window id/day mismatch or a blind window is rejected and counted. Prints counts only, never text."""
import argparse, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/kit"))
import launch_lane as L
from reb import writer
from reb.validate import validate_track, ValidationError

def collect(day, src, reb_root, write, heldout, union):
    c = {"files": 0, "tracks_ok": 0, "written": 0, "exists_skipped": 0, "blind_refused": 0, "rejected": 0, "rejected_reasons": {}}
    def rej(why): c["rejected"] += 1; c["rejected_reasons"][why] = c["rejected_reasons"].get(why, 0) + 1
    for fn in sorted(os.listdir(src)):
        if not fn.endswith(".json") or fn.startswith("."): continue
        c["files"] += 1
        try: d = json.load(open(f"{src}/{fn}")); stub = d["manifest_stub"]; tracks = d["tracks"]
        except Exception: rej("unreadable_json"); continue
        w = {"win_id": stub.get("window_id", ""), "room": stub.get("room_id", ""), "ist_date": stub.get("ist_date", ""), "start": stub.get("t0_ms") and __import__("datetime").datetime.fromtimestamp(stub["t0_ms"] / 1000, __import__("datetime").timezone.utc).isoformat() or "",
             "end": stub.get("t1_ms") and __import__("datetime").datetime.fromtimestamp(stub["t1_ms"] / 1000, __import__("datetime").timezone.utc).isoformat() or ""}
        if fn != f"{w['win_id']}.json" or w["ist_date"] != day: rej("window_id_or_day_mismatch"); continue
        if L.is_blind(w, heldout, union): c["blind_refused"] += 1; continue
        for eng, t in tracks.items():
            if eng not in L.TRACKS or t.get("config_hash") != L.TRACKS[eng] or t.get("engine") != eng: rej("engine_or_hash_not_lane1"); continue
            if t.get("status") not in ("ok", "empty"): rej("status_" + str(t.get("status"))); continue
            try: validate_track(t)
            except ValidationError: rej("schema"); continue
            c["tracks_ok"] += 1
            if not write: continue
            try: writer.write_track(reb_root, w["ist_date"], w["room"], w["win_id"], t, manifest_stub=stub); c["written"] += 1
            except writer.TrackExistsError: c["exists_skipped"] += 1
            except Exception as e: rej("write_" + type(e).__name__)
    return c

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--day", required=True); ap.add_argument("--src", required=True); ap.add_argument("--reb-root", default=L.REB_DEFAULT); ap.add_argument("--write", action="store_true")
    a = ap.parse_args(); heldout, union, _ = L.load_guard()
    print(json.dumps({"mode": "WRITE" if a.write else "DRY-RUN", **collect(a.day, a.src, a.reb_root, a.write, heldout, union)}, indent=1))
