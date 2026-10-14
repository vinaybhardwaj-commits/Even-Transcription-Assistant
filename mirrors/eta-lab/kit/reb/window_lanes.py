"""window_lanes.py: the Nemotron lane over REB room WINDOWS (ORDERS-PALIMPSEST-13A B1). Lab compute only: no Sarvam call, no network, box T4 under ~/gpu.lock.

For each window id: the window audio is planned and sha-verified by the research-window planner (sarvam_lane.window_plan: the cut local window file, or the room's tape
chunks, coverage recorded), built into one 16 kHz mono wav (sarvam_lane.build_window_audio), diarized by the stock Nemotron engine (clip_lane_engines.Nemotron, rev
f667ed73, offline 30.4 s setting, the same engine and config as the clip lane), and written as a diar.nemotron track in the window's OWN dir with segments on TAPE
time (manifest t0_ms + offset). cfg8 = sha256(lane config + window_id + the window audio signature)[:8], so a changed audio source is a new track and a rerun is a
no-op (skipped_existing). Counters only in the job log: never a transcript (there is none) and never an error message that is not allow-listed (clip_lanes._safe_msg).

Guards, before any audio is touched: the held-out guard (from_hist.load_heldout, fail closed; empty after the 10 Oct lift) on the window's day+room and its span, and the
four SEALED lid-debug window ids (from_hist.SEALED_WINDOWS). A window longer than Sarvam's 7200 s, or whose source_kind is not room_tape / room_tape_orphan, is refused.

GPU manners (as the production shadow worker): the lane takes ~/gpu.lock and waits for 2048 MiB free (clip_lanes.GpuGate) for ONE window's inference at a time and lets go
between windows, so it never holds the GPU for more than one 15-min window. Before every window a YIELD check reads the production worker's status (gating-lead #11324, architect #11327):
`cd ~/dev/nemotron-worker-main-79fc614/tools/nemotron-worker && ./nemotron-worker.sh status`, line 2 = JSON {state, in_flight, counts, last_ok_at, updated_at}. A window starts only when state is
rate_capped or idle AND in_flight is empty; otherwise the lane waits (a running window is always finished first); updated_at older than 3 min = the worker is stalled: WorkerStalled, the
lane stops and the driver stops and posts; 30 min of continuous waiting = ProductionBehind (the 13A stop rule). Read-only: the lane never stops, restarts or signals the worker.

Scratch: the wav is built in a per-run scratch dir under the work root as a single file overwritten per window (derived, bit-reproducible from the sha-verified
sources), and that scratch dir is MOVED to <work_root>/_to_delete at the end of the run (never deleted).
Python: ~/eta-data/nemotron/venv-nemo-main (torch, NeMo), like the clip lane. One lane per process.
"""
import argparse
import datetime
import json
import os
import shlex
import subprocess
import sys
import time
import traceback

from . import clip_lane_engines as eng
from . import clip_lanes as cl
from . import reb
from . import sarvam_lane as sl
from . import writer
from .from_hist import REB_ROOT, SEALED_WINDOWS, load_heldout, window_held
from .schema import SCHEMA_VERSION
from .validate import validate_track

MACHINE = "box-window-lanes"
LAYER, ENGINE, VERSION, MODEL = "diar", "nemotron", eng.NEMOTRON_REV[:8], eng.NEMOTRON_REPO
WORK_ROOT = os.path.expanduser("~/eta-data/window-lanes-work")
OK_KINDS = ("room_tape", "room_tape_orphan")
BEHIND_POLL_S, BEHIND_STOP_S, MAX_ERRORS = 60.0, 1800.0, 5
COUNTERS = ("windows", "ok", "empty", "errors", "skipped_existing", "would_write", "not_found", "blind_refused", "sealed", "audio_missing", "sha_mismatch", "over_limit",
            "behind_waits", "audio_s")


class ProductionBehind(RuntimeError):
    """The production Nemotron worker stayed behind for the whole `behind_stop_s`: the run stops (13A stop rule)."""


# ---------------------------------------------------------------- production worker (yield rule, gating-lead #11324 via architect #11327)
WORKER_STATUS_CMD = "cd ~/dev/nemotron-worker-main-79fc614/tools/nemotron-worker && ./nemotron-worker.sh status"   # read-only; line 2 of its output is the status JSON
GO_STATES = ("rate_capped", "idle")
STALE_S = 180.0


