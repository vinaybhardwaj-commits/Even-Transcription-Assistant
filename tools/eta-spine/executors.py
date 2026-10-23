"""spine-runner executors (S6): recut, acoustics, nemotron. Used ONLY by `spine-runner --live` for a job whose stage mode is live; would_run never imports a subprocess.

Each executor runs the EXISTING CLI for one consult uid, as a subprocess, by path from env (nothing is imported from the lab or the cutter):
  recut      <SPINE_CUTTER_PY> -m cutter.run --once --only UID --recut                      (cwd SPINE_CUTTER_DIR; nice 10, as recut_queue)
  acoustics  <SPINE_LAB_PY> -m kit.reb.clip_lanes --lane acoustics --consult UID --write     (cwd SPINE_LAB_DIR, the directory that holds kit/)
  nemotron   <SPINE_LAB_PY> -m kit.reb.clip_lanes --lane nemotron --consult UID --write --worker-status worker
Optional env: SPINE_DATA_DIR (default ~/eta-data), SPINE_GPU_LOCK (default ~/gpu.lock), SPINE_HOURLY_FROM_MIN / SPINE_HOURLY_TO_MIN (K-lane refusal window, default 25 / 45).
NOTE (F8): SPINE_DATA_DIR moves OUR lock and track paths only. clip_lanes keeps its own root and its own ~/gpu.lock (hard-coded in the lab), so it does not follow SPINE_DATA_DIR or SPINE_GPU_LOCK. A missing SPINE_*_DIR / _PY is ExecutorUnconfigured: the runner releases the job untouched.

LOCKS (the same ones the timers take, so the runner and the hourly never run one stage for one uid at once):
  recut      cutter.lock is taken by the cutter itself (non-waiting with --only; busy prints {"locked": true}); we also probe it first, and refuse inside the :35 gap
             (the 180 s after a firing, and when the next firing is under 720 s away: recut_queue's rule).
  K lanes    <data>/reb/_hourly.lock is held by US (flock, non-blocking) for the whole child run, and the CHILD INHERITS the fd (pass_fds), so the lock lives as long as the child even if
             this runner is SIGKILLed. A busy lock is transient and nothing is spawned. palimpsest-hourly starts at :40 and skips its WHOLE run when it cannot take the lock, so K lanes are
             refused (release hourly_gap: the attempt is given back, no breaker tick) from :25 to :45, and also when under MIN_LANE_BUDGET_S (300 s) is left before the next :25 (release budget_too_small).
             The child timeout is capped to the time left before the next :25 (a job started at :45 ends before :25). The claim route does not hand K lanes out in that time either.
             Children run in their own process group; on SIGTERM / SIGINT the runner kills the group, waits, and only then exits (install_signal_handlers).
  GPU lane   ~/gpu.lock is only PROBED here (acquire + release): clip_lanes holds it per inference itself, so holding it here would deadlock the child.
Every busy lock is TRANSIENT (backoff, attempt counted, breaker-visible). Nothing here waits for a lock.

ERROR MAP (Result.outcome / code):
  rc 0 + cut / written / skipped_existing   done, with an artefact REF + sha256 of the file the engine wrote
  silent_audio, blind_room_day, blind_refused   permanent (the audio will not change; retrying cannot help)
  locked, gpu busy, timer gap, timeout, lane failed, no tape yet, clip not cut yet, stopped, any other rc   transient
  rc 2 from clip_lanes or the cutter (usage / validation)   permanent
  no consult_uid link   BLOCKED (not a failure): no breaker tick, no attempt spent, not retried until a link appears
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
import signal
import subprocess
import sys
import time
from dataclasses import dataclass, field

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
TIMER_MINUTE, TIMER_LAUNCH_S, MIN_BEFORE_TIMER_S = 35, 180, 720   # recut_queue.py:15
CHILD_TIMEOUT_S = 840                                              # under the 15 min lease
MIN_LANE_BUDGET_S = 300                                           # a K lane is not started with less than this before the next :25 (nemotron's worker-status wait alone can reach 30 min)
HOURLY_FROM_MIN, HOURLY_TO_MIN, HOURLY_CAP_MIN = 25, 45, 25      # K lanes refused from :25 to :45 (palimpsest-hourly starts :40); a child must end before the next :25
UID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$")      # never starts with '-': it cannot be read as a flag
EXECUTOR_STAGES = ("recut", "acoustics", "nemotron")


class ExecutorUnconfigured(Exception):
    """The env that names the CLI is missing. The job is not at fault: the runner releases it."""


@dataclass
class Result:
    outcome: str                      # done | transient | permanent | blocked | release
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


def minute_of_hour_s(now: float) -> float:
    t = dt.datetime.fromtimestamp(now, IST)
    return t.minute * 60 + t.second + t.microsecond / 1e6


def in_hourly_window(now: float, from_min: int = HOURLY_FROM_MIN, to_min: int = HOURLY_TO_MIN) -> bool:
    """True from :from_min:00 up to (not including) :to_min:00 of every IST hour."""
    return from_min * 60 <= minute_of_hour_s(now) < to_min * 60


def lane_timeout_s(now: float, cap_min: int = HOURLY_CAP_MIN, base: float | None = None) -> float:
    """min(base, seconds until the next :cap_min). At exactly :cap_min the next one is an hour away."""
    d = cap_min * 60 - minute_of_hour_s(now)
    if d <= 0:
        d += 3600
    return min(CHILD_TIMEOUT_S if base is None else base, d)


def _env_min(raw: str | None, default: int) -> int:
    try:
        v = int(raw) if raw is not None else default
    except ValueError:
        return default
    return v if 0 <= v <= 60 else default


def _env_window(env: dict) -> tuple[int, int]:
    """(from, to) minutes of the K-lane refusal window. An inverted or empty pair (from >= to) would silently open the gap: use the defaults, with one stderr line."""
    f = _env_min(env.get("SPINE_HOURLY_FROM_MIN"), HOURLY_FROM_MIN)
    t = _env_min(env.get("SPINE_HOURLY_TO_MIN"), HOURLY_TO_MIN)
    if f >= t:
        print(f"spine-executors: SPINE_HOURLY_FROM_MIN={f} must be below SPINE_HOURLY_TO_MIN={t}: using {HOURLY_FROM_MIN}/{HOURLY_TO_MIN}", file=sys.stderr)
        return HOURLY_FROM_MIN, HOURLY_TO_MIN
    return f, t


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
        self._children: set[subprocess.Popen] = set()
        self.state, self.stop_signum, self.signals_seen = self.RUNNING, None, 0
        self._run = run or self._run_group
        self.hourly_from, self.hourly_to = _env_window(e)
        self.clock = clock or time.time
        home = os.path.expanduser("~")
        self.data = e.get("SPINE_DATA_DIR") or os.path.join(home, "eta-data")
        self.gpu_lock = e.get("SPINE_GPU_LOCK") or os.path.join(home, "gpu.lock")
        self.cutter_lock = os.path.join(self.data, "consult", "cutter.lock")
        self.hourly_lock = os.path.join(self.data, "reb", "_hourly.lock")
        self.clips = os.path.join(self.data, "consult", "clips")
        self.reb = os.path.join(self.data, "reb")

    # Signal handling (SIGTERM / SIGINT). The handler is one rule, so there is no race to get wrong:
    #   - it ALWAYS records the signal: the first signum is kept (it fixes the exit code), later ones are only counted;
    #   - while a child group is registered it NEVER raises: _run_group polls in <= POLL_S slices, sees the recorded stop, kills the group ONCE, reaps it, and then exits 143 / 130 by normal control flow;
    #   - with no child registered it raises SystemExit(128 + first signum), so an idle runner still stops at once. If that raise is swallowed (e.g. in a finaliser) the next signal raises again (_run_group forgets an idle
    #     swallowed stop at entry, so first-signal-wins cannot return). A stop recorded WITH a child registered is never lost: the poll loop acts on it.
    # state is REAPING only while a kill + reap runs (a timeout reap too), otherwise RUNNING.
    RUNNING, REAPING = "RUNNING", "REAPING"
    POLL_S = 0.5

    @property
    def reaping(self) -> int:
        return 1 if self.state == self.REAPING else 0

    def on_signal(self, signum: int) -> None:
        if self.stop_signum is None:
            self.stop_signum = signum
        self.signals_seen += 1
        if self._children:
            return
        raise SystemExit(128 + self.stop_signum)

    def _raise_pending(self) -> None:
        if self.stop_signum is not None:
            raise SystemExit(128 + self.stop_signum)

    def _reap(self, p: subprocess.Popen) -> None:
        """The one kill + reap of a child's group. REAPING for its duration."""
        self.state = self.REAPING
        try:
            self._kill_group(p)
        finally:
            self.state = self.RUNNING

    def _run_group(self, argv, cwd=None, timeout=None, pass_fds=(), **_kw) -> subprocess.CompletedProcess:
        """subprocess.run, but the child leads its own process group, so a timeout or a signal kills the child AND whatever it spawned; pass_fds are inherited."""
        if not self._children:   # an idle raise that was swallowed earlier (no child was running): forget it, the next signal must still kill and exit
            self.stop_signum = None
        # SIGTERM/SIGINT are blocked across spawn + register, so a signal cannot land between Popen() and _children.add() and orphan the child; the child gets the old mask back before exec.
        old = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
        p = None
        try:
            try:
                p = subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True, pass_fds=tuple(pass_fds),
                                     preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, old))
                self._children.add(p)
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, old)   # a pending signal is delivered here, with the child already registered: recorded, not raised
            deadline = None if timeout is None else time.monotonic() + timeout
            timed_out = False
            while True:
                if self.stop_signum is not None:
                    self._reap(p)   # the one kill; a signal during it is only recorded
                    break
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    self._reap(p)
                    timed_out = True
                    break
                try:
                    out, err = p.communicate(timeout=self.POLL_S if remaining is None else min(self.POLL_S, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue
        except BaseException:
            if p is not None and p.poll() is None:
                self._reap(p)
            raise
        finally:
            if p is not None:
                self._children.discard(p)
        # Child gone and unregistered: from here the handler raises by itself, and anything recorded while the child was registered (also during a timeout reap) is raised now. Never lost.
        self._raise_pending()
        if timed_out:
            raise subprocess.TimeoutExpired(argv, timeout)
        return subprocess.CompletedProcess(argv, p.returncode, out, err)

    @staticmethod
    def _kill_group(p: subprocess.Popen) -> None:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            p.communicate()   # reap, and drain the pipes
        except Exception:   # noqa: BLE001
            pass

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
            return Result("blocked", "no_consult_uid") if not uid else Result("permanent", "bad_consult_uid")
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
        if rc == 2:
            return Result("permanent", "usage")
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
        now = self.clock()
        if in_hourly_window(now, self.hourly_from, self.hourly_to):
            return Result("release", "hourly_gap")   # nothing ran and it is not the job's fault: the attempt is given back, no breaker tick
        timeout = lane_timeout_s(now, self.hourly_from)
        if timeout < MIN_LANE_BUDGET_S:
            return Result("release", "budget_too_small")
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
                p = self._run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False, pass_fds=(hourly,))   # the child holds the lock too
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
        try:
            files = sorted(glob.glob(pat), key=lambda p: (os.path.getmtime(p), p))
        except OSError:
            return Result("transient", "artefact_missing")   # a file vanished between the glob and its mtime
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
        try:
            sha = sha256_file(path)
        except OSError:
            return Result("transient", "artefact_missing")   # the file vanished between the glob and the read
        return Result("done", None, {"engine": m["engine"], "version": m["version"], "cfg8": m["cfg8"], "store": "box", "status": status,
                                     "sha256": sha, "object_key": f"tracks/{os.path.basename(path)}"})


def install_signal_handlers(execs: Executors) -> None:
    """SIGTERM / SIGINT: the handler records the signal (see Executors.on_signal); with a child running _run_group kills the child's group once, reaps it, and only then does the process exit (143 / 130).
    The hourly lock is the child's too, so it is never free while a child runs."""
    def _h(signum, _frame):
        execs.on_signal(signum)
    signal.signal(signal.SIGTERM, _h)
    signal.signal(signal.SIGINT, _h)
