#!/usr/bin/env python3
"""collect_e2e.py — HF-4 box-side collector for outputs pulled from the E2E node (pull dir = ~/eta-data/hist/e2e-pull/<ts>, mode 0700). Generalises hf-lane1/collect_lane.collect (unchanged, imported):
write-once via reb.writer.write_track (TrackExistsError = skip), lane hashes only, blind re-refused with heldout.py f672c1ef046089dd, schema validated. ADDED here, per file, BEFORE collect_lane sees it:
  - every track's machine starts with 'e2e-node:' and provenance.script_sha16 == 3bec47c98551c29b (the vendored job file)
  - the stub's audio sha256 equals the box manifest's sha256 for that window (audio tampered/mixed up in transit => rejected, counted)
  - the file belongs to a window in the work list (nothing else is ever written)
Files are grouped per IST day into a staging dir of symlinks (0700, under the pull dir), then collect_lane.collect runs per day. DRY RUN by default; --write writes (only after the refuter's PASS + a later order).
  collect_e2e.py --src ~/eta-data/hist/e2e-pull/<ts> --worklist <plan>/worklist.jsonl [--reb-root ~/eta-data/reb] [--write]      Counts only, never text."""
import argparse, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); LANE = os.path.join(os.path.dirname(HERE), "hf-lane1"); sys.path.insert(0, LANE)
import launch_lane as L, collect_lane as C
JOB_SHA16 = "3bec47c98551c29b"

def screen(src, worklist, stage):
    """Returns (counts, days). Symlinks acceptable files into <stage>/<day>/. Never reads transcript text beyond json structure."""
    wl = {w["win_id"]: w for w in (json.loads(l) for l in open(worklist) if l.strip())}
    c = {"files": 0, "not_in_worklist": 0, "unreadable": 0, "machine_not_e2e": 0, "script_sha_mismatch": 0, "audio_sha_mismatch": 0, "accepted_for_collect": 0}; days = set()
    for fn in sorted(os.listdir(src)):
        if not fn.endswith(".json") or fn.startswith("."): continue
        c["files"] += 1; wid = fn[:-5]
        if wid not in wl: c["not_in_worklist"] += 1; continue
        try: d = json.load(open(f"{src}/{fn}")); stub, tracks = d["manifest_stub"], d["tracks"]
        except Exception: c["unreadable"] += 1; continue
        if not tracks or not all(str(t.get("machine", "")).startswith("e2e-node:") for t in tracks.values()): c["machine_not_e2e"] += 1; continue
        if not all((t.get("provenance") or {}).get("script_sha16") == JOB_SHA16 for t in tracks.values()): c["script_sha_mismatch"] += 1; continue
        if (stub.get("audio") or {}).get("sha256") != wl[wid]["audio_sha256"] or stub.get("window_id") != wid: c["audio_sha_mismatch"] += 1; continue
        day = wl[wid]["ist_date"]; os.makedirs(f"{stage}/{day}", mode=0o700, exist_ok=True); os.symlink(os.path.abspath(f"{src}/{fn}"), f"{stage}/{day}/{fn}"); days.add(day); c["accepted_for_collect"] += 1
    return c, sorted(days)

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True); ap.add_argument("--worklist", required=True); ap.add_argument("--reb-root", default=L.REB_DEFAULT); ap.add_argument("--write", action="store_true"); ap.add_argument("--stage")
    a = ap.parse_args(argv); heldout, union, _ = L.load_guard()
    if (os.stat(a.src).st_mode & 0o077): raise SystemExit("REFUSED: pull dir must be mode 0700")
    stage = a.stage or os.path.join(a.src, "_stage"); assert not os.path.exists(stage) or not os.listdir(stage), "stage dir not empty"
    os.makedirs(stage, mode=0o700, exist_ok=True)
    scr, days = screen(a.src, a.worklist, stage); tot = {"mode": "WRITE" if a.write else "DRY-RUN", "screen": scr, "collect": {}}
    agg = {"files": 0, "tracks_ok": 0, "written": 0, "exists_skipped": 0, "blind_refused": 0, "rejected": 0, "rejected_reasons": {}}
    for d in days:
        r = C.collect(d, f"{stage}/{d}", a.reb_root, a.write, heldout, union)
        for k in ("files", "tracks_ok", "written", "exists_skipped", "blind_refused", "rejected"): agg[k] += r[k]
        for k, v in r["rejected_reasons"].items(): agg["rejected_reasons"][k] = agg["rejected_reasons"].get(k, 0) + v
    tot["collect"] = agg; print(json.dumps(tot, indent=1)); return 0

if __name__ == "__main__": sys.exit(main())
