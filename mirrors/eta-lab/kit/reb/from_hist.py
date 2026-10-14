"""hist-bulk window json -> REB stt.router-twin-<stack> tracks (REB-SPEC-v2.3 section 5; ORDERS-PALIMPSEST-2 Part B).

Converts, never re-runs: ~/eta-data/hist/runs/<run_id>/<room>/<date>/<win>.json (schema eta-lab-result/1, read-only) ->
reb/<ist_date>/<room>/<window>/tracks/stt.router-twin-<stack>__<sha8>__<cfg8>.json + manifest entry + per-day index.jsonl line,
plus one outbox line per written track in ~/eta-data/reb/_outbox/index-pending.jsonl (spec section 4 columns) for the future
collector. No Neon, no R2 push, no credential. Default is --dry-run (counts only). Logs are counts only, never transcript text.

Deliberate deviations/decisions (flagged for review):
* cfg8 = sha256(run_id + json.dumps(provenance.stack, sort_keys=True) + json.dumps(routers))[:8], per the orders, which is NOT
  writer.config_hash(config). So write_track() cannot be used (it enforces config_hash == config_hash(config)); this module
  calls writer's manifest/index/lock helpers directly. `routers` = [hist["router"]] (the one router port that served the file).
* t0/t1: the window's REB manifest if one exists (tape clock, authoritative), else the hist file's start/end.
* A window with NO REB manifest that BACKFILL plans (any windows-reb/manifest-<day>.jsonl) is deferred, never written (ORDERS-2c).
* A hist-created manifest has no audio of its own: audio.r2_key = "hist-chunks:<first chunk key>", sha256 "unknown:from_hist",
  sample_rate 0 so validate_manifest passes and other writers can still append; clock "approx".
* A conflict (same track name, different sha256) is never overwritten; the new body goes to
  <window>/tracks/_conflicts/<trackname>.conflict-<ts>.json (ORDERS-2b R4), so tracks/*.json holds only real tracks.
* cfg8 = sha256(run_id + stack json + routers json)[:8], a run hash, not config_hash(config) (ORDERS-2b R1).
* conf is null when the source gave no score (34k hist segments have neither score nor confidence); null conf means
  "source gave no score", NOT low confidence. Readers must not rank on null conf (ORDERS-2b R9).
* extras.mining_only is copied as-is from the hist file's top-level key; omitted if absent (R8).
"""
import argparse
import datetime
import glob
import hashlib
import importlib.util
import json
import os
import re
import sys
import time

from . import r2_mirror, writer
from .schema import SCHEMA_VERSION
from .validate import validate_track

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
HIST_RUNS = os.path.expanduser("~/eta-data/hist/runs")
REB_ROOT = os.path.expanduser("~/eta-data/reb")
HELDOUT_PY = os.path.expanduser("~/eta-data/drtpqma/heldout.py")
HELDOUT_PY_SHA16 = "f672c1ef046089dd"
WREB = os.path.expanduser("~/eta-data/hist/windows-reb")   # BACKFILL worklists: WREB/manifest-<day>.jsonl (launch_lane.py:20,103-105)
ALIAS_FILE = os.path.expanduser("~/eta-data/reb-aliases/REB-ALIAS-45-from-map-9ba4795e.json")
ALIAS_SHA8 = "09c25ccb"
OUT_DIR = "/home/eta/oc/palimpsest/out"
LAYER = "stt"
COUNTERS = ("seen", "written", "empty", "failed", "ok", "degraded", "skipped_existing", "conflicts", "blind_refused",
            "would_write", "worklist_rows", "start_resolved", "attempts_carried", "deferred_backfill_window", "alias_resolved", "t0_from_manifest", "t0_mismatch", "new_manifest", "errors")


class GuardUnavailable(SystemExit):
    pass


