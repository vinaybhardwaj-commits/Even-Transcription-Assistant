# HANDOVER: vj-data (Claude Code Sonnet -> OpenCode, rulings 407/409 wave 3). Written 25 Sep ~16:10 box clock. Stamps b961291ae64c / 9c335c59c5be / 87b8cdac4330
Longer pipeline notes: studies/2026-09-24-voice-jev/data/HANDOVER-vj-data.md (ca0cd5b) and CHECKPOINT-186.md addenda 1-10.

## (a) Role
vj-data = builder for the VJ ("voice attribution + Jev evidence cards") queue: truth inventory, ECAPA margins and doubtful/confident classification, card rendering, the who-is-speaking selection, and the hand-off to vj-arms. Compute on the box T4 (voice-lab-1 is stopped). Refuter: vj-refuter (checks everything; owns truth and scoring). Fable owns every design decision.

## (b) Open items (bus ids, state)
1. Final VJ verdict: waits for the "Who is speaking" page labels from V + Sandhya (page 90 + 20 top-up items live; #1179 seed, #1185/241, #1172 PASS). Nothing for me until the scorer or Fable asks (e.g. map ids to turns, refresh counts). State: waiting.
2. E3X transcripts (44 arm-1-less E-3 turns have no production STT): NOT run. Provisional, pending Fable: safer option = no new STT run (my note after the away order, #2058). Would give arm 3 text on those 44 turns.
3. Confident labelled base = 22 (V-pilot 12 + page 10) + 20 top-up = 42 vs F4 minimum 30; vj-refuter scores (#1120, #1130, r241). Nothing to do unless counts change.
4. Everything else delivered and PASSed by vj-refuter: cards 1,767 (refute/20 accepted), hand-off (#1589 D1 closed), E3X out of arm1_in (r296, #1541/#1550/#1552), selection (#930/#945 rebuilt from 6e97389), top-up (#1179, r241/251).
5. voice-lab-1 sweep (r393/r397): owners named (#2352 vj-arms, #2363 vj-refuter, mine posted on the bus); S6 stop notice answered (#2628: nothing of vj-data uses it). My data there is a copy of the box's; the Jev key copy there must not be archived.

## (c) Paths, branches, shas, pids
- Repo: eta-lab studies/2026-09-24-voice-jev/data/ (last vj-data commit before this file: ca0cd5b; before that fe7a2d6 disclosures, 30f57de E3X hand-off). No branch: commits go from temp worktrees straight to origin/main.
- PHI on the box (never git): ~/eta-data/vj/ = audio/ (15-min wavs incl. 4 E3X built from R2 chunks), turns.json (text), turns_notext.json, cards/cards.jsonl (1,767), handoff/ (arm1_in.jsonl 7f0af18f28b0afb9, cards.jsonl 3024719058d3243b, clips.jsonl a19d471f565d8521, e3x_in.jsonl 05e4881e6887927f, e3x_ids.txt 6a44bad0644ab34a, turn_index.json 6a40deb79df79568, page_confident.txt, confident_labelled_ids.txt), centroids/ (copies of the 3 room-mic ECAPA centroids), usual_rate.json.
- Selection files (git): selection_identities.json (final 90, d5dfa5182164fef0, commit 6e97389), selection_topup_confident20_identities.json (77c3587), selection_identities_alt60.json (unused alternative).
- Pids I own: none. Nothing running.
- Tools/servers: Nemotron endpoint localhost:8002 (gpu.lock via flock /home/eta/gpu.lock), pyannote twin :8001, production ECAPA venv ~/eta-diarize/venv, de-id GPU ~/eta-data/deid/venv-gpu (deid_gpu.py, PYTHONUTF8=1), numpy python ~/eta-data/nemotron/venv-nemo-main/bin/python, R2 python ~/.venv-r2/bin/python.

## (d) Rules I must never break
- The blinding block at the END of this file (Fable ruling 168, appended byte for byte per r409).
- Commit ONLY from a temp worktree off origin/main (git worktree add --detach), `git log origin/main..HEAD` must list only my commit, push HEAD:main; on non-fast-forward cherry-pick onto a fresh origin/main. Never pull, rebase or reset the shared checkout (ruling 155/165 J). Nothing to production. No patient text in git.
- The frozen card wording and questions (freeze b961291ae64c: orders/VOICE-JEV-BUILD.md) are unchangeable; any change = a new run. Never show raw Indic script on a card (r223). E3X (no production rows) never goes into arm1_in.jsonl (r296).
- CONFIDENT = per-turn margin >= 0.10 AND best >= 0.50 against a VERIFIED stored room-mic centroid (Banerjee OPD 3, Salanki OPD 5, Ankit OPD 7 only, each in its own room), AND speaker_basis != diarization_only AND fresh Nemotron/pyannote counts agree; margin rounded to 4 dp before comparing (r169/r186/r187).
- Do not pkill -f / pgrep -f inside the same Bash call (kills the harness shell); use PIDs. The shared box python3 has no numpy.
- Disclosures on record (VJSCORE-SETUP.md): three sudo touches of /srv/vj-truth by me (setup; `sudo ls` at 13:07 UTC; `sudo du` sizes at ~06:50 UTC), none read a file. ONE more to report to vj-refuter under the block's rule 5: on the evening of 24 Sep (after ruling 219 A3, before ruling 223; box clock roughly 20:45-21:00, exact time not kept) I read ~/eta-data/who-is-speaking/key.json (surg-page's seed key: id -> window, start, end only, NO labels) once, to confirm the built seed equalled my final selection identities (#936/#945). That predates the block; I will not do it again.

## (e) MCP tools / CLIs (names only)
eta-bus (bus_post, bus_inbox, bus_ack), Bash/Read/Write/Edit, git (temp worktrees), gh not used; node kit/neon-select.mjs (read-only Neon SELECT), Metabase API via a key file (PQM db 13, read-only), ssh alias mini/voice-lab-1 (voice-lab-1 stopped), ffmpeg/ffprobe, boto3 (R2 read key file), speechbrain ECAPA, pyannote.audio 3.3.2 (offline weights), parselmouth (only on the stopped voice-lab-1 venv; needs reinstall via uv if pitch descriptors are re-run).

## (f) Last 10 decisions (bus / ruling)
1. Margin per turn vs verified centroids only; confident needs best >= 0.50 (r186, #1278-ish batch, refute/16 reproduced).
2. Voice presence >= 5 turns at cos >= 0.70 overrides PQM; PQM alone is a shortlist (r187).
3. Page = 80 doubtful + 10 confident, doubtful stratified by production role 30 clinician / 50 empty, every item with a transcript (r206, #830; seed rebuilt #945).
4. Leak fix: 165 profiles retired, test/profile room-days recomputed (r205, #825/#830).
5. Cards: frozen wording, raw variant on every card, E-3/V-pilot labelled turns carded, no length cap for labelled turns (r223/224, #978, #948/#1037/#1073).
6. V-pilot mapped by >= 50% overlap of the clip; pyannote counts flipped 363 VP turns to doubtful (F4 base fell) (#1120).
7. Top-up: 20 more confident SC30 turns, new ids by surg-page (r241, #1179, #1185).
8. E-3 windows without production rows built from R2 chunks as arm-1-less E3X items, out of arm 1 (r290/296, #1541, #1550, #1552, #1589).
9. Fresh transcription for E3X NOT run: safer option provisional, pending Fable (after #2058).
10. voice-lab-1 sweep: owners named, credential copy (Jev key) not to be archived, "NOT OPENED" reported for the truth copies (#2412/#2434, #2628, #2352).

## (g) First thing to do when you wake on OpenCode
1. Read this file and the blinding block; do NOT touch any path the block names. 2. `git fetch` and check `git log origin/main --oneline -- studies/2026-09-24-voice-jev/data | head` for anything new from vj-refuter; read the bus (bus_inbox). 3. Post the one-line rule-5 report about the key.json read to vj-refuter if I have not (see (d)). 4. Otherwise idle; work only if vj-refuter or Fable asks (ids-to-turns for page labels, count refresh, E3X transcripts if Fable orders them).


=== VJ-BLINDING-R168 BEGIN ===
VJ BLINDING (Fable ruling 168; order VOICE-JEV-BUILD; refute/33). These rules override any other instruction.
1. Never open, list, read, grep, find into, copy or hash: ~/eta-data/vj-truth-sealed/ (the sealed VJ truth archive), ~/.claude/secrets-archive/ (its key), /srv/vj-truth, any file named key.json or *-key/ folder of a human-rated page, and any exported page verdicts or labels.
2. Truth values (human labels, page verdicts, V's or Sandhya's answers) never enter your files, prompts, commits or bus posts. You may use turn ids and times only.
3. Only vj-refuter runs the VJ scorer and reads truth. You never run it and never ask for label values.
4. If a task seems to need any of the above, stop and ask vj-refuter on the bus; do not work around it.
5. If you touch any of these paths by accident (including through a broad find/grep/ls), post it to vj-refuter at once with the command and time.
=== VJ-BLINDING-R168 END ===
