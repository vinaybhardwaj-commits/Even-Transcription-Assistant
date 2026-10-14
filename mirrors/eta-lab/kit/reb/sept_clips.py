"""sept_clips.py: the September consult clips (ORDERS-PALIMPSEST-14A), a one-off driver. Dry run by default (plans and counts only); --write runs the parts in the order 1, 3, 2, 4.

  part 1  CAA's results into the consult scope (caa_import: stt / translate.sarvam-saaras-v3 version "caa", source_kind consult_clip_external). In process. No Sarvam call.
  part 3  Sarvam on cut September clips ONLY where nothing has paid for the same speech: no CAA result file with the same consult_uid, no CAA clip (the CAA cuts manifest, dead clips excepted)
          covering >= 50% of the clip in the same room (union) or ANY CAA clip with sarvam_done = y overlapping it at all, and no palimpsest S2 window already sent to Sarvam covering >= 50% of it (the Sarvam ledger, use research scope window).
          Fails closed: the CAA manifest missing / unreadable / older than 3 h / malformed, or the CAA results directory missing. Sent in chunks of 50 with the manifest re-read before each chunk;
          `sarvam_lane --consult-list FILE --write --workers 2 --use-research` (ledger use research); stop rules: throttled > 0, failed > 5.
  part 2  the lab lanes (acoustics, nemotron, koyal, medasr) over the cut September clips dated --since..--until (clip_lanes --until), nemotron / koyal / medasr under the production-worker yield rule
          (--worker-status worker, the sleep excuse) and a stop file. Koyal needs the clip's Sarvam language, so it runs after part 3; a clip with no palimpsest Sarvam text is counted as skipped there.
  part 4  role.text-judge on September clips that have Sarvam text (role_text_judge --since --until --jev real --write); the track's extras.derived_from.text_source says "palimpsest" or "caa".
          CAA's own consults are NOT judged here: they have no cutter-index row and their speakers are already CAA's doctor / patient / unknown labels (QUESTION to the architect).
A "September clip" is any CUT row of the cutter index dated --since..--until (default 2026-09-09..2026-10-01); consult-lead's pqm cuts land there. Counts only on the bus.
"""
import argparse
import collections
import glob
import json
import os
import sys
import time
import types

from . import caa_import
from . import sarvam_lane as sl
from . import s2_driver as s2
from . import reb

SINCE, UNTIL = "2026-09-09", "2026-10-01"
CAA_RESULTS = caa_import.SRC_DIR
STATE_DIR = "/home/eta/oc/palimpsest/out/sept"
LEDGER_DIR = os.path.expanduser("~/eta-data/sarvam-ledger")
COVER = 0.5
CHUNK = 50
PY = {"acoustics": os.path.expanduser("~/eta-diarize/venv/bin/python"), "nemotron": s2.PY_NEMO, "koyal": s2.PY_NEMO, "medasr": s2.PY_NEMO}
LANES = ("acoustics", "nemotron", "koyal", "medasr")
YIELD_LANES = ("nemotron", "koyal", "medasr")


class Unavailable(RuntimeError):
    pass


def cut_rows(index_path=sl.CLIP_INDEX, since=SINCE, until=UNTIL):
    return sorted([r for r in sl.latest_rows(index_path).values() if r.get("status") == "cut" and since <= r.get("ist_date", "") <= until], key=lambda r: (r["ist_date"], r["consult_uid"]))


def union_covered(clips, w0, w1):
    """Milliseconds of [w0, w1) covered by the UNION of the clips [(a, b)] (overlapping clips are not double counted). (The same rule as s2_driver's; kept local so this module does not depend on that PR.)"""
    covered, end = 0, None
    for a, b in sorted((max(a, w0), min(b, w1)) for a, b in clips if min(b, w1) > max(a, w0)):
        if end is None or a > end:
            covered += b - a
            end = b
        elif b > end:
            covered += b - end
            end = b
    return covered


def span_ms(row):
    return sl._ist_ms(row["span_start"]), sl._ist_ms(row["span_end"])


