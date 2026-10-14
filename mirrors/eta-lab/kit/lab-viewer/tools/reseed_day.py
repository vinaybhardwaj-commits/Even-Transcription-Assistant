#!/usr/bin/env python3
"""Per-day re-seed of the REB lanes (incl. Koyal) into timeline/<room>/<date>.json for every room of one IST day.

  reseed_day.py --date 2026-09-25                 # DRY RUN (default): builds every room's lanes locally, prints counts only, needs no token, writes nothing
  reseed_day.py --date 2026-09-25 --apply         # per room: `reb_timeline_seed.py merge` (reads the live doc, needs the token), then ONE `timeline_seed.py load --replace`
                                                  # (the live object is archived to timeline-history/ and read back first; refused if it changed since the merge read it). Fable runs this; the token comes from the env.
Counts only, never text. A blind room-day (R3/W51) builds to all-empty lanes via the seed's own guard; the merge keeps every other part of the live doc."""
import argparse, os, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import reb_timeline_seed as S   # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--date", required=True)
ap.add_argument("--reb-root", default=os.path.expanduser("~/eta-data/reb"))
ap.add_argument("--apply", action="store_true")
a = ap.parse_args()
day = Path(a.reb_root) / a.date
rooms = sorted(p.name for p in day.iterdir() if p.is_dir() and p.name.startswith("room_")) if day.is_dir() else []
if not rooms:
    sys.exit(f"no rooms under {day}")
if not a.apply:
    is_held = S.load_heldout()
    for room in rooms:
        lanes, nw, nt, nh = S.build_reb_lanes(a.reb_root, a.date, room, is_held)
        blind = "BLIND room-day" if is_held(a.date, room) else ""
        print(f"{a.date} {room}: {nw} windows, {nt} tracks, {nh} held {blind} | " + " ".join(f"{k}={len(v)}" + (f"(of {lanes.capped[k]['n_total']})" if k in lanes.capped else "") for k, v in lanes.items()))
    print("dry run: nothing written, no token used")
    sys.exit(0)
out = tempfile.mkdtemp(prefix=f"reseed-{a.date}-")
is_held = S.load_heldout()
skipped = [r for r in rooms if is_held(a.date, r)]
for room in rooms:
    if room in skipped:
        continue   # blind room-day: not re-put, not created; whatever is live stays as it is
    r = subprocess.run([sys.executable, str(HERE / "reb_timeline_seed.py"), "merge", "--room", room, "--date", a.date, "--reb-root", a.reb_root, "--out", out], text=True)
    if r.returncode:
        sys.exit(f"merge failed for {room}; nothing loaded")
print(f"skipped {len(skipped)} blind room-day(s): {', '.join(skipped) or 'none'}")
if len(skipped) == len(rooms):
    sys.exit("nothing to load")
r = subprocess.run([sys.executable, str(HERE / "timeline_seed.py"), "load", "--dir", out, "--replace"], text=True)
sys.exit(r.returncode)
