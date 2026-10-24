#!/usr/bin/env python3
"""spine-runner — claims spine jobs over /api/spine/claim and reports over /api/spine/report (D10: a bearer token, no DB credential on the box).

DEFAULT IS would_run: it claims, reports status `shadow`, logs the CLI it WOULD run, and executes NOTHING (no subprocess is ever created on that path).
`--live` (S6) runs only the FREE stages that have an executor (recut, acoustics, nemotron; executors.py): the claim is made with live=true (the server returns only stages whose
spine_config mode is live, with the consult_uid link), and every job is re-checked here — a job whose mode is not live, a paid stage, or a stage with no executor is released
untouched and the runner exits 3; the rest of that claim is released too (it does not burn an attempt). Stdlib only.

Env: SPINE_BASE_URL (https://host), SPINE_BEARER_TOKEN; --live also SPINE_CUTTER_DIR/_PY (recut) and SPINE_LAB_DIR/_PY (acoustics, nemotron), see executors.py. Optional: SPINE_RUNNER_OWNER (replaces the hostname part), SPINE_POLL_SECONDS (default 60; a malformed value falls back to 60 with one error line).
Owner: <hostname>:<pid>:<random token>, fresh per process (two runners on one box never share a lease owner).
Exit codes: 143/130 on SIGTERM/SIGINT (after the child's process group is killed), 0 once-pass done, 2 bad config, 3 live refused (or an executor is not configured).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import executors  # noqa: E402

DEFAULT_POLL = 60.0
PAID_STAGES = frozenset({"sarvam", "gapfill", "role", "llm-roles", "parts"})
# The CLI each stage WOULD run, for one encounter. Per-uid flags for several lanes are unverified (S6 adds --only where missing); the encounter id stands in for the uid.
CLI = {
    "recut": ["python3", "-m", "cutter.run", "--once", "--only", "{encounter_id}", "--recut"],
    "acoustics": ["python3", "-m", "kit.reb.clip_lanes", "--lane", "acoustics", "--consult", "{encounter_id}", "--write"],
    "nemotron": ["python3", "-m", "kit.reb.clip_lanes", "--lane", "nemotron", "--consult", "{encounter_id}", "--write", "--worker-status", "worker"],
    "collector": ["python3", "-m", "collector.run", "--only", "{encounter_id}"],
    "freescript": ["python3", "-m", "eta2freescript", "--consult-uid", "{encounter_id}"],
}


def make_owner(host: str | None = None) -> str:
    """hostname:pid:random token, within the server's owner pattern [A-Za-z0-9_.:-]{1,64}."""
    h = re.sub(r"[^A-Za-z0-9_.-]", "", host if host is not None else (os.environ.get("SPINE_RUNNER_OWNER") or socket.gethostname()))[:40] or "host"
    return f"{h}:{os.getpid()}:{secrets.token_hex(4)}"


def poll_seconds(raw: str | None, log=None) -> float:
    """A malformed, non-positive or non-finite value falls back to the default with one error line (no crash loop)."""
    try:
        v = float(raw) if raw is not None else DEFAULT_POLL
        if v > 0 and v != float("inf"):
            return v
    except ValueError:
        pass
    (log or (lambda m: print(m, file=sys.stderr, flush=True)))(f"spine-runner: bad SPINE_POLL_SECONDS, using {DEFAULT_POLL:g}")
    return DEFAULT_POLL


def build_cli(job: dict) -> list[str] | None:
    tpl = CLI.get(job.get("stage", ""))
    if tpl is None:
        return None
    return [a.format(encounter_id=job["encounter_id"]) for a in tpl]


class Runner:
    def __init__(self, base_url: str, token: str, owner: str, live: bool = False, post=None, log=None, execs=None):
        self.base, self.token, self.owner, self.live = base_url.rstrip("/"), token, owner, live
        self.execs = execs if execs is not None else executors.Executors()
        self._post = post or self._http_post
        self.log = log or (lambda m: print(m, flush=True))

    def _http_post(self, path: str, body: dict) -> tuple[int, dict]:
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except ValueError:
                return e.code, {}
        except (urllib.error.URLError, TimeoutError, OSError):
            return 0, {}

    def report(self, job: dict, outcome: str, code: str | None = None, artefact: dict | None = None) -> int:
        """Report once, retry ONCE on a transport/server failure (not on 409 lease_lost: that is final), then log and move on. Never spends more."""
        body = {"job_id": job["job_id"], "owner": self.owner, "outcome": outcome}
        if code:
            body["error_code"] = code
        if artefact:
            body["artefact"] = artefact
        status = self._post("/api/spine/report", body)[0]
        if status not in (200, 409):
            status = self._post("/api/spine/report", body)[0]
        if status != 200:
            self.log(f"report failed job={job['job_id']} outcome={outcome} status={status}: moving on")
        return status

    def run_once(self) -> int:
        """One claim pass. Returns 0, or 3 when --live was refused."""
        status, resp = self._post("/api/spine/claim", {"owner": self.owner, "limit": 1 if self.live else 2, "live": self.live})   # live: one job per pass, so its lease is not spent while the one before it runs
        if status != 200:
            self.log(f"claim status={status}")
            return 0
        jobs = resp.get("jobs", [])
        for i, job in enumerate(jobs):
            rc = self._handle(job)
            if rc:
                for rest in jobs[i + 1:]:   # N4: the others of this claim were never started: give them back, no attempt spent
                    self.report(rest, "release")
                return rc
        return 0

    def _handle(self, job: dict) -> int:
        cli = build_cli(job)
        label = f"job={job['job_id']} stage={job['stage']}"
        if not self.live:
            self.log(f"would_run {label} cli={shlex.join(cli) if cli else 'none'}")
            self.report(job, "shadow")
            return 0
        if job.get("mode") != "live" or job["stage"] in PAID_STAGES or cli is None or not self.execs.has(job["stage"]):
            self.log(f"REFUSED live {label} mode={job.get('mode')}: released untouched")
            self.report(job, "release")
            return 3
        try:
            res = self.execs.execute(job["stage"], job.get("consult_uid"))
        except executors.ExecutorUnconfigured as e:
            self.log(f"REFUSED live {label}: executor not configured ({e}): released untouched")
            self.report(job, "release")
            return 3
        self.log(f"{label} outcome={res.outcome} code={res.code}")   # codes only: never the uid, the argv or the child's output
        self.report(job, res.outcome, res.code, res.artefact)
        return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--live", action="store_true", help="execute jobs (refused unless the stage mode is live)")
    ap.add_argument("--once", action="store_true", help="one claim pass, then exit")
    a = ap.parse_args(argv)
    base, token = os.environ.get("SPINE_BASE_URL", ""), os.environ.get("SPINE_BEARER_TOKEN", "")
    if not base or not token:
        print("spine-runner: SPINE_BASE_URL and SPINE_BEARER_TOKEN are required", file=sys.stderr)
        return 2
    owner = make_owner()
    r = Runner(base, token, owner, live=a.live)
    if a.live:
        executors.install_signal_handlers(r.execs)
    r.log(f"spine-runner start mode={'live' if a.live else 'would_run'} owner={owner}")
    poll = poll_seconds(os.environ.get("SPINE_POLL_SECONDS"))
    while True:
        r.execs.raise_pending()   # an idle stop swallowed by a finaliser is not lost: exit 128+signum before claiming anything
        rc = r.run_once()
        if rc or a.once:
            return rc
        time.sleep(poll)


if __name__ == "__main__":
    sys.exit(main())
