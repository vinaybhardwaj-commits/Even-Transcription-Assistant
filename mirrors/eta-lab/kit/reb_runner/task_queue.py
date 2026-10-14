"""Claim-once task queue for REB's step-3 fan-out (W47 §6 build order: "claim-once semantics...
lease + retry; nothing lost if a worker dies").

Reuses hist-bulk's proven shape (studies/2026-09-24-hist-bulk/runner.py: O_EXCL claim files + an
append-only state.jsonl) rather than inventing a new one, with one addition that order asked for and
hist-bulk's version didn't need: a LEASE TIMEOUT, so a claim from a worker that died is automatically
stealable instead of needing a person to run a manual claims-reset between epochs.

Coordinates workers that share the SAME local filesystem view of `root` (plain POSIX flock/O_EXCL —
this does NOT reach across separate hosts on its own; a box worker and a c3 worker only coordinate
through this queue if `root` is actually the same mounted path for both, which nothing in this repo
sets up yet — eta-refuter-2, #4807 Q3). For box/c3/HF to share one real queue, something has to give
every worker a shared view of this root (NFS, or the "workers upload just their track file, box's
own process is the only queue participant" design in kit/reb_runner/DESIGN.md) — that's a step-3
follow-up, not something this module does by itself.

A task is (queue_name, window_id) — per Fable's 15:22 "fan out across windows, not engines-per-window":
one claim covers a WHOLE window for a given queue (e.g. queue_name="box-whisper" claims window W means
"I will run all 3 whisper passes for W"), not one claim per (window, engine).

Fencing (eta-refuter-2 #4807 Q2, eta-refuter-3 #4797 B2): every claim carries a random TOKEN. Once
claim() returns one, that token is this worker's proof of ownership — release()/mark_done()/
mark_failed() require it and are a no-op if the claim file's CURRENT token doesn't match (someone else
stole it in the meantime), so a zombie whose lease already expired can never corrupt or delete the
window it no longer owns. is_done() answers "has 'done' EVER been logged for this (queue, window)",
not "is the latest logged state done" — a stale worker's late mark_failed can therefore never flip a
genuinely finished window back to not-done (eta-refuter-2 #4807 Q2's other half of the same bug).
"""
import fcntl
import json
import os
import time
import uuid

DEFAULT_LEASE_S = 1800  # 30 min: generous for a whole-window multi-engine unit of work


def _claims_dir(root, queue_name):
    return os.path.join(root, "_runner", "claims", queue_name)


def _claim_path(root, queue_name, window_id):
    return os.path.join(_claims_dir(root, queue_name), window_id)


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
    """True if 'done' has EVER been logged for this (queue, window) — not just whether it's the latest
    line. A zombie worker's late mark_failed (landing after a legitimate mark_done) must never undo a
    real completion (eta-refuter-2 #4807 Q2)."""
    path = _state_path(root)
    if not os.path.exists(path):
        return False
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            if rec.get("queue") == queue_name and rec.get("window_id") == window_id and rec.get("state") == "done":
                return True
    return False


def _read_claim(claim_path):
    """(owner, token, claimed_at) from a claim file, tolerating a missing/empty/corrupt one (a worker
    that crashed between O_CREAT|O_EXCL and writing its body leaves exactly this — eta-refuter-2 #4807
    Q1). claimed_at falls back to the file's own mtime so an empty file isn't immortally "fresh"."""
    try:
        with open(claim_path) as f:
            raw = f.read()
        existing = json.loads(raw) if raw.strip() else {}
    except (FileNotFoundError, json.JSONDecodeError):
        existing = {}
    claimed_at = existing.get("claimed_at")
    if claimed_at is None:
        try:
            claimed_at = os.path.getmtime(claim_path)
        except FileNotFoundError:
            claimed_at = time.time()
    return existing.get("owner"), existing.get("token"), claimed_at


