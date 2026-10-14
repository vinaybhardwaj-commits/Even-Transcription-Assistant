"""s2_driver.py: the S2 backfill driver (ORDERS-PALIMPSEST-13A B3). Per unit (an ISO week, newest first, or the orphan OPD 4 tape as its own unit):
  (a) Nemotron on the unit's UNCLASSIFIED windows   -> kit.reb.window_lanes   (nemo venv, T4 under ~/gpu.lock, yields to the production worker)
  (b) classify the unit again (7A rule, classify_windows.window_turns: pyannote evidence first, else the new diar.nemotron track)
  (c) Sarvam --research-windows on the unit's CONSULT-LIKE windows with audio coverage >= 0.99, 2 workers   -> kit.reb.sarvam_lane (sarvam venv; ledger use research scope window)
and one counts-only line per unit. Research use only (O5): results stay in the lab store.

The driver itself is stdlib + kit (system python3). Each lane runs as its OWN process in its OWN venv (one lane per process, as everywhere else): the driver builds a window-id
file under the state dir and launches `python -m kit.reb.window_lanes` / `kit.reb.sarvam_lane --research-windows`, then reads the single counters line they print (counts only).
Dry run is the default: it plans from the store (census with the audio planner, no GPU, no Sarvam, no write) and prints what each phase WOULD do.

Idempotent and resumable: every phase skips what already exists (skipped_existing), so rerunning a unit does only the remainder; a unit state file
<state-dir>/<unit>.json keeps the last counts line, and a unit marked done (nothing left to do) is skipped unless --force.

STOP RULES (checked after each phase; on a stop the driver prints `STOP <reason> unit=<unit>`, saves the state and exits 3, so a human posts and decides):
  sarvam throttled > 0 | sarvam failed > 5 | nemotron errors > 5 | the production worker behind for > 30 min (stopped=production_behind) | its status stale > 3 min (stopped=worker_stalled).
Selection options: --weeks W,W (default: every unit with work, newest first), --unit orphan (the orphan tape windows, source_kind room_tape_orphan), --phases a,b,c,
--evidence pyannote (phase c only on windows whose label comes from existing pyannote turns: the remaining 26-27 Sep CONSULT-LIKE windows), --min-coverage.
"""
import argparse
import collections
import csv
import json
import os
import subprocess
import sys
import time

from . import classify_pre_2oct as cp
from . import sarvam_lane as sl
from .from_hist import load_heldout

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE_DIR = "/home/eta/oc/palimpsest/out/s2"
PY_NEMO = os.path.expanduser("~/eta-data/nemotron/venv-nemo-main/bin/python")
PY_SARVAM = os.path.expanduser("~/.venv-sarvam/bin/python")
SARVAM_R2_KEY_FILE = os.path.expanduser("~/.claude/secrets/r2_lab_results_write")   # a path, as in hourly.sh; the contents are read only by sarvam_lane
ORPHAN_UNIT, ORPHAN_KIND = "orphan-opd4", "room_tape_orphan"
MIN_COVERAGE, SARVAM_WORKERS = 0.99, 2
STOP_SARVAM_FAILED, STOP_NEMOTRON_ERRORS = 5, 5
EXIT_STOP = 3
CAA_MANIFEST = "/home/eta/oc/palimpsest/in/caa/sep-caa-cuts-manifest.csv"   # copied from the Mini mirror hourly at :17 (architect #11352)
ROOM_LABELS = "/home/eta/oc/palimpsest/in/room-labels.json"
CAA_MAX_AGE_S, CAA_COVER_FRAC = 3 * 3600, 0.5
PLANNED_CSV = "/home/eta/oc/palimpsest/in/consult-sep/planned-clips.csv"   # consult-lead's phase-1 PLANNED Sept clips (architect #11427): all of them, planned / cut / dead
PLANNED_COLUMNS = ("consult_uid", "room_id", "t0_utc_ms", "t1_utc_ms", "status")
PLANNED_STATUSES = ("planned", "cut", "dead")
CAA_RELOAD_EVERY = 50   # windows per Sarvam chunk; the CAA manifest is re-read before each chunk (refuter #11359)
CAA_COLUMNS = ("consult_uid", "room", "t0_utc_ms", "t1_utc_ms", "sarvam_done", "clip_status")


