"""W50 set (c) box-local baselines: pins the IDENTITY of the shared, long-running services (whisper-server
:8080, sravaani-twin :8085) that a config_hash alone can't capture (refuter-2 #5273 / refuter-3 #5274's gate: "the
config hash pins the REQUEST, not the SERVICE"). A process older than its own code, or one that's been restarted
with different flags/model since it wrote set (b)'s baselines, would silently change what a config_hash claims to
represent.

Neither service is restarted or reconfigured here - they're shared with other consumers (reb #5275). This module
only OBSERVES and either confirms continuity or refuses loudly.

refuter-2 #5277 (G3/G4) / refuter-3 #5278 (R2/R3) fixes:
G3/R2 - the model/binary path is now PARSED from the live process's cmdline (a "-m <path>" flag for whisper-
        server), not a hard-coded constant - a server started with a different model would otherwise pass a
        check against the wrong file. Also resolves and hashes the actual running executable
        (/proc/<pid>/exe's target), and records the full cmdline flags for comparison.
G4/R3 - a file's sha256 alone proves nothing about what code an ALREADY-RUNNING process loaded unless that
        file's mtime predates the process start time (the "stale-code" / drift-audit rule, matching diar-lab's
        nightly convention, bus #5143) - assert_predates_process() checks this for the model, binary, and
        sravaani script, refusing if any file was modified AFTER the process using it started.
"""
import hashlib
import os
import re
import subprocess
from datetime import datetime

WHISPER_PORT = int(os.environ.get("REB_WHISPER_PORT", "8080"))
SRAVAANI_PORT = int(os.environ.get("REB_SRAVAANI_PORT", "8085"))
SRAVAANI_SERVER_SCRIPT = os.path.expanduser("~/services/eta-sravaani-twin/sravaani_server.py")


class ServiceIdentityError(RuntimeError):
    """A service's identity could not be established, or doesn't match what a prior check recorded - refuses
    loudly rather than guess a shared, unrestartable-by-us service is still the same one."""


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _pid_listening_on(port):
    """-> the PID of the process listening on `port`, via `ss` (no root needed for TCP listen sockets owned by
    this user). Raises ServiceIdentityError if none or more than one is found - ambiguous, never guessed."""
    out = subprocess.run(["ss", "-tlnp", f"sport = :{port}"], capture_output=True, text=True, check=True).stdout
    pids = set()
    for line in out.splitlines():
        if f":{port} " not in line and not line.rstrip().endswith(f":{port}"):
            continue
        if "pid=" not in line:
            continue
        pids.add(line.split("pid=")[1].split(",")[0])
    if len(pids) != 1:
        raise ServiceIdentityError(f"expected exactly 1 process listening on port {port}, found {pids}")
    return int(pids.pop())


def _process_cmdline_and_start(pid):
    with open(f"/proc/{pid}/cmdline", "rb") as f:
        cmdline = f.read().decode("utf-8", "replace").replace("\x00", " ").strip()
    # started_at via `ps -o lstart=` (human-readable, locale-independent enough for logging/comparison here)
    lstart = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, check=True
                             ).stdout.strip()
    started_at = datetime.strptime(lstart, "%a %b %d %H:%M:%S %Y")
    return cmdline, started_at


def _exe_path_and_sha256(pid):
    exe_path = os.readlink(f"/proc/{pid}/exe")
    return exe_path, (_sha256_file(exe_path) if os.path.exists(exe_path) else None)


def _mtime(path):
    return datetime.fromtimestamp(os.stat(path).st_mtime) if os.path.exists(path) else None


def _parse_model_path_from_cmdline(cmdline, flag="-m"):
    """G3/R2: the model path a service is ACTUALLY running with, parsed from its live cmdline - never a
    hard-coded guess of where the model "should" be. Raises ServiceIdentityError if the flag isn't present."""
    parts = cmdline.split()
    for i, part in enumerate(parts):
        if part == flag and i + 1 < len(parts):
            return parts[i + 1]
    raise ServiceIdentityError(f"couldn't find {flag!r} in cmdline {cmdline!r} - can't identify the running model")


