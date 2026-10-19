#!/usr/bin/env python3
"""spine-runner — claims spine jobs over /api/spine/claim and reports over /api/spine/report (D10: a bearer token, no DB credential on the box).

DEFAULT IS would_run: it claims, reports status `shadow`, logs the CLI it WOULD run, and executes NOTHING (no subprocess is ever created on that path).
`--live` exists but refuses: the claim is made with live=true (the server returns only stages whose spine_config mode is live), and every job is
re-checked here — a job whose mode is not live, or a paid stage, is released untouched and the runner exits 3. Stdlib only.

Env: SPINE_BASE_URL (https://host), SPINE_BEARER_TOKEN. Optional: SPINE_RUNNER_OWNER, SPINE_POLL_SECONDS (default 60).
Exit codes: 0 once-pass done, 2 bad config, 3 live refused.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

PAID_STAGES = frozenset({"sarvam", "gapfill", "role", "llm-roles", "parts"})
# The CLI each stage WOULD run, for one encounter. Per-uid flags for several lanes are unverified (S6 adds --only where missing); the encounter id stands in for the uid.
CLI = {
    "recut": ["python3", "-m", "cutter.run", "--once", "--only", "{encounter_id}", "--recut"],
    "acoustics": ["python3", "-m", "acoustics.run", "--only", "{encounter_id}"],
    "nemotron": ["python3", "-m", "nemotron.run", "--only", "{encounter_id}"],
    "collector": ["python3", "-m", "collector.run", "--only", "{encounter_id}"],
    "freescript": ["python3", "-m", "eta2freescript", "--consult-uid", "{encounter_id}"],
}
# live exit codes -> report outcome (EX_TEMPFAIL 75 and lock-busy are retried; 2 is a permanent usage/validation error; 70 is budget)
RC_OUTCOME = {0: "done", 75: "transient", 2: "permanent", 70: "budget"}


def build_cli(job: dict) -> list[str] | None:
    tpl = CLI.get(job.get("stage", ""))
    if tpl is None:
        return None
    return [a.format(encounter_id=job["encounter_id"]) for a in tpl]


class Runner:
    def __init__(self, base_url: str, token: str, owner: str, live: bool = False, post=None, log=None):
        self.base, self.token, self.owner, self.live = base_url.rstrip("/"), token, owner, live
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

    def report(self, job: dict, outcome: str, code: str | None = None) -> int:
        body = {"job_id": job["job_id"], "owner": self.owner, "outcome": outcome}
        if code:
            body["error_code"] = code
        return self._post("/api/spine/report", body)[0]

    def run_once(self) -> int:
        """One claim pass. Returns 0, or 3 when --live was refused."""
        status, resp = self._post("/api/spine/claim", {"owner": self.owner, "limit": 2, "live": self.live})
        if status != 200:
            self.log(f"claim status={status}")
            return 0
        for job in resp.get("jobs", []):
            rc = self._handle(job)
            if rc:
                return rc
        return 0

    def _handle(self, job: dict) -> int:
        cli = build_cli(job)
        label = f"job={job['job_id']} stage={job['stage']}"
        if not self.live:
            self.log(f"would_run {label} cli={shlex.join(cli) if cli else 'none'}")
            self.report(job, "shadow")
            return 0
        if job.get("mode") != "live" or job["stage"] in PAID_STAGES or cli is None:
            self.log(f"REFUSED live {label} mode={job.get('mode')}: released untouched")
            self.report(job, "release")
            return 3
        try:
            rc = subprocess.run(cli, timeout=900, check=False).returncode
        except subprocess.TimeoutExpired:
            self.report(job, "transient", "timeout")
            return 0
        self.report(job, RC_OUTCOME.get(rc, "transient"), None if rc == 0 else f"rc_{rc}")
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
    owner = os.environ.get("SPINE_RUNNER_OWNER") or f"spine-runner:{socket.gethostname()}"
    r = Runner(base, token, owner, live=a.live)
    r.log(f"spine-runner start mode={'live' if a.live else 'would_run'} owner={owner}")
    poll = float(os.environ.get("SPINE_POLL_SECONDS", "60"))
    while True:
        rc = r.run_once()
        if rc or a.once:
            return rc
        time.sleep(poll)


if __name__ == "__main__":
    sys.exit(main())
