"""classify_pre_2oct.py: READ-ONLY census of every REB room window dated before 2026-10-02 (ORDERS-PALIMPSEST-12A), to size a Sarvam backfill.

No Sarvam call, no GPU, no pyannote/Nemotron run, nothing written to the store. Counts only (no window text is read at all).

Population: manifests dated < 2026-10-02 under the REB root (not _consults), source_kind not dev_clip / suite_synthetic. Excluded and counted BEFORE any
track or audio is read: `sealed` (window id in from_hist.SEALED_WINDOWS) and `blind` (from_hist.load_heldout, fail closed; empty after the 10 Oct lift).
Audio: sarvam_lane.window_plan in dry-run use (read-only; verifies the sha of the cut local window file, or of every overlapping tape chunk). A window whose audio
is not verifiably on the box is `audio_missing` / `sha_mismatch`, reported per week and NOT classified. Hours are (t1_ms - t0_ms) / 3600000.
Weeks: ISO week of the IST date of t0.

Label (7A classifier, kit/reb/classify_windows.py, unchanged): speaker turns from the latest-finished live ok diar.pyannote-local-twin track (EVIDENCE already on
the box; no new pyannote run). A live pyannote track with status "empty" is a measured zero -> QUIET. Windows with no pyannote track are looked up for a
diar.nemotron* track; none exist for dates before 2 Oct (the count is reported), so such a window is UNCLASSIFIED (reason no_turns) and, if a nemotron track
did exist, UNCLASSIFIED (reason nemotron_unsupported) rather than guessed. The clinic-wide visit overlap is NOT used (as in 7A without --visits), so
CONSULT-LIKE = longest_turn_taking_s >= 90 s and speech_frac not below 0.2 only through the 7A rule: label == label_turn_only.

Estimates (computed from measured inputs, never run):
- Nemotron on the T4 for UNCLASSIFIED audio: GPU h = hours x rtf (rtf = sum wall_s / sum audio_s over the ok rows of a real 10A nemotron lane log) ;
  build h = hours x (audio build seconds per audio hour measured with sarvam_lane.build_window_audio on up to 8 sampled windows of each audio source, into a temp dir that is removed; the dearer source is used); wall = (GPU + build)
  / share of the T4 (0.25 / 0.5 / 1.0 rows). Tape fetch: windows with no audio on the box need their tape chunks from R2: audio h x bytes per audio hour
  (tape manifest size_bytes / duration_ms), which is bulk traffic and only outside 07:30-21:30 IST.
- Sarvam for CONSULT-LIKE: audio h, jobs (one per window; plan_split gives 0 extra parts for windows <= 7200 s), wall = audio h / observed x
  (research windows: 136 windows, 34.0 audio h in 33 min = about 62x at 2 workers). Throttles: count of http 429 / throttled lines in the Sarvam ledger.
  Projection for the UNCLASSIFIED: consult-like share of the CLASSIFIED hours of the same week x unclassified hours (a projection, labelled as one).
"""
import argparse
import collections
import contextlib
import datetime
import glob
import json
import os
import subprocess
import sys
import time

from . import classify_windows as cw
from . import reb
from . import sarvam_lane as sl
from .from_hist import IST, SEALED_WINDOWS, load_heldout, window_held

CUTOFF = "2026-10-02"
OUT = "/home/eta/oc/palimpsest/out"
LEDGER_DIR = os.path.expanduser("~/eta-data/sarvam-ledger")
SKIP_KINDS = ("dev_clip", "suite_synthetic")
LABELS = ("CONSULT-LIKE", "STAFF/OTHER", "QUIET", "UNCLASSIFIED")
OBSERVED_X, OBSERVED_WORKERS = 136 * 900 / (33 * 60), 2            # 136 windows of 900 s in 33 min (SARVAM-WINDOWS-26-27SEP.md, 34.0 h)
SHARES = (0.25, 0.5, 1.0)


def iso_week(t0_ms):
    d = datetime.datetime.fromtimestamp(t0_ms / 1000, IST).date()
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def cached_sha():
    """A per-process cache around sarvam_lane._file_sha: a tape chunk shared by two windows is read once."""
    cache = {}
    real = sl._file_sha

    def f(path):
        if path not in cache:
            cache[path] = real(path)
        return cache[path]
    return f