def whisper_server_identity(port=WHISPER_PORT):
    """-> {"pid", "cmdline", "started_at", "exe_path", "exe_sha256", "exe_mtime", "model_path", "model_sha256",
    "model_mtime", "health"}. model_path is parsed from the live cmdline's "-m <path>" flag, not hard-coded."""
    import requests

    pid = _pid_listening_on(port)
    cmdline, started_at = _process_cmdline_and_start(pid)
    exe_path, exe_sha256 = _exe_path_and_sha256(pid)
    model_path = _parse_model_path_from_cmdline(cmdline, "-m")
    health = requests.get(f"http://127.0.0.1:{port}/health", timeout=5).text.strip()
    model_sha256 = _sha256_file(model_path) if os.path.exists(model_path) else None
    return {
        "pid": pid, "cmdline": cmdline, "started_at": started_at,
        "exe_path": exe_path, "exe_sha256": exe_sha256, "exe_mtime": _mtime(exe_path),
        "model_path": model_path, "model_sha256": model_sha256, "model_mtime": _mtime(model_path),
        "health": health,
    }


def sravaani_server_identity(port=SRAVAANI_PORT, script_path=SRAVAANI_SERVER_SCRIPT):
    """-> {"pid", "cmdline", "started_at", "exe_path", "exe_sha256", "exe_mtime", "script_path", "script_sha256",
    "script_mtime", "health"}. No /health endpoint was found on this service (checked, not assumed - a 404 HTML
    page, recorded honestly as None rather than a fabricated "ok")."""
    import requests

    pid = _pid_listening_on(port)
    cmdline, started_at = _process_cmdline_and_start(pid)
    exe_path, exe_sha256 = _exe_path_and_sha256(pid)
    try:
        resp = requests.get(f"http://127.0.0.1:{port}/health", timeout=5)
        health = resp.text.strip() if resp.status_code == 200 else None
    except Exception:
        health = None
    script_sha256 = _sha256_file(script_path) if os.path.exists(script_path) else None
    return {
        "pid": pid, "cmdline": cmdline, "started_at": started_at,
        "exe_path": exe_path, "exe_sha256": exe_sha256, "exe_mtime": _mtime(exe_path),
        "script_path": script_path, "script_sha256": script_sha256, "script_mtime": _mtime(script_path),
        "health": health,
    }


def assert_predates(identity, cutoff, service_name):
    """cutoff: a datetime the service's `started_at` must be BEFORE - confirms this is the same long-running
    instance that (per refuter-3 #5274) wrote set (b)'s baselines, not a restarted one. Raises
    ServiceIdentityError otherwise."""
    if identity["started_at"] >= cutoff:
        raise ServiceIdentityError(
            f"{service_name} (pid {identity['pid']}) started at {identity['started_at']}, which is NOT before "
            f"the required cutoff {cutoff} - this may be a different (restarted) instance than the one that "
            f"wrote set (b)'s baselines. Refusing to write; ask the service's owner before proceeding."
        )


def assert_files_predate_process(identity, service_name, mtime_keys):
    """G4/R3 (the "stale-code" / drift-audit rule): for each key in `mtime_keys` (e.g. "model_mtime",
    "exe_mtime", "script_mtime"), asserts that file's mtime is BEFORE the process's own start time. A file
    modified AFTER the process started proves nothing about what that already-running process actually loaded -
    hashing it would be measuring code/a model the process never read. Raises ServiceIdentityError otherwise."""
    started_at = identity["started_at"]
    for key in mtime_keys:
        mtime = identity.get(key)
        if mtime is None:
            raise ServiceIdentityError(f"{service_name}: {key} is unknown (file missing?) - can't verify staleness")
        if mtime >= started_at:
            raise ServiceIdentityError(
                f"{service_name}: {key}={mtime} is NOT before the process's start time {started_at} - this file "
                f"was modified after the process started, so hashing it does not prove what code/model the "
                f"running process actually has loaded. Refusing to trust this identity."
            )


def assert_unchanged(identity_a, identity_b, service_name, compare_keys):
    """Compares two identity snapshots (e.g. taken before and after a batch of writes) on `compare_keys` -
    raises ServiceIdentityError if ANY differ (refuter-3 #5274: re-check per consult, refuse on a mid-run
    restart or model change)."""
    diffs = {k: (identity_a.get(k), identity_b.get(k)) for k in compare_keys if identity_a.get(k) != identity_b.get(k)}
    if diffs:
        raise ServiceIdentityError(
            f"{service_name} identity changed mid-run: {diffs} - a restart or reconfiguration happened while "
            f"writing; refusing to continue (already-written tracks before this point are unaffected, but no "
            f"more should be written under the same config_hash until this is understood)."
        )