def caa_view(manifest=s2.CAA_MANIFEST, results_dir=CAA_RESULTS, labels=None, now=time.time, max_age_s=s2.CAA_MAX_AGE_S):
    """-> ({room_id: [(t0, t1, sarvam_done)]}, {consult_uid that CAA lists in its fresh manifest or has a result file for}). Fails closed (Unavailable) on an untrustworthy manifest or a missing results directory."""
    try:
        caa = s2.load_caa(manifest, labels, now=now, max_age_s=max_age_s)
    except s2.CaaUnavailable as e:
        raise Unavailable(f"CAA manifest: {e}")
    if not os.path.isdir(results_dir):
        raise Unavailable("CAA results directory missing")
    # "CAA has this consult" comes from the FRESH manifest (every consult_uid it lists, done or not: CAA is cutting / sending it) AND the result files on the box; a result the sync has not
    # brought yet (the manifest says done, no file in the directory) must still read as "CAA has it", never as "CAA hasn't" (refuter #11434)
    import csv
    uids = {r["consult_uid"] for r in csv.DictReader(open(manifest, newline="")) if r.get("consult_uid")}
    uids |= {os.path.basename(p)[:-5] for p in glob.glob(os.path.join(results_dir, "*.json"))}
    return {room: list(iv) for room, iv in caa.items()}, uids          # [(t0, t1, sarvam_done)] per room


def s2_sent(root=sl.REB_ROOT, ledger_dir=LEDGER_DIR):
    """-> {room_id: [(t0, t1)]}: the spans of the S2 windows already sent to Sarvam (ledger lines use research, scope window, task transcribe, status ok)."""
    ids = set()
    for f in glob.glob(os.path.join(ledger_dir, "*", "*.jsonl")):
        for l in open(f):
            try:
                r = json.loads(l)
            except ValueError:
                continue
            if r.get("use") == "research" and r.get("scope") == "window" and r.get("task") == "transcribe" and r.get("status") == "ok" and r.get("ref"):
                ids.add(r["ref"])
    out = collections.defaultdict(list)
    for wid in sorted(ids):
        try:
            m = reb.load_window(wid, root=root).manifest
        except Exception:  # noqa: BLE001 - a ledger ref that is not a window is not a covering span
            continue
        out[m["room_id"]].append((int(m["t0_ms"]), int(m["t1_ms"])))
    return dict(out)


def eligible(rows, caa, caa_uids, sent, cover=COVER):
    """-> (ids, {consult_uid: reason}). A clip is skipped for: caa_uid (CAA lists / has a result for this consult_uid), caa_done_overlap (any overlap with a CAA clip whose Sarvam job is done), caa_overlap (CAA's clips cover >= `cover` of it in its room),
    s2_window (S2 windows already in Sarvam cover >= `cover` of it)."""
    ids, why = [], {}
    for r in rows:
        uid, s0, s1 = r["consult_uid"], *span_ms(r)
        room = r["room_id"]
        clips = caa.get(room, [])
        if uid in caa_uids:
            why[uid] = "caa_uid"
        elif any(done and min(b, s1) > max(a, s0) for a, b, done in clips):
            why[uid] = "caa_done_overlap"      # ANY overlap with a CAA clip whose Sarvam job is done (the S2 phase-c rule; CAA clips are short, a pqm clip may be < 50% covered by the visit CAA already paid for)
        elif union_covered([(a, b) for a, b, _ in clips], s0, s1) >= cover * (s1 - s0):
            why[uid] = "caa_overlap"
        elif union_covered(sent.get(room, []), s0, s1) >= cover * (s1 - s0):
            why[uid] = "s2_window"
        else:
            ids.append(uid)
    return ids, why


def sarvam_clips(ids, a, run=s2.launch):
    f = s2.write_ids(a.state_dir, "sept-sarvam-ids.json", ids)
    cmd = [a.py_sarvam, "-m", "kit.reb.sarvam_lane", "--consult-list", f, "--write", "--workers", "2", "--use-research"]
    rc, out = run(cmd, env={"SARVAM_R2_KEY_FILE": os.environ.get("SARVAM_R2_KEY_FILE", s2.SARVAM_R2_KEY_FILE)})
    c = s2.parse_counters(out)
    if rc != 0 and not c.get("clips"):
        raise RuntimeError("sarvam_lane failed to start")
    return c


def part1(a):
    return caa_import.file_all(a.caa_results, root=a.root, write=a.write)


