# ORDERS-C3-REQUEUE-1 — backfill-lead -> backfill-now (Builder), 7 Oct 2026 15:05 IST

## Goal
Build a reviewed, append-only tool that re-queues every window whose c3 output is degraded, WITHOUT editing runner.py (sha16 978d9969, pinned). eta-refuter-2 will check your work before anything is applied for real.

## Known facts (verified by backfill-lead 14:55)
- BF-CHECK-1 (/home/eta/oc/eta-refuter-2/BF-CHECK-1-REPORT.md): :c3s1 engines have no ffmpeg on PATH -> every :c3s1 "done" since 26 Sep has 0 segments (2,169 windows). Both c3 routers point Whisper at dead 127.0.0.1:8091 -> no c3 window ever had a Whisper candidate (3,212 c3 windows). All c3 output since 26 Sep is degraded.
- runner.py queues a window when its LATEST state in ~/eta-data/hist/state.jsonl is not "done" (line ~421) AND no claim file ~/eta-data/hist/claims/<win_id> exists (claim(), line ~179). --retry-failed covers only "failed". So a re-queue = (1) append one new latest-state line per target window, (2) move its claim file aside.
- state.jsonl is append-only (log_state, line 32). Never rewrite or truncate it.
- The box loop (run_real.sh pid 28030, tier C, :box, CHUNK=1) is running and must keep running. The c3 lane is stopped and stays stopped.

## Build
/home/eta/oc/backfill-now/requeue_c3.py, run with /home/eta/.venv-r2/bin/python.
- Default is --dry-run. --apply needs an explicit --phase {C,rest} AND --set-file pointing at a dry-run set file whose sha16 you pass with --expect-sha.
- Target set: windows whose LATEST state record has router starting ":c3" and t >= 2026-09-26, with latest state in {done, failed}. no_audio is NOT a target (decided before routing). Report anything else you find (e.g. "running" left by a killed c3 run).
- Apply = (a) append to state.jsonl one line per target: {"t": now, "run": "requeue-c3-1", "win": id, "state": "requeue", "router": <orig router>, "reason": "BF-CHECK-1 c3 degraded"}; (b) mv each target's claim file to ~/eta-data/hist/_to_delete/claims-requeue-c3-1-<phase>/ (move, never delete); (c) write-once manifest /home/eta/oc/backfill-now/requeue-c3-1-<phase>-<YYYYmmddHHMM>.json listing the windows, counts and the set sha16.
- --phase C = only windows in windows_tierC.json. --phase rest = everything else in the set.

## Verify before you report (all of these, with numbers)
1. Counts of the target set by tier (A/B/C), by router (:c3s0/:c3s1), by day. Reconcile with 3,212 and 2,169 and explain every difference.
2. Blind guard: how many targets fall on held-out room-days (heldout.py sha16 f672c1ef046089dd, union f07171dc). Expect 0; runner refuses them anyway. Never bypass it.
3. Output collision: find the output path runner writes per window (write_once / os.O_EXCL). Will a re-run of a window that already has a c3 output file raise FileExistsError or overwrite? If it collides, STOP and report the minimal option for my decision; do not fix it.
4. Downstream: where did vault_push send the old c3 outputs, and does anything (lab viewer, REB, manifests) read them? Report only.
5. Test: run --apply against a COPY of state.jsonl + claims in a scratch dir (env/flag for the base dir), then show that runner's queue rule (latest state != done and no claim) now selects exactly the target set. If runner.py --dry-run is used on the real data, first prove from source that --dry-run writes no state lines, claims or manifests.
6. Phase C list should be today's 21 tier-C c3 windows (13:57-14:29); confirm.

## Do NOT
Edit runner.py, run_real.sh, run_c3.sh or progress.sh. Run --apply on the real state.jsonl (either phase). Start, stop or touch the c3 lane or the box loop. Hard-delete anything. Prompt any other pane. Put secrets on argv or in output. Print transcript text.

## Output
/home/eta/oc/backfill-now/REQUEUE-C3-1-REPORT.md, max 60 lines: verdict line first (READY-FOR-REFUTER or BLOCKED: <reason>), then answers 1-6, the dry-run set file path + sha16, and the exact apply commands for each phase. Then post ONE bus message to backfill-lead (subject <=120 chars) with the report path; if you have no bus, just finish. Time box: 45 min.
