#!/usr/bin/env python3
"""W49 palimpsest overnight priority (Fable, 28 Sep): extend timeline/<room>/<date>.json with REB engine-layer
lanes - the named categories Fable asked for: whisper, indic (IndicConformer), sravaani, medasr (the terms
layer), diar, acoustic (REB's own acoustics layer - distinct from the existing top-level `acoustics` key, which
comes from acoustics' own separate missed-speech export), tone (emotion/wavlm). Walks every window in
~/eta-data/reb/<date>/<room>/*/manifest.json for that room-day using kit.reb's own load_window()/
.tracks(latest_ok=True) - the REAL selection semantics (eta-refuter-2 #5266: never reimplement this by hand
again) - never invents a lane grouping beyond the named lanes.

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
import argparse, datetime, glob, hashlib, importlib.util, json, os, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve()
KIT_ROOT = HERE.parents[2]   # kit/lab-viewer/tools/reb_timeline_seed.py -> parents[0]=tools [1]=lab-viewer [2]=kit
sys.path.insert(0, str(KIT_ROOT))
from reb.reb import load_window, WindowNotFoundError   # the REAL library (eta-refuter-2 #5266: read reb.py from THIS repo, never a snapshot)

BUCKET = "eta-lab-ratings"
CWD = HERE.parents[1]   # kit/lab-viewer, matching timeline_seed.py's own wrangler cwd

# the eight lanes (Fable's seven + translate, T-PALIMPSEST-7), in that order; a track matching none of these is not shown on the day overlay
# (still fully visible per-window in the P3 inspector - this file is additive, never a substitute for that).
LANES = [
    ("whisper", lambda e: e.get("layer") == "stt" and str(e.get("engine", "")).startswith("whisper")),
    ("medmodel", lambda e: e.get("layer") == "stt" and e.get("engine") == "medasr"),   # T-MEDMODEL-2: stt layer only; terms.medasr (W50 evidence, other windows + decode) stays in the MedASR row below
    ("indic", lambda e: e.get("layer") == "stt" and str(e.get("engine", "")).startswith("indic-")),
    ("sravaani", lambda e: e.get("layer") == "stt" and e.get("engine") == "sravaani"),
    ("medasr", lambda e: e.get("layer") == "terms"),
    ("translate", lambda e: e.get("layer") == "translate"),   # layer name per REB-SPEC-v1 (translate: Gemini text->English per Indic STT track); no such track exists on disk yet
    ("diar", lambda e: e.get("layer") == "diar"),
    ("acoustic", lambda e: e.get("layer") == "acoustics"),
    ("tone", lambda e: e.get("layer") == "emotion"),
]


KOYAL_LANGS = ("hi", "kn", "ml", "te")   # KOYAL-LANE-SPEC f1f57dc3: four prompt-language tracks per window, same engine name, told apart only by config.lang


def lane_of(entry, body=None):
    if entry.get("layer") == "stt" and entry.get("engine") == "koyal":
        cfg = (body or {}).get("config")
        lang = str(cfg.get("lang", "") if isinstance(cfg, dict) else "").split("-")[0].lower()
        return f"koyal_{lang}" if lang in KOYAL_LANGS else None   # an unknown prompt language is not shown rather than guessed
    for name, pred in LANES:
        if pred(entry):
            return name
    return None


# stt.medasr tracks by config_hash that must not reach the viewer. e2b69f8a = hf-l4-medasr-1 (chunk_s 30): eta-refuter-3 #8625 verdict, EOS-only on 356/432,
# a chunking fault. Track versions are never mixed in one lane; a new v2 hash is added to the allow rule here only after r3 PASSes its launcher.
MEDMODEL_SUSPECT_HASHES = frozenset({"e2b69f8a"})
SUSPECT_REASON = "SUSPECT e2b69f8a (30 s chunking)"


def suspect_medmodel(entry, body=None):
    if not (entry.get("layer") == "stt" and entry.get("engine") == "medasr"):
        return False
    h = entry.get("config_hash") or (body or {}).get("config_hash")
    return h in MEDMODEL_SUSPECT_HASHES


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

HELDOUT_PY = os.path.expanduser("~/eta-data/drtpqma/heldout.py")   # shared R3/W51 predicate (Fable #6727/#6754), union sha16 f07171dc
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def load_heldout(path=HELDOUT_PY):
    """(is_held_out(day, room_id) -> bool). FAIL-CLOSED: if the shared helper or its union cannot be loaded and verified
    the seed refuses to run, it never proceeds unguarded."""
    try:
        spec = importlib.util.spec_from_file_location("heldout", path)
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        union, _sha = mod.load_union()
    except Exception as e:   # noqa: BLE001 - any failure to establish the guard is fatal
        sys.exit(f"R3/W51 guard unavailable ({type(e).__name__}); refusing to build reb lanes unguarded")
    return lambda day, room_id: mod.is_held_out(union, day, room_id)


def window_held(is_held, room, t0_ms, t1_ms):
    """A window is held out if the IST day of its start OR of end-1s (the end is exclusive) is a blind room-day for this room.
    Unusable times are treated as held (fail-closed)."""
    try:
        days = {datetime.datetime.fromtimestamp(ms / 1000, IST).strftime("%Y-%m-%d") for ms in (t0_ms, t1_ms - 1000)}
    except (TypeError, ValueError, OverflowError, OSError):
        return True
    return any(is_held(d, room) for d in days)


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


class Lanes(dict):
    """lane -> segments; .capped = {lane: {"n_total", "until_ms"}} for every lane cut at LANE_CAP (so the viewer can say so)"""
    capped = None
    eos = None   # {lane: {"eos": chunks dropped because their text was only the "</s>" token, "kept": segments left}}; dropped BEFORE counting/capping, stored REB tracks are untouched
    excluded = None   # {lane: {"n_tracks", "reason"}} for tracks deliberately left out (SUSPECT); the viewer must say so instead of "no segments"
    full = None   # {lane: every segment, sorted} for capped lanes: written as timeline-lanes/ objects so the Worker can page by time window


LANE_CAP = 2000


def build_reb_lanes(reb_root, date, room, is_held=None):
    """{"whisper": [...], ...} - each entry {t0_ms, t1_ms, text, engine}, absolute ms, across every window in
    this room-day, sorted, capped. A malformed window is skipped, never fatal to the rest of the day."""
    lanes = Lanes({name: [] for name, _ in LANES})
    lanes.capped = {}
    lanes.full = {}
    lanes.excluded = {}
    lanes.eos = {}
    eos_n = {}
    lanes.update({f"koyal_{l}": [] for l in KOYAL_LANGS})
    n_windows = n_tracks = n_held = 0
    is_held = is_held or load_heldout()
    if is_held(date, room):   # the whole room-day is blind: nothing is read at all
        return lanes, 0, 0, sum(1 for _ in window_ids_for(reb_root, date, room))
    for wid in window_ids_for(reb_root, date, room):
        try:
            w = load_window(wid, ist_date=date, room_id=room, root=reb_root)
        except (WindowNotFoundError, OSError, json.JSONDecodeError, KeyError):
            continue
        if window_held(is_held, room, w.t0_ms, w.t1_ms):
            n_held += 1   # no segments, no text: the lane shows "held out"
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
            lane = lane_of(t.entry, t.body)
            if lane is None:
                continue
            if suspect_medmodel(t.entry, t.body):
                ex = lanes.excluded.setdefault(lane, {"n_tracks": 0, "reason": SUSPECT_REASON})
                ex["n_tracks"] += 1
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
                if text and not text.replace("</s>", "").strip():
                    eos_n[lane] = eos_n.get(lane, 0) + 1
                    continue
                lanes[lane].append({"t0_ms": a, "t1_ms": b, "text": text[:1000], "engine": str(t.entry.get("engine"))[:60]})
    for name, n in eos_n.items():
        lanes.eos[name] = {"eos": n, "kept": len(lanes[name])}
    for name in lanes:
        lanes[name].sort(key=lambda s: s["t0_ms"])
        if len(lanes[name]) > LANE_CAP:
            lanes.capped[name] = {"n_total": len(lanes[name]), "until_ms": lanes[name][LANE_CAP - 1]["t1_ms"], "full": True}
            lanes.full[name] = list(lanes[name])
        lanes[name] = lanes[name][:LANE_CAP]
    return lanes, n_windows, n_tracks, n_held


def write_lane_objects(out, room, date, lanes):
    """timeline-lanes/<room>/<date>/<lane>.json under out, one per capped lane (the uncapped, sorted segments); private 0600/0700."""
    d = Path(out) / "timeline-lanes" / room / date
    if lanes.full:
        d.mkdir(parents=True, exist_ok=True)
        for parent in (d, d.parent, d.parent.parent):
            private_dir_file(parent)
    for name, segs in lanes.full.items():
        p = d / f"{name}.json"
        p.write_text(json.dumps(segs, ensure_ascii=False)); private_dir_file(p)


def private_dir_file(p):
    os.chmod(p, 0o700 if Path(p).is_dir() else 0o600)


def cmd_build(a):
    os.umask(0o077)
    lanes, n_windows, n_tracks, n_held = build_reb_lanes(a.reb_root, a.date, a.room)
    out = Path(a.out) / "timeline" / a.room; out.mkdir(parents=True, exist_ok=True); private_dir_file(out)
    p = out / f"{a.date}.reb.json"
    p.write_text(json.dumps({"reb": lanes, "reb_cap": lanes.capped, "reb_excluded": lanes.excluded, "reb_eos": lanes.eos}, ensure_ascii=False)); private_dir_file(p)
    write_lane_objects(a.out, a.room, a.date, lanes)
    print(f"built reb lanes for {a.room}/{a.date}: {n_windows} windows, {n_tracks} current tracks, {n_held} held out (R3/W51) -> {p}")


def fetch_live(room, date):
    """Read-only R2 get of the live doc: (parsed doc, sha256 of the exact bytes) or (None, None) if it doesn't exist yet (a fresh room-day, not an error)."""
    r = subprocess.run(["npx", "wrangler", "r2", "object", "get", f"{BUCKET}/timeline/{room}/{date}.json", "--pipe", "--remote"],
                        capture_output=True, cwd=CWD)
    if r.returncode != 0:
        if b"does not exist" in (r.stderr or b""):
            return None, None
        sys.exit(f"cannot read the live doc for {room}/{date} (not a clean not-found - refusing to guess): {(r.stderr or b'')[:300]!r}")
    try:
        return json.loads(r.stdout), hashlib.sha256(r.stdout).hexdigest()
    except json.JSONDecodeError:
        sys.exit(f"live doc for {room}/{date} is not valid JSON - refusing to build on top of it")