def turns_of(track):
    return [(s["t0_ms"] / 1000.0, s["t1_ms"] / 1000.0, str(s.get("speaker"))) for s in track.segments]


def classify_window(w):
    """-> (label, reason). Only a live ok/empty diar.pyannote-local-twin track classifies; see the module docstring."""
    audio_s = (w.t1_ms - w.t0_ms) / 1000.0
    py = [t for t in w.tracks(layer="diar", engine="pyannote-local-twin") if t.status != "quarantined"]
    ok = sorted([t for t in py if t.status == "ok"], key=lambda t: t.entry.get("finished_at") or "")
    if ok:
        f = cw.diar_features(turns_of(ok[-1]), audio_s)
    elif any(t.status == "empty" for t in py):
        f = cw.diar_features([], audio_s)
    else:
        nem = [t for t in w.tracks(layer="diar") if t.engine.startswith("nemotron") and t.status == "ok"]
        return "UNCLASSIFIED", ("nemotron_unsupported" if nem else "no_turns")
    return cw.label_of(f["speech_frac"], f["longest_turn_taking_s"] or 0, None), "pyannote"


@contextlib.contextmanager
def patched_sha(fn):
    """Swap sarvam_lane._file_sha for `fn` (a caching wrapper) for the duration of the block only; always restored."""
    real = sl._file_sha
    if fn is not None:
        sl._file_sha = fn
    try:
        yield
    finally:
        sl._file_sha = real


def census(root, cutoff=CUTOFF, is_held=None, tapes=sl.TAPES, data=sl.HOME_DATA, sha=None, rows_out=None, progress=None, ivs_out=None, problems_out=None, samples_out=None):
    """-> (weeks, totals). weeks[week][bucket] = {"windows": n, "audio_s": s}; bucket is a label, "audio_missing", "sha_mismatch", "sealed" or "blind"."""
    is_held = is_held or load_heldout()   # fail closed
    with patched_sha(sha):
        return _census(root, cutoff, is_held, tapes, data, rows_out, progress, ivs_out, problems_out, samples_out)


def _census(root, cutoff, is_held, tapes, data, rows_out, progress, ivs_out, problems_out=None, samples_out=None):
    by_room = sl.load_tapes(os.path.join(tapes, "manifest.jsonl"))
    weeks = collections.defaultdict(lambda: collections.defaultdict(lambda: {"windows": 0, "audio_s": 0.0}))
    tot = collections.Counter()
    reasons = collections.Counter()
    for mp in sorted(glob.glob(os.path.join(root, "20*", "*", "*", "manifest.json"))):
        date = os.path.relpath(mp, root).split(os.sep)[0]
        if date >= cutoff:
            continue
        m = json.load(open(mp))
        tot["manifests"] += 1
        if m.get("source_kind") in SKIP_KINDS or not str(m.get("room_id", "")).startswith("room_"):
            tot["not_room_window"] += 1
            continue
        wk, dur = iso_week(int(m["t0_ms"])), (int(m["t1_ms"]) - int(m["t0_ms"])) / 1000.0
        tot["room_windows"] += 1

        def add(bucket):
            weeks[wk][bucket]["windows"] += 1
            weeks[wk][bucket]["audio_s"] += dur
            if ivs_out is not None:   # (room, week, bucket) -> [(t0_s, t1_s)], for the distinct-hours figures
                ivs_out.setdefault((m["room_id"], wk, bucket), []).append((int(m["t0_ms"]) / 1000.0, int(m["t1_ms"]) / 1000.0))
        if m["window_id"] in SEALED_WINDOWS:
            add("sealed")
            continue
        if window_held(is_held, m["room_id"], int(m["t0_ms"]), int(m["t1_ms"])):
            add("blind")
            continue
        try:
            plan = sl.window_plan(m, by_room, tapes, data)
        except sl.AudioProblem as e:
            add(e.kind)
            if problems_out is not None:
                problems_out.append({"window_id": m["window_id"], "week": wk, "room_id": m["room_id"], "kind": e.kind, "audio_s": dur,
                                     "audio_key_kind": ((m.get("audio") or {}).get("r2_key") or "").split(":")[0] or "none"})
            reasons[(e.kind, (m.get("audio") or {}).get("r2_key", "").split(":")[0] if (m.get("audio") or {}).get("r2_key", "").startswith(("local:", "hist-chunks:")) else "tape")] += 1
            continue
        tot["audio_ok"] += 1
        tot["src_" + plan["source"]] += 1
        if samples_out is not None and tot["src_" + plan["source"]] % 250 == 1 and len(samples_out.setdefault(plan["source"], [])) < 8:
            samples_out[plan["source"]].append((m, plan))      # every 250th window of each audio source, up to 8, for the build-cost timing
        tot["covered_short"] += 1 if plan["covered_ms"] < (int(m["t1_ms"]) - int(m["t0_ms"])) * 0.98 else 0
        label, why = classify_window(reb.Window(root, m, mp))
        reasons[(label, why)] += 1
        add(label)
        if rows_out is not None:
            rows_out.append({"window_id": m["window_id"], "week": wk, "label": label, "reason": why, "audio_s": dur})
        if progress and tot["audio_ok"] % 500 == 0:
            progress(tot["audio_ok"])
    return {k: {b: dict(v) for b, v in d.items()} for k, d in weeks.items()}, tot, reasons


