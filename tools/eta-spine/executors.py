"""spine-runner executors (S6): recut, acoustics, nemotron. Used ONLY by `spine-runner --live` for a job whose stage mode is live; would_run never imports a subprocess.

Each executor runs the EXISTING CLI for one consult uid, as a subprocess, by path from env (nothing is imported from the lab or the cutter):
  recut      <SPINE_CUTTER_PY> -m cutter.run --once --only UID --recut                      (cwd SPINE_CUTTER_DIR; nice 10, as recut_queue)
  acoustics  <SPINE_LAB_PY> -m kit.reb.clip_lanes --lane acoustics --consult UID --write     (cwd SPINE_LAB_DIR, the directory that holds kit/)
  nemotron   <SPINE_LAB_PY> -m kit.reb.clip_lanes --lane nemotron --consult UID --write --worker-status worker
Optional env: SPINE_DATA_DIR (default ~/eta-data), SPINE_GPU_LOCK (default ~/gpu.lock). A missing SPINE_*_DIR / _PY is ExecutorUnconfigured: the runner releases the job untouched.

LOCKS (the same ones the timers take, so the runner and the hourly never run one stage for one uid at once):
  recut      cutter.lock is taken by the cutter itself (non-waiting with --only; busy prints {"locked": true}); we also probe it first, and refuse inside the :35 gap
             (the 180 s after a firing, and when the next firing is under 720 s away: recut_queue's rule).
  K lanes    <data>/reb/_hourly.lock is held by US (flock, non-blocking) for the whole child run. A busy lock is transient and nothing is spawned.
  GPU lane   ~/gpu.lock is only PROBED here (acquire + release): clip_lanes holds it per inference itself, so holding it here would deadlock the child.
Every busy lock is TRANSIENT (backoff, attempt counted, breaker-visible). Nothing here waits for a lock.

ERROR MAP (Result.outcome / code):
  rc 0 + cut / written / skipped_existing   done, with an artefact REF + sha256 of the file the engine wrote
  silent_audio, blind_room_day, blind_refused   permanent (the audio will not change; retrying cannot help)
  locked, gpu busy, timer gap, timeout, lane failed, no tape yet, clip not cut yet, stopped, any other rc   transient
  rc 2 from clip_lanes (usage / validation)   permanent
No uid, path, argv or child output is ever logged or reported: only the codes below. Stdlib only.
"""
from __future__ import annotations

import datetime as dt
import fcntl
import glob
import hashlib
import json
import os
import re
import subprocess
import time
from dataclasses import dataclass, field

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
TIMER_MINUTE, TIMER_LAUNCH_S, MIN_BEFORE_TIMER_S = 35, 180, 720   # recut_queue.py:15
CHILD_TIMEOUT_S = 840                                              # under the 15 min lease
UID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$")      # never starts with '-': it cannot be read as a flag
EXECUTOR_STAGES = ("recut", "acoustics", "nemotron")


class ExecutorUnconfigured(Exception):
    """The env that names the CLI is missing. The job is not at fault: the runner releases it."""


@dataclass
class Result:
    outcome: str                      # done | transient | permanent
    code: str | None = None
    artefact: dict | None = None
    note: dict = field(default_factory=dict)


