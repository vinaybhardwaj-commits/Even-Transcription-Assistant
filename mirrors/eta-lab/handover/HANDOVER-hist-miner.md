# HANDOVER hist-miner (Claude Code -> OpenCode, ruling 409, 25 Sep ~15:45 box clock)

No patient text in this file (ids and counts only). Nothing of mine is in flight; no process of mine is running anywhere.

## (a) Role, 3 lines
- I am the HIST-MINING stage-1 miner (orders/HIST-MINING.md): truth-anchored mining of historical room audio on the box, and owner of the room-path harness (studies/2026-09-24-hist-mining/harness/).
- Everything I produced is MINING ONLY (ruling 146): nothing reaches a rater or a label without a production-path re-transcription.
- Closed lanes: stage 1 (49 anchors with tape, 5 anchored items H01-H05), the HIST tier accounting (4,507 of 4,507 windows), router retirement, Mini clean-up, exact-zero sizing and lists, CT rescans.

## (b) Open items
- H02 / H03 (fleet's stage-1 items, HIST twin text): settling them needs a production-path re-transcription. State: PARKED, provisional (pending Fable), bus #2070. Safer option taken: they stay mining-only, nothing is re-run. No router exists for a production-path run (only the Mini, and nothing new touches the Mini).
- H04 (12 Sep, Dietary Room; weak as a doctor-consult anchor) and H05 (16 Sep OPD 4; vj-refuter's pre-registered voice test PASSED, known-voice card, not HIGH): both are with vj-link / vj-refuter (#1459, #1474, #1668). Nothing for me.
- Untested skipped windows (12) were transcribed on eta-lab-l4 by hist-bulk (no speech signature, #2015) and marked by hist-bulk's kind=correction / kind=retranscription files (#2034). Nothing for me.
- Everything else: none. If a new request comes in on the bus, answer it; do not start anything unasked.

## (c) Paths, branches, pins, pids
- Harness (UNCOMMITTED in the shared checkout, studies/2026-09-24-hist-mining/harness/): run_window.py (ROUTERS = {":mini": ("mini", 8083)} ONLY since 25 Sep 06:25; :mini is gated by ~/eta-data/hist-mining/MINI_READY, which is REMOVED), provenance.py, node_route.py (cf4bc5cae187), cut_window.py, mine_runner.py, tag.py, ct_cues.py, case_talk.py, scan_windows_ct.py, stage1_tierA.py, build_stage1b_turns.py, account_windows.py, ct_job.py (retired). All tests pass (each file has --selftest or a test_*.py). If the file must survive the pane, commit it from a temp worktree after review.
- Box data (0600/0700), ~/eta-data/hist-mining/: anchors_hist.json (204 anchors), queue.json, shortlist.json, mine_state.json, runs/ and manifests/ (vault layout, write-once), tierA-stage1/decisions.json, ct_windows.json (63 candidates), account_windows.json, exact_zero_by_size_v1.json, retranscribe_skipped_windows.json, ct_candidates_job_v1.json (unused, ruling 322), RETIRED_ROUTERS.md, for-V-exact-zero-rooms-dates.md. Hand-offs: ~/eta-data/hist-stage1 (H01-H03), ~/eta-data/hist-stage1b (H04, H05).
- Pins: stack_versions da631545 (twin stack 0b12949986df, nodes deleted), Mini stack file dbcc425dd1a3 (commit 8733270, sha d3b9d01c...), NO_SIGNAL list commit 6b84da0 (sha eaf36bb4233bba76708553c25edd02779affec3b9b049a3e7ca8ec5bc8415f2e), production worktree ~/eta-wt-hist-prod @5970852 (pinned production collapse).
- Branches: none. pids: none.
- All GCP mining nodes are DELETED (hist-cpu-1..12, hist-gpu-1..4). Do not re-add router keys. hist-cpu-13/14 and hist-gpu-5 are hist-bulk's / lab-mover's, not mine.

## (d) Rules I must never break (verbatim where they are written)
HIST-MINING.md Do-not list, verbatim:
- Put patient text/audio in git.
- Print secrets.
- Use the production Mini during clinic hours.
- Write into the production DB.
- Touch V's 18 labelled consults except as the exclusion list.

Further standing rules:
- Secrets: the R2 read key (~/.claude/secrets/r2_audio_read: line 1 id, 2 secret, 3 endpoint) is never printed and never on argv; only via ssh stdin at 0600 to a remote.
- Mining only (146): anything shown to raters or used as labels is re-transcribed on the production path first. No Jev, no scoring by me.
- Vault outputs are write-once (ruling 184): a new run is a NEW run_id (producer-YYYYMMDDTHHMM in IST-sha7), never an overwrite; failed attempts are .attemptN files; every record carries provenance (or provenance_complete false with a reason).
- Shared checkout (ruling 135): never pull/reset it. Before any push run `git log origin/<branch>..HEAD` and push ONLY your own commits, from a temp worktree (`git worktree add`), never HEAD of the shared checkout.
- Mini: nothing new touches it (ruling 312); MINI_READY stays removed; nothing goes to the Mini without minibot's 'Mini ready' and an order.
- Exact-zero rule of record (r343/376): a FULL chunk (>= 290 s) at 707-709 B/s; short chunks are not judged by size alone. Never quote the old 700-716 band as zero.
- Honest reporting: say what was measured, what was not, and correct errors on the bus at once (I have done this several times; keep doing it).
- Bus subject <= 120 chars; no patient text and no secrets on the bus.

## (e) Tools
- Bus: bus_inbox, bus_post, bus_thread. Read-only data: neon-select.mjs (kit/), Metabase via studies/2026-09-24-surgery-review-v2/mb.py (read-only). R2 chunks: ~/.venv-r2/bin/python + r2audio.py (studies/2026-09-24-encounter-first/). Also git, ssh (box only), ffmpeg, python3. Fleet's lexicon.py / locate.py / anchor.py in studies/2026-09-24-surgery-review-v2/.
- No MCP tool of mine touches production.

## (f) My last 10 decisions (bus ids)
1. Accounting of all HIST windows, independent of hist-bulk: 4,507/4,507, 0 problems (#1629, #1639).
2. Removed every twin router from the harness; ROUTERS = Mini only (#1745); archive marker RETIRED_ROUTERS.md (#1758).
3. Mini clean-up: MINI_READY removed, ~/hist-lab deleted (only my file) (#1772).
4. Translate check on the twin failed (no OpenRouter key on the twin); CT job not run (#1727); MT route stays closed for CT windows (#1730).
5. Exact-zero band too wide; strict rule 707-709 on full chunks; 134.2 h floor (#1843, #1844).
6. Near-silence window 2026-09-20_room_ux92qpws_0600 = unverified near-silence, not confirmed zero (#1855).
7. Reconciled the 5 / 19 / 22 short-chunk lists; 12 skipped untested windows (#1865, #1964).
8. OPD 4: withdrew my mechanism guess only; the 11-14 Sep exact-zero stands (#2123, #2127, #2132).
9. H02/H03 parked, provisional, pending Fable (#2070).
10. Sizing for 337b: 13,212 Indic-script segments (script is the right selector, not the tag) (#1902).

## (g) First thing to do when you wake on OpenCode
1. Read this file, orders/HIST-MINING.md, ~/eta-data/hist-mining/RETIRED_ROUTERS.md; check the bus inbox.
2. Do NOT act on anything unasked. Do not run any harness against a router; there is none but the Mini, which is closed to new work.
3. If asked about HIST: the counts are in account_windows.py output and the tier lists in ~/eta-data/hist/; if asked about stage 1: decisions in ~/eta-data/hist-mining/tierA-stage1/decisions.json.
4. If asked to settle H02/H03: it needs a production-path re-transcription and Fable's word; ask conductor.
5. Decide with the conductor whether the harness dir (uncommitted) should be committed for the record.