def distinct_hours(ivs):
    """Same-room windows of different origin (hist-chunks vs local cut) overlap in time: distinct room-hours = per room, per week, the UNION of the intervals.
    -> {week: {bucket: h, "all": h, "missing_uncovered": h}}: `missing_uncovered` = audio_missing + sha_mismatch time NOT inside an audio-ok window of the same room."""
    out = collections.defaultdict(lambda: collections.defaultdict(float))
    by = collections.defaultdict(lambda: collections.defaultdict(list))        # (week, room) -> bucket -> intervals
    for (room, wk, bucket), iv in ivs.items():
        by[(wk, room)][bucket] += iv
    for (wk, room), bs in by.items():
        ok = [iv for b, v in bs.items() if b in LABELS for iv in v]
        miss = [iv for b in ("audio_missing", "sha_mismatch") for iv in bs.get(b, [])]
        okm = cw.merge(ok)
        for b, v in bs.items():
            out[wk][b] += cw.covered(cw.merge(v)) / 3600.0
        out[wk]["all"] += cw.covered(cw.merge([iv for v in bs.values() for iv in v])) / 3600.0
        out[wk]["audio_ok"] += cw.covered(okm) / 3600.0
        out[wk]["missing_uncovered"] += (cw.covered(cw.merge(miss + okm)) - cw.covered(okm)) / 3600.0
    return {w: {k: round(v, 2) for k, v in d.items()} for w, d in out.items()}


def pool_rtf(paths):
    wall = aud = n = 0
    for p in paths:
        r = rtf_from_lane_log_raw(p)
        wall, aud, n = wall + r[0], aud + r[1], n + r[2]
    return {"rtf": round(wall / aud, 5), "rows": n, "audio_h": round(aud / 3600, 2), "logs": len(paths)} if aud else None


def day_range(paths):
    r = []
    for p in paths:
        w, a, n = rtf_from_lane_log_raw(p)
        if a:
            r.append(round(w / a, 5))
    return {"min": min(r), "max": max(r), "logs": len(r)} if r else None


def rtf_from_lane_log_raw(path):
    wall = aud = n = 0
    for l in open(path):
        try:
            r = json.loads(l)
        except ValueError:
            continue
        if r.get("status") == "ok" and r.get("wall_s") and r.get("audio_s"):
            wall, aud, n = wall + r["wall_s"], aud + r["audio_s"], n + 1
    return wall, aud, n


def rtf_from_lane_log(path):
    wall = aud = n = 0
    for l in open(path):
        try:
            r = json.loads(l)
        except ValueError:
            continue
        if r.get("status") == "ok" and r.get("wall_s") and r.get("audio_s"):
            wall += r["wall_s"]
            aud += r["audio_s"]
            n += 1
    return {"rtf": round(wall / aud, 5), "rows": n, "audio_h": round(aud / 3600, 2)}


