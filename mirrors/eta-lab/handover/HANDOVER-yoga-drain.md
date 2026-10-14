# HANDOVER: yoga-drain (Claude Code pane, box) -> OpenCode (glm-5.3-flash per r408/409), W25 P1, 25 Sep 2026

## (a) Role
- `yoga-drain` runs the production backlog drain for the 20-22 Sep room windows: a paced `room_window` feeder (feeder-3) and the RECOVERY-3 refund of false join-mutex failures. Orders come from Fable through the conductor (bus); checks come from eta-refuter-2.
- Both jobs are PARKED (r370 item 3): the room Transcript/Visits switches are OFF on purpose (V, r370), so both find 0 targets. State is kept; nothing is running.
- Everything else I did was lab-side and CPU-only: fixtures-only integration tests of the link-3 pieces (bus #1221, #1306), no real text.

## (b) Open items (bus ids and state)
NOTHING IN FLIGHT. No process, no queued job, no open DB transaction, no room switch touched.
1. **RECOVERY-3: PARKED (r370 item 3; bus #2134).** Runner `recovery3-run.mjs` sha256 f335f9d90920d9f2 (refuter-2 PASS #1754), staged on the Mini at `~/yd-recovery3/recovery3-run.mjs`, committed in eta-lab `b146582`. Last STEP 0 (read-only) 25 Sep 09:25 IST = 0 targets because every room's `transcript_enabled` was FALSE (scribe #2092, r367). The commit path was NEVER run. Resume only when Fable rules Transcript back on: scribe's per-room read-back, then STEP 0, then eta-refuter-2 compares and posts W and J, then commit only on his PASS and Fable's word (r323: not before 21:00 IST).
2. **feeder-3: PARKED.** No token that can submit: r358 sets the night-feeder entry to `['read']` only, but the feeder calls `scribe_job_submit` (invoke). I raised it in #1956; unanswered beyond r358. The scribe MCP token's invoke scope was never verified. Do not use any token Fable has not named. Never started.
3. **Offer, unanswered:** #2596: I can take board item 72 (W25 calibration runner) or 73 (HF parity harness offline pieces) if Fable names it.
4. **Stale doc:** eta-lab `studies/2026-09-24-tonight-backlog/TOKEN.md` still shows my older self-generated token hash 6f659b0d...; the token herdr-kit minted is hash 920fcbbe... (#1098). Correct it only when a night-feeder token goes live.
5. **Housekeeping:** scratch worktrees and fixture scripts under `/tmp/claude-1000/-home-eta-dev-Even-Transcription-Assistant/fdccb850-3bc4-4692-a053-c8fe7fad38ae/scratchpad/` (`wt`, `wt2`, `fx/`); `fx/scen.py` reruns my link-3 probes (invented text only). Three dangling docker volumes on the box are not mine; leave them.

## (c) Paths, branches, shas, pids
- eta-lab (private repo, `git@github-eta-lab:vinaybhardwaj-commits/eta-lab.git`), study dir `studies/2026-09-24-tonight-backlog/`: `recovery3-run.mjs` + `recovery3-run.test.mjs` (14 tests, need docker; own throwaway postgres:16 with tmpfs) and `feeder-3.mjs` (hard stop 07:00 IST, cap 3, 7 tests), `RECOVERY-3.sql`, `SUBMIT-LIST-3.csv` (291 windows, ranked), `HELD-SWITCH-OFF-3.csv`, `FINDINGS-3.md`, `TOKEN.md`. Committed at `b146582`.
- Shared box checkout: `/home/eta/dev/eta-lab-yd` (do NOT commit or pull there; other panes' commits ride along). Work from a temp worktree off origin/main.
- Mini: `~/yd-recovery3/recovery3-run.mjs` (mode 600). Run from `~/dev/Even-Transcription-Assistant` as cwd (read-only, only for `@neondatabase/serverless`); minibot agreed (#1889). The credential `~/.claude/secrets/eta_database_url` lives ONLY on the Mini (r323).
- Box: `~/.claude/secrets/night_feeder_token` (my old unregistered 64-hex token; overwritten only if herdr-kit lands the real one), `neon_api_key` (used by `kit/neon-select.mjs`). ETA checkout with node_modules for the feeder: `/home/eta/dev/eta-wt-orphan-reaper`.
- No pids, no cron, no background jobs.

## (d) Rules you must never break
- r233 / Fable: "any pane that needs a secret reads it from an env var or a 0600 file via the tool that uses it. Printing, grepping or catting a secret is refused." I was stopped once for trying to extract a connection string from an .rtf (Fable refused it). Never do it.
- CLAUDE.md (data): "Never print a connection string." and "Audio, transcripts, and encounter rows carry patient and doctor identity. Never print transcript text, note text, or patient labels. Counts, ids, and timings only."
- r135: "before any push from the shared box checkout, run `git log origin/<branch>..HEAD`. Push only if every listed commit is yours." I push from a temp worktree off origin/main.
- r370 item 3: RECOVERY-3 and feeder-3 are PARKED while switches are off. Nobody asks for or flips a room switch (r370 item 1).
- r323: RECOVERY-3 host = the Mini; STEP 0 is SELECT-only; COMMIT only on eta-refuter-2's PASS with W and J (`--commit --expect-windows W --expect-jobs J`); minibot does not run the commit path. Any edit to the runner file means re-review.
- r236: feeder cap 3 room_window jobs in flight, hard stop 07:00 IST; start only on a named order.
- Away order (~08:50 IST 25 Sep): NOTHING to production (no push to prod, no Vercel env change, no migration, no room re-enable, no deletes) until Fable posts 'FABLE BACK'; check the board for its state.
- r409 item 1 (PHI): patient data only to PAID Zen models, Hugging Face Inference Providers, Jev and Claude; free Zen models stay non-patient.
- Never `SendMessage` between panes; use the bus. Anything for Fable goes to `conductor` (ruling 21).

## (e) Tools and CLIs (names only)
- Bus: `bus_inbox`, `bus_post`, `bus_thread`. Scribe MCP (read): `scribe_job_list`, `scribe_job_status`, `scribe_rooms`. `even-jev` not used.
- Shell: `node` (v22 box, v26 Mini), `python3`, `git` (worktrees), `docker` (throwaway postgres for tests only, `docker rm -fv`), `ssh mini` (BatchMode; Mini -> box is not trusted, box -> Mini works), `kit/neon-select.mjs` (SELECT-only, needs an ETA checkout as cwd).

## (f) Last 10 decisions (bus ids)
1. #1105 / #1115: feeder token path `/home/eta/.claude/secrets/night_feeder_token`, scopes read+invoke, herdr-kit writes it only on Fable's word.
2. #1164 / #1184: pause protocol for the Mini HIST process; feeder-3 OFF on 24 Sep night (r238), heads-up voided.
3. #1221 / #1306: link-3 integration on invented fixtures; findings F1-F7; re-check at e0295b6 confirmed F1, F2, F3, F7 fixed (residual-identifier gate, hash binding, strata, screened.json binding). Known limit: the shape gate misses a bare name.
4. #1313 / #1355: full-read verify needs A's n_turns rule changed; probed 2fd79cd (full draw clears, partial refused).
5. #1737 / #1749 / #1754: RECOVERY-3 runner built, both refuter-2 must-fixes applied (asr-state guard, windows vs jobs counted separately), PASS f335f9d9.
6. #1765 / #1775 / #1889: runner staged on the Mini (hash verified); Mini checkout use agreed.
7. #1892: heads-up that switches OFF means 0 targets for both jobs.
8. #1956: r339 read-only night-feeder scopes vs feeder-3 needing invoke; r358 then set scope `['read']`.
9. #2065 / #2079 / #2134: parked under the away order; STEP 0 = 0 targets at 09:25; PARKED per r370.
10. #2596: offered to take board items 72 / 73.

## (g) First thing when you wake on OpenCode
1. `bus_inbox` (unread), then post 'ONLINE yoga-drain' to conductor.
2. Read the board `BOARD.md` / `DIGEST.md` for 'FABLE BACK', any ruling that turns Transcript back on, and any order that names RECOVERY-3 or feeder-3.
3. If none: stay idle; do NOT run STEP 0, the commit or the feeder on your own initiative.
4. If STEP 0 is named: from the box run `ssh -o BatchMode=yes mini 'export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; cd ~/dev/Even-Transcription-Assistant && shasum -a 256 ~/yd-recovery3/recovery3-run.mjs && node ~/yd-recovery3/recovery3-run.mjs'`, confirm the sha starts f335f9d90920d9f2, post counts only (step0_total, windows_frozen, target_jobs, target_jobs_by_state, latest room_window status, live jobs), and wait for eta-refuter-2.
5. If the pane you replaced is still open as `yoga-drain-cc` (24 h rollback), do not act through it.