def cmd_merge(a):
    os.umask(0o077)
    live_fetched, live_sha = fetch_live(a.room, a.date)
    live = live_fetched if live_fetched is not None else {"schema": 1, "room_id": a.room, "date": a.date}
    lanes, n_windows, n_tracks, n_held = build_reb_lanes(a.reb_root, a.date, a.room)
    merged = {**live, "reb": lanes, "reb_cap": lanes.capped, "reb_excluded": lanes.excluded, "reb_eos": lanes.eos}
    merged["source_sha256"] = hashlib.sha256(json.dumps({k: v for k, v in merged.items() if k != "source_sha256"}, sort_keys=True).encode()).hexdigest()
    out = Path(a.out) / "timeline" / a.room; out.mkdir(parents=True, exist_ok=True); private_dir_file(out)
    p = out / f"{a.date}.json"
    p.write_text(json.dumps(merged, ensure_ascii=False)); private_dir_file(p)
    side = out / f"{a.date}.livesha"   # timeline_seed.py load --replace refuses if the live object is no longer this one (lost-update guard)
    side.write_text(live_sha or "absent"); private_dir_file(side)
    write_lane_objects(a.out, a.room, a.date, lanes)
    print(f"merged reb lanes ({n_windows} windows, {n_tracks} current tracks, {n_held} held out R3/W51) into {a.room}/{a.date} "
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
