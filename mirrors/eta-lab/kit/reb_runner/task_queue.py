"""Claim-once task queue for REB's step-3 fan-out (W47 §6 build order: "claim-once semantics; works
across box, c3 and HF Spaces; lease + retry; nothing lost if a worker dies").

Reuses hist-bulk's proven shape (studies/2026-09-24-hist-bulk/runner.py: O_EXCL claim files + an
append-only state.jsonl) rather than inventing a new one, with one addition that order asked for and
hist-bulk's version didn't need: a LEASE TIMEOUT, so a claim from a worker that died (box/c3 process
killed, an HF Job that hit its wall-clock timeout) is automatically stealable instead of needing a
person to run a manual claims-reset between epochs.

A task is (queue_name, window_id) — per Fable's 15:22 "fan out across windows, not engines-per-window":
one claim covers a WHOLE window for a given queue (e.g. queue_name="box-whisper" claims window W means
"I will run all 3 whisper passes for W"), not one claim per (window, engine). This keeps a worker's
unit of work coarse enough that it isn't constantly re-contending manifest.lock with other workers on
the SAME window (see the wrangler-lock finding, bus #4669) — different windows, not engines within one
window, is the fan-out axis.
"""
import fcntl
import json
import os
import time

DEFAULT_LEASE_S = 1800  # 30 min: generous for a whole-window multi-engine unit of work


def _claims_dir(root, queue_name):
    return os.path.join(root, "_runner", "claims", queue_name)


def _state_path(root):
    return os.path.join(root, "_runner", "state.jsonl")


def _lock(lock_path):
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o640)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def _unlock(fd):
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)


def log_state(root, queue_name, window_id, state, **kw):
    """Append-only, one line per event (claimed / done / failed / released). Never mutated in place —
    the log is a history, not a cache; is_done() replays it."""
    path = _state_path(root)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    line = json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "queue": queue_name,
                        "window_id": window_id, "state": state, **kw}, ensure_ascii=False)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o640)
    try:
        os.write(fd, (line + "\n").encode("utf-8"))
    finally:
        os.close(fd)


def is_done(root, queue_name, window_id):
    """True if the LATEST logged state for this (queue, window) is 'done'. A missing log or any other
    latest state (claimed/failed/released) means "not done" — safe to (re)claim."""
    path = _state_path(root)
    if not os.path.exists(path):
        return False
    latest = None
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get("queue") == queue_name and rec.get("window_id") == window_id:
                latest = rec
    return bool(latest and latest.get("state") == "done")


def claim(root, queue_name, window_id, owner, lease_s=DEFAULT_LEASE_S):
    """Try to claim window_id for queue_name. Returns True if this call took the claim (or stole an
    expired one), False if someone else holds a live claim or the window is already done.
    A claim file holds {"owner": <str>, "claimed_at": <epoch float>}. Stealing an expired claim is
    itself guarded by a lock on a sibling .lock file, so two stealers can't both think they won."""
    if is_done(root, queue_name, window_id):
        return False
    claims_dir = _claims_dir(root, queue_name)
    os.makedirs(claims_dir, exist_ok=True)
    claim_path = os.path.join(claims_dir, window_id)
    body = json.dumps({"owner": owner, "claimed_at": time.time()}).encode("utf-8")
    try:
        fd = os.open(claim_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640)
        os.write(fd, body)
        os.close(fd)
        log_state(root, queue_name, window_id, "claimed", owner=owner)
        return True
    except FileExistsError:
        pass

    # someone holds it (or held it) — steal only if it's stale, under a lock so stealers can't race.
    lock_fd = _lock(claim_path + ".lock")
    try:
        try:
            with open(claim_path) as f:
                existing = json.loads(f.read() or "{}")
        except (FileNotFoundError, json.JSONDecodeError):
            existing = {}
        age = time.time() - existing.get("claimed_at", time.time())
        if age <= lease_s:
            return False  # still a live claim, not ours
        if is_done(root, queue_name, window_id):
            return False  # finished while we were checking
        fd = os.open(claim_path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o640)
        try:
            os.write(fd, body)
        finally:
            os.close(fd)
        log_state(root, queue_name, window_id, "claimed", owner=owner, stole_from=existing.get("owner"), stale_after_s=round(age, 1))
        return True
    finally:
        _unlock(lock_fd)


def release(root, queue_name, window_id):
    """Give up a claim early (e.g. a clean failure the worker wants retried immediately rather than
    waiting out the full lease). Never required for correctness — an expired lease is reclaimable on
    its own — this just avoids the wait."""
    claim_path = os.path.join(_claims_dir(root, queue_name), window_id)
    try:
        os.remove(claim_path)
    except FileNotFoundError:
        pass


def mark_done(root, queue_name, window_id, **kw):
    log_state(root, queue_name, window_id, "done", **kw)


def mark_failed(root, queue_name, window_id, reason, **kw):
    log_state(root, queue_name, window_id, "failed", reason=str(reason)[:500], **kw)


def pending(root, queue_name, window_ids, owner, lease_s=DEFAULT_LEASE_S):
    """Generator: try to claim each of window_ids in order, yielding the ones this call actually won.
    A worker calls this with its full candidate list and just processes whatever comes back — claim
    contention with other workers is invisible to the caller."""
    for w in window_ids:
        if claim(root, queue_name, w, owner, lease_s=lease_s):
            yield w
