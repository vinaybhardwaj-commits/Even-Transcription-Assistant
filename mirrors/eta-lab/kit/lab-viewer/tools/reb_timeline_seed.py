#!/usr/bin/env python3
"""W49 palimpsest overnight priority (Fable, 28 Sep): extend timeline/<room>/<date>.json with REB engine-layer
lanes - the named categories Fable asked for: whisper, indic (IndicConformer), sravaani, medasr (the terms
layer), diar, acoustic (REB's own acoustics layer - distinct from the existing top-level `acoustics` key, which
comes from acoustics' own separate missed-speech export), tone (emotion/wavlm). Walks every window in
~/eta-data/reb/<date>/<room>/*/manifest.json for that room-day using kit.reb's own load_window()/
.tracks(latest_ok=True) - the REAL selection semantics (eta-refuter-2 #5266: never reimplement this by hand
again) - never invents a lane grouping beyond the seven Fable named.

  reb_timeline_seed.py build --room <room_id> --date <ist_date> [--reb-root ~/eta-data/reb] --out <dir>
    Writes <out>/timeline/<room>/<date>.reb.json - the `reb` key ONLY, standalone. Never touches other owners'
    pqm_truth/cap_links/acoustics/fleet/detected keys or R2 itself.
  reb_timeline_seed.py merge --room ... --date ... [--reb-root ...] --out <dir>
    Fetches the CURRENT live timeline/<room>/<date>.json (via `npx wrangler r2 object get --remote`, read-only;
    starts from a fresh {schema:1,room_id,date} doc if none exists yet), merges in the `reb` key computed the
    same way as `build`, writes the FULL merged doc to <out>/timeline/<room>/<date>.json. Load it the normal way:
    timeline_seed.py load --dir <out> --replace (archives the pre-REB object under timeline-history/ first, same
    safety as every other correction - this is one, since it changes an already-loaded room-day's document).

No patient/doctor/drug/diagnosis text ever passes through this script; it prints only counts."""
import argparse, glob, hashlib, json, os, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve()
KIT_ROOT = HERE.parents[2]   # kit/lab-viewer/tools/reb_timeline_seed.py -> parents[0]=tools [1]=lab-viewer [2]=kit
sys.path.insert(0, str(KIT_ROOT))
from reb.reb import load_window, WindowNotFoundError   # the REAL library (eta-refuter-2 #5266: read reb.py from THIS repo, never a snapshot)

BUCKET = "eta-lab-ratings"
CWD = HERE.parents[1]   # kit/lab-viewer, matching timeline_seed.py's own wrangler cwd

# the seven lanes Fable named, in that order; a track matching none of these is not shown on the day overlay
# (still fully visible per-window in the P3 inspector - this file is additive, never a substitute for that).
LANES = [
    ("whisper", lambda e: e.get("layer") == "stt" and str(e.get("engine", "")).startswith("whisper")),
    ("indic", lambda e: e.get("layer") == "stt" and str(e.get("engine", "")).startswith("indic-ctc")),
    ("sravaani", lambda e: e.get("layer") == "stt" and e.get("engine") == "sravaani"),
    ("medasr", lambda e: e.get("layer") == "terms"),
    ("diar", lambda e: e.get("layer") == "diar"),
    ("acoustic", lambda e: e.get("layer") == "acoustics"),
    ("tone", lambda e: e.get("layer") == "emotion"),
]


def lane_of(entry):
    for name, pred in LANES:
        if pred(entry):
            return name
    return None


def clip_local_offset(source_kind, t0, t1, all_raw_segments):
    """Ported 1:1 from worker/reb.js's clipLocalOffset (eta-refuter-2 #5266 F2: a real dev_clip manifest declared
    clock:"tape_utc" but its segments were actually 0-based). No shared module between Python and the Worker's
    JS - keep the two in sync by hand if either changes; a mismatch here would misalign the whole day's bars."""
    duration = t1 - t0
    if source_kind in ("dev_clip", "suite_synthetic", "room_tape"):
        return t0
    if duration > 0 and all_raw_segments and all(
        isinstance(s.get("t0_ms"), (int, float)) and isinstance(s.get("t1_ms"), (int, float))
        and s["t0_ms"] >= -1 and s["t1_ms"] <= duration + 1
        for s in all_raw_segments
    ):
        return t0
    return 0


OUTLIER_MS = 30000


def place_room_tape_segment(t0, t1, s0, s1):
    """Port of worker/reb.js placeRoomTapeSegment: offset = t0; drop a segment starting <-1 or >OUTLIER_MS past the
    window end, clamp one that merely ends late. Returns (a, b) or None."""
    duration = t1 - t0
    if s0 < -1 or s0 >= duration or s0 > duration + OUTLIER_MS:
        return None
    return t0 + max(0, s0), t0 + min(s1, duration)


def window_ids_for(reb_root, date, room):
    for p in sorted(glob.glob(os.path.join(reb_root, date, room, "*", "manifest.json"))):
        yield Path(p).parent.name


