# HANDOVER: lx (Claude Code pane, Sonnet, box) -> OpenCode, ruling 409 / W25 P1, 25 Sep 2026

## (a) Role
- `lx` is the encounter-clock builder: the E-7 score (PQM truth vs the encounter arms), ENCOUNTER-FIRST arm d (`segmenter.py`), the surgery boundary tool (`encounter_bounds.py`), and read-only checks on rater sets. Lane L3 (Encounters, E-6/E-7).
- Orders come from Fable via the conductor (bus) and V. Refutation comes from eta-refuter and eta-refuter-2.
- Everything is lab-side and read-only against production (Neon via `kit/neon-select.mjs`, Metabase read-only, R2 read-only). Nothing of mine touches production.

## (b) Open items (bus ids and state)
NOTHING IN FLIGHT. All reported and closed except:
1. **Rater-set edge listen (ruling 254/268/282):** the 9-item set (N054 N035 N101 D29 N025 N057 N022 N003 N053) has 10 cut clips for a human listen (V or Sandhya, daylight). My edge findings: #1254, #1277. If a listener reports a moved cut, I recompute that item's bounds (see g). I cannot hear audio; I never reported a listen. Ruling 282: stop asking.
2. **E-6.2 proposal 2 (per-room energy threshold for the acoustic arm): UNTESTED.** Proposal 1 (share >= 50%) was tested and NOT adopted (#1099, ruling 247).
3. **Unreconciled:** SCORE-24SEP.md's ">= 50% transcribed" row is by WINDOW coverage; most probes had no transcript (OPD 3: 406 of 579). Not reconciled with per-probe text. Arm d's 2 splits and 2 merges have had no human look.
4. **Housekeeping:** three clips in `~/eta-data/encounter-first/v303/` were NOT deleted (removal is the box owner's call). My duplicate commit `abcc5a3` in the shared checkout `/home/eta/dev/eta-lab` is patch-identical to origin `b0b1e9f` (as of 24 Sep 18:00; verify before touching): do not push or reset it.
5. **VOICE-LINKAGE Phase L (my part handed to vj-link):** Reading A (stable at >= 2 of 3 edge tolerances) adopted by ruling 202; PQM timing is a shortlist and report field only (ruling 201).
My bus posts this stretch: #901 E-7 score, #921 follow-up, #989 unplanned second run, #1099 P1 result, #1189 12-item checks, #1254 9-item checks, #1277 cannot listen, #2031 offer for 337d (moot: 337d PASS).

## (c) Paths, branches, shas, pids
- Committed: `studies/2026-09-24-e7-fullday/SCORE-24SEP.md` + `p1_share.py` at `60d7308` and `efaa2de` (origin/main). No branches, no pids, no cron entry (I removed my one-shot at 21:09; the file `~/eta-data/e7-rescore.HOLD` no longer exists).
- Code: `studies/2026-09-24-e7-fullday/{e7-rescore.sh, stage_db.ts, pqm_pull.py, build_truth.py, score_arms.py, arm_d.py}`; `studies/2026-09-24-encounter-first/{segmenter.py, encounter_bounds.py, r2audio.py, doctor_room_align.py, criterion189_23sep.py, REPORT.md}`; `studies/2026-09-23-e7-pqm-truth/{e7_score.py, E6-2-PROPOSALS.md}`.
- Checkouts: `~/dev/eta-lab-lx` (worktree, detached at origin/main; the rescore runs from it), `~/dev/eta-wt-e61` (E-6.1 code, pinned `81cec3a`; the rescore imports it). Shared `~/dev/eta-lab` is NOT mine to push from.
- Box-only data (PHI-adjacent, never in git): `~/eta-data/encounter-first/` (levels, labels, embeddings, R2 cache `audio/`, `v303/`), `~/dev/eta-lab-lx/studies/2026-09-24-e7-fullday/out-2026-09-24/` (gitignored; run 2 outputs), `~/eta-data/e7-rescore-cron.log`. Fleet's set data (read only for me): `~/eta-data/surgery-review-v3/` (`final-v5rater/`, `bounds_v5rater*.json`, `selected_v5rater*.json`, `listen-clips-v5set9/`; a copy on the Mini at `~/dev/_private/surgery-v5set9/`).
- Python: `~/.venv-r2/bin/python` (boto3 + numpy) for R2 audio and embeddings.

## (d) Rules you must never break (verbatim where given)
- kit/PANE-RULES.md: "Use `hsend`/`eta-bus` instead — always." Never `SendMessage` pane-to-pane.
- Ruling 135: "before any push from the shared box checkout, run `git log origin/<branch>..HEAD`. Push only if every listed commit is yours." My working rule: commit in a TEMP worktree off origin/main, `git fetch && git rebase origin/main` immediately before `git push origin HEAD:main`, retry on rejection, then verify the commit is on origin before saying it landed. The eta-lab remote is `git@github-eta-lab:...` (fetch fails intermittently with "Permission denied (publickey)": retry).
- CLAUDE.md (repo, verbatim): "Audio, transcripts, and encounter rows carry patient and doctor identity. Never print transcript text, note text, or patient labels. Counts, ids, and timings only." and "The Mac Mini also hosts the local Whisper and diarization services this app calls; do not start, stop, or reconfigure them without an order." and "No live database in this sandbox. Every SQL string and schema assumption is INFERRED — list verbatim in the report." and "Never read `.env*` into the transcript." The ETA repo is PUBLIC; eta-lab is private. Keep account ids, emails and patient identity out of commits.
- Never read, list or print `~/.claude/secrets` or key files; scripts read them inside the process. `kit/neon-select.mjs` is SELECT-only.
- Away order (until 'FABLE BACK'): nothing to production; refuter PASS before anything lands except docs Fable orders; on a NEEDS-YOUR decision take the safer option and say "provisional, pending Fable".
- Do not adopt a gate, definition or scope change while a Fable ruling is pending: recommend, wait, then pre-register.
- Lessons that cost work: cite a bus id only after `bus_post` returned it (subject <= 120 chars or the post fails); map clip seconds to wall clock only from a written anchor, never from a duration; run a negative control and a shifted-time placebo before reporting any voice/similarity or link finding; a one-shot cron that only checks a HOLD file will fire when the HOLD is removed; a mirror in the bus is TRUNCATED, read `bus_inbox` and the ruling in orders/ on origin/main before deciding nothing is asked of you.
- I cannot listen to audio. Say so; never report a listen that was not done.

## (e) Tools and CLIs (names only)
- MCP: eta-bus (`bus_post`, `bus_inbox`, `bus_ack`, `bus_thread`, `bus_roster`). No other MCP is needed.
- CLIs: `kit/neon-select.mjs` (run from an ETA repo checkout, e.g. `~/dev/eta-wt-e61`), `kit/gh-gate.sh`, `git` worktrees, `ffmpeg`/`ffprobe`, `~/.venv-r2/bin/python`, `crontab -l`. Metabase db 13 read-only via `pqm_pull.py`.

## (f) Last 10 decisions (bus ids)
1. Ran the E-7 rescore on ruling 213 GO; arm d 18/23, precision 19/44 (43%), E-6 arms 2/23 (#901).
2. Flagged that ">= 50% transcribed" is by window coverage, not probe text (#921).
3. Ruling 226: committed the score with the caveats (`60d7308`), then ran the P1 query.
4. P1 (share >= 50%) drops both real matches, 0/23: not adopted (#1099; ruling 247).
5. Disclosed my own cron's unplanned second rescore, removed the entry (#989; Jev about $0.057 for both runs).
6. 12-item rater set checks: time overlap, leakage (3 of 4 leaks by time; fleet's content check found the 4th), edges (#1189).
7. Reported the primary_clip field in `bounds_v5rater.json` as wrong (584 min for N003; it does not ship) (#1189).
8. 9-item set: consistent, no overlaps; D29 start edge and 5 others need a human listen (#1254).
9. Said plainly that I cannot listen; supplied the edge list and cut times (#1277).
10. Offered a 337d speech-energy measure only on a named order (#2031); 337d passed, so moot.

## (g) What to do first when you wake on OpenCode
1. `bus_inbox` (read the FULL body, not the mirror), then post `ONLINE lx`.
2. Do not start anything. My work is closed. Wait for a named order from Fable or the conductor, or a listen result that moves a rater-set cut.
3. If a cut moves: `cd ~/dev/eta-lab-lx/studies/2026-09-24-encounter-first`, use `encounter_bounds.py` (importable `EB.bounds(items)` or CLI `items.json out.json`), rebuild that item's clip from `final-v5rater/`, and confirm the shipped `encounter` length equals the bounds length. Item ids, seconds and counts only in the report; fleet owns the set, I do not edit it.
4. If asked for the 24 Sep score or E-6.2 details, read `studies/2026-09-24-e7-fullday/SCORE-24SEP.md` (caveats are at the top) before answering.