def ledger_counts(ledger_dir=LEDGER_DIR):
    c = collections.Counter()
    for f in glob.glob(os.path.join(ledger_dir, "*", "*.jsonl")):
        for l in open(f):
            try:
                r = json.loads(l)
            except ValueError:
                continue
            c["calls"] += 1
            c["throttled"] += 1 if r.get("throttled") or r.get("http_status") == 429 else 0
            c["http_429"] += 1 if r.get("http_status") == 429 else 0
    return dict(c)


def tape_bytes_per_audio_h(tapes=sl.TAPES):
    size = dur = 0
    for l in open(os.path.join(tapes, "manifest.jsonl")):
        if l.strip():
            r = json.loads(l)
            if r.get("source", "primary") == "primary" and r.get("size_bytes") and r.get("duration_ms"):
                size += r["size_bytes"]
                dur += r["duration_ms"]
    return size / (dur / 3600000.0)


def build_seconds_tape_windows(samples, runner=subprocess.run):
    """Time sarvam_lane.build_window_audio (the real ffmpeg build) on sampled windows (local cut files or tape chunks) into a throwaway temp dir; seconds per audio hour."""
    import shutil
    import tempfile
    wall = aud = 0.0
    for m, plan in samples:
        d = tempfile.mkdtemp(prefix="c12-build-")
        try:
            t = time.time()
            sl.build_window_audio(plan, d, int(m["t1_ms"]) - int(m["t0_ms"]), runner=runner)
            wall += time.time() - t
            aud += (int(m["t1_ms"]) - int(m["t0_ms"])) / 3600000.0
        except sl.AudioProblem:
            pass
        finally:
            shutil.rmtree(d, ignore_errors=True)
    return (wall / aud) if aud else None


def estimates(weeks, rtfs, build_s_per_h, bytes_per_h, ledger, distinct=None):
    """rtfs: {"best": rtf, "day": rtf} (the best case is the quiet overnight batch; the day case is the pooled hourly logs under T4 contention).
    With `distinct` (distinct_hours) the Nemotron hours, the tape fetch and the Sarvam hours use the de-overlapped room-hours; the window-hour figures stay beside them."""
    hrs = lambda b: sum(v.get(b, {}).get("audio_s", 0.0) for v in weeks.values()) / 3600.0
    dh = lambda b: sum(d.get(b, 0.0) for d in (distinct or {}).values())
    un_w, miss_w, cons_w = hrs("UNCLASSIFIED"), hrs("audio_missing") + hrs("sha_mismatch"), hrs("CONSULT-LIKE")
    un, cons = (dh("UNCLASSIFIED"), dh("CONSULT-LIKE")) if distinct else (un_w, cons_w)
    miss = dh("missing_uncovered") if distinct else miss_w
    est = {"unclassified_h_windows": round(un_w, 2), "unclassified_h_distinct": round(un, 2), "nemotron_runs": {}}
    for name, rtf in rtfs.items():
        gpu_h = un * rtf
        build_h = un * (build_s_per_h or 0) / 3600.0
        est["nemotron_runs"][name] = {"rtf": rtf, "gpu_h": round(gpu_h, 2), "build_h": round(build_h, 2),
                                      "wall_h_at_share": {str(x): round((gpu_h + build_h) / x, 2) for x in SHARES}}
    est.update({"audio_missing_h_windows": round(miss_w, 2), "audio_missing_h_not_covered_by_an_audio_ok_window": round(miss, 2),
                "tape_fetch_gb_for_uncovered": round(miss * bytes_per_h / 1e9, 2), "tape_mb_per_audio_h": round(bytes_per_h / 1e6, 1)})
    classified_h = sum(weeks_v.get(b, {}).get("audio_s", 0.0) for weeks_v in weeks.values() for b in LABELS[:3]) / 3600.0
    share = cons_w / classified_h if classified_h else 0.0
    ev = [w for w, v in weeks.items() if sum(v.get(b, {}).get("audio_s", 0.0) for b in LABELS[:3]) > 0]
    n_cons = sum(v.get("CONSULT-LIKE", {}).get("windows", 0) for v in weeks.values())
    w39 = {w: v for w, v in weeks.items() if w in ev}
    cls_w39 = sum(v.get(b, {}).get("audio_s", 0.0) for v in w39.values() for b in LABELS[:3]) / 3600.0
    share_w39 = sum(v.get("CONSULT-LIKE", {}).get("audio_s", 0.0) for v in w39.values()) / 3600.0 / cls_w39 if cls_w39 else 0.0
    un_w39 = sum(v.get("UNCLASSIFIED", {}).get("audio_s", 0.0) for v in w39.values()) / 3600.0
    sar = {"consult_like_h_windows": round(cons_w, 2), "consult_like_h_distinct": round(cons, 2), "jobs": n_cons, "observed_x_realtime": round(OBSERVED_X, 1),
           "workers": OBSERVED_WORKERS, "wall_h": round(cons / OBSERVED_X, 2), "ledger": ledger,
           "projection_a_w39_only": {"basis": "what the evidence shows: the consult-like share of W39's classified hours applied to W39's unclassified hours only",
                                     "share": round(share_w39, 4), "consult_like_h_in_unclassified": round(share_w39 * un_w39, 2),
                                     "total_audio_h": round(cons + share_w39 * un_w39, 2), "total_wall_h": round((cons + share_w39 * un_w39) / OBSERVED_X, 2)},
           "projection_b_assumption": {"basis": "ASSUMPTION: that W39 (26-27 Sep, the only week with classified windows: %s) share holds for every week's unclassified hours" % ",".join(sorted(ev)),
                                       "share": round(share, 4), "consult_like_h_in_unclassified": round(share * un, 2), "total_audio_h": round(cons + share * un, 2),
                                       "total_wall_h": round((cons + share * un) / OBSERVED_X, 2)},
           "suggested_cap_audio_h_per_wall_h": round(OBSERVED_X * 0.5, 1)}
    return {"nemotron": est, "sarvam": sar}