class StopRequested(RuntimeError):
    """A stop-flag file exists (--stop-file): the lane finishes the window it is on and exits cleanly (stopped = stop_file). Nothing is killed."""


WORKER_CMDLINE_MARK = "tools/nemotron-worker/worker.py"


def worker_alive(st, proc_root="/proc"):
    """Liveness from the status JSON's own pid (refuter #11598, architect #11604), NOT from the pidfile or line 1 of `status` (the pidfile can be missing while the worker runs): the pid must be a positive
    int, /proc/<pid>/cmdline must exist and contain tools/nemotron-worker/worker.py (so a recycled pid or the lab copy of another program does not count). Anything else -> False."""
    pid = st.get("pid") if isinstance(st, dict) else None
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        cmd = open(f"{proc_root}/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return False
    return WORKER_CMDLINE_MARK in cmd


class WorkerStalled(RuntimeError):
    """The production worker's status has not been updated for more than 3 min: the driver stops and a human posts (13A)."""


class WorkerStatus:
    """status() -> the worker's status dict {state, in_flight, counts, last_ok_at, updated_at, ...} or None when it cannot be read. Read-only: the lane never stops, restarts or signals the worker."""

    def status(self):
        return None


class NoWorker(WorkerStatus):
    """For dry runs and tests: there is no production worker to yield to (always go)."""

    def status(self):
        return {"state": "idle", "in_flight": 0, "updated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}


class FileStatus(WorkerStatus):
    def __init__(self, path):
        self.path = path

    def status(self):
        try:
            return json.load(open(self.path))   # no liveness check on this source: the freshness / state / in_flight rule only (use the default `worker` source for the pid check)
        except (OSError, ValueError):
            return None


class CmdStatus(WorkerStatus):
    """Runs a shell command whose output line 2 is the status JSON (the worker's own `nemotron-worker.sh status`)."""

    def __init__(self, cmd=WORKER_STATUS_CMD, runner=subprocess.run, proc_root="/proc"):
        self.cmd, self.runner, self.proc_root = cmd, runner, proc_root

    def status(self):
        try:
            r = self.runner(["bash", "-lc", self.cmd], capture_output=True, text=True, timeout=60)
            lines = r.stdout.splitlines()
            if r.returncode != 0 or len(lines) < 2:
                return None
            st = json.loads(lines[1])
            if isinstance(st, dict):
                st["running"] = worker_alive(st, self.proc_root)   # line 1 ("running pid=N" / "not running") is ignored: it comes from a pidfile that can be missing while the worker runs
            return st
        except Exception:  # noqa: BLE001 - an unreadable signal is "unknown", never a crash
            return None


def status_from_spec(spec):
    if spec in (None, "", "none"):
        return NoWorker()
    if spec == "worker":
        return CmdStatus()
    if spec.startswith("file:"):
        return FileStatus(spec[5:])
    if spec.startswith("cmd:"):
        return CmdStatus(spec[4:])
    raise SystemExit(f"--worker-status: expected worker, none, file:<json> or cmd:<command> (got {spec!r})")


def _age_s(iso, now):
    try:
        return now() - datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def _empty(x):
    return not x   # 0, None, [] and {} are "nothing in flight"


class Yield:
    """The rule, exactly: start a window only when the production worker's state is rate_capped or idle AND in_flight is empty; otherwise wait (a window already running is finished first,
    since the check is only made BETWEEN windows). If updated_at is older than `stale_s` (3 min) raise WorkerStalled. An unreadable status is "wait", and `stop_s` (30 min) of continuous
    waiting raises ProductionBehind (the 13A stop rule). Nothing here touches the worker."""

    def __init__(self, source, poll_s=BEHIND_POLL_S, stop_s=BEHIND_STOP_S, stale_s=STALE_S, sleep=time.sleep, now=time.monotonic, wall=time.time, excuse_rate_cap_sleep=False, stop_check=None):
        self.stop_check = stop_check   # () -> True when a stop-flag file exists; looked at on every poll of the wait loop too
        self.source, self.poll_s, self.stop_s, self.stale_s, self.sleep, self.now, self.wall = source, poll_s, stop_s, stale_s, sleep, now, wall
        self.excuse = excuse_rate_cap_sleep   # OFF by default (the rule as ordered): a rate_capped worker asleep for its own sleep_s does not update updated_at
        self.waits = 0

    def decide(self):
        """-> 'go' | 'wait'; raises WorkerStalled."""
        st = self.source.status()
        if not isinstance(st, dict):
            return "wait"
        if st.get("running") is False:   # the status JSON's pid is not a live worker.py process: no sleep excuse can cover a dead worker
            raise WorkerStalled("worker pid is not a live worker.py process")
        age = _age_s(st.get("updated_at"), self.wall)   # a missing / null / unparseable updated_at is NOT fresh: fail closed
        asleep = self.excuse and st.get("state") == "rate_capped" and isinstance(st.get("sleep_s"), (int, float)) and age is not None and age <= st["sleep_s"] + self.stale_s
        if (age is None or age > self.stale_s) and not asleep:
            raise WorkerStalled("worker status updated_at is missing or unreadable" if age is None else f"worker status updated_at is {int(age)} s old")
        return "go" if st.get("state") in GO_STATES and _empty(st.get("in_flight")) else "wait"

    def wait_clear(self):
        t0 = None
        while self.decide() == "wait":
            if self.stop_check and self.stop_check():
                raise StopRequested("stop file present")
            t0 = self.now() if t0 is None else t0
            if self.now() - t0 >= self.stop_s:
                raise ProductionBehind(f"production worker not ready for {int(self.now() - t0)} s")
            self.waits += 1
            self.sleep(self.poll_s)


# ---------------------------------------------------------------- the track
def window_config(manifest, plan):
    return {**eng.NEMOTRON_ENGINE_CONFIG, "model": MODEL, "model_rev": eng.NEMOTRON_REV, "window_id": manifest["window_id"], "audio_signature": plan["signature"]}


def track_path(root, manifest, cfg8):
    wd = writer._window_dir(root, manifest["ist_date"], manifest["room_id"], manifest["window_id"])
    return os.path.join(wd, "tracks", writer.track_filename(LAYER, ENGINE, VERSION, cfg8))


def build_track(manifest, plan, config, status, reason, turns, created_at):
    """Pure. turns: [(start_s, end_s, 'speaker_N')] window-relative -> segments on TAPE time."""
    t0 = int(manifest["t0_ms"])
    segs = [{"t0_ms": t0 + int(round(a * 1000)), "t1_ms": t0 + int(round(max(a, b) * 1000)), "speaker": sp, "extras": {"win_t0_s": a, "win_t1_s": b}} for a, b, sp in turns]
    cov = round(min(1.0, plan["covered_ms"] / (plan["audio_s"] * 1000)), 4) if plan["audio_s"] else 0.0
    t = {"schema": SCHEMA_VERSION, "window_id": manifest["window_id"], "layer": LAYER, "engine": ENGINE, "model": MODEL, "version": VERSION, "config": config,
         "config_hash": writer.config_hash(config), "machine": MACHINE, "status": status, "reason": reason, "segments": segs,
         "extras": {"created_at": created_at, "use": sl.RESEARCH_USE, "scope": sl.WINDOW_SCOPE, "window_id": manifest["window_id"], "window_t0_ms": t0, "audio_s": plan["audio_s"],
                    "audio": {"source": plan["source"], "n_files": len(plan["files"]), "coverage": cov, "signature": plan["signature"]},
                    "n_speakers": len({s["speaker"] for s in segs}), "model_rev": eng.NEMOTRON_REV,
                    "clock": "tape_utc_ms: t0_ms/t1_ms = manifest t0_ms + offset; the offset in window seconds is in segment extras win_t0_s/win_t1_s"}}
    validate_track(t)
    return t


class RealRunner:
    """diarize(wav) -> [(start_s, end_s, speaker)]. The model loads on first use, never in a dry run."""

    def __init__(self):
        self.model = None

    def diarize(self, wav):
        if self.model is None:
            self.model = eng.Nemotron()
        return self.model.diarize(wav)


# ---------------------------------------------------------------- one window
def process_window(wid, root, is_held, write, cnt, joblog, by_room, runner, gate, yielder, scratch, tapes=sl.TAPES, data=sl.HOME_DATA, subproc=subprocess.run, load=reb.load_window,
                   fallback_tape=False):
    def bump(k, n=1):
        cnt[k] += n
    bump("windows")
    if wid in SEALED_WINDOWS:
        bump("sealed")
        return None
    try:
        manifest = load(wid, root=root).manifest
    except Exception:  # noqa: BLE001 - unknown / unreadable window id: counted
        bump("not_found")
        return None
    if (manifest.get("source_kind") or "room_tape") not in OK_KINDS:
        bump("not_found")
        return None
    if manifest["window_id"] in SEALED_WINDOWS:
        bump("sealed")
        return None
    if is_held(manifest["ist_date"], manifest["room_id"]) or window_held(is_held, manifest["room_id"], int(manifest["t0_ms"]), int(manifest["t1_ms"])):
        bump("blind_refused")
        return None
    dur_s = (int(manifest["t1_ms"]) - int(manifest["t0_ms"])) / 1000
    if dur_s > sl.MAX_AUDIO_S:
        bump("over_limit")
        return None
    try:
        plan = sl.window_plan(manifest, by_room, tapes, data, fallback_tape)
    except sl.AudioProblem as e:
        bump(e.kind)
        joblog(window_id=wid, refused=e.kind)
        return None
    config = window_config(manifest, plan)
    cfg8 = writer.config_hash(config)
    if os.path.exists(track_path(root, manifest, cfg8)):
        bump("skipped_existing")
        return "skipped_existing"
    if not write:
        bump("would_write"); bump("audio_s", dur_s)
        return "would_write"
    yielder.wait_clear()
    t = time.time()
    try:
        wav = sl.build_window_audio(plan, scratch, int(manifest["t1_ms"]) - int(manifest["t0_ms"]), subproc)
        with gate.hold():   # ONE window's inference at a time: the lock and the VRAM are let go again right after
            turns = runner.diarize(wav)
        created = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        status, reason = ("ok", None) if turns else ("empty", "no speaker activity")
        track = build_track(manifest, plan, config, status, reason, turns, created)
        try:
            writer.write_track(root, manifest["ist_date"], manifest["room_id"], wid, track, config_hash=cfg8)
        except writer.TrackExistsError:
            bump("skipped_existing")
            return "skipped_existing"
        bump(status); bump("audio_s", dur_s)
        joblog(window_id=wid, status=status, audio_s=dur_s, wall_s=round(time.time() - t, 2), n_segments=len(turns), coverage=track["extras"]["audio"]["coverage"])
        return status
    except (ProductionBehind, WorkerStalled, StopRequested, KeyboardInterrupt):
        raise
    except Exception as e:  # noqa: BLE001 - one bad window never stops the batch; allow-listed message + frames only
        bump("errors")
        tb = traceback.extract_tb(e.__traceback__)
        joblog(window_id=wid, error=type(e).__name__, where=cl._frame(tb, lambda x: x[-1] if x else None),
               where_kit=cl._frame(tb, lambda x: next((f for f in reversed(x) if os.sep + "kit" + os.sep + "reb" + os.sep in f.filename.replace("\\", os.sep)), None)),
               wall_s=round(time.time() - t, 2), **cl._safe_msg(e))
        return "error"


def run_ids(ids, root=None, is_held=None, write=False, runner=None, gate=None, yielder=None, tapes=sl.TAPES, data=sl.HOME_DATA, log_dir=sl.OUT_DIR, work_root=WORK_ROOT,
            by_room=None, max_errors=MAX_ERRORS, sha=None, subproc=subprocess.run, load=reb.load_window, fallback_tape=False, stop_file=None):
    """-> counters (+ stopped: None | 'errors' | 'production_behind'). Sequential: the T4 serves one window at a time."""
    root = root or REB_ROOT
    is_held = is_held or load_heldout()   # fail closed before anything is read
    by_room = by_room if by_room is not None else sl.load_tapes(os.path.join(tapes, "manifest.jsonl"))
    gate = gate or cl.GpuGate()
    yielder = yielder or Yield(NoWorker())
    runner = runner or RealRunner()
    ts = time.strftime("%Y%m%dT%H%M%S")
    cnt = {k: 0 for k in COUNTERS}
    jpath = os.path.join(log_dir, f"window-lanes-nemotron-{ts}.jsonl") if log_dir else None
    if jpath:
        os.makedirs(log_dir, exist_ok=True)

    def joblog(**k):   # counts and timings only
        if jpath:
            with open(jpath, "a") as f:
                f.write(json.dumps({"ts": time.strftime("%H:%M:%S"), **k}, sort_keys=True) + "\n")
    scratch = os.path.join(work_root, f"scratch-{ts}-{os.getpid()}")
    stopped = None
    from .classify_pre_2oct import patched_sha
    with patched_sha(sha):
        try:
            for wid in ids:
                if stop_file and os.path.exists(stop_file):   # checked between windows: the window just finished is written, the next is not started
                    raise StopRequested("stop file present")
                process_window(wid, root, is_held, write, cnt, joblog, by_room, runner, gate, yielder, scratch, tapes, data, subproc, load, fallback_tape)
                if cnt["errors"] > max_errors:
                    stopped = "errors"
                    break
        except ProductionBehind:
            stopped = "production_behind"
        except WorkerStalled:
            stopped = "worker_stalled"
        except StopRequested:
            stopped = "stop_file"
        finally:
            if os.path.isdir(scratch):   # moved, never deleted; a name that is taken gets a numeric suffix (never merged into or overwritten)
                dest = os.path.join(work_root, "_to_delete")
                os.makedirs(dest, exist_ok=True)
                target, n = os.path.join(dest, os.path.basename(scratch)), 0
                while os.path.exists(target):
                    n += 1
                    target = os.path.join(dest, f"{os.path.basename(scratch)}-{n}")
                os.rename(scratch, target)
    cnt["audio_h"] = round(cnt.pop("audio_s") / 3600, 3)
    cnt["behind_waits"] = yielder.waits
    cnt["stopped"] = stopped
    print(f"window_lanes nemotron {'write' if write else 'dry-run'} " + json.dumps(cnt, sort_keys=True))
    return cnt


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--windows", required=True, help="JSON list of window ids (or an object with window_ids / sample_window_ids), or a text file with one id per line")
    ap.add_argument("--write", action="store_true", help="run Nemotron and write tracks (default: dry run, nothing is run or written)")
    ap.add_argument("--root", help="REB root (default ~/eta-data/reb); use a temp root for a pilot")
    ap.add_argument("--excuse-rate-cap-sleep", action="store_true", help="OFF by default: do not call the worker stalled while it is rate_capped and its updated_at is within its own sleep_s + 3 min")
    ap.add_argument("--worker-status", default="worker", help="production-worker signal: worker (its own `nemotron-worker.sh status`, the default) | none (dry runs only) | file:<json> | cmd:<command>")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--stop-file", help="a path: when the file exists the lane finishes the window it is on and exits with stopped=stop_file (nothing is killed)")
    ap.add_argument("--tape-fallback", action="store_true", help="plan a window whose cut local file is missing / differs from the room's sha-verified tape chunks")
    a = ap.parse_args(argv)
    if a.write and a.worker_status == "none":
        raise SystemExit("--write needs a production-worker signal (--worker-status worker); none is for dry runs")
    ids = load_ids(a.windows)
    if a.limit:
        ids = ids[:a.limit]
    run_ids(ids, root=a.root, write=a.write, yielder=Yield(status_from_spec(a.worker_status), excuse_rate_cap_sleep=a.excuse_rate_cap_sleep, stop_check=(lambda: os.path.exists(a.stop_file)) if a.stop_file else None),
            fallback_tape=a.tape_fallback, stop_file=a.stop_file)
    return 0


def load_ids(path):
    txt = open(path).read()
    try:
        d = json.loads(txt)
        ids = d if isinstance(d, list) else (d.get("window_ids") or d.get("sample_window_ids") or [])
    except ValueError:
        ids = [l.strip() for l in txt.splitlines() if l.strip() and not l.startswith("#")]
    if not ids or not all(isinstance(i, str) and i and "/" not in i and ".." not in i for i in ids):
        raise SystemExit("--windows: expected a non-empty list of window ids")
    return list(dict.fromkeys(ids))


if __name__ == "__main__":
    sys.exit(main())