class Stop(RuntimeError):
    def __init__(self, reason, unit, partial=None):
        super().__init__(f"STOP {reason} unit={unit}")
        self.reason, self.unit, self.partial = reason, unit, partial   # partial: what the unit had done when it stopped (phase c totals), so a stop does not lose the counts


# ---------------------------------------------------------------- the plan from the store
def unit_of_orphan(m):
    return ORPHAN_UNIT


def scan(root, units=None, orphan=False, is_held=None, tapes=sl.TAPES, data=sl.HOME_DATA, sha=None, cutoff=cp.CUTOFF, fallback_tape=True):
    """-> (rows, tot): one row per audio-ok room window of the selected units (see classify_pre_2oct.census rows)."""
    rows = []
    if orphan:
        _, tot, _ = cp.census(root, cutoff="9999-12-31", is_held=is_held, tapes=tapes, data=data, sha=sha, rows_out=rows, units={ORPHAN_UNIT}, unit_of=unit_of_orphan, kinds=(ORPHAN_KIND,), fallback_tape=fallback_tape)
    else:
        _, tot, _ = cp.census(root, cutoff=cutoff, is_held=is_held, tapes=tapes, data=data, sha=sha, rows_out=rows, units=units, kinds=("room_tape",), fallback_tape=fallback_tape)
    return rows, tot


def tally(rows):
    labels = collections.Counter(r["label"] for r in rows)
    return {"windows": len(rows), "audio_h": round(sum(r["audio_s"] for r in rows) / 3600, 2), "labels": {k: labels.get(k, 0) for k in cp.LABELS}}


def sarvam_ids(rows, min_coverage=MIN_COVERAGE, evidence="any"):
    """CONSULT-LIKE windows with coverage >= min_coverage that have no Sarvam stt track yet (+ evidence pyannote: only where the turns are the old pyannote evidence)."""
    return [r["window_id"] for r in rows if r["label"] == "CONSULT-LIKE" and r["coverage"] >= min_coverage and not r["sarvam"] and (evidence == "any" or r["reason"] == evidence)]


def units_with_work(rows_by_unit):
    return sorted(rows_by_unit, reverse=True)


# ---------------------------------------------------------------- CAA overlap (architect #11351/#11352): never pay Sarvam twice for the same speech
class CaaUnavailable(RuntimeError):
    """The CAA manifest cannot be trusted (missing / unreadable / stale / malformed / an unmapped room label): phase (c) refuses (fail closed)."""


def _room_ids_by_label(labels_path):
    rooms = json.load(open(labels_path))["rooms"]
    return [(r["label"], r["room_id"]) for r in rooms]


def load_caa(path=CAA_MANIFEST, labels_path=None, now=time.time, max_age_s=CAA_MAX_AGE_S, count_dead=False):
    """-> {room_id: [(t0_ms, t1_ms, sarvam_done)]} from the CAA cuts manifest. The manifest's `room` is a LABEL (OPD 1 ... Dietary); it maps to the room whose label equals it or
    starts with it plus a space (OPD 4 -> OPD 4 Ortho, Dietary -> Dietary OPD); no match or more than one match is an error. A `dead` clip (CAA could not cut it, so CAA sends no Sarvam job for it)
    is not counted unless count_dead. Anything else wrong -> CaaUnavailable."""
    try:
        age = now() - os.path.getmtime(path)
        rooms = _room_ids_by_label(labels_path or ROOM_LABELS)
        rows = list(csv.DictReader(open(path, newline="")))
    except (OSError, ValueError, KeyError, csv.Error) as e:
        raise CaaUnavailable(f"CAA manifest or room labels unreadable: {type(e).__name__}")
    if age > max_age_s:
        raise CaaUnavailable(f"CAA manifest is {int(age)} s old (limit {max_age_s})")
    if not rows or any(c not in rows[0] for c in CAA_COLUMNS):
        raise CaaUnavailable("CAA manifest has no rows or lacks a required column")
    out, cache = collections.defaultdict(list), {}
    for r in rows:
        label = (r["room"] or "").strip()
        if label not in cache:
            hit = [rid for lab, rid in rooms if lab == label or lab.startswith(label + " ")] if label else []
            if len(hit) != 1:
                raise CaaUnavailable(f"CAA room label {label!r} maps to {len(hit)} rooms")
            cache[label] = hit[0]
        try:
            t0, t1 = int(r["t0_utc_ms"]), int(r["t1_utc_ms"])
        except (TypeError, ValueError):
            raise CaaUnavailable("CAA manifest has a non-numeric time")
        done = (r["sarvam_done"] or "").strip().lower()
        if t1 <= t0 or done not in ("y", "n"):
            raise CaaUnavailable("CAA manifest has an invalid interval or sarvam_done value")
        if (r["clip_status"] or "").strip() == "dead" and not count_dead:
            continue
        out[cache[label]].append((t0, t1, done == "y"))
    return dict(out)


