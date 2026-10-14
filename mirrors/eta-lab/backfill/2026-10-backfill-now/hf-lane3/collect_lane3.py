#!/usr/bin/env python3
"""collect_lane3.py — HF-3 collector (BOX side): turn lane-3 job outputs pulled from HF-1 (<src>/indic/<win>.json and <src>/sravaani/<win>.json) into REB track files via reb.writer.write_track (write-once:
TrackExistsError = skip, never an overwrite).
  collect_lane3.py --day 2026-09-29 --src <pulled /data/lane3/out copy> --reb-root ~/eta-data/reb              DRY RUN (default): validates, counts, writes nothing
  collect_lane3.py ... --write                                                                              writes (only on backfill-lead's go)
Per track it REJECTS (counted, never written): a key/engine/model/version that is not the lane's; a config that is not EXACTLY the lane config; a config_hash that is not the lane hash or that equals an EXISTING product hash
(hf-l4-backfill-* tracks); status other than ok/empty; schema errors (reb.validate); a file whose name / window id / ist_date disagrees with itself or with --day; a blind window (heldout.py pin, re-checked here).
Never prints transcript text."""
import argparse, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE); sys.path.insert(0, os.path.expanduser("~/dev/eta-lab/kit"))
import lane3_plan as P
from reb import writer
from reb.validate import validate_track, ValidationError
JM = P.JM
def collect(day, src, reb_root, write, heldout, union):
    c = {"files": 0, "tracks_ok": 0, "written": 0, "exists_skipped": 0, "blind_refused": 0, "rejected": 0, "rejected_reasons": {}}
    def rej(why): c["rejected"] += 1; c["rejected_reasons"][why] = c["rejected_reasons"].get(why, 0) + 1
    for fam in ("indic", "sravaani"):
        d = os.path.join(src, fam)
        if not os.path.isdir(d): continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".json") or fn.startswith("."): continue
            c["files"] += 1
            try: o = json.load(open(os.path.join(d, fn))); stub = o["manifest_stub"]; tracks = o["tracks"]
            except Exception: rej("unreadable_json"); continue
            import datetime as D
            ms = lambda k: D.datetime.fromtimestamp(stub[k] / 1000, D.timezone.utc).isoformat() if stub.get(k) else ""
            w = {"win_id": stub.get("window_id", ""), "room": stub.get("room_id", ""), "ist_date": stub.get("ist_date", ""), "start": ms("t0_ms"), "end": ms("t1_ms")}
            if fn != f"{w['win_id']}.json" or w["ist_date"] != day: rej("window_id_or_day_mismatch"); continue
            if P.is_blind(w, heldout, union): c["blind_refused"] += 1; continue
            for k, t in tracks.items():
                if k not in JM.CONFIGS or JM.FAMILY_OF[k] != fam: rej("key_not_lane3_or_wrong_family"); continue
                cfg, h = JM.CONFIGS[k]
                if h == JM.EXISTING_HASHES[k] or t.get("config_hash") == JM.EXISTING_HASHES[k]: rej("existing_product_hash"); continue
                if t.get("config_hash") != h or t.get("config") != cfg: rej("config_or_hash_not_lane3"); continue
                if t.get("engine") != JM.ENGINE_OF[k] or t.get("model") != cfg["model"] or t.get("version") != JM.VERSION or t.get("window_id") != w["win_id"]: rej("engine_model_version_window"); continue
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
    ap.add_argument("--day", required=True); ap.add_argument("--src", required=True); ap.add_argument("--reb-root", default=P.REB); ap.add_argument("--write", action="store_true")
    a = ap.parse_args(); heldout, union = P.load_guard()
    print(json.dumps({"mode": "WRITE" if a.write else "DRY-RUN", **collect(a.day, a.src, a.reb_root, a.write, heldout, union)}, indent=1))