def table(weeks, totals, est, dist=None):
    cols = ("windows", "audio_h")
    L = ["# Pre-2-Oct room windows (counts only)", "",
         f"manifests {totals['manifests']}; not room windows {totals['not_room_window']}; room windows {totals['room_windows']}; audio ok {totals['audio_ok']}", "",
         "| week | windows | audio h | CONSULT-LIKE | STAFF/OTHER | QUIET | UNCLASSIFIED | audio_missing | sha_mismatch | sealed | blind |", "|---|---|---|---|---|---|---|---|---|---|---|"]
    keys = LABELS + ("audio_missing", "sha_mismatch", "sealed", "blind")
    g = collections.defaultdict(lambda: [0, 0.0])
    for wk in sorted(weeks):
        v = weeks[wk]
        n = sum(v[b]["windows"] for b in v)
        h = sum(v[b]["audio_s"] for b in v) / 3600.0
        cells = []
        for k in keys:
            x = v.get(k, {"windows": 0, "audio_s": 0.0})
            cells.append(f"{x['windows']} / {x['audio_s'] / 3600:.1f} h")
            g[k][0] += x["windows"]
            g[k][1] += x["audio_s"]
        L.append(f"| {wk} | {n} | {h:.1f} | " + " | ".join(cells) + " |")
        g["all"][0] += n
        g["all"][1] += h * 3600
    L.append("| ALL | {} | {:.1f} | ".format(g["all"][0], g["all"][1] / 3600) + " | ".join(f"{g[k][0]} / {g[k][1] / 3600:.1f} h" for k in keys) + " |")
    if dist:
        L += ["", "## Distinct room-hours (same-room windows overlap in time; union per room)", "", "| week | all | audio ok | UNCLASSIFIED | CONSULT-LIKE | missing, not covered by an audio-ok window |", "|---|---|---|---|---|---|"]
        tt = collections.Counter()
        for wk in sorted(dist):
            d = dist[wk]
            L.append(f"| {wk} | {d.get('all', 0)} | {d.get('audio_ok', 0)} | {d.get('UNCLASSIFIED', 0)} | {d.get('CONSULT-LIKE', 0)} | {d.get('missing_uncovered', 0)} |")
            for k in ("all", "audio_ok", "UNCLASSIFIED", "CONSULT-LIKE", "missing_uncovered"):
                tt[k] += d.get(k, 0)
        L.append(f"| ALL | {tt['all']:.1f} | {tt['audio_ok']:.1f} | {tt['UNCLASSIFIED']:.1f} | {tt['CONSULT-LIKE']:.1f} | {tt['missing_uncovered']:.1f} |")
    L += ["", "## Estimates (not run)", "", "```", json.dumps(est, indent=1), "```"]
    return "\n".join(L) + "\n"


