# rl-stt-oref4: refute rl_stt.py FIX2 (sha256 1196d95d…, ft copy == .bc/r4 copy)
Model: Opus 5.5. No network, no Sarvam, no GO file, ft/* and ~/eta-data untouched (run in /tmp/oref4, fake client, patched paths).
Builder tests rerun (in a /tmp copy, vendor_split symlinked): test_rl_stt 54 OK, test_rl_stt_oref 44 OK, test_rl_stt_fix2 24 OK = 122 (matches claim).
Hold-outs: /tmp/oref4/h/hold.py, hold2.py (25 checks, 22 PASS, 3 FAIL).

VERDICT: FAIL (A, B; C minor). D PASS.
(A) FAIL. PASS: dry-run makes only status GETs and writes no stt or ledger; create/upload/start/PUT trap never reached;
    only Completed failed-job keys with no json and no ok line get recovered; 0600 with no .tmp left; ledger ok_recovered with the same job_id and audio_s 0;
    rerun idempotent; recovered key counts as MAX attempts. FAIL: recover_only never calls load_guard/vet_rows/read_manifest/labels,
    so H/unlinked keys in the given shard (positional arg, any file) with a 'failed' ledger job get downloaded into stt/ (my test: guard patched to refuse, recovery still ran).
    Small: --dry-run still creates the lane dir and STT_DIR, takes the lock and appends PROGRESS.md ("write nothing" is not literal).
(B) FAIL (race). PASS: 2-in-a-row trips with no create after it (workers=1); 3-in-20 trips at the 3rd failure; 2 spaced failures do not trip;
    main exits 3 and writes BREAKER.tripped 0600; a relaunch is REFUSED; rl_stt_wait_b.sh (fake HOME, BREAKER + GO + shard present) logs "not launching" and does not launch.
    FAIL: halt is checked only at the top of one(). Create is inside ResilientGateway._retry and never re-checks halt. With 2 workers, worker A got a 429 on
    create and was in backoff when B's 2nd failure tripped the breaker; A's retry then CREATED a new job after the trip (created after trip: ['0.wav']).
    In a 429 burst the backoff lasts seconds, so this window is real. Fix: pass halt into transcribe and check it before each create attempt (and before start).
    run_a.sh unchanged (rl_stt.py refuses, which is OK).
(C) PASS with a gap. Bearer/Authorization, key=/token:, 10-digit runs, full URLs with ?sig=, JWTs: masked; non-gateway exception text dropped;
    FAILURES.jsonl fchmod 0600 even when it was 0644 before; lane dir forced 0755->0700. GAP: a query string on a bare path is kept
    ("/…/status?callee=foo&x=bar" survives). The order says query strings are masked; mask '\?\S*' too.
(D) PASS. Upload 503x5 then retry: same job_id, one create, ledger 3.9 min total (no double bill). GO 1 4 x3 with a dead job: runs 2 and 3 REFUSED by check_go, 3.9 min <= 4.2.
    Gate code (lines 1-357, read_go/check_go/bind_go/vet_rows/in_window/pin/guard/probe) is byte-identical to r2 apart from Ledger.billed also counting ok_recovered (stricter).
    Note: a resumed job still reserves its full minutes before reuse is detected, so near the cap it is budget-stopped (the job costs nothing, but its result is lost). No overspend.
Top issue: B race, a create retry after a 429 runs after the breaker trips; next: A has no H/unlinked guard in --recover-only.