def load_heldout(path=HELDOUT_PY):
    """FAIL-CLOSED: returns is_held(day, room) only if heldout.py has the expected sha16 and its union loads and verifies."""
    try:
        raw = open(path, "rb").read()
        if hashlib.sha256(raw).hexdigest()[:16] != HELDOUT_PY_SHA16:
            raise ValueError("heldout.py sha16 mismatch")
        spec = importlib.util.spec_from_file_location("heldout", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        union, _ = mod.load_union()
    except Exception as e:  # noqa: BLE001 - any failure to establish the guard is fatal
        raise GuardUnavailable(f"heldout guard unavailable ({type(e).__name__}); refusing to convert unguarded")
    return lambda day, room: mod.is_held_out(union, day, room)


def window_held(is_held, room, t0_ms, t1_ms):
    """Held if the IST day of t0 OR of t1-1s is blind for this room. Unusable times => held (fail closed)."""
    try:
        days = {datetime.datetime.fromtimestamp(ms / 1000, IST).strftime("%Y-%m-%d") for ms in (t0_ms, t1_ms - 1000)}
    except (TypeError, ValueError, OverflowError, OSError):
        return True
    return any(is_held(d, room) for d in days)


def load_aliases(path=ALIAS_FILE):
    raw = open(path, "rb").read()
    if hashlib.sha256(raw).hexdigest()[:8] != ALIAS_SHA8:
        raise GuardUnavailable("alias map sha8 mismatch; refusing")
    return json.loads(raw)


def load_backfill_windows(wreb=WREB):
    """Windows BACKFILL plans from windows-reb/manifest-<day>.jsonl (rows: win_id, room, ist_date, start, end). Returns a set of
    (room, id-without-leading-"c-") and (room, start_ms) keys; hist/REB ids carry a "c-" prefix that the worklists lack."""
    keys = set()
    rows = 0
    for f in sorted(glob.glob(os.path.join(wreb, "manifest-*.jsonl"))):
        for line in open(f):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                keys.add((r["room"], re.sub(r"^c-", "", r["win_id"])))
                keys.add((r["room"], parse_iso_ms(r["start"])))
                rows += 1
            except (ValueError, KeyError, TypeError):
                continue
    if rows == 0:   # FAIL CLOSED: an unreadable/missing/empty worklist dir must never silently mean "nothing to defer"
        raise GuardUnavailable(f"no BACKFILL worklist rows read from {wreb}/manifest-*.jsonl; refusing (would not defer anything)")
    return keys, rows


def is_backfill_window(keys, room, wid, t0_ms):
    return (room, re.sub(r"^c-", "", wid)) in keys or (room, t0_ms) in keys


ATTEMPT_RE = re.compile(r"\.attempt\d*\.json$")


def read_attempts(path):
    """Superseded tries <window_id>.attemptN.json beside the final <window_id>.json: evidence only, never converted alone and
    never any transcript text. -> [{n, file, state, ok, error, router_status, created_at, n_segments}] ordered by n."""
    stem = path[:-5]
    out = []
    for f in glob.glob(glob.escape(stem) + ".attempt*.json"):
        m = re.search(r"\.attempt(\d*)\.json$", f)
        try:
            a = json.load(open(f))
        except (OSError, json.JSONDecodeError):
            out.append({"n": int(m.group(1) or 0), "file": os.path.basename(f), "unreadable": True})
            continue
        out.append({"n": int(m.group(1) or 0), "file": os.path.basename(f), "state": a.get("state"), "ok": a.get("ok"),
                    "error": a.get("error"), "router_status": a.get("router_status"),
                    "created_at": (a.get("provenance") or {}).get("created_at"), "n_segments": len(a.get("segments") or [])})
    return sorted(out, key=lambda x: x["n"])


def parse_iso_ms(s):
    return int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def ist_date_of(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, IST).strftime("%Y-%m-%d")


def _safe(s):
    s = re.sub(r"[^A-Za-z0-9._-]", "-", str(s))
    return s if re.match(r"^[A-Za-z0-9]", s) else "x" + s


def stack_of(hist):
    """box | c3s0 | c3s1 | c4s0 | c4s1 | mini ...: from the router port that served the file (hist['router'], echoed in
    provenance.served_by.router_port). A bare numeric port is qualified by the node name. Never from notes.stack_versions_file."""
    port = hist.get("router") or ((hist.get("provenance") or {}).get("served_by") or {}).get("router_port") or "unknown"
    port = str(port).lstrip(":")
    if port.isdigit():
        port = f"{hist.get('node') or 'node'}-{port}"
    return _safe(port)


def cfg8_of(hist):
    prov = hist.get("provenance") or {}
    routers = [hist.get("router")]
    s = str(hist.get("run_id")) + json.dumps(prov.get("stack"), sort_keys=True) + json.dumps(routers)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:8]