def try_flock(path: str) -> int | None:
    """A held, non-blocking exclusive flock (fd), or None when another process holds it. Raises OSError when the file cannot be opened."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


def probe_flock(path: str) -> bool:
    """True when the lock is FREE right now (taken and dropped at once)."""
    fd = try_flock(path)
    if fd is None:
        return False
    os.close(fd)
    return True


def seconds_since_timer(now: float) -> float:
    t = dt.datetime.fromtimestamp(now, IST)
    last = t.replace(minute=TIMER_MINUTE, second=0, microsecond=0)
    if last > t:
        last -= dt.timedelta(hours=1)
    return (t - last).total_seconds()


def seconds_to_next_timer(now: float) -> float:
    t = dt.datetime.fromtimestamp(now, IST)
    nxt = t.replace(minute=TIMER_MINUTE, second=0, microsecond=0)
    if nxt <= t:
        nxt += dt.timedelta(hours=1)
    return (nxt - t).total_seconds()


def last_json(out: str | None) -> dict | None:
    for line in reversed((out or "").strip().splitlines()):
        try:
            v = json.loads(line)
        except ValueError:
            continue
        if isinstance(v, dict):
            return v
    return None


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _token(s: str, fallback: str) -> str:
    return re.sub(r"[^a-z0-9_]", "_", s.lower())[:40] or fallback


class Executors:
    def __init__(self, env=None, run=None, clock=None):
        e = dict(os.environ if env is None else env)
        self.env = e
        self._run = run or subprocess.run
        self.clock = clock or time.time
        home = os.path.expanduser("~")
        self.data = e.get("SPINE_DATA_DIR") or os.path.join(home, "eta-data")
        self.gpu_lock = e.get("SPINE_GPU_LOCK") or os.path.join(home, "gpu.lock")
        self.cutter_lock = os.path.join(self.data, "consult", "cutter.lock")
        self.hourly_lock = os.path.join(self.data, "reb", "_hourly.lock")
        self.clips = os.path.join(self.data, "consult", "clips")
        self.reb = os.path.join(self.data, "reb")

    def has(self, stage: str) -> bool:
        return stage in EXECUTOR_STAGES

    def _need(self, *names: str) -> list[str]:
        miss = [n for n in names if not self.env.get(n)]
        if miss:
            raise ExecutorUnconfigured(",".join(miss))
        return [self.env[n] for n in names]

    def execute(self, stage: str, uid: str | None) -> Result:
        if stage == "recut":
            self._need("SPINE_CUTTER_DIR", "SPINE_CUTTER_PY")
        elif stage in ("acoustics", "nemotron"):
            self._need("SPINE_LAB_DIR", "SPINE_LAB_PY")
        else:
            raise ExecutorUnconfigured(f"no executor for {stage}")
        if not uid or not UID_RE.match(uid):
            return Result("permanent", "no_consult_uid" if not uid else "bad_consult_uid")
        return self.recut(uid) if stage == "recut" else self.lane(stage, uid)

    # ---------------------------------------------------------------- recut
    def recut(self, uid: str) -> Result:
        now = self.clock()
        if seconds_since_timer(now) < TIMER_LAUNCH_S or seconds_to_next_timer(now) < MIN_BEFORE_TIMER_S:
            return Result("transient", "timer_gap")
        try:
            if not probe_flock(self.cutter_lock):
                return Result("transient", "lock_busy")
        except OSError:
            return Result("transient", "lock_unavailable")
        py, cwd = self.env["SPINE_CUTTER_PY"], self.env["SPINE_CUTTER_DIR"]
        argv = ["nice", "-n", "10", py, "-m", "cutter.run", "--once", "--only", uid, "--recut"]
        try:
            p = self._run(argv, cwd=cwd, capture_output=True, text=True, timeout=CHILD_TIMEOUT_S, check=False)
        except subprocess.TimeoutExpired:
            return Result("transient", "timeout")
        except OSError:
            return Result("transient", "spawn_failed")
        return self._classify_recut(p.returncode, p.stdout, p.stderr, uid)

    def _classify_recut(self, rc: int, out: str, err: str, uid: str) -> Result:
        if rc != 0:
            return Result("transient", f"rc_{rc}" if 0 < rc < 128 else "killed")   # 3 = prints invalid: global, not the job's fault
        s = last_json(out)
        if s is None:
            return Result("transient", "no_summary")
        if s.get("locked"):
            return Result("transient", "lock_busy")
        if s.get("cut") == 1 and not s.get("errors"):
            return self._recut_done(uid)
        if s.get("deferred_gpu"):
            return Result("transient", "gpu_busy")
        if s.get("errors"):
            return Result("transient", "cut_error")
        if s.get("skipped"):
            m = re.search(r"not done: skip (\S+)", err or "")
            reason = _token(m.group(1), "unknown") if m else "unknown"
            if reason in ("silent_audio", "blind_room_day"):
                return Result("permanent", reason)
            return Result("transient", f"skip_{reason}")   # e.g. no_tape: the tape may still arrive
        return Result("transient", "not_selected")

    def _recut_done(self, uid: str) -> Result:
        """The artefact is the latest cut's consult.flac, found through the cutter's own index row."""
        row = None
        try:
            with open(os.path.join(self.clips, "index.jsonl")) as f:
                for line in f:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if r.get("consult_uid") == uid:
                        row = r
        except OSError:
            row = None
        if not row or row.get("status") != "cut" or not row.get("path") or not row.get("signature"):
            return Result("transient", "artefact_missing")
        flac = os.path.join(self.clips, str(row["path"]), "consult.flac")
        try:
            sha = sha256_file(flac)
        except OSError:
            return Result("transient", "artefact_missing")
        cfg8 = hashlib.sha256(str(row["signature"]).encode()).hexdigest()[:8]
        return Result("done", None, {"engine": "cutter", "version": "v1", "cfg8": cfg8, "store": "box", "status": "ok", "sha256": sha, "object_key": "consult.flac"})

    # ---------------------------------------------------------------- K clip lanes
    def lane(self, stage: str, uid: str) -> Result:
        try:
            hourly = try_flock(self.hourly_lock)
        except OSError:
            return Result("transient", "lock_unavailable")
        if hourly is None:
            return Result("transient", "lock_busy")
        try:
            if stage == "nemotron":
                try:
                    if not probe_flock(self.gpu_lock):
                        return Result("transient", "gpu_busy")
                except OSError:
                    return Result("transient", "lock_unavailable")
            py, cwd = self.env["SPINE_LAB_PY"], self.env["SPINE_LAB_DIR"]
            argv = [py, "-m", "kit.reb.clip_lanes", "--lane", stage, "--consult", uid, "--write"]
            if stage == "nemotron":
                argv += ["--worker-status", "worker"]   # yield to the production Nemotron worker before every inference
            try:
                p = self._run(argv, cwd=cwd, capture_output=True, text=True, timeout=CHILD_TIMEOUT_S, check=False)
            except subprocess.TimeoutExpired:
                return Result("transient", "timeout")
            except OSError:
                return Result("transient", "spawn_failed")
            return self._classify_lane(stage, uid, p.returncode, p.stdout)
        finally:
            os.close(hourly)   # releases the flock

    def _classify_lane(self, stage: str, uid: str, rc: int, out: str) -> Result:
        if rc == 2:
            return Result("permanent", "usage")
        if rc != 0:
            return Result("transient", f"rc_{rc}" if 0 < rc < 128 else "killed")
        s = last_json(out)
        c = (s or {}).get("counts")
        if not isinstance(c, dict):
            return Result("transient", "no_summary")
        n = lambda k: int(c.get(k) or 0)   # noqa: E731
        if c.get("stopped"):
            return Result("transient", f"stopped_{_token(str(c['stopped']), 'unknown')}")
        if n("blind_refused"):
            return Result("permanent", "blind_refused")
        if n("clips") == 0:
            return Result("transient", "no_clip")
        if n("deferred_recut"):
            return Result("transient", "recut_pending")
        if n("not_cut_refused") or n("clip_mismatch"):
            return Result("transient", "not_cut")
        if n("errors") or n("failed"):
            return Result("transient", "lane_failed")
        if n("written") or n("skipped_existing"):
            return self._track_artefact(stage, uid)
        return Result("transient", "nothing_written")

    LANE_PREFIX = {"acoustics": "acoustics.room_profile_acoustics", "nemotron": "diar.nemotron"}

    def _track_artefact(self, stage: str, uid: str) -> Result:
        """The newest track file of this lane under reb/<date>/<room>/_consults/<uid>/tracks/. The ref is `tracks/<file>` only: no date, room or uid."""
        pat = os.path.join(self.reb, "*", "*", "_consults", glob.escape(uid), "tracks", f"{self.LANE_PREFIX[stage]}__*__*.json")
        files = sorted(glob.glob(pat), key=lambda p: (os.path.getmtime(p), p))
        if not files:
            return Result("transient", "artefact_missing")
        path = files[-1]
        m = re.match(r"^(?P<layer>[a-z]+)\.(?P<engine>[A-Za-z0-9_]+)__(?P<version>[A-Za-z0-9_.-]+)__(?P<cfg8>[0-9a-f]{8})\.json$", os.path.basename(path))
        if not m:
            return Result("transient", "artefact_missing")
        status = "ok"
        try:
            with open(path) as f:
                st = json.load(f).get("status")
            status = st if st in ("ok", "empty", "failed", "skipped") else "ok"
        except (OSError, ValueError, AttributeError):
            pass
        return Result("done", None, {"engine": m["engine"], "version": m["version"], "cfg8": m["cfg8"], "store": "box", "status": status,
                                     "sha256": sha256_file(path), "object_key": f"tracks/{os.path.basename(path)}"})
