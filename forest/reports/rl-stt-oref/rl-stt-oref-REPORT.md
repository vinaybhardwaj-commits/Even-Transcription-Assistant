# rl-stt-oref: Opus 5.5 refute of rl_stt.py 3c155d07 (base fca99c18)
Verdict: **PASS-WITH-FIXES**. No Sarvam or network calls (sockets blocked in tests, fake Gateway). No GO file created. Real audio, stt and ledger untouched; ~/oc/forest-lead/ft/* not edited (sha still 3c155d07).
Builder suite: 42/42 OK, reproduced. My suite: /tmp/rloref/oref_test.py, 42 tests, 40 pass, 2 fail = findings F1 and F2.
Mutants: /tmp/rloref/mut.py, 18/18 killed (GO<=0, no N check, reserve only checks cum>=cap, window 0..14, day0 at the consult instant,
event day allowed, short calls kept, no existing-file skip, no split_guard, non-D allowed, ledger 0644, dirty pin ignored, GO missing tolerated,
path mismatch, no manifest check, minutes cap off, refund after a job was created, vendored sha unchecked).

## Verified OK
- Order in main: read_go, then shard, then the pin check and import, then vet (manifest, labels D, window, split_guard), then existing-file skip,
  then ffprobe (<20 s and unreadable files dropped), then check_go. Only after all of that is a Gateway built. Missing or garbled GO, too many
  calls, too many minutes, or an H key: all refused with Gateway constructed 0 times.
- G2 boundaries: before Rx refused; day 0 before or at the consult refused, after it OK; day 0 date-only refused; day 0 with no consult refused;
  day 13 OK; day 14 refused (also via a UTC 'Z' timestamp converted to IST); event day and later refused. One bad row refuses the whole shard.
  The real labels.parquet has consult_ist as 'YYYY-MM-DD HH:MM' (0 NaN, 0 midnight) and split values D/H (counts only were read).
- Budget: reserve() happens before each send. A send that would cross cap = GO x 1.05 is refused (exact cap OK). With 100 concurrent threads,
  exactly the cap's worth was taken. Failure after a job_id exists: the minutes stay reserved, and the retry reserves again (it is blocked when
  over the cap). Refund happens only when no job was created.
- Ledger: dir forced to 0700 and file to 0600 (even if they existed as 0755/0644). Exactly the 9 required fields. One line per gateway job,
  so a retried failure gives 2 'failed' lines.
- Pin: the real checkout is at c41bb34a5710... and passes. A wrong HEAD or a modified tracked kit/ file is refused. A vendored split_guard sha mismatch is refused.
- G6: only rows in the shard are sent; a manifest key that is not in the shard was never sent.
- Wait scripts a/b/c: go_ok accepts only 'GO <int> <num>'. With the shard present and no GO, they ran 3 s in a sandbox HOME and never launched.
  Their only Python call is "$PY" "$RL" "$SHARD" --lane "$LANE"; no curl, no sarvam_lane, no python -c. rl_stt.py re-checks GO (rejects 0).

## Findings (fix before GO)
- **F1 (top, spend): the budget, the retry-once rule and the GO cap are per process, not per lane.** Each run of rl_stt.py starts with cum=0
  and nothing records that a GO was used. A billed job that failed is not written to stt/, so every re-run sends it again: 2 sends per run.
  Test: one GO of 'GO 1 4' with a 2-min call that keeps failing, run 3 times, gave 6 sends = 12 min against a 4.2-min cap. This breaks G4
  ("retry once, then give up") and G5 (hard stop) whenever a lane is restarted or re-run by hand. rl_stt.py also has no lane lock of its own
  (only the supervisor has flock), so a manual run alongside the supervisor would send the same keys twice.
  Fix: flock out/<lane>/lock inside rl_stt.py. Persist cum minutes in out/<lane>/BUDGET.json, or sum this lane's ledger lines. Skip keys
  already listed in FAILED.tsv or with a 'failed' ledger line, or mark GO consumed (GO -> GO.used) at the end.
- **F2: a duplicate key_id in the shard is sent twice** (test: 2 jobs for 1 key with 4 workers). check_go counts both rows, so it stays
  inside N, but it breaks G4 "one transcript per object key". Fix: refuse duplicate key_id in vet_rows (or read_shard).
- F3 (minor): the pin check runs `status --untracked-files=no`. An untracked or ignored kit/reb/sarvam_lane/ package dir would shadow the
  tracked .py without being noticed. Fix: use --untracked-files=all and --ignored, excluding __pycache__ (the real checkout has only .pyc
  files today). Or check that the sha of kit/reb/sarvam_lane.py equals `git rev-parse HEAD:kit/reb/sarvam_lane.py`. Also, the requirement
  says "sha asserted" but only the HEAD prefix plus a clean tree are checked; asserting the full 40-hex commit would be stricter.
- F4 (process): GO is not bound to a shard (no shard sha or row count in the file), and it is per lane. If whoever writes it copies the global
  newcat-orch numbers into all 3 lanes, the cap becomes 3x. Suggest 'GO <N> <min> <shard_sha8>', and that newcat-orch split the numbers per lane.
- F5 (minor): if ledger.write raises after a successful transcribe, the except branch writes a 'failed' line for an OK job (the stt json
  already exists). If that write also fails, the exception escapes ex.map and the run dies without DONE.md. Use separate try blocks.
- F6 (note): check_go accepts shard minutes up to GO x 1.05 up front, so the +5% margin can be used up by planned calls instead of covering
  drift. Consider refusing when probed minutes > GO minutes.
- Note: the say() lines (GATES PASSED / REFUSED) always print sarvam_min_cum=0.0. That is true at that point, and the PROGRESS lines carry the real value (G7 OK).
