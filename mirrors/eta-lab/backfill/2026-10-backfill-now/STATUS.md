# backfill-now STATUS (7 Oct 2026, ~14:00 IST)

Run NOT started. 3-window check (run-20261007-134605.log) failed 3/3 with `ModuleNotFoundError` on every window.

## Diagnosis (verified)
- Services are healthy: whisper-server 127.0.0.1:8080 /health = ok; eta-router-twin.service active, uvicorn listening 127.0.0.1:8083.
- state.jsonl: all 3 windows go running -> failed in the same second with error ModuleNotFoundError (import time, never reached the router).
- Cause: run_real.sh runs `python3 runner.py` = /usr/bin/python3, which has NO boto3/botocore. runner.py -> run_window -> r2audio (R2 fetch) needs boto3. The interpreter used by every earlier hist-bulk runner run, /home/eta/.venv-r2/bin/python, has boto3/botocore. (Reverse: system python has requests/soundfile/yaml, venv does not; none of these is needed by the runner path.)
- Not a runner.py bug; no runner.py edit needed.

## Fix (not applied: my edit of run_real.sh was denied by the auto-mode classifier, [Auto-Mode Bypass]; not retried)
In run_real.sh, both launch lines, replace `python3 runner.py` with `/home/eta/.venv-r2/bin/python runner.py`:
    sed -i 's#flock /home/eta/gpu.lock python3 runner.py#flock /home/eta/gpu.lock /home/eta/.venv-r2/bin/python runner.py#' /home/eta/oc/backfill-now/run_real.sh
This changes the wrapper sha16 (bca61858 -> new); re-pin it and keep the allow rule as is (it matches the path). runner.py stays at 978d9969.
Alternative with no wrapper change: `/usr/bin/python3 -m pip install --user boto3` (changes system python env instead).

## After the fix
1. `bash /home/eta/oc/backfill-now/run_real.sh --limit 3` -> expect 3/3 done, non-zero segments.
2. `bash /home/eta/oc/backfill-now/run_real.sh --bg` -> full run. Queue at 13:40 plan: 1008 windows, 244.9 tape-h, 3 blind windows refused.

Bus: backfill-now cannot post (MCP identity unresolved: needs ETA_BUS_AS or a herdr pane).
14:13 herdr-lead: box lane paused. One :box window (bh6jtq4t_1300) held gpu.lock 18 min in the Indic twin (pid 1915, still ~127% CPU after its client was killed), starving the consult cutter. Backfill continues on c3 lane only (run_c3.sh). Box lane resumes after eta-refuter-2 BF-CHECK-1 Q3.
14:33 herdr-lead: c3 lane STOPPED (BF-CHECK-1: c3 has no Whisper path, :8091 dead; s1 engines broken since 26 Sep). All c3 output since 26 Sep must be re-queued after router-fix repairs c3.
14:30 herdr-lead: box lane resumed with CHUNK=1 (lock held one window at a time; consult cutter waits at most one window).
