VERDICT: READY-FOR-REFUTER. One deviation from "nothing else in runner.py" (3rd line, below) — needs your/Refuter's OK. No --bg loop started; STOP-c4 mine, moved to ~/eta-data/hist/_to_delete/stop-files/. c3 loop (pids 28790/37199, still running at 20:10) and box loop untouched; gpu.lock untouched.
Order sha16 6b29bab5 OK.

NEW SHA16s: runner.py 24822a9cffdedd42 (was 978d9969e2589af8; backup ~/oc/backfill-now/runner.py.bak-978d9969-c4) | run_c4.sh f12b60720076f736 (new) | run_real.sh 141ed062b9277371 (bak .bak-20261007-c4; only the pin changed) | run_c3.sh 68ddfeebae26373d (bak .bak-20261007-c4; only the pin changed) | progress.sh b32d6336a37b74d8 (bak .bak-20261007-c4) | c4 stack file stack_versions.c4.DRAFT.json 6d7fdf13a8a3305c (router-fix's, leaves == c3's per C4-PASS; still named DRAFT, used as is, no copy made).
Ports verified on c4 (ss): :8083 and :8088 (127.0.0.1) = s0/s1 routers (C4-STACK-1 + CPU whisper 8080/8081); histwork/node_route.py on c4 sha cf4bc5ca == c3's (H2 done); ssh alias e2e-c4 works from the box (H1 done).

RUNNER DIFF (py_compile OK; `diff` vs backup shows exactly these 3 hunks):
 +85  NODES.update({":c4s0": ("e2e-c4", 8083), ":c4s1": ("e2e-c4", 8088)})   # comment
  89  whisper_cfg: if any(r.startswith((":c3", ":c4")) for r in routers): return ("e2e-c4" if routers[0].startswith(":c4") else "e2e-ci"), {...same kwargs...}
 369  DEVIATION: if any(r.startswith((":c3", ":c4")) for r in routers):   (was ":c3" only)
  Why the 3rd line: that branch asserts --ci-lock and sets CI_LOCK = (host, path). Without it a :c4 run would IGNORE --ci-lock silently, i.e. the CI-priority lock the order asks for (/tmp/eta-ci-c4-ci.lock) would be dead. If you refuse it, drop that line and drop --ci-lock from run_c4.sh.
run_c4.sh = run_c3.sh with: ROUTERS default ":c4s0,:c4s1", --stack-file stack_versions.c4.DRAFT.json, --ci-lock /tmp/eta-ci-c4-ci.lock (lock file does not exist yet on c4 => FREE), no END, STOP file /home/eta/oc/backfill-now/STOP-c4, log c4-<ts>.log, new runner pin. progress.sh: lanes label adds c4 (pgrep run_c4.sh --loop); :c4 is never demoted to redo (the existing rule only demotes :c3 before C3_OK_SINCE), comment added.

VERIFY
- Dry-run safe: runner.py main() returns at `if a.dry_run: return` (line ~430) BEFORE wait_routers_idle, provenance, write_once manifests, log_state or claim(); only --retry-failed/--claims-reset (not used) touch claims. Measured: state.jsonl 21,128 -> 21,128 lines, manifests 8,316 -> 8,316, claims 5,334 -> 5,334 across the run.
- `runner.py --tier C --routers :c4s0,:c4s1 --stack-file ...c4.DRAFT.json --ci-lock /tmp/eta-ci-c4-ci.lock --dry-run`: "R3/W51 BLIND GUARD: 3 windows ... refused", queue 3,945 windows (959.5 tape-h) [dry run].
- Stack/whisper checks (those run after the dry-run return, so called directly): load_stack_versions sha 6d7fdf13a8a3305c, stack_id 8738c90bf1bf; remote_whisper_check ok=True: "e2e-c4: whisper-server binary dc5fe7d84952 and shim c2210237966f match the published stack; argv guards present; units active".
- REAL WINDOWS via `CHUNK=1 bash run_c4.sh` (loop ended by STOP-c4 after the first chunk), 3 runs:
  1) newest window already claimed by the live c3 loop -> claim guard skipped it, nothing ran (planned 1, done 0): claims work across lanes.
  2) c-2026-09-26_room_jwyrr4dc_2115 on :c4s1, state done, 186 s wall, 26 whisper segments but ALL 26 refused by english_hallucination_guard (a silent evening window): ok but proves nothing about speech.
  3) c-2026-09-29_room_4ggnkg5x_1530 (loud speech window chosen by RMS, selected with --remaining-frac, run hist-bulk-20261007T2003-09ac813): :c4s0, done, 321 s wall, router_status ok, 33 segments all non-empty, 10,587 chars: whisper 27 (en) + sravaani 5 (und) + indicconformer 1 (mr), dominant en, provenance_complete true, stack_id 8738c90bf1bf, whisper cross-check ok on e2e-c4. => Whisper candidate present and non-zero segments.
  These 2 windows are now real "done" lines on c4 in state.jsonl/runs (the runner's own lines only; no other state/claims touched).
NOTES: c4 runs both stacks on one shared CPU whisper (~2x wall as c3; 186-321 s/window observed). The c3 loop was still alive when I edited run_c3.sh/runner.py (sed -i/replace; its running bash is unaffected, new chunks load the new runner.py whose c3 behaviour is unchanged); box lane still paused.
START COMMAND (backfill-lead, after the Refuter PASS; no END, own STOP):  CHUNK=3 bash /home/eta/oc/backfill-now/run_c4.sh --bg      (stop: touch /home/eta/oc/backfill-now/STOP-c4)