def caa_skip(rows, caa, cover=CAA_COVER_FRAC):
    """-> {window_id: 'sarvam_done' | 'cover'} for the windows S2 must NOT send: any overlap at all with a CAA clip whose Sarvam job is done, or the union of that room's CAA clips covering
    >= `cover` of the window (the stricter of the two rules, architect #11351)."""
    skip = {}
    for r in rows:
        clips = caa.get(r["room_id"], [])
        w0, w1 = r["t0_ms"], r["t1_ms"]
        if any(done and min(b, w1) > max(a, w0) for a, b, done in clips):
            skip[r["window_id"]] = "sarvam_done"
            continue
        if union_covered([(a, b) for a, b, _ in clips], w0, w1) >= cover * (w1 - w0):
            skip[r["window_id"]] = "cover"
    return skip


def union_covered(clips, w0, w1):
    """Milliseconds of [w0, w1) covered by the UNION of the clips [(a, b)] (overlapping clips are not double counted)."""
    covered, end = 0, None
    for a, b in sorted((max(a, w0), min(b, w1)) for a, b in clips if min(b, w1) > max(a, w0)):
        if end is None or a > end:
            covered += b - a
            end = b
        elif b > end:
            covered += b - end
            end = b
    return covered


class PlannedUnavailable(RuntimeError):
    """consult-lead's planned-clips file cannot be trusted (missing / unreadable / stale / malformed): phase (c) refuses (fail closed)."""


def planned_complete(path, rows):
    """architect #11457: the staleness limit is waived ONLY when consult-lead's runner has finished everything: the marker <csv without .csv>.COMPLETE exists, its mtime is >= the csv's mtime
    (written after the last csv update), and no csv row is still status planned (every clip is cut or dead, so the list can no longer change). Anything else: the 3 h rule applies (fail closed)."""
    marker = os.path.splitext(path)[0] + ".COMPLETE"
    try:
        if os.path.getmtime(marker) < os.path.getmtime(path):
            return False
    except OSError:
        return False
    return bool(rows) and all((r.get("status") or "").strip().lower() != "planned" for r in rows)


