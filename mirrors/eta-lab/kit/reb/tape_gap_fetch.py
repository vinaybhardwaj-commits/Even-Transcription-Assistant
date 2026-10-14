"""tape_gap_fetch.py: plan and (off-hours) fetch the room-tape chunks that the audio-problem windows lack (ORDERS-PALIMPSEST-13A B5).

Input: the 12A audio-problem list (out/CLASSIFY-PRE-2OCT-AUDIO-PROBLEMS.jsonl: window_id, room_id, kind) and the REB manifests. Every problem window is sorted into one of
  rebuild_on_box   the room's tape chunks that overlap the window are all in the tape manifest AND on the box already (sha-verified by the planner): no network, the window just needs the
                   planner's tape fallback (sarvam_lane.window_plan(fallback_tape=True)), because its manifest names a cut local file that is missing / differs;
  fetch            no chunk of the window is on the box: its chunks must come from R2 (eta-audio) through the EXISTING puller;
  already_covered  (not reported as a problem any more once chunks are on the box).
Plan (dry run, the default): per room, the chunk rows for the merged time ranges of the `fetch` windows from Neon (READ-ONLY SELECT through kit/neon-select.mjs, the puller's own reader,
credentials stay inside that process): chunks, verified chunks, hours, bytes, and how many of the windows the verified chunks would cover. Counts only.
Fetch (--fetch) is DISABLED by the architect's ruling #11330 (V's standing rule on the r2_audio_read key); the text below describes what it would do. It would run ONLY between 21:30 and 07:30 IST (the Mini is quiet; bulk traffic rule) and only up to --max-gb. It does not download anything itself: it runs the consult-lead puller
~/oc/consult/cutter/tools/tape_pull_room.py once per (room, range) in the R2-read-key venv. That tool pulls verified chunks only, checks the size against the DB size_bytes, never overwrites,
writes to a temp name then renames, and appends the sha256 of the bytes to ~/eta-data/tapes/manifest.jsonl, which is the manifest every later window plan verifies against. The window plan
then finds the new chunks by room and time. NOTE: the DB carries no sha, so the "verification against the tape manifest" is size equality at fetch + the sha recorded at fetch, checked by the
planner on every later use; there is no independent expected sha for chunks older than 25 Sep.
"""
import argparse
import collections
import datetime
import glob
import json
import os
import subprocess
import sys

from . import sarvam_lane as sl
from .from_hist import IST

PROBLEMS = "/home/eta/oc/palimpsest/out/CLASSIFY-PRE-2OCT-AUDIO-PROBLEMS.jsonl"
NEON = os.path.expanduser("~/dev/eta-lab/kit/neon-select.mjs")
ETA = os.path.expanduser("~/dev/Even-Transcription-Assistant")
PULLER = os.path.expanduser("~/oc/consult/cutter/tools/tape_pull_room.py")
PY_R2 = os.path.expanduser("~/.venv-r2/bin/python")
QUIET_FROM, QUIET_TO = datetime.time(21, 30), datetime.time(7, 30)   # IST
MAX_GB = 1.0
SLACK_MS = 60_000


def in_quiet_hours(now=None):
    t = (now or datetime.datetime.now(IST)).timetz().replace(tzinfo=None)
    return t >= QUIET_FROM or t < QUIET_TO


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_problems(path=PROBLEMS, root=sl.REB_ROOT):
    """-> [{window_id, room_id, kind, t0_ms, t1_ms, ist_date}] from the problem list joined to the manifests."""
    out = []
    for l in open(path):
        if not l.strip():
            continue
        p = json.loads(l)
        mp = glob.glob(os.path.join(root, "*", p["room_id"], p["window_id"], "manifest.json"))
        if mp:
            m = json.load(open(mp[0]))
            out.append({"window_id": p["window_id"], "room_id": p["room_id"], "kind": p["kind"], "t0_ms": int(m["t0_ms"]), "t1_ms": int(m["t1_ms"]), "ist_date": m["ist_date"]})
    return out


