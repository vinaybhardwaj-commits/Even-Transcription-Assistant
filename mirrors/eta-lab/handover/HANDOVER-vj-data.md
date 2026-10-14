# HANDOVER: vj-data (Claude Code Sonnet -> OpenCode, rulings 407/409 wave 3). Written 25 Sep ~16:10; REFRESHED 26 Sep ~12:00 box clock (r432). Stamps b961291ae64c / 9c335c59c5be / 87b8cdac4330
Longer pipeline notes: studies/2026-09-24-voice-jev/data/HANDOVER-vj-data.md (ca0cd5b) and CHECKPOINT-186.md addenda 1-10.

## (a) Role
vj-data = builder for the VJ ("voice attribution + Jev evidence cards") queue: truth inventory, ECAPA margins and doubtful/confident classification, card rendering, the who-is-speaking selection, and the hand-off to vj-arms. Compute on the box T4 (voice-lab-1 is stopped). Refuter: vj-refuter (checks everything; owns truth and scoring). Fable owns every design decision.

## (b) Open items (bus ids, state) -- refreshed 26 Sep 12:00
1. J-card A DONE (vj-refuter #3287): the 20 ruling-241 top-up confident turns are carded + clipped (commit b245c35); vj-refuter PASSed it as J-005 (#3360). Next is vj-arms J-006/J-card B (arms 2/3 on the 19; the 20th, t12cca6639e, is carded but not scored). Arm 4 = "YES" (r425/427, shim approved) but voice-lab-1 is stopped: vj-arms / Fable own the Vertex route. Nothing owed by me.
2. Final VJ verdict: waits on scoring by vj-refuter (page labels are IN: #3276; 109 of 110 page items mapped, refute/35). Only if the scorer asks: map ids to turns / refresh counts.
3. E3X transcripts (44 arm-1-less E-3 turns, no production STT): NOT run; provisional, pending Fable (safer option). Would give arm 3 text on them.
4. Everything else delivered and PASSed by vj-refuter (cards 1,787, hand-off, E3X out of arm1_in r296, selection 90 + top-up 20). voice-lab-1 is STOPPED (r393/S6): do not use it; my data is mirrored on the box.
5. Wave-3 switch to OpenCode (r412.10/r432): opencode/glm-5.3; run with EXTRA_DENY="/home/eta/eta-data/vj-truth-sealed/*".

## (c) Paths, branches, shas, pids
- Repo: eta-lab studies/2026-09-24-voice-jev/data/ (latest vj-data commits: b245c35 J-card A, ca0cd5b/2ea7d01 handover, fe7a2d6 disclosures, 30f57de E3X hand-off). No branch: commits go from temp worktrees straight to origin/main.
- PHI on the box (never git): ~/eta-data/vj/ = audio/ (15-min wavs incl. 4 E3X built from R2 chunks), turns.json (text), turns_notext.json, cards/cards.jsonl (1,787), handoff/ (arm1_in.jsonl 7f0af18f28b0afb9 unchanged, cards.jsonl 467560040b5abc45, clips.jsonl d95dc0b751ec76d6, e3x_in.jsonl 05e4881e6887927f, e3x_ids.txt 6a44bad0644ab34a, turn_index.json 6a40deb79df79568, page_confident.txt, topup_confident_ids.txt 4403f96adc28cecb, confident_labelled_ids.txt 0b04566706f3cfb9 = 42 ids), centroids/ (copies of the 3 room-mic ECAPA centroids), usual_rate.json.
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
1. J-card A: card + clip the ruling-241 top-up confident turns; existing 1,767 cards byte-identical (#3287, PASS #3360; commit b245c35).
2. Fresh transcription for E3X NOT run: safer option, provisional, pending Fable (away order #2058).
3. Named the ~/vj owners on voice-lab-1; Jev key copy NOT to be archived; reported NOT OPENED for the truth copies (#2352, #2363, #2412/#2434, #2628).
4. Rule-5 report of the one key.json identity read filed (#2724), checked clean (#2726).
5. E3X kept out of arm 1: e3x_in.jsonl + e3x_ids.txt separate; production_row=false (r296, #1541/#1550/#1552/#1589).
6. E-3 windows without production rows built from raw R2 chunks (r290, refute/30).
7. Top-up: 20 more confident SC30 turns, blind, new ids by surg-page (r241, #1179).
8. Page = 80 doubtful (role-stratified) + 10 confident, every item with transcript (r206, #830; seed #945).
9. Confident = per-turn margin >= 0.10 AND best >= 0.50 vs a verified centroid; voice presence >= 5 turns at cos >= 0.70 overrides PQM (r186/r187).
10. Leak fix: 165 profiles retired; test/profile room-days recomputed (r205, #825).

## Checks I owe others
None open. If vj-refuter or vj-arms asks: regenerate the hand-off (handoff.py, box only), rerun classify186 after any new counts, map page ids to turns.

## (g) First thing to do when you wake on OpenCode
1. Read this file and the blinding block; do NOT touch any path the block names. 2. `git fetch` and check `git log origin/main --oneline -- studies/2026-09-24-voice-jev/data | head` for anything new from vj-refuter; read the bus (bus_inbox). 3. The rule-5 report about the key.json read is already filed (#2724, checked #2726). 4. Otherwise idle; work only if vj-refuter or Fable asks (ids-to-turns for page labels, count refresh, E3X transcripts if Fable orders them).


=== VJ-BLINDING-R168 BEGIN ===
VJ BLINDING (Fable ruling 168; order VOICE-JEV-BUILD; refute/33). These rules override any other instruction.
1. Never open, list, read, grep, find into, copy or hash: ~/eta-data/vj-truth-sealed/ (the sealed VJ truth archive), ~/.claude/secrets-archive/ (its key), /srv/vj-truth, any file named key.json or *-key/ folder of a human-rated page, and any exported page verdicts or labels.
2. Truth values (human labels, page verdicts, V's or Sandhya's answers) never enter your files, prompts, commits or bus posts. You may use turn ids and times only.
3. Only vj-refuter runs the VJ scorer and reads truth. You never run it and never ask for label values.
4. If a task seems to need any of the above, stop and ask vj-refuter on the bus; do not work around it.
5. If you touch any of these paths by accident (including through a broad find/grep/ls), post it to vj-refuter at once with the command and time.
=== VJ-BLINDING-R168 END ===