def load_planned(path=None, now=time.time, max_age_s=CAA_MAX_AGE_S, count_dead=False):
    """-> {room_id: [(t0_ms, t1_ms)]} of the planned and cut Sept clips (status dead is not counted unless count_dead: consult-lead cannot cut it, so no Sarvam job will come from it).
    The file is consult-lead's phase-1 list (consult_uid, room_id, t0_utc_ms, t1_utc_ms, status in planned / cut / dead). Anything wrong -> PlannedUnavailable: a missing, unreadable, stale (> max_age_s by mtime),
    empty or malformed file, a missing required column, a room_id that is not room_..., a non-numeric time, t1 <= t0, or an unknown status."""
    path = path or PLANNED_CSV
    try:
        age = now() - os.path.getmtime(path)
        rows = list(csv.DictReader(open(path, newline="")))
    except (OSError, ValueError, csv.Error) as e:
        raise PlannedUnavailable(f"planned-clips file unreadable: {type(e).__name__}")
    if age > max_age_s and not planned_complete(path, rows):
        raise PlannedUnavailable(f"planned-clips file is {int(age)} s old (limit {max_age_s})")
    if not rows or any(c not in rows[0] for c in PLANNED_COLUMNS):
        raise PlannedUnavailable("planned-clips file has no rows or lacks a required column")
    out = collections.defaultdict(list)
    for r in rows:
        room, status = (r["room_id"] or "").strip(), (r["status"] or "").strip().lower()
        try:
            t0, t1 = int(r["t0_utc_ms"]), int(r["t1_utc_ms"])
        except (TypeError, ValueError):
            raise PlannedUnavailable("planned-clips file has a non-numeric time")
        if not room.startswith("room_") or t1 <= t0 or status not in PLANNED_STATUSES:
            raise PlannedUnavailable("planned-clips file has a bad room_id, interval or status")
        if status == "dead" and not count_dead:
            continue
        out[room].append((t0, t1))
    return dict(out)


def planned_skip(rows, planned, cover=CAA_COVER_FRAC):
    """-> {window_id: 'cover'} for windows whose room's planned/cut Sept clips cover >= `cover` of them (the same union rule as the CAA cover rule; the file has no Sarvam-done flag)."""
    return {r["window_id"]: "cover" for r in rows if union_covered(planned.get(r["room_id"], []), r["t0_ms"], r["t1_ms"]) >= cover * (r["t1_ms"] - r["t0_ms"])}


# ---------------------------------------------------------------- lanes as processes
def parse_counters(stdout):
    """The last line holding a JSON object: the lane's counters line."""
    for line in reversed(stdout.splitlines()):
        if "{" in line:
            try:
                return json.loads(line[line.index("{"):])
            except ValueError:
                continue
    raise RuntimeError("no counters line in the lane output")


def launch(cmd, env=None, runner=subprocess.run):
    r = runner(cmd, cwd=REPO, env={**os.environ, **(env or {})}, capture_output=True, text=True)
    return r.returncode, r.stdout


def write_ids(state_dir, name, ids):
    os.makedirs(state_dir, exist_ok=True)
    p = os.path.join(state_dir, name)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(ids, f)
    return p


def run_nemotron(unit, ids, a, run=launch):
    f = write_ids(a.state_dir, f"{unit}-nemotron-ids.json", ids)
    cmd = [a.py_nemo, "-m", "kit.reb.window_lanes", "--windows", f, "--write", "--worker-status", a.worker_status, "--stop-file", stop_file_of(a)] + (["--tape-fallback"] if a.tape_fallback else []) + (["--excuse-rate-cap-sleep"] if getattr(a, "excuse_rate_cap_sleep", True) else [])
    rc, out = run(cmd)
    c = parse_counters(out)
    if rc != 0 and not c.get("windows"):
        raise RuntimeError("window_lanes failed to start")
    return c


def run_sarvam(unit, ids, a, run=launch):
    f = write_ids(a.state_dir, f"{unit}-sarvam-ids.json", ids)
    cmd = [a.py_sarvam, "-m", "kit.reb.sarvam_lane", "--research-windows", f, "--write", "--workers", str(a.sarvam_workers)] + (["--tape-fallback"] if a.tape_fallback else [])
    rc, out = run(cmd, env={"SARVAM_R2_KEY_FILE": os.environ.get("SARVAM_R2_KEY_FILE", SARVAM_R2_KEY_FILE)})
    c = parse_counters(out)
    if rc != 0 and not c.get("windows"):
        raise RuntimeError("sarvam_lane failed to start")
    return c


# ---------------------------------------------------------------- one unit
def check_stops(unit, nem=None, sar=None):
    if nem and (nem.get("stopped") in ("production_behind", "worker_stalled", "stop_file")):
        raise Stop(nem["stopped"], unit)
    if nem and (nem.get("errors", 0) > STOP_NEMOTRON_ERRORS or nem.get("stopped") == "errors"):
        raise Stop("nemotron_errors", unit)
    if sar and sar.get("throttled", 0) > 0:
        raise Stop("sarvam_throttled", unit)
    if sar and (sar.get("failed", 0) > STOP_SARVAM_FAILED):
        raise Stop("sarvam_failed", unit)


