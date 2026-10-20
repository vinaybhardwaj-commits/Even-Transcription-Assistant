# rl-stt-oref2: Opus 5.5 re-refute of rl_stt.py 4d2d15f0 (fix round 2)
Verdict: **PASS** (one residual, R1, below). Fake gateway only, sockets blocked, no Sarvam or network call, no GO file created; ~/oc/forest-lead/ft/* and ~/eta-data untouched (work in /tmp/rloref2). The snapshot in .bc/r2 is byte-identical to ft/ (rl_stt.py, wait_b, wait_c) and to ~/wt/ft-rl-stt-a/run_a.sh.
Builder suites, rerun on a /tmp copy: test_rl_stt.py 53/53 OK, test_rl_stt_oref.py 44/44 OK = 97/97. No G1-G7 regression.
The old /tmp/rloref/oref_test.py gives 38/42 on the new file. The 4 errors are API drift (bind_go, check_go now plans against prior billed minutes), not gate regressions; the adopted copy updates those tests.
New probes: /tmp/rloref2/r2_test.py and r2b.py.
## F1: PASS
- 'GO 1 4' run 3 times, with a 4-min call whose job always fails after it is created. Run 1: 1 send (4.0 min billed). The retry is blocked (it would reach 8 > 4.2) and the key stays in FAILED.
  Runs 2 and 3 are REFUSED by check_go before any Gateway is built ("8.0 min incl. already billed > GO 4"). Total billed 4.0 <= 4.2.
- The literal old demo (a 2-min call with GO 1 4) is now refused by bind_go up front (4 > 2.0 x 1.05), so 0 sends.
- Attempts persist across runs. With a 1000-min budget, so only the attempt rule can stop sends, 3 runs of run_jobs with prior_attempts from Ledger.billed gave exactly 2 billed sends.
  A key whose send succeeded and whose stt json was then deleted is not resent (1 send).
- Lane lock: with out/<lane>/rl_stt.lock held, main() is Refused and the Gateway is constructed 0 times.
  Harness note: in-process, the lock fd is not closed when Refused is raised. A real process frees it on exit, so this has no effect in production.
- R1 (residual; I recommend a fix before anyone restarts by hand): the ledger line is written only after the job finishes.
  If the process dies (SIGKILL, SIGTERM, OOM, reboot) after on_start (job created, billed) and before that line, the ledger shows 0 min and 0 attempts.
  Probe: transcribe calls on_start and then SystemExit, and Ledger.billed returns 0.0, {}. A rerun would resend those keys and not count the earlier spend.
  This is bounded by the jobs in flight (<= workers, 4) per crash. Fix: write a 'started' line at on_start, and make billed() dedupe by job_id.
## F2: PASS
- A duplicate key_id in the shard is refused in vet_rows (my probe and the builder test). run_jobs also dedupes, and check_go counts unique keys.
## PATH: PASS
- run_a.sh, rl_stt_wait_b.sh and rl_stt_wait_c.sh watch ~/eta-data/forest/rl/shard_{a,b,c}.tsv. Each looks up the path column by its header name.
- b and c accept only an exact 'GO <int> <num>'. run_a.sh only checks that GO exists, then calls rl_stt.py. rl_stt.py's read_go refuses a missing, garbled or zero GO before any Gateway (builder TestScripts and TestGO pass), so a valid GO is still required end to end.
