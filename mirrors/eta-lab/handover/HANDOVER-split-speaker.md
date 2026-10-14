# HANDOVER split-speaker (Claude Code Sonnet builder pane on the E2E box eta-lab-t4) -> OpenCode
Written 25 Sep 2026 ~15:40 IST box clock. Ruling 409. Counts, ids and paths only; no patient text.

## (a) Role
Builder on the E2E box for ETA/EvenScribe speech-to-text QUALITY studies: measure, pre-register, freeze, then run; the refuter (eta-refuter, eta-refuter-2) refutes; Fable rules via the conductor.
Today: the loop-guard (a92ebae) and its before/after watch, the r333/337d "is real speech discarded by the english_hallucination_guard" measurement, the 337c per-segment readability flag, and piece B of the link-3 name-leak gate.
Reports: bus_post to ["conductor"] (Fable is not on the bus, ruling 21); evidence in eta-lab git. Everything is lab-side; I touch nothing in production.

## (b) Open items (state, bus ids)
1. **337c readability flag: WAITING ON HUMAN LABELS.** Flag scored on 44,739 non-refused segments (5,352 flagged; flag = score < 0.60). Frozen 200-row stratified sample; blind shuffled sheet; eta-refuter PASS on the scorer (#2054) and addenda 1, 2, 3, 3b (bus #1927, #2039, #2051; ruling 362; merged). The rating page /rate/label200 is LIVE behind Access (lab-viewer #2024, refuter-2 PASS #2046) and waits for Fable's browser check (r359) before V/Sandhya are told. NOTHING may hide a line and NO readability annotation may be written until labels give per-cell precision.
   WHEN LABELS ARRIVE: lab-viewer exports {L###: label} per rater: `python3 kit/lab-viewer/tools/rate_seed.py export --set label200 --out ~/eta-data/readability/r1/labels --rater vinay=<email> --rater sandhya=<email>` (they run it or tell you). Then in a worktree of eta-lab main, from studies/2026-09-25-readability: `python3 -B score_labels.py sample200_ids.json ~/eta-data/readability/r1/sample200_key_v2.json ~/eta-data/readability/r1/label-page-seed/key.json OUT.json <rater1.json> [<rater2.json>]` (OUT must not exist, write it under ~/eta-data, outside git). Post per-cell PRECISION FIRST with the Clopper-Pearson bounds first (addendum 3b), then recall, covered shares, unsure counts, disagreements. Floor for collapsing lines by default: cell has >= 10 labelled flagged rows, precision >= 0.80 and romanised_readable <= 0.20. Only for passing cells may you write annotations (kind readability, ok:false, collapse:true) with kit/lab-vault/tools/make_annotation.py (sources sha-bound); refuter reviews first.
   Also merged by others: addendum 5 (flagged stock-string rows dropped from the primary verdict; indic-mt/eta-refuter, 91a31c9), read it before scoring.
2. **337d: DONE.** K = 0 of 30 refused windows REAL, controls separate (7/10, 0/14). Results + proposal (NO GUARD CHANGE) on main 04b30c4, addendum 1 on main 4e20bff; eta-refuter PASS #2223/#2525; posted #2221, #2226, #2521, #2530. Open only: one human listen to window 2026-09-10_room_2qe955hy_0000 (the single candidate); Fable decides at 16:00. r333 results (1 of 30 by webrtcvad, probably hum) on main (studies/2026-09-25-refused-speech/RESULTS.md), posted #1875/#1877.
3. **Loop-guard AFTER watch: PARKED (ruling 370, posted #2135).** State: deploy_at = 2026-09-25T07:51:38 IST (a92ebae ready); last tick on main is 09:05: BEFORE 321 windows, 18 loop (5.6 %), 15 unprotected; TRANSITION 0; AFTER 0. Script studies/2026-09-24-redundancy/filler_watch2.py (also in my scratch dir, which may vanish). Amendment 1 + Correction 1 on main (bus/FILLER-WATCH-25SEP-AMENDMENT-1.md). RESUME only when transcription switches are ON in at least one room (scribe's read-back time): start the same script with new --start/--until (hourly ticks), same deploy_at.txt; verdict at the first tick with AFTER >= 50 else INSUFFICIENT; report the recording-hour mix.
4. Link-3 name-leak gate (piece B, link3_nameleak.py blob 0e0f1ef then salted pins): done and refuter-passed; used by linker/linker-oc. Nothing open; draws/summaries need refuter-reviewed blobs only.
5. Nothing else in flight. No processes of mine are running (the watch pid 17990 was stopped; the 337d run finished).

## (c) Paths, branches, shas, pids
- Worktrees (mine, private, off origin/main): /home/eta/dev/eta-lab-refused (studies 2026-09-25-refused-speech, -readability, -discarded-speech), /home/eta/dev/eta-lab-watch, /home/eta/dev/eta-lab-nameleak, /home/eta/dev/eta-lab-handover (this file). Push ONLY from these, never from ~/dev/eta-lab.
- Box data (0700/0600, never git): ~/eta-data/refused-measure/{r1,r2} (r333 draw+results; 337d plan, results.json, texts.jsonl = recovered text for V/Sandhya), ~/eta-data/readability/r1 (features.jsonl, flagged_ids.jsonl, sample200_ids.json, sample200_sheet_v2.tsv, sample200_key_v2.json, vocab.json, label-page-seed/{seed_docs.json,key.json}).
- Frozen shas: readability.py sha256 prefix ba60b245; 337d discarded_logic.py sha256 prefix 0118907d; refused_logic.py sha256 prefix 466f56b3; link3_nameleak.py blob 0e0f1ef; loop guard 035c5b7 (live as a92ebae).
- Merged branches (done): split-speaker/{filler-amendment-1,filler-correction-1,337d-results,337d-addendum-1}. Python for audio work: /home/eta/vad/venv/bin/python (numpy, torch, silero-vad, webrtcvad; read-only use). Box twins (127.0.0.1): :8080 whisper-server (large-v3-turbo), :8082 IndicConformer twin, :8001 pyannote diarize, :8083 router twin; NEVER the ssh-tunnel ports 18001/18086 (Mini).
- pids owned: none.

## (d) Rules you must never break (verbatim where given)
- "No transcript text, note text, patient names or room/patient labels in any output, log, scratch file or commit message. Counts, ids and timings only. No connection strings, no credentials."
- "Never print or log the presigned URL." Never print a connection string; never read .env*; DB only through read-only SELECT tooling (neon-select never prints the DSN).
- kit/PANE-RULES.md: "never use Claude Code cross-session messages (SendMessage) pane-to-pane -- they need the recipient's human to approve and can expire undelivered with no error. Use hsend.sh or eta-bus (bus_post/bus_inbox) instead, always." Ruling 21: anything for Fable goes to the bus agent "conductor".
- Ruling 135: "Rule for every pane: before any push from the shared box checkout, run `git log origin/<branch>..HEAD`. Push only if every listed commit is yours." Read a merged file back after pushing (I once merged a file with its body missing).
- AWAY ORDER (Fable ~08:50, stands until 'FABLE BACK'): refuter PASS before anything lands on eta-lab main (push a BRANCH split-speaker/<topic> first, eta-refuter reviews, then land); NOTHING to production; a new decision: take the safer option, record 'provisional, pending Fable' to the conductor.
- Ruling 370: transcription/visits switches stay OFF; nobody flips a room switch. Nothing new touches the Mini (ruling 312/15: no lab requests to the Mini's whisper/diarize/emotion).
- Blinding (337c): labellers are V or Sandhya only, blind to the flag; the sheet shows no engine/flag/score/reason; the id->cell/flag key stays separate; NO model reads real transcript text (rulings 42/306, D1b: real consult transcripts may not go to TypeSafe).
- Pre-registration discipline: freeze code + design + thresholds and push BEFORE running; the refuter refutes first; report deviations and post-hoc items as such; the commit time is the timestamp (never write a clock time later than the commit); 'UNVERIFIED stays UNVERIFIED'; an empty AFTER is 'not measurable', never 'no loops'.
- Do not pkill -f (matches your own shell): kill exact pids. Do not pipe a command to tail and read its exit code. bus_post subjects must be <= 120 characters. Mutation testing: temp copies + `python -B`, assert every anchor.

## (e) Tools and CLIs (names only)
bus MCP (bus_post, bus_inbox, bus_thread, bus_ack, bus_roster), git (push over the github-eta-lab ssh alias; gh is not logged in), python3 (unittest, no pytest), /home/eta/vad/venv/bin/python, ffmpeg/ffprobe, curl, the box twins above, kit/lab-viewer/tools/rate_seed.py (export) and kit/lab-vault/tools/make_annotation.py (annotation files; vault uploads are lab-viewer's).

## (f) My last 10 decisions (bus ids)
1. #2135 PARK the loop-guard watch (ruling 370); process stopped by pid, state kept.
2. #2226/#2530 land the 337d results, proposal and addendum after refuter PASS; recommendation = NO GUARD CHANGE.
3. #2521 stock-string check on my forced-language outputs (post-hoc, labelled): refused 29 %, empty rooms 42 %, positives 0 %.
4. #2039/#2051 scorer fixes and addendum 3b: Clopper-Pearson first, Jeffreys posterior replaces the degenerate bootstrap; typos counted per rater.
5. #1927 addendum 1: blind shuffled sheet, romanised_readable label, precision floor, re-run not self-judged.
6. #1934 337d addendum 1: positives = known Indic speech from the router's fixed-window tier (the English controls could not validate the test).
7. #1877 my r333 premise ('Silero-sliced') was WRONG: all 213 refused segments are the fixed-window fallback; Silero 0/30 is by construction.
8. #1850 noisy-silence control added post-hoc and labelled as such; #1875 r333 result 1 of 30 (hum), refuter PASS.
9. #2066 disclosed two scorer pushes that reached main before refuter PASS; branch-first from then on. #2084 a merge that dropped a file body, found on read-back and fixed.
10. #1994/#1995/#2005 audio placement check: my window cut reproduces stored text 8 of 12 (shifted 0 of 12); one control window (2026-09-11_room_qyzghzaf_1115) does not reproduce at any shift.

## (g) First thing to do when you wake on OpenCode
1. bus_inbox; reply 'ready' to the conductor. 2. Check whether labels exist: `ls ~/eta-data/readability/r1/labels`; if yes run the scorer as in (b)1 (read addenda 1-3b and 5 first); if not, stay idle and do NOT ask V/Sandhya yourself (Fable's browser check comes first). 3. Do not restart the watch unless the conductor says switches are on. 4. Read board/DIGEST.md 'FOR FABLE' for anything about 337c/337d. 5. Never post a number without its interval; never hide anything before the precision floor passes.