def degraded_of(hist, n_segments, n_refused=0):
    reasons = []
    if not hist.get("ok"):
        reasons.append("ok=false")
    if hist.get("state") != "done":
        reasons.append(f"state={hist.get('state')}")
    if n_segments and n_refused == n_segments:
        reasons.append("all segments guard-refused")
    if n_segments == 0 and ((hist.get("cut") or {}).get("covered_fraction") or 0) > 0.5:
        reasons.append("zero segments with cut.covered_fraction>0.5")
    return bool(reasons), "; ".join(reasons) or None


def build_track(hist, t0_ms, attempts=None):
    """-> (track dict, status). Pure function of the hist file and t0_ms (no clock reads), so re-running is byte-identical."""
    prov = hist.get("provenance") or {}
    stack = stack_of(hist)
    version = _safe((((hist.get("versions") or {}).get("pinned_prod_sha")) or "nosha")[:8])
    cfg8 = cfg8_of(hist)
    segs = []
    n_refused = 0
    for s in hist.get("segments") or []:
        a = t0_ms + int(round(float(s["start_s"]) * 1000))
        b = t0_ms + int(round(float(s["end_s"]) * 1000))
        # hist segments have two shapes: {.., score} and {.., confidence, refused, refused_reason}. conf = score if present
        # else confidence; the guard verdict is carried per segment, never flattened into an empty ordinary segment.
        conf = s.get("score") if s.get("score") is not None else s.get("confidence")
        seg = {"t0_ms": a, "t1_ms": max(a, b), "text": s.get("text"), "lang": s.get("lang"), "conf": conf,
               "extras": {"engine": s.get("engine")}}
        if s.get("score") is None and s.get("confidence") is not None:
            seg["extras"]["confidence"] = s.get("confidence")
        if "refused" in s:
            seg["extras"]["refused"] = s.get("refused")
            seg["extras"]["refused_reason"] = s.get("refused_reason")
            n_refused += 1 if s.get("refused") else 0
        if b < a:
            seg["extras"]["end_before_start"] = True
        segs.append(seg)
    degraded, why = degraded_of(hist, len(segs), n_refused)
    ok = bool(hist.get("ok"))
    if not ok:
        status, reason = "failed", str(hist.get("error") or hist.get("state") or "ok=false")
    elif segs:
        status, reason = "ok", None
    else:
        status, reason = "empty", "no segments in hist run"
    cut = hist.get("cut") or {}
    track = {
        "schema": SCHEMA_VERSION, "window_id": hist["window_id"], "layer": LAYER, "engine": f"router-twin-{stack}",
        "model": f"router-twin-{stack}", "version": version,
        "config": {"run_id": hist.get("run_id"), "routers": [hist.get("router")], "stack_id": prov.get("stack_id")},
        "config_hash": cfg8, "machine": hist.get("node") or "unknown", "status": status, "reason": reason, "segments": segs,
        "extras": {
            "run_id": hist.get("run_id"), "language_timeline": hist.get("language_timeline"),
            "dominant_language": hist.get("dominant_language"), "indic_script_share": hist.get("indic_script_share"),
            "english_dominant": hist.get("english_dominant"), "english_span_share": hist.get("english_span_share"),
            "router_status": hist.get("router_status"), "state": hist.get("state"), "ok": hist.get("ok"),
            "error": hist.get("error"), "guards": prov.get("guards"), "not_run": prov.get("not_run"),
            "cut": {"n_chunks": cut.get("n_chunks"), "covered_fraction": cut.get("covered_fraction"),
                    "gap_s": cut.get("gap_s"), "duration_s": cut.get("duration_s"),
                    "chunk_r2_keys": [c.get("r2_key") for c in (cut.get("chunks_used") or [])],
                    "chunks_dropped": cut.get("chunks_dropped")},
            **({"mining_only": hist["mining_only"]} if "mining_only" in hist else {}),
            "n_segments": len(segs), "n_refused": n_refused, "assembled_collapse": hist.get("assembled_collapse"),
            **({"attempts": attempts} if attempts else {}),
            "degraded": degraded, "degraded_reason": why,
        },
    }
    validate_track(track)
    return track, status


