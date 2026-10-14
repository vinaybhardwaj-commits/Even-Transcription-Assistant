"""GPU window (R1; ONLY while config.GPU_WINDOW_ENABLED is True, off since 08 Oct 2026 by V decision: gate() then allows any hour): no GPU work from 22:30 to 06:00 IST (E1 owns the T4 23:00-06:00). The clock is checked immediately before EVERY GPU job and again after the lock is acquired (the worker's --not-after);
the lock is taken per job and released between jobs; waiting for the lock never goes past the latest allowed start.
Reading of the orders (stricter, and the only one consistent with their own example 'fake clock 22:29 + a 30-min span => no GPU launch'): a job may START only if its estimated finish
(span_min / 15 + 2 min margin) is before 22:30; 22:50 is the HARD STOP: a job still running then is killed."""
import datetime as dt
from . import config as C
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))

def at(now, hm):
    d = dt.datetime.fromtimestamp(now, IST); return d.replace(hour=hm[0], minute=hm[1], second=0, microsecond=0).timestamp()

def est_seconds(span_min): return span_min / C.GPU_SPEED * 60.0 + C.GPU_MARGIN_S

def gate(now, span_min, lock_wait_max=1800.0):
    """-> dict(ok, why, wait_s, not_after, timeout_s). ok only inside 06:00-22:30 and when now + estimate <= 22:30."""
    if not C.GPU_WINDOW_ENABLED:                                                  # m3-09: no night gate; the lock is still taken for ONE job only (speak.run_job), so CLARITY's runner can interleave
        return dict(ok=True, why="", wait_s=lock_wait_max, not_after=None, hard_stop=None, timeout_s=max(1800.0, est_seconds(span_min) * 4))
    t = dt.datetime.fromtimestamp(now, IST).time()
    if t >= dt.time(*C.GPU_STOP) or t < dt.time(*C.GPU_START): return dict(ok=False, why="gpu_window_closed")
    stop, hard = at(now, C.GPU_STOP), at(now, C.GPU_HARD_STOP); est = est_seconds(span_min); latest = stop - est
    if now > latest: return dict(ok=False, why="would_finish_after_22:30")
    return dict(ok=True, why="", wait_s=max(0.0, min(lock_wait_max, latest - now)), not_after=latest, hard_stop=hard, timeout_s=max(60.0, min(hard - now, max(1800.0, est * 4))))