def classify(problems, by_room, tapes=sl.TAPES):
    """-> {window_id: 'rebuild_on_box' | 'fetch'} by the tape manifest and the files on the box."""
    out = {}
    for w in problems:
        ch = [r for r in by_room.get(w["room_id"], []) if sl._iso_ms(r["started_at"]) < w["t1_ms"] and sl._iso_ms(r["started_at"]) + r["duration_ms"] > w["t0_ms"]]
        out[w["window_id"]] = "rebuild_on_box" if ch and all(os.path.exists(os.path.join(tapes, r["path"])) for r in ch) else "fetch"
    return out


def ok_intervals(root, problem_ids, skip_kinds=("dev_clip", "suite_synthetic", "consult_clip")):
    """Per room, the [t0, t1) of every room window that is NOT on the problem list (those have audio): {room: sorted merged [(t0_ms, t1_ms)]}."""
    by = collections.defaultdict(list)
    for mp in glob.glob(os.path.join(root, "20*", "room_*", "*", "manifest.json")):
        m = json.load(open(mp))
        if m.get("source_kind") in skip_kinds or m["window_id"] in problem_ids:
            continue
        by[m["room_id"]].append((int(m["t0_ms"]), int(m["t1_ms"])))
    return {room: merge(iv) for room, iv in by.items()}


def merge(iv):
    out = []
    for a, b in sorted(iv):
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def uncovered_ms(w, ok):
    """Milliseconds of the window that no audio-ok window of the same room covers."""
    free = w["t1_ms"] - w["t0_ms"]
    for a, b in ok.get(w["room_id"], []):
        free -= max(0, min(b, w["t1_ms"]) - max(a, w["t0_ms"]))
    return free


def merge_ranges(windows):
    """Per room, the windows' [t0, t1] merged when they touch or overlap -> {room: [(t0_ms, t1_ms)]}."""
    by = collections.defaultdict(list)
    for w in windows:
        by[w["room_id"]].append((w["t0_ms"], w["t1_ms"]))
    out = {}
    for room, iv in by.items():
        iv.sort()
        m = [list(iv[0])]
        for a, b in iv[1:]:
            if a <= m[-1][1]:
                m[-1][1] = max(m[-1][1], b)
            else:
                m.append([a, b])
        out[room] = [tuple(x) for x in m]
    return out


def neon(q, runner=subprocess.run):
    r = runner(["node", NEON, q], cwd=ETA, capture_output=True, text=True, timeout=300)
    if r.returncode:
        raise RuntimeError(f"neon-select rc={r.returncode}")
    return json.loads(r.stdout)


def chunk_rows(room, t0_ms, t1_ms, runner=subprocess.run):
    assert room.replace("_", "").isalnum()
    return neon("SELECT c.id, c.started_at, c.duration_ms, c.size_bytes, c.upload_state FROM bench_chunk c JOIN bench_session bs ON bs.id=c.session_id "
                f"WHERE bs.room_id = '{room}' AND c.started_at >= '{iso(t0_ms - SLACK_MS)}' AND c.started_at <= '{iso(t1_ms)}' ORDER BY c.started_at", runner)