def stop_requested(a):
    """True when the stop-flag file exists (<state-dir>/STOP by default; --stop-file). The driver never kills a lane: it stops between units and phases, and the Nemotron lane stops between windows."""
    return os.path.exists(stop_file_of(a))


def stop_file_of(a):
    return getattr(a, "stop_file", None) or os.path.join(a.state_dir, "STOP")


def process_unit(unit, a, scan_fn, nemotron=run_nemotron, sarvam=run_sarvam, now=time.time):
    """-> the unit's counts line (a dict). Raises Stop."""
    phases = set(a.phases.split(","))
    if stop_requested(a):
        raise Stop("stop_file", unit)
    rows, tot = scan_fn(unit)
    line = {"unit": unit, "mode": "write" if a.write else "dry-run", "before": tally(rows), "audio_missing": tot.get("room_windows", 0) - tot.get("audio_ok", 0)}
    nem = sar = None
    if "a" in phases:
        ids = [r["window_id"] for r in rows if r["label"] == "UNCLASSIFIED"]
        line["nemotron"] = {"to_run": len(ids)}
        if a.write and ids:
            nem = nemotron(unit, ids, a)
            line["nemotron"].update({k: nem.get(k, 0) for k in ("ok", "empty", "errors", "skipped_existing", "audio_h")})
            check_stops(unit, nem=nem)
            rows, tot = scan_fn(unit)   # (b) classify again: the new diar.nemotron tracks are now the turns
    if "b" in phases:
        line["after"] = tally(rows)
    if "c" in phases and stop_requested(a):
        raise Stop("stop_file", unit)
    if "c" in phases:
        by_id = {r["window_id"]: r for r in rows}
        pending = sarvam_ids(rows, a.min_coverage, a.evidence)
        skipped, skipped_consult, to_send, sar_total = {}, {}, 0, collections.Counter()
        sent_audio_s = 0.0

        def partial_totals():   # what this unit has done so far: a stop carries it
            return {"to_send_so_far": to_send, "sent_audio_min_so_far": round(sent_audio_s / 60, 1), "skipped_caa": len(skipped), "skipped_consult": len(skipped_consult),
                    **{k: sar_total[k] for k in ("ok", "failed", "throttled", "errors", "skipped_existing")}, "sarvam_audio_min": round(sar_total["audio_h"] * 60, 1)}
        chunk_n = max(1, int(getattr(a, "caa_reload_every", CAA_RELOAD_EVERY)))
        first = True
        while pending or first:
            if not first and stop_requested(a):
                raise Stop("stop_file", unit, partial=partial_totals())
            first = False
            try:   # (refuter #11359) the manifest is re-read before every chunk, so a CAA clip that flips to sarvam_done mid-unit is seen at send time, not at the next unit
                caa = load_caa(getattr(a, "caa_manifest", CAA_MANIFEST), max_age_s=getattr(a, "caa_max_age_h", 3.0) * 3600, count_dead=getattr(a, "caa_count_dead", False), now=now)
            except CaaUnavailable:
                raise Stop("caa_manifest_unavailable", unit, partial=partial_totals())
            try:   # consult-lead's planned Sept clips (architect #11427): read before every chunk too, same fail-closed rule
                planned = load_planned(getattr(a, "consult_planned", None), max_age_s=getattr(a, "consult_max_age_h", 3.0) * 3600, count_dead=getattr(a, "consult_count_dead", False), now=now)
            except PlannedUnavailable:
                raise Stop("consult_planned_unavailable", unit, partial=partial_totals())
            chunk, pending = pending[:chunk_n], pending[chunk_n:]
            sk = caa_skip([by_id[i] for i in chunk], caa)
            skipped.update(sk)
            left = [i for i in chunk if i not in sk]
            psk = planned_skip([by_id[i] for i in left], planned)
            skipped_consult.update(psk)
            ids = [i for i in left if i not in psk]
            to_send += len(ids)
            sent_audio_s += sum(by_id[i]["audio_s"] for i in ids)
            if a.write and ids:
                sar = sarvam(unit, ids, a)
                for k in ("ok", "failed", "skipped_existing", "throttled", "errors"):
                    sar_total[k] += sar.get(k, 0)
                sar_total["audio_h"] += sar.get("audio_h", 0)
                try:
                    check_stops(unit, sar=dict(sar_total))   # the stop rules see the unit's running totals, chunk by chunk
                except Stop as s:
                    s.partial = partial_totals()
                    raise
        h = sent_audio_s / 3600
        line["sarvam"] = {"to_send": to_send, "audio_min": round(h * 60, 1), "wall_h_at_61x": round(h / (cp.OBSERVED_X), 2),
                          "skipped_caa": len(skipped), "skipped_caa_sarvam_done": sum(1 for v in skipped.values() if v == "sarvam_done"), "skipped_caa_cover": sum(1 for v in skipped.values() if v == "cover"),
                          "skipped_consult": len(skipped_consult)}
        if a.write and skipped:
            write_ids(a.state_dir, f"{unit}-caa-skipped.json", sorted(skipped))   # box-only, 0600
        if a.write and skipped_consult:
            write_ids(a.state_dir, f"{unit}-consult-skipped.json", sorted(skipped_consult))
        if a.write and sar_total:
            line["sarvam"].update({"ok": sar_total["ok"], "failed": sar_total["failed"], "skipped_existing": sar_total["skipped_existing"], "throttled": sar_total["throttled"],
                                   "sent_audio_min": round(sar_total["audio_h"] * 60, 1), "errors": sar_total["errors"], "chunks": -(-to_send // chunk_n) if to_send else 0})
    line["stop"] = None
    return line


def save_state(state_dir, unit, line, done=False):
    os.makedirs(state_dir, exist_ok=True)
    p = os.path.join(state_dir, f"{unit}.json")
    body = json.dumps({"unit": unit, "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "done": done, "last": line}, indent=1)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(body)


def load_state(state_dir, unit):
    try:
        return json.load(open(os.path.join(state_dir, f"{unit}.json")))
    except (OSError, ValueError):
        return None


def is_done(line):
    n = (line.get("nemotron") or {}).get("to_run", 0)
    s = (line.get("sarvam") or {}).get("to_send", 0)
    return n == 0 and s == 0


def pick_units(a, root, is_held, tapes, data, sha):
    """Units to process, newest first."""
    if a.unit == "orphan":
        return [ORPHAN_UNIT]
    if a.weeks:
        return sorted(a.weeks.split(","), reverse=True)
    rows = []
    cp.census(root, cutoff=cp.CUTOFF, is_held=is_held, tapes=tapes, data=data, sha=sha, rows_out=rows, kinds=("room_tape",), fallback_tape=a.tape_fallback)
    weeks = {r["week"] for r in rows}
    return units_with_work({w: 1 for w in weeks})


def drive(a, root=None, is_held=None, tapes=sl.TAPES, data=sl.HOME_DATA, nemotron=run_nemotron, sarvam=run_sarvam, out=print):
    root = root or sl.REB_ROOT
    is_held = is_held or load_heldout()
    sha = cp.cached_sha()
    orphan = a.unit == "orphan"

    def scan_fn(unit):
        return scan(root, units=None if orphan else {unit}, orphan=orphan, is_held=is_held, tapes=tapes, data=data, sha=sha, fallback_tape=a.tape_fallback)
    lines = []
    for unit in pick_units(a, root, is_held, tapes, data, sha):
        st = load_state(a.state_dir, unit)
        if st and st.get("done") and not a.force and a.write:
            out(json.dumps({"unit": unit, "skipped": "done"}))
            continue
        try:
            line = process_unit(unit, a, scan_fn, nemotron, sarvam)
        except Stop as s:
            out(f"STOP {s.reason} unit={s.unit}" + (f" partial={json.dumps(s.partial, sort_keys=True)}" if s.partial else ""))
            if a.write:
                save_state(a.state_dir, unit, {"unit": unit, "stop": s.reason, **({"partial": s.partial} if s.partial else {})})
            return lines, s
        lines.append(line)
        out(json.dumps(line, sort_keys=True))
        if a.write:
            save_state(a.state_dir, unit, line, done=is_done(line) and a.phases == "a,b,c" and a.evidence == "any")
    return lines, None


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--write", action="store_true", help="run the lanes (default: dry run, a plan from the store)")
    ap.add_argument("--weeks", help="comma list of ISO weeks, e.g. 2026-W39,2026-W38 (default: every week with work, newest first)")
    ap.add_argument("--unit", choices=("orphan",), help="the orphan OPD 4 tape windows as their own unit")
    ap.add_argument("--phases", default="a,b,c", help="a=nemotron, b=classify, c=sarvam (default a,b,c)")
    ap.add_argument("--evidence", choices=("any", "pyannote"), default="any", help="phase c: any label source, or only windows labelled from existing pyannote turns")
    ap.add_argument("--min-coverage", type=float, default=MIN_COVERAGE)
    ap.add_argument("--sarvam-workers", type=int, default=SARVAM_WORKERS)
    ap.add_argument("--no-excuse-rate-cap-sleep", dest="excuse_rate_cap_sleep", action="store_false", help="architect #11330: the driver passes --excuse-rate-cap-sleep to the Nemotron lane by default (a rate_capped worker asleep for its own sleep_s + 3 min is asleep, not stalled); this turns it off")
    ap.add_argument("--worker-status", default="worker", help="production-worker signal for the Nemotron lane: worker (default) | none (dry runs only) | file:<json> | cmd:<command>")
    ap.add_argument("--state-dir", default=STATE_DIR)
    ap.add_argument("--py-nemo", default=PY_NEMO)
    ap.add_argument("--py-sarvam", default=PY_SARVAM)
    ap.add_argument("--no-tape-fallback", dest="tape_fallback", action="store_false", help="do not plan windows with a missing/mismatched local file from the room's tape chunks (default: do)")
    ap.add_argument("--caa-manifest", default=CAA_MANIFEST, help="the CAA cuts manifest mirror on the box; phase c refuses without a fresh, valid one")
    ap.add_argument("--caa-max-age-h", type=float, default=CAA_MAX_AGE_S / 3600, help="phase c refuses when the manifest file is older than this (default 3 h)")
    ap.add_argument("--caa-reload-every", type=int, default=CAA_RELOAD_EVERY, help="send Sarvam in chunks of this many windows and re-read the CAA manifest before each chunk (default 50)")
    ap.add_argument("--consult-planned", default=PLANNED_CSV, help="consult-lead's planned Sept clips (consult_uid, room_id, t0_utc_ms, t1_utc_ms, status); phase c refuses without a fresh, valid one")
    ap.add_argument("--consult-max-age-h", type=float, default=CAA_MAX_AGE_S / 3600, help="phase c refuses when the planned-clips file is older than this (default 3 h)")
    ap.add_argument("--consult-count-dead", action="store_true", help="also count planned clips whose status is dead (default: they do not block S2)")
    ap.add_argument("--caa-count-dead", action="store_true", help="also count CAA clips whose cut is dead (default: they do not block S2)")
    ap.add_argument("--stop-file", help="touch this file to stop: the Nemotron lane finishes its window and exits, the driver stops between phases and units, nothing is killed (default <state-dir>/STOP)")
    ap.add_argument("--force", action="store_true", help="also reprocess a unit marked done")
    ap.add_argument("--root")
    return ap


def main(argv=None):
    a = build_parser().parse_args(argv)
    if not 1 <= a.sarvam_workers <= 2:
        raise SystemExit("--sarvam-workers must be 1 or 2 (13A: 2 workers)")
    if a.write and a.worker_status == "none":
        raise SystemExit("--write needs the production-worker signal (--worker-status worker); none is for dry runs only")
    _, stop = drive(a, root=a.root)
    return EXIT_STOP if stop else 0


if __name__ == "__main__":
    sys.exit(main())