def claim(root, queue_name, window_id, owner, lease_s=DEFAULT_LEASE_S):
    """Try to claim window_id for queue_name. Returns a TOKEN (str) if this call took the claim (fresh
    or stolen), or None if someone else holds a live claim or the window is already done. Callers MUST
    hold onto the token and pass it to release()/mark_done()/mark_failed() — those are no-ops without
    a matching token (fencing, eta-refuter-2 #4807 Q2 / eta-refuter-3 #4797 B2).

    The fresh-create path and the steal path both run under the SAME per-window lock (eta-refuter-3
    #4797 B1: previously only the steal path was locked, so a fresh O_EXCL create could race a
    concurrent steal and both would return success for the same window)."""
    if is_done(root, queue_name, window_id):
        return None
    claims_dir = _claims_dir(root, queue_name)
    os.makedirs(claims_dir, exist_ok=True)
    claim_path = os.path.join(claims_dir, window_id)
    lock_fd = _lock(claim_path + ".lock")
    try:
        if is_done(root, queue_name, window_id):
            return None  # finished while we waited for the lock
        token = uuid.uuid4().hex
        body = json.dumps({"owner": owner, "token": token, "claimed_at": time.time()}).encode("utf-8")
        if not os.path.exists(claim_path):
            fd = os.open(claim_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640)
            try:
                os.write(fd, body)
            finally:
                os.close(fd)
            log_state(root, queue_name, window_id, "claimed", owner=owner, token=token)
            return token

        existing_owner, _existing_token, claimed_at = _read_claim(claim_path)
        age = time.time() - claimed_at
        if age <= lease_s:
            return None  # still a live claim, not ours
        fd = os.open(claim_path, os.O_WRONLY | os.O_TRUNC, 0o640)
        try:
            os.write(fd, body)
        finally:
            os.close(fd)
        log_state(root, queue_name, window_id, "claimed", owner=owner, token=token,
                  stole_from=existing_owner, stale_after_s=round(age, 1))
        return token
    finally:
        _unlock(lock_fd)


def _with_owned_claim(root, queue_name, window_id, token, fn):
    """Run fn() only if `token` still matches the claim file's CURRENT token, under the per-window
    lock so the check-then-act can't race a concurrent steal. Returns whether fn() ran."""
    claim_path = _claim_path(root, queue_name, window_id)
    lock_fd = _lock(claim_path + ".lock")
    try:
        _owner, current_token, _claimed_at = _read_claim(claim_path)
        if current_token != token:
            return False
        fn()
        return True
    finally:
        _unlock(lock_fd)


def release(root, queue_name, window_id, token):
    """Give up a claim early (e.g. a clean failure the worker wants retried immediately rather than
    waiting out the full lease). No-op if `token` isn't the CURRENT owner (a stale worker must never
    delete a live stealer's claim — eta-refuter-2 #4807 Q2). Never required for correctness — an
    expired lease is reclaimable on its own — this just avoids the wait."""
    claim_path = _claim_path(root, queue_name, window_id)
    def _do():
        try:
            os.remove(claim_path)
        except FileNotFoundError:
            pass
    return _with_owned_claim(root, queue_name, window_id, token, _do)


def renew(root, queue_name, window_id, token, lease_s=DEFAULT_LEASE_S):
    """Heartbeat: refresh claimed_at so a long-running window doesn't get stolen from an alive worker
    (eta-refuter-2 #4807, eta-refuter-3 #4797: noted as a real gap, not wired into any driver yet —
    a worker doing multiple slow engine passes over one window should call this periodically). No-op,
    returns False, if `token` isn't the current owner."""
    claim_path = _claim_path(root, queue_name, window_id)
    def _do():
        body = json.dumps({"owner": _read_claim(claim_path)[0], "token": token, "claimed_at": time.time()}).encode("utf-8")
        fd = os.open(claim_path, os.O_WRONLY | os.O_TRUNC, 0o640)
        try:
            os.write(fd, body)
        finally:
            os.close(fd)
    return _with_owned_claim(root, queue_name, window_id, token, _do)


def mark_done(root, queue_name, window_id, token, **kw):
    """No-op (returns False) if `token` isn't the current owner — a stale worker must never be able to
    log a fabricated completion for a window it no longer owns."""
    return _with_owned_claim(root, queue_name, window_id, token,
                              lambda: log_state(root, queue_name, window_id, "done", owner_token=token, **kw))


def mark_failed(root, queue_name, window_id, token, reason, **kw):
    return _with_owned_claim(
        root, queue_name, window_id, token,
        lambda: log_state(root, queue_name, window_id, "failed", reason=str(reason)[:500], owner_token=token, **kw),
    )


def pending(root, queue_name, window_ids, owner, lease_s=DEFAULT_LEASE_S):
    """Generator: try to claim each of window_ids in order, yielding (window_id, token) for the ones
    this call actually won. A worker calls this with its full candidate list and just processes
    whatever comes back — claim contention with other workers is invisible to the caller."""
    for w in window_ids:
        token = claim(root, queue_name, w, owner, lease_s=lease_s)
        if token:
            yield w, token