def plan(problems, by_room, tapes=sl.TAPES, query=chunk_rows, cap_gb=MAX_GB, ok=None, min_new_s=300):
    cls = classify(problems, by_room, tapes)
    resc = [w for w in problems if cls[w["window_id"]] == "rebuild_on_box"]
    fetch_all = [w for w in problems if cls[w["window_id"]] == "fetch"]
    # with `ok` (audio-ok intervals) only the windows that add at least min_new_s of NEW time are fetched; the others lie inside audio the box already has
    fetch = [w for w in fetch_all if ok is None or uncovered_ms(w, ok) >= min_new_s * 1000]
    h = lambda ws: round(sum(w["t1_ms"] - w["t0_ms"] for w in ws) / 3.6e6, 2)
    new_h = round(sum(uncovered_ms(w, ok) for w in fetch) / 3.6e6, 2) if ok is not None else None
    res = {"problem_windows": len(problems), "rebuild_on_box": {"windows": len(resc), "window_h": h(resc), "network_bytes": 0},
           "fetch_all_problem_windows": {"windows": len(fetch_all), "window_h": h(fetch_all)}, "fetch": {"windows": len(fetch), "window_h": h(fetch)}, "ranges": [], "by_kind": {f"{k[0]}:{k[1]}": v for k, v in collections.Counter((w["kind"], cls[w["window_id"]]) for w in problems).items()}}
    tot = collections.Counter()
    for room, ranges in sorted(merge_ranges(fetch).items()):
        for t0, t1 in ranges:
            try:
                rows = query(room, t0, t1)
            except RuntimeError as e:   # a failed read-only query is reported per range, never fatal
                res["ranges"].append({"room": room, "from": iso(t0), "to": iso(t1), "query_error": str(e)[:60]})
                tot["query_errors"] += 1
                continue
            ver = [r for r in rows if r["upload_state"] == "verified"]
            covered = [w for w in fetch if w["room_id"] == room and w["t0_ms"] >= t0 and w["t1_ms"] <= t1
                       and any(sl._iso_ms(r["started_at"]) < w["t1_ms"] and sl._iso_ms(r["started_at"]) + int(r["duration_ms"] or 0) > w["t0_ms"] for r in ver)]
            item = {"room": room, "from": iso(t0), "to": iso(t1), "range_h": round((t1 - t0) / 3.6e6, 2), "db_chunks": len(rows), "verified": len(ver),
                    "verified_h": round(sum(int(r["duration_ms"] or 0) for r in ver) / 3.6e6, 2), "bytes": sum(int(r["size_bytes"] or 0) for r in ver), "windows_touched": len(covered)}
            res["ranges"].append(item)
            tot["chunks"] += len(ver); tot["bytes"] += item["bytes"]; tot["windows_touched"] += len(covered)
    res["fetch"].update({"new_time_h_not_in_any_audio_ok_window": new_h, "ranges": len(res["ranges"]), "verified_chunks": tot["chunks"], "bytes": tot["bytes"], "gb": round(tot["bytes"] / 1e9, 3), "windows_with_a_verified_chunk": tot["windows_touched"], "query_errors": tot["query_errors"],
                         "windows_without_any_db_chunk": len(fetch) - tot["windows_touched"], "within_cap": tot["bytes"] <= cap_gb * 1e9})
    return res


def fetch(plan_res=None, **_):
    """DISABLED (architect #11330 ruling 3): the puller uses the r2_audio_read key, and V's standing rule is to use that key for nothing new until he rules on it. Only the plan
    (Neon read-only SELECT, no R2 call) and the no-network rebuild of the windows whose chunks are already on the box remain. The quiet-hours / cap logic below is kept for the day V allows it."""
    raise SystemExit("--fetch is disabled: no new use of the r2_audio_read key until V rules (architect #11330)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--problems", default=PROBLEMS)
    ap.add_argument("--root")
    ap.add_argument("--fetch", action="store_true", help="DISABLED (architect #11330): refuses; the plan is the only mode")
    ap.add_argument("--max-gb", type=float, default=MAX_GB)
    a = ap.parse_args(argv)
    root = a.root or sl.REB_ROOT
    by_room = sl.load_tapes(os.path.join(sl.TAPES, "manifest.jsonl"))
    problems = load_problems(a.problems, root)
    res = plan(problems, by_room, cap_gb=a.max_gb, ok=ok_intervals(root, {w["window_id"] for w in problems}))
    print(json.dumps(res, indent=1))
    if a.fetch:
        print(json.dumps(fetch(res, cap_gb=a.max_gb)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