def provenance():
    """The code that produced the numbers: git HEAD, and the sha256[:16] of the classifier and the planner file (refuter #11197, architect #11198)."""
    here = os.path.dirname(os.path.abspath(__file__))
    head = subprocess.run(["git", "-C", here, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    fsha = lambda n: __import__("hashlib").sha256(open(os.path.join(here, n), "rb").read()).hexdigest()[:16]
    return {"git_head": head, "classify_windows_sha16": fsha("classify_windows.py"), "sarvam_lane_sha16": fsha("sarvam_lane.py"), "classify_pre_2oct_sha16": fsha("classify_pre_2oct.py")}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", default=reb.DEFAULT_ROOT)
    ap.add_argument("--cutoff", default=CUTOFF)
    ap.add_argument("--nemotron-log", required=True, help="the quiet overnight clip-lanes-nemotron-*.jsonl job log (10A): the best-case RTF")
    ap.add_argument("--day-logs", nargs="*", default=[], help="hourly clip-lanes-nemotron-*.jsonl logs, pooled: the RTF under T4 contention")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args(argv)
    rows = []
    t = time.time()
    ivs, problems, samples = {}, [], {}
    weeks, tot, reasons = census(a.root, a.cutoff, sha=cached_sha(), rows_out=rows, ivs_out=ivs, problems_out=problems, samples_out=samples, progress=lambda n: print(f"audio_ok {n} {time.time() - t:.0f}s", file=sys.stderr))
    rtf = rtf_from_lane_log(a.nemotron_log)
    day = pool_rtf(a.day_logs)
    bs_local = build_seconds_tape_windows(samples.get("local_window", []))
    bs_tape = build_seconds_tape_windows(samples.get("tape_chunks", []))
    bs = max(x for x in (bs_local, bs_tape) if x is not None) if (bs_local or bs_tape) else None        # the dearer of the two, so the estimate is not low
    dist = distinct_hours(ivs)
    rtfs = {"best_overnight": rtf["rtf"]}
    if day:
        rtfs["day_pooled"] = day["rtf"]
    rtfs["order_assumption_0.012"] = 0.012
    est = estimates(weeks, rtfs, bs, tape_bytes_per_audio_h(), ledger_counts(), dist)
    est["nemotron"]["rtf_source"] = {"best_overnight": rtf, "day_pooled": day, "build_s_per_audio_h_used": None if bs is None else round(bs, 1),
                                     "build_s_per_audio_h_local_cut": None if bs_local is None else round(bs_local, 1),
                                     "build_s_per_audio_h_tape_chunks": None if bs_tape is None else round(bs_tape, 1),
                                     "build_samples": {k: len(v) for k, v in samples.items()}, "day_per_log_range": day_range(a.day_logs)}
    res = {"provenance": provenance(), "cutoff": a.cutoff, "totals": dict(tot), "reasons": {f"{k[0]}:{k[1]}": v for k, v in sorted(reasons.items())}, "weeks": weeks, "distinct_room_hours": dist, "estimates": est}
    stamp = datetime.datetime.now().strftime("%Y%m%dT%H%M%S")
    os.makedirs(a.out, exist_ok=True)
    for name, body in (("CLASSIFY-PRE-2OCT.json", json.dumps(res, indent=1)), ("CLASSIFY-PRE-2OCT.md", table(weeks, tot, est, dist)),
                       ("CLASSIFY-PRE-2OCT-ROWS.jsonl", "\n".join(json.dumps(r) for r in rows) + "\n"),
                       ("CLASSIFY-PRE-2OCT-AUDIO-PROBLEMS.jsonl", "\n".join(json.dumps(r) for r in problems) + "\n")):
        p = os.path.join(a.out, name)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(body)
        os.chmod(p, 0o600)
    print(json.dumps({"totals": dict(tot), "stamp": stamp}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