def build_reb_lanes(reb_root, date, room):
    """{"whisper": [...], ...} - each entry {t0_ms, t1_ms, text, engine}, absolute ms, across every window in
    this room-day, sorted, capped. A malformed window is skipped, never fatal to the rest of the day."""
    lanes = {name: [] for name, _ in LANES}
    n_windows = n_tracks = 0
    for wid in window_ids_for(reb_root, date, room):
        try:
            w = load_window(wid, ist_date=date, room_id=room, root=reb_root)
        except (WindowNotFoundError, OSError, json.JSONDecodeError, KeyError):
            continue
        n_windows += 1
        try:
            tracks = w.tracks(latest_ok=True)
        except (OSError, json.JSONDecodeError):
            continue
        all_raw = [s for t in tracks for s in t.segments]
        offset = clip_local_offset(w.source_kind, w.t0_ms, w.t1_ms, all_raw)
        for t in tracks:
            if t.entry.get("status") != "ok":
                continue   # a day overlay is about what was SAID; per-engine failure bookkeeping stays in the per-window P3 inspector
            lane = lane_of(t.entry)
            if lane is None:
                continue
            n_tracks += 1
            for seg in t.segments[:500]:
                s0, s1 = seg.get("t0_ms"), seg.get("t1_ms")
                if not isinstance(s0, (int, float)) or not isinstance(s1, (int, float)) or s1 < s0:
                    continue
                text = seg.get("text") if isinstance(seg.get("text"), str) else ""
                a, b = s0 + offset, s1 + offset
                if w.source_kind == "room_tape":
                    placed = place_room_tape_segment(w.t0_ms, w.t1_ms, s0, s1)
                    if placed is None:
                        continue
                    a, b = placed
                lanes[lane].append({"t0_ms": a, "t1_ms": b, "text": text[:1000], "engine": str(t.entry.get("engine"))[:60]})
    for name in lanes:
        lanes[name].sort(key=lambda s: s["t0_ms"])
        lanes[name] = lanes[name][:2000]
    return lanes, n_windows, n_tracks


def private_dir_file(p):
    os.chmod(p, 0o700 if Path(p).is_dir() else 0o600)


def cmd_build(a):
    os.umask(0o077)
    lanes, n_windows, n_tracks = build_reb_lanes(a.reb_root, a.date, a.room)
    out = Path(a.out) / "timeline" / a.room; out.mkdir(parents=True, exist_ok=True); private_dir_file(out)
    p = out / f"{a.date}.reb.json"
    p.write_text(json.dumps({"reb": lanes}, ensure_ascii=False)); private_dir_file(p)
    print(f"built reb lanes for {a.room}/{a.date}: {n_windows} windows, {n_tracks} current tracks -> {p}")


def fetch_live(room, date):
    """Read-only R2 get of the live doc; None if it doesn't exist yet (a fresh room-day, not an error)."""
    r = subprocess.run(["npx", "wrangler", "r2", "object", "get", f"{BUCKET}/timeline/{room}/{date}.json", "--pipe", "--remote"],
                        capture_output=True, text=True, cwd=CWD)
    if r.returncode != 0:
        if "does not exist" in (r.stderr or ""):
            return None
        sys.exit(f"cannot read the live doc for {room}/{date} (not a clean not-found - refusing to guess): {(r.stderr or '')[:300]}")
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        sys.exit(f"live doc for {room}/{date} is not valid JSON - refusing to build on top of it")


def cmd_merge(a):
    os.umask(0o077)
    live_fetched = fetch_live(a.room, a.date)
    live = live_fetched if live_fetched is not None else {"schema": 1, "room_id": a.room, "date": a.date}
    lanes, n_windows, n_tracks = build_reb_lanes(a.reb_root, a.date, a.room)
    merged = {**live, "reb": lanes}
    merged["source_sha256"] = hashlib.sha256(json.dumps({k: v for k, v in merged.items() if k != "source_sha256"}, sort_keys=True).encode()).hexdigest()
    out = Path(a.out) / "timeline" / a.room; out.mkdir(parents=True, exist_ok=True); private_dir_file(out)
    p = out / f"{a.date}.json"
    p.write_text(json.dumps(merged, ensure_ascii=False)); private_dir_file(p)
    print(f"merged reb lanes ({n_windows} windows, {n_tracks} current tracks) into {a.room}/{a.date} "
          f"({'had' if live_fetched is not None else 'no'} pre-existing live doc) -> {p}; "
          f"load with: timeline_seed.py load --dir {a.out} --replace")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("build", cmd_build), ("merge", cmd_merge)):
        p = sub.add_parser(name)
        p.add_argument("--room", required=True); p.add_argument("--date", required=True)
        p.add_argument("--reb-root", default=os.path.expanduser("~/eta-data/reb")); p.add_argument("--out", required=True)
        p.set_defaults(fn=fn)
    args = ap.parse_args()
    args.fn(args)
