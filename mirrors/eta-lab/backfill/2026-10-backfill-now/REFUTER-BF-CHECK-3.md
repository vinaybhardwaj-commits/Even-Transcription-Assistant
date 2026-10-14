# BF-CHECK-3 report (eta-refuter-2, 7 Oct 2026 ~20:20 IST; backfill-lead #9337; ORDERS-C4-LANE-1 6b29bab5, report C4-LANE-1 28c06e68). Read-only.
VERDICT: PASS. Start `CHUNK=3 bash ~/oc/backfill-now/run_c4.sh --bg`. Three minor follow-ups for the next edit, none blocking (M1-M3).

1) runner.py 978d9969 -> 24822a9c: `diff` vs the backup = exactly 3 hunks, as declared.
- +l.85 NODES :c4s0 = (e2e-c4, 8083), :c4s1 = (e2e-c4, 8088).
- l.89 whisper_cfg: host e2e-c4 when routers[0] is :c4, else e2e-ci; same kwargs.
- l.369 CI-lock branch extended to :c4. The deviation is ACCEPTED: without it --ci-lock is silently ignored for :c4. /tmp/eta-ci-c4-ci.lock does not exist on c4, so ci_busy reads FREE; it fails closed on an ssh error.
- No c3 behaviour change: with :c3-only routers every branch takes exactly the old values (host e2e-ci, CI_LOCK from NODES[:c3..]).
- M1: a process given BOTH :c3 and :c4 routers would take whisper host and CI lock from routers[0] only. Add `assert not (any :c3 and any :c4)` next to the existing own-process assert at l.368.
2) run_c4.sh f12b6072 vs run_c3.sh: only the header comments, no END, log name c4-*, STOP-c4, ROUTERS :c4s0,:c4s1, stack file, ci-lock path; the pin 24822a9c is the same in both. run_real.sh 141ed062 and run_c3.sh 68ddfeeb vs their .bak-20261007-c4: only the pin line changed.
- The running c3 loop (started 15:47) checked the pin only at start, so it is unaffected and uses the new runner (c3-identical); it ends by END 20:15.
- M2: run_c4.sh no longer honours the shared STOP (by design: per-lane files, #9319). Anyone's "touch STOP" emergency habit will NOT stop c4. Post it on the board: c4 stops only via STOP-c4.
3) stack_versions.c4.DRAFT.json 6d7fdf13: faithful. The leaves equal stack_versions.c3.json except host/collected_at/ports.whisper_shim 8081/revision_note, and I verified the c4 binaries/model/shim against them in C4-PASS #9311.
- The runner records the stack file's sha, not its name, so running on the DRAFT name is OK.
- M3: copy it to stack_versions.c4.json (same bytes) and point run_c4.sh at it at the next edit, together with the STOP split.
4) The 2 real c4 windows (state done, runs hist-bulk-20261007T1959/T2003-09ac813):
- c-2026-09-29_room_4ggnkg5x_1530 :c4s0: ok, 33 segments, 10,619 chars, whisper present (27 en) + sravaani + indic, dominant en. Loud audio (chunk rms 0.09-0.11). Sane.
- c-2026-09-26_room_jwyrr4dc_2115 :c4s1: ok, 26 segments all emptied by english_hallucination_guard (0 chars). Audio is quiet (rms 0.005-0.011, peak <= 0.07), so guard-on-quiet is the expected behaviour; it proves the guard path, not speech.
- Blind: neither room-day is in the union. The dry run refused 3 held-out windows; the guard code is unchanged (not in the diff).
- Note: the report's 10,587 chars = the sum of segment texts; my 10,619 = transcript_native (with joiners). Same output, not a mismatch.
