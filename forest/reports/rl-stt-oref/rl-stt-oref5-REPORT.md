# rl-stt-oref5: refute rl_stt.py FIX3 (sha256 c72b517d…; ft copy == .bc/r5 copy)
Model: Opus 5.5. No network, no Sarvam, no GO file, ft/* and ~/eta-data untouched (all in /tmp/oref5, fake client, patched paths).
Builder tests (in a /tmp copy): test_rl_stt 54 OK, test_rl_stt_oref 44 OK, test_rl_stt_fix2 34 OK = 132 (matches claim; one unexplained error in the very first test_rl_stt run, 6 reruns clean).
oref4 hold-outs: hold2.py 11/11 PASS unchanged. hold.py needed 2 lines changed (shard at SHARD_DIR/shard_b.tsv, guard stub passes) because the fix rightly refuses other shard paths: 14/14 PASS.
New hold-outs: /tmp/oref5/h/hold3.py (12 checks, 10 PASS, 2 FAIL) and hold4.py (main() level, FAIL). Against r4, B1 FAILs (4 calls after the trip) and B4/B5 PASS, so the tests catch the old race and the overspend is NEW in FIX3.

VERDICT: FAIL (D, a budget regression from the FIX3 "resume reserves nothing" change). A, B and C PASS.
(A) PASS. Real vet_rows with a stubbed manifest, labels and guard: a clean shard recovers. An H key (split_guard), an unlinked episode and an out-of-manifest key
    are each REFUSED with 0 gateway calls and nothing written. A --shard path other than the lane's is refused. --dry-run (STT_DIR absent): the whole tmp tree is identical
    (names, mtimes, sizes). Nit: Ledger() still runs makedirs + chmod 0700 on LEDGER_DIR in dry-run (harmless when the dir exists).
(B) PASS. 2 workers, A in a 429 backoff while B trips the breaker: 0 create/upload/start after the trip, at the create, upload or start step (B1-B3).
    A halted create writes no FAILURES or ledger line. A halted start keeps its 'failed' ledger line for the job that already exists.
(C) PASS. '?callee=..&x=..', '?token=', '?sig=..&exp=', './a?b=c' on bare paths all become '?<q>'.
(D) FAIL. Gate code lines 1-357: byte-identical to r4 apart from the new SHARD_DIR constant. wait_b and wait_c are unchanged. GO 1 4 x3 = 3.9 min <= 4.2 PASS. Upload 503 reuse PASS.
    BUG: transcribe() calls jobs.setdefault(wav, stage="new") BEFORE create. When create runs out of retries (5x 429, a transient error, not JobFailed), the entry stays
    with jid=None. run_jobs then refunds and decrements attempts. On the retry pass resumable(path) is True, so budget.reserve is SKIPPED, but a NEW job is created and billed.
    run_jobs: 1 key -> billed 2.0 min, budget.cum 0.0. Cap 2.1 -> billed 4.0. main() with a valid GO 3 6 (cap 6.3; key0 create 5x429, key2 Failed then Completed):
    exit 0, 4 jobs, ledger 8.0 min > 6.3 cap. This breaks the G5 hard cap. A Halted create leaves the same stale entry.
    Fix: resumable() = entry exists AND entry["jid"] is not None (or pop the entry when create raises). Add B4/B5/D2 as tests.
Top issue: G5 cap overspend. The "resumable" retry after a create that ran out of retries is never reserved (8.0 min billed on a 6.3 min cap).