def find_window(root, room, wid, hist_t0_ms, hist_date_dir, aliases):
    """-> (ist_date, window_id, manifest|None, alias_used). Looks for an existing REB manifest at the hist id (in the IST date of
    t0 and in the hist file's date dir); failing that, via the alias map, accepting a candidate only if its manifest start time
    matches the hist start (never by id alone)."""
    dates = []
    for d in (ist_date_of(hist_t0_ms), hist_date_dir):
        if d and d not in dates:
            dates.append(d)

    def load(d, w):
        p = os.path.join(root, d, room, w, "manifest.json")
        if os.path.isfile(p):
            try:
                return json.load(open(p))
            except (OSError, json.JSONDecodeError):
                return None
        return None

    for d in dates:
        m = load(d, wid)
        if m:
            return d, wid, m, False
    for a in aliases or []:
        if wid not in (a.get("old_id"), a.get("new_id")):
            continue
        parts = (a.get("reb_window") or "").split("/")
        if len(parts) != 3 or parts[1] != room:
            continue
        for w in {a.get("old_id"), a.get("new_id")}:
            for d in {parts[0], *dates}:
                m = load(d, w)
                if m and abs(int(m.get("t0_ms", 0)) - hist_t0_ms) < 1000:
                    return d, w, m, True
    return dates[0], wid, None, False


def index_manifests_by_start(root):
    """{(room, t0_ms): (ist_date, window_id)} over the REB manifests on disk (one pass per run). Used to resolve a hist window whose
    id has no manifest but whose room + start already has one under another id (spec section 2)."""
    idx = {}
    if not os.path.isdir(root):
        return idx
    for date in os.listdir(root):
        dd = os.path.join(root, date)
        if not os.path.isdir(dd) or date.startswith("_"):
            continue
        for room in os.listdir(dd):
            rd = os.path.join(dd, room)
            if not os.path.isdir(rd):
                continue
            for wid in os.listdir(rd):
                p = os.path.join(rd, wid, "manifest.json")
                try:
                    m = json.load(open(p))
                    idx.setdefault((room, int(m["t0_ms"])), (date, wid))
                except (OSError, ValueError, KeyError, TypeError):
                    continue
    return idx


def iter_hist(runs_dir, run=None, since=None):
    for r in sorted(os.listdir(runs_dir)):
        if run and r != run:
            continue
        if since:
            m = re.search(r"(\d{8}T\d{4})", r)
            if not m or m.group(1) < since:
                continue
        rd = os.path.join(runs_dir, r)
        if not os.path.isdir(rd):
            continue
        for room in sorted(os.listdir(rd)):
            for date in sorted(os.listdir(os.path.join(rd, room))):
                dd = os.path.join(rd, room, date)
                if os.path.isdir(dd):
                    for f in sorted(os.listdir(dd)):
                        if f.endswith(".json") and not ATTEMPT_RE.search(f):
                            yield os.path.join(dd, f), date


