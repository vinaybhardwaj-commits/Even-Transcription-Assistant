# ORDERS-HF-3c-LOCAL-DISK (backfill-lead, 08 Oct ~11:35 IST)

GOAL: lane 3 on HF-1 runs from LOCAL disk. Root cause of the 10:51 bench failure (both families exit non-zero, zero output): /data on HF-1 is hf-mount (FUSE, network-backed). The venvs, uv-python and hf_home live there; a debug run (indic --limit 1) spent 5.5 min wall / 5 s CPU sleeping in FUSE request_wait_answer while importing transformers. Local overlay disk: 304 GB free, ephemeral (lost on Space restart). No OOM (cgroup oom_kill 0).

SCOPE / ALLOWED CHANGES (box ~/oc/backfill-now/hf-lane3/, then push to HF-1 /data/lane3/bin):
1. New stage_local.sh, idempotent, run once per Space session: builds/copies everything the job READS to a local root (e.g. /tmp/lane3-local): python interpreter + venv-indic + venv-sra (rebuild with install_hf1.sh under a local L3_ROOT, using UV_CACHE_DIR=/data/lane3/uv-cache, or copy; your call, venvs have absolute paths), hf_home snapshots (byte-verify against the existing manifests, same OFFLINE OK checks), bench/day audio (sha256 verify), bin/. Writes a READY marker with the shas.
2. run_lane3.sh: refuse unless the local READY marker matches; run the job with L3_ROOT=local; after each window/family, copy finished out/<family>/<win>.json to /data/lane3/out/<family>/ atomically (tmp+rename), never overwrite. Logs written locally first, mirrored to /data/lane3/work. A job crash must leave its traceback in the log.
3. Keep lane3_cpu_job.py UNCHANGED (sha16 ab5cef4f stays pinned). If you must change it, stop and say why.
4. Tests for the new script logic (marker refusal, no-overwrite copy, resume skips done).

VERIFY on HF-1 (direct box key: ssh -i ~/.ssh/hf_box_ed25519 -o IdentitiesOnly=yes vrbeven-eta-hf-1@ssh.hf.space, always < /dev/null or a file; inner ssh in bash -s eats stdin; no scp, use cat pipes):
- local `python -c "import torch, transformers"` time for both venvs (expect seconds).
- indic and sravaani, --limit 1 on bench-2026-09-29.json: outputs land in /data/lane3/out/<family>/, timing_s per window recorded.
- Then the full 5-window bench (run_lane3.sh all bench-2026-09-29.json) and bench_summary.py -> windows/h. Report the number.

DO NOT: start the 418-window day run; delete anything on /data (moves to _to_delete only); route any traffic via the Mini (C2: no Mini bulk 07:30-21:30); read the HF token; touch c4/box lanes.

REPORT: append section HF-3c to HF-3-REPORT.md (<=30 lines): root cause, what changed with sha16s, import times, bench windows/h, READY-FOR-REFUTER. Cap 75 min.

HF-4 rulings (backfill-lead, same time): scope = your 6,256 windows from local audio (accepted; the 82 extra are wanted). The 5 duplicate window ids stay EXCLUDED from this run, listed in plan.json; they go to a later dedupe pass. HF-4 goes to eta-refuter-2 via the bus now; do not create the node until PASS.