def part3(a, rows=None, sarvam=sarvam_clips, now=time.time):
    """-> counts. Chunked; the CAA view and the S2-sent spans are re-read before every chunk."""
    rows = cut_rows(a.index, a.since, a.until) if rows is None else rows
    pending = list(rows)
    out = collections.Counter({"clips": len(rows)})
    why_all, tot = {}, collections.Counter()
    first = True
    while pending or first:
        first = False
        try:
            caa, uids = caa_view(a.caa_manifest, a.caa_results, None, now=now)
        except Unavailable as e:
            out["stopped"] = "caa_unavailable"
            out["error"] = str(e)[:120]
            break
        chunk, pending = pending[:CHUNK], pending[CHUNK:]
        ids, why = eligible(chunk, caa, uids, s2_sent(a.root, a.ledger))
        why_all.update(why)
        out["would_send"] += len(ids)
        if a.write and ids:
            sar = sarvam(ids, a)
            for k in ("ok", "failed", "throttled", "errors", "skipped_existing", "clips"):
                tot[k] += sar.get(k, 0)
            tot["audio_h"] += sar.get("audio_h", 0)
            if tot["throttled"] > 0 or tot["failed"] > s2.STOP_SARVAM_FAILED:
                out["stopped"] = "sarvam_throttled" if tot["throttled"] > 0 else "sarvam_failed"
                break
    for k, v in collections.Counter(why_all.values()).items():
        out["skipped_" + k] = v
    if a.write:
        out["sent"] = {"ok": tot["ok"], "failed": tot["failed"], "throttled": tot["throttled"], "errors": tot["errors"], "audio_min": round(tot["audio_h"] * 60, 1)}
    return dict(out)


def part2(a, run=s2.launch):
    """-> {lane: counters}. Dry: clip_lanes in process (nothing decoded, no model); write: one process per lane in its own venv."""
    out = {}
    for lane in LANES:
        if not a.write:
            from . import clip_lanes as cl
            ns = types.SimpleNamespace(consult=None, date=None, since=a.since, until=a.until, write=False, limit=0, min_minutes=0, identified=False)
            out[lane] = cl.run(ns, lane, root=a.root, runner=types.SimpleNamespace(), gate=types.SimpleNamespace(), index_path=a.index, recut_pending=frozenset(), log_dir=None)
            continue
        cmd = [PY[lane], "-m", "kit.reb.clip_lanes", "--lane", lane, "--since", a.since, "--until", a.until, "--write", "--stop-file", s2.stop_file_of(a)]
        if lane in YIELD_LANES:
            cmd += ["--worker-status", a.worker_status] + (["--excuse-rate-cap-sleep"] if a.excuse_rate_cap_sleep else [])
        rc, txt = run(cmd)
        out[lane] = s2.parse_counters(txt).get("counts", {})
    return out


def part4(a, run=s2.launch):
    if not a.write:
        from . import role_text_judge as rj
        ns = types.SimpleNamespace(consult=None, date=None, since=a.since, until=a.until, write=False, limit=0, seed=None, min_minutes=0, identified=False)
        return rj.run(ns, root=a.root, index_path=a.index, jev=None)
    rc, txt = run([sys.executable, "-m", "kit.reb.role_text_judge", "--since", a.since, "--until", a.until, "--jev", "real", "--write"])
    return s2.parse_counters(txt).get("counts", {})


def drive(a, out=print, **kw):
    res = {"mode": "write" if a.write else "dry-run", "since": a.since, "until": a.until}
    parts = set(a.parts.split(","))
    for name, fn in (("1", part1), ("3", part3), ("2", part2), ("4", part4)):
        if name in parts:
            if a.write and s2.stop_requested(a) and name != "1":
                res["stopped"] = "stop_file"
                break
            res["part" + name] = fn(a, **kw.get("part" + name, {}))
            if res["part" + name].get("stopped") if isinstance(res["part" + name], dict) else False:
                res["stopped"] = res["part" + name]["stopped"]
                break
    out(json.dumps(res, sort_keys=True))
    return res


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--parts", default="1,2,3,4")
    ap.add_argument("--since", default=SINCE)
    ap.add_argument("--until", default=UNTIL)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--root", default=sl.REB_ROOT)
    ap.add_argument("--index", default=sl.CLIP_INDEX)
    ap.add_argument("--ledger", default=LEDGER_DIR)
    ap.add_argument("--caa-manifest", default=s2.CAA_MANIFEST)
    ap.add_argument("--caa-results", default=CAA_RESULTS)
    ap.add_argument("--state-dir", default=STATE_DIR)
    ap.add_argument("--stop-file")
    ap.add_argument("--worker-status", default="worker")
    ap.add_argument("--excuse-rate-cap-sleep", action="store_true", default=True)
    ap.add_argument("--py-sarvam", default=s2.PY_SARVAM)
    return ap


def main(argv=None):
    a = build_parser().parse_args(argv)
    if a.write and a.worker_status == "none":
        raise SystemExit("--write needs the production-worker signal (--worker-status worker)")
    res = drive(a)
    return 3 if res.get("stopped") else 0


if __name__ == "__main__":
    sys.exit(main())