def convert_one(path, date_dir, root, is_held, aliases, write, outbox, ts, cnt, backfill=frozenset(), deferred=None, start_index=None):
    cnt["seen"] += 1
    hist = json.load(open(path))
    room = hist["room_id"]
    h0, h1 = parse_iso_ms(hist["start"]), parse_iso_ms(hist["end"])
    if window_held(is_held, room, h0, h1):
        cnt["blind_refused"] += 1
        return
    ist_date, wid, manifest, alias_used = find_window(root, room, hist["window_id"], h0, date_dir, aliases)
    if manifest is None and start_index:
        hit = start_index.get((room, h0))
        if hit:   # same room + same start already has a manifest under another id: write INTO it (never a second manifest)
            ist_date, wid = hit
            manifest = json.load(open(os.path.join(root, ist_date, room, wid, "manifest.json")))
            cnt["start_resolved"] += 1
    if manifest is None and is_backfill_window(backfill, room, wid, h0):
        # BACKFILL will write this window's real manifest (real audio); a placeholder manifest made here would win the race and
        # write_track would then ignore BACKFILL's stub. Defer: a later per-chunk run writes it once the manifest exists.
        cnt["deferred_backfill_window"] += 1
        if deferred is not None:
            deferred.append({"window_id": wid, "room": room, "date": date_dir, "run_path": path})
        return
    if alias_used:
        cnt["alias_resolved"] += 1
    if manifest:
        t0, t1 = int(manifest["t0_ms"]), int(manifest["t1_ms"])
        cnt["t0_from_manifest"] += 1
        if abs(t0 - h0) >= 1000:
            cnt["t0_mismatch"] += 1
        if window_held(is_held, room, t0, t1):   # the manifest's own clock is guarded too
            cnt["blind_refused"] += 1
            return
    else:
        t0, t1 = h0, h1
        cnt["new_manifest"] += 1
    hist = dict(hist, window_id=wid)
    attempts = read_attempts(path)
    if attempts:
        cnt["attempts_carried"] += len(attempts)
    track, status = build_track(hist, t0, attempts)
    cnt[{"ok": "ok", "empty": "empty", "failed": "failed"}[status]] += 1
    if track["extras"]["degraded"]:
        cnt["degraded"] += 1
    body = json.dumps(track, ensure_ascii=False, indent=1, sort_keys=True).encode("utf-8")
    sha = hashlib.sha256(body).hexdigest()
    fname = writer.track_filename(track["layer"], track["engine"], track["version"], track["config_hash"])
    for n, v in (("ist_date", ist_date), ("room_id", room), ("window_id", wid), ("engine", track["engine"]),
                 ("version", track["version"])):
        writer._check_component(n, v)
    tdir = os.path.join(root, ist_date, room, wid, "tracks")
    path_out = os.path.join(tdir, fname)
    writer._assert_under_root(path_out, root)
    if os.path.exists(path_out):
        if hashlib.sha256(open(path_out, "rb").read()).hexdigest() == sha:
            cnt["skipped_existing"] += 1
        else:
            cnt["conflicts"] += 1
            if write:
                cdir = os.path.join(tdir, "_conflicts")
                os.makedirs(cdir, exist_ok=True)
                writer._write_file_atomic_create(os.path.join(cdir, fname[:-5] + f".conflict-{ts}.json"), body)
        return
    if not write:
        cnt["would_write"] += 1
        return
    started = hist.get("started_at") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    finished = (hist.get("provenance") or {}).get("created_at") or started
    cut = hist.get("cut") or {}
    first = ((cut.get("chunk_keys") or [None])[0]) or "none"
    stub = {"window_id": wid, "room_id": room, "room_slug": room, "ist_date": ist_date, "t0_ms": t0, "t1_ms": t1,
            "clock": "approx", "source_kind": "room_tape",
            "audio": {"r2_key": f"hist-chunks:{first}", "sha256": "unknown:from_hist", "sample_rate": 0,
                      "duration_ms": int(round(float(cut.get("duration_s") or (t1 - t0) / 1000) * 1000))}}
    try:
        writer.write_track(root, ist_date, room, wid, track, manifest_stub=stub, started_at=started, finished_at=finished,
                           config_hash=track["config_hash"])
    except writer.TrackExistsError:   # lost a create race: same body => skipped, different => conflict (never overwrite)
        if hashlib.sha256(open(path_out, "rb").read()).hexdigest() == sha:
            cnt["skipped_existing"] += 1
        else:
            cnt["conflicts"] += 1
        return
    entry_path = os.path.relpath(path_out, root)
    os.makedirs(os.path.dirname(outbox), exist_ok=True)
    line = {"window_id": wid, "ist_date": ist_date, "room_id": room, "t0_ms": t0, "t1_ms": t1, "layer": track["layer"],
            "engine": track["engine"], "model": track["model"], "version": track["version"],
            "config_hash": track["config_hash"], "shadow": False, "status": status, "reason": track["reason"],
            "machine": track["machine"], "r2_key": "reb/" + entry_path, "sha256": sha, "bytes": len(body),
            "started_at": started, "finished_at": finished}
    with open(outbox, "a") as f:
        f.write(json.dumps(line, ensure_ascii=False, sort_keys=True) + "\n")
    cnt["written"] += 1


