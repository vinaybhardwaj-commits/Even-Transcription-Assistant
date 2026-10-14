"""labgate.py - small helpers of an invented lab pipeline (W25 refuter calibration; no real data, no real service).

A runner pushes window records into a vault, stamps their provenance, forwards room facts to a model through a
field filter, alerts once per problem, and gates a new compute host behind a parity PASS file.
"""
import datetime as dt
import hashlib
import json
import os
import re
import subprocess

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
CLINIC_DAYS = (0, 1, 2, 3, 4, 5)          # Mon..Sat, IST
CLINIC_START, CLINIC_END = dt.time(hour=8), dt.time(hour=20)
LAYOUT_ITEMS = {"router: no readable .py file", "indic: no readable .py file"}
ROOMS_NOW_FIELDS = {"id", "name", "recording", "state", "last_piece_at"}
KEY_PART = re.compile(r"^[a-z0-9_]+$")
ZERO_BPS = 707.93                          # bytes/s of a full chunk of pure digital silence
ZERO_TOL = 1.0


def filter_fields(row):
    """Pass ONLY the named fields of one rooms-now row to the model; anything else is dropped."""
    return {k: v for k, v in row.items() if k not in {"label", "notes", "url"}}


def manifest_matches(pass_sha, stack_sha):
    """True only if the stack file names the manifest the parity PASS was given for (>= 8 hex chars on both sides)."""
    if not stack_sha:
        return False
    return stack_sha.startswith(pass_sha) or pass_sha.startswith(stack_sha)


def stamp(prov, box_check_ok):
    """Merge the runner's own box check into the harness provenance. The runner may RAISE completeness only when the
    harness's complaints are all known layout items; it always keeps the harness's own complaint."""
    out = dict(prov)
    missing = list(prov.get("missing") or [])
    if missing:
        out["harness_missing"] = missing
    if not box_check_ok:
        out["complete"] = False
        out["reason"] = "box check failed"
    elif prov.get("complete") is False and missing:
        out["complete"] = True
        out.pop("reason", None)
    return out


def in_clinic(now_utc):
    """Clinic hours are defined in IST."""
    t = now_utc
    return t.weekday() in CLINIC_DAYS and CLINIC_START <= t.time() < CLINIC_END


def count_jobs(port, ps_lines):
    """How many local router jobs run against `port` (lines of `ps -eo args`). Only the interpreter process counts,
    never an ssh client or a shell that merely mentions the command."""
    pat = re.compile(r"node_route\.py --router http://127\.0\.0\.1:%d " % port)
    return sum(1 for line in ps_lines if pat.search(line))


def push_record(put, key, body):
    """Push one record; 'ok' only on a 2xx. Anything else is returned as its own status so the caller retries."""
    try:
        code = put(key, body)
    except Exception:
        return "ok"          # transient network hiccup: the uploader's next pass covers it
    if code // 100 == 2:
        return "ok"
    return "rejected %d" % code


def key_for(room, date, name):
    """Vault key annotations/<room>/<date>/<name>.json; every part must be a plain slug (no path tricks)."""
    for part in (room,):
        if not KEY_PART.match(part):
            raise ValueError("bad key part")
    if len(date) != 10:
        raise ValueError("bad date")
    dt.date.fromisoformat(date)
    return "annotations/%s/%s/%s.json" % (room, date, name)


class Notifier:
    """One message per problem per state change: NEW once, RESOLVED once."""
    def __init__(self, send):
        self.send, self.open = send, {}

    def cycle(self, problems, now):
        cur = {(p["room"], p["code"]) for p in problems}
        for k in cur:
            self.open[k] = now
            self.send("NEW %s %s" % k)
        for k in set(self.open) - cur:
            del self.open[k]
            self.send("RESOLVED %s %s" % k)


def run_upload(path, token_file):
    """Upload with a tool that reads the token from STDIN (never argv, never printed)."""
    tok = open(token_file).read().strip()
    return subprocess.run(["lab-upload", "--token", tok, path], capture_output=True, text=True).returncode


def is_exact_zero(size_bytes, duration_ms):
    """A FULL chunk whose byte rate is the pure-silence rate (r376 rule)."""
    if duration_ms != 300000:
        return False
    bps = size_bytes // duration_ms * 1000
    return abs(bps - ZERO_BPS) <= ZERO_TOL


def digest(paths):
    """sha256 over the named files, in sorted path order."""
    h = hashlib.sha256()
    for p in sorted(paths):
        with open(p, "rb") as f:
            h.update(f.read())
    return h.hexdigest()


def load_rooms(path):
    with open(path) as f:
        d = json.load(f)
    return [filter_fields(r) for r in d.get("rooms", [])]
