# rl-stt-oref6: refute rl_stt.py FIX4 (sha256 4ef05cbe…; ft copy == .bc/r6 copy, unchanged after the run)
Model: Opus 5.5. No network, no Sarvam, no GO file; ft/* and ~/eta-data untouched. All work in /tmp/oref6 (fake gateway, patched paths).
(1) diff r5->r6 rl_stt.py: ONLY 2 hunks. resumable() now needs entry AND jid (L430-431). transcribe() has a new `except Exception` that pops the entry when it has no jid (L552-556). test_rl_stt_fix2 has 2 new tests; the other test files are byte-identical.
(2) Hold-outs rerun on the new file: oref5 hold_adapt 14/14, hold2 12/12, hold3 12/12 (B1-B5 PASS: B4 jobs=1 billed 2.0 = cum 2.0, B5 billed 2.0 <= 2.1), hold4 D2 PASS.
    oref4 hold2 12/12 PASS. The original oref4 hold.py is still REFUSED on its shard path (expected; the adapted copy, hold_adapt, passes).
    main() 'GO 3 6' (key0 create 5x429, key2 Failed then Completed): exit 0, 3 jobs, billed 6.0 <= 6.3, budget.cum 6.0 == billed (was 8.0 billed in r5).
(3) New /tmp/oref6/h/hold5.py, 5/5 PASS:
    N1 create runs out of retries, then the retry pass: reserve, refund, reserve (one reservation per attempt), cum == billed == 2.0, 1 job, no stale entry.
    N2 halted create: Halted raised, gw.jobs == {}, resumable False.
    N2b halted create inside run_jobs: no ledger line, cum 0, no stale entry, 0 jobs.
    N3 (over-pop guard) upload runs out of retries after create: the jid entry is kept and resumable (no second job).
    One harness slip, now fixed: run_jobs replaces the gateway's halt with its own, so N2b had to combine the injected halt with the lane's.
(4) Builder tests: test_rl_stt 54 OK, test_rl_stt_oref 44 OK, test_rl_stt_fix2 36 OK = 134. F1 'GO 1 4' x3 demo, run 3 times: 3.9 min <= 4.2 each time.
VERDICT: PASS. The D/G5 overspend is fixed and nothing regressed. Top issue: none blocking. The residual nit from oref5 (Ledger() makedirs in dry-run) is unchanged.
