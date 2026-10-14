# HANDOVER indic-mt (Claude Code -> OpenCode), 25 Sep 2026 ~16:00 IST. No secrets in this file. Patient text: none.

## (a) Role
indic-mt = Builder (Sonnet) in the lab lanes. Closed: L6 local Indic->English MT bake-off (V: Gemini 3.8 Flash stays); emotion backlog (r140/r347, 21 windows requeued, dedupe fix live). ACTIVE: r337 lane 337c(2): re-transcribe the flagged segments with forced language, then a BLIND before/after judgement by V/Sandhya. Owner of nothing in production.

## (b) Open items (bus ids)
1. 337c(2) sheet ba106: 106 rows (96 pairs + 10 identical controls), built to the PASSed prereg (eta-refuter #2122/#2192/#2209/#2519), loaded as rating set on lab.* (lab-viewer #2173, refuter-2 PASS #2184, r375 YES). NOBODY TOLD to label: waits for Fable's browser check (r359). After labels: export with `python3 kit/lab-viewer/tools/rate_seed.py export --set ba106 --out <dir> --rater vinay=vinay.bhardwaj@even.in --rater sandhya=sandhya.cherukuri@even.in` ({P###: label} per rater), then `score_ba.py` (below). eta-refuter re-runs the scoring himself before any verdict is quoted.
2. Batch 2 (prereg addendum 5 item 4, eta-refuter PASS #2519, conductor asked #2515): 100 unflagged pairs + 10 controls, seed 20260941; builder options exist, NOT built; needs Fable's OK for a fourth rating set (or appending to ba106). Expected: sheet 1 primary cells will mostly say 'not enough labels' (only kn/hi can decide), so batch 2 is likely needed.
3. Annotation files kind=retranscription (lab-viewer #2007 grammar, sources sha-bound): NOT written. Writer `write_annotations.py` tested privately; write only after labels favour a cell on UNFLAGGED rows and eta-refuter looks at a batch; flagged rows (42%) are never offered as replacements (better:null + flag). Staging into ~/eta-data/lab-vault/staged/annotations = publishing to an immutable vault.
4. Emotion: CLOSED. 2 windows stay dead (emotion_zero_scored, 14 Sep). Branch indic-mt/emotion-runkey-unique @ad507e1 (score-batch key fold) has eta-refuter PASS but is OUT of the train (Fable r154/a92ebae); optional. Production carries indic-mt/emotion-dedupe 87a7215 (in a92ebae).
5. eta-lab-l4 stopped by Fable (S6, #2622/#2624); all my l4 data is on the box and in lab-mover's archive. GCP exit (r386) needs nothing more from me.
6. Not mine: stash@{0} "auto-stash by indic-mt before pull" in the shared eta-lab checkout holds OTHER panes' files (ledger, diar-lab PHASE1-RESULTS.md): leave it untouched (r89b).

## (c) Paths, branches, shas, pids
- PIDS I OWN: none. No background job, timer, or service of mine runs anywhere (verified 15:5x IST: l4 0 processes; box none).
- eta-lab main: studies/2026-09-25-readable-rerun/ = cut_segments.py (audio cutter via fleet's full_audio.assemble), flagged_to_list.py, rerun_whisper.py, rerun_indicconformer.py, ic_file.py, lid_check.py, hall_checks.py, make_ba_sheet.py, write_annotations.py, score_ba.py, l4_restart.sh, README.md, PREREG-337c-rerun.md + addenda 1-5. Merged as ae8e1f1 then 91a31c9 (my branch indic-mt/337c; worktree /home/eta/dev/eta-lab-indic).
- ETA repo (evenscribe) worktree /home/eta/dev/eta-wt-emotion-dedupe: branches indic-mt/emotion-dedupe 87a7215, indic-mt/emotion-runkey-unique 01b4b42+ad507e1 (both on origin).
- BOX DATA (patient, 0700/0600, NEVER in git): ~/eta-data/readable-rerun/r1/ = s0..s3/ (5,130 16 kHz wavs + manifest.jsonl per shard, shuffled row-level, seed 20260925+k), results/ (s?_whisper_large-v3.jsonl 5,130 lines, s?_indicconformer.jsonl 195, hall.json, rows.json), ba_v1/ (sheet.tsv, rows.json, counts.json, key.json = PRIVATE key: old_side, cell, flags, LID), list_all.jsonl, chunk_times.json, lid_s?.jsonl. Whisper result sha256 (first 12 hex): s0 fd660cc64591 s1 e2f741a298d1 s2 9f1139d61ec1 s3 64a5cd3356c7 (#2501). Split-speaker's inputs: ~/eta-data/readability/r1/ (flagged_ids.jsonl, vocab.json).
- Helper scripts in my old session scratchpad (analyze.py, emo_watch.sh, l4_restart.sh copy) are EPHEMERAL: do not rely on them; l4 is gone.
- Prereg in one line: 96 pairs+10 identical controls; labels A_better|B_better|same|neither_readable|unsure; decided = A_better+B_better; E = round(N_ne*e/(1-e)) counted OLD better (N_ne = labelled non-empty rows except unsure); RE-RUN PREFERRED needs re-run share >=0.60, old share <=0.20, Wilson lower bound >0.5, empty rate <=15%; <10 decided = not enough labels; PRIMARY verdict drops FLAGGED rows (output string seen >=3x in the full 5,130, or text on near-silence: <1.0 voiced s by webrtcvad mode 2 and >=10 chars); the all-rows result is secondary; identical-pair position bias >20% flags the whole sheet; two raters: FIRST --labels rater is primary (must have 106/106), second = agreement+kappa; a verdict disagreement = annotate-only until Fable rules (applied by hand).

## (d) Rules never to break (verbatim/near-verbatim)
- Patient text never in git, logs, bus messages or chat: counts, ids, shas only. Reports <= 12 lines to Fable via conductor (Fable-bound messages go to bus agent 'conductor'; never SendMessage pane-to-pane).
- The sheet KEY (key.json: which side is old) is PRIVATE: never show it to raters or post it. Do NOT quote structural readability scores as before/after (forced language forces the script: eta-refuter #2111); only output length/empty rate/hallucination counts. The structural score never picks a winner; only the blind human labels do. `better` in annotations stays null until then.
- Away order (Fable ~08:50): NOTHING to production (no evenscribe push, no Vercel/env, no migration, no room re-enable, no deletes of images/tunnels/snapshots); refuter PASS required before anything lands on eta-lab main; new NEEDS-YOUR decision = take the SAFER option, post 'provisional, pending Fable' to conductor.
- Ruling 135/shared checkout: never push HEAD from the shared checkout; use a temp git worktree, run `git log origin/main..HEAD` first, push only your own commits (plain merge/ff, commits unchanged). Do not pull/rebase/reset the shared box checkout.
- Never `pkill -f`/`pgrep -f` with a pattern that matches your own shell command line (it killed a session twice): use the [x] trick or PIDs, and check state after && chains.
- Tests: grep test files for pgContainer before running any emotion test (real-Postgres suites start docker on the box outside /tmp/eta-ci.lock: r407 slip disclosed by eta-refuter and me); no docker suites in this lane.
- Production DB: only kit/neon-select.mjs (read-only SELECT). Emotion job requeue = scribe_job_submit kind emotion_window, args window_id only, ONE at a time, only on Fable's word (was r347, finished).
- STT stack rule (STT-STACK-PARITY): nothing V reads may come from a reduced stack; my re-runs are labelled lab re-runs with their own engine strings, never 'same as HIST'. ORT on l4 was 1.23.2 vs HIST 1.26.0.
- HF/patient-data rule r382: private repos/buckets under vrbeven only, deleted after copy-back; nothing public. Data outside India is allowed by V.
- Annotation files are write-once; staging = publishing; include sources sha; max 400 distinct k per file.

## (e) Tools
MCP: eta-bus (bus_inbox, bus_ack, bus_post, bus_thread), Scribe MCP (scribe_job_submit, scribe_job_status, scribe_job_list; job_status output is HUGE for finished emotion jobs: prefer the DB row). CLIs: git/gh, ssh (box only now), python3, node kit/neon-select.mjs, ffmpeg, webrtcvad, faster-whisper (was on l4). No secrets used in this lane except the read key files already on the box (never printed).

## (f) Last 10 decisions
1. Emotion 128b triage: 21 windows = prepare-batch duplicate keys (13 explained by replay), 8 = Mini timeouts (#376).
2. Dedupe fix 87a7215 (PASS #576), then runkey fold ad507e1 (PASS #591/#598), kept OUT of the train (#661).
3. Requeue of the 21 one at a time via scribe_job_submit: 20 ok, 1 no_segments (#2047).
4. V3-03 = whisper-English of a Kannada lead-in, closed by r149 (#463).
5. 337c cutter = fleet full_audio.assemble slices (per-segment ffmpeg cut was wrong; split-speaker independently confirmed #1994).
6. Whisper large-v3 forced language, greedy, no fallback; IC RNNT stopped (empty on 80-100%, matches Mini production) (#2108).
7. Prereg + addenda 1-5 before any label; empties in the rule, Wilson gate, flagged rows dropped for the primary verdict (#2114/#2120/#2515, PASS #2122/#2209/#2519).
8. Sheet ba106 built from a frozen 541-row prefix; rows.json handed to surg-page/lab-viewer (#2128/#2154); r375 YES third rating set.
9. Full-set hallucination counts: 35% of the 5,130 re-runs are recurring stock strings, 703 text on near-silence, ml 44% empty (#2505).
10. S4: whisper arm finished on l4 (5,130/5,130, ~13:04 IST), STOP posted (#2501), no objection to stopping l4 (#2624).

## (g) First thing on wake
1. bus_inbox; ack. 2. Check whether Fable's browser check happened and whether V/Sandhya labelled ba106 (lab-viewer's export command above). 3. If labels exist: run `python3 studies/2026-09-25-readable-rerun/score_ba.py --key ~/eta-data/readable-rerun/r1/ba_v1/key.json --counts ~/eta-data/readable-rerun/r1/ba_v1/counts.json --labels <rater>=<file> [--labels <second>=<file>]` (exit 2 = bad keys/values, 3 = partial primary, 4 = key lacks flag_full), post counts/verdicts to eta-refuter + conductor (no text), eta-refuter re-scores. 4. If Fable OKs batch 2: `make_ba_sheet.py --n 100 --seed 20260941 --unflagged-only --exclude-key ba_v1/key.json --alloc kn=30,hi=30,bn=12,ta=12,ml=8,other=8 --out <dir>` (needs results/hall.json fresh), hand rows.json to lab-viewer/surg-page. 5. Otherwise idle; do not invent work.