def run(args, runs_dir=HIST_RUNS, root=REB_ROOT, is_held=None, aliases=None, outbox=None, log_dir=OUT_DIR, wreb=WREB):
    if args.write and r2_mirror.enabled():
        sys.exit("REB_R2_MIRROR is on: from_hist must not push to R2 in this step; unset it")
    is_held = is_held or load_heldout()
    if aliases is None:
        aliases = load_aliases()
    outbox = outbox or os.path.join(root, "_outbox", "index-pending.jsonl")
    ts = time.strftime("%Y%m%dT%H%M%S")
    cnt = {k: 0 for k in COUNTERS}
    backfill, cnt["worklist_rows"] = load_backfill_windows(wreb)   # raises (fail closed) if it reads 0 rows
    start_index = index_manifests_by_start(root)
    deferred = []
    for i, (p, date_dir) in enumerate(iter_hist(runs_dir, args.run, args.since)):
        if args.limit and i >= args.limit:
            break
        try:
            convert_one(p, date_dir, root, is_held, aliases, args.write, outbox, ts, cnt, backfill, deferred, start_index)
        except Exception as e:  # noqa: BLE001 - one bad file never stops the batch; count only, class only
            cnt["errors"] += 1
            cnt.setdefault("error_classes", {})
            cnt["error_classes"][type(e).__name__] = cnt["error_classes"].get(type(e).__name__, 0) + 1
    mode = "write" if args.write else "dry-run"
    summary = f"from_hist {mode} run={args.run} since={args.since} limit={args.limit} " + json.dumps(cnt, sort_keys=True)
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, f"from_hist-{ts}.log"), "w") as f:
            f.write(summary + "\n")
        if deferred:
            with open(os.path.join(log_dir, f"from_hist-deferred-{ts}.jsonl"), "w") as f:
                f.writelines(json.dumps(d, sort_keys=True) + "\n" for d in deferred)
    print(summary)
    return cnt


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--run")
    g.add_argument("--since", help="run-id timestamp YYYYMMDDTHHMM; converts runs at or after it")
    g.add_argument("--all", action="store_true")
    ap.add_argument("--write", action="store_true", help="actually write (default is dry-run: counts only)")
    ap.add_argument("--dry-run", action="store_true", help="default; kept for explicitness")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args(argv)
    if a.write and a.dry_run:
        ap.error("--write and --dry-run are exclusive")
    run(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
