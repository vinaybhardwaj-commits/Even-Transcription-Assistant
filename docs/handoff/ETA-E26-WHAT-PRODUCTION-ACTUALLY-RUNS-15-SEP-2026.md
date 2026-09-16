# ETA-E26 — What production actually runs · 15 Sep 2026 · Fable

MEASURED from the Vercel API, not inferred. Team "Hospital Product"
(team_yu1wWpsKdjsf90haai1ETJDG), project even-transcription-assistant
(prj_8nVH2HdbeDy6aJ8oeWqfkhYijM9Z), linked to GitHub
vinaybhardwaj-commits/Even-Transcription-Assistant.

## 1. The finding

**Production runs commit `fe021a30` from branch `vinay/s1-auto-drain`. It does NOT
run `main`.**

Every deployment with `target: "production"` in the window checked carries
`githubCommitRef: vinay/s1-auto-drain` and `githubCommitSha: fe021a30f6ae70d4a6ffcf4efaf53332ef322527`
("S1 MERGE C19: correct the C16 comparison comment..."). The current production
deployment is `dpl_3KgFAxELdKDz2DbzaQekTiYaNzmi`. Three earlier production rows are
redeploys of the same sha.

`origin/main` is `7ffb168`, dated 25 Aug 2026. It is three weeks stale and is not a
release channel. There is no `.vercel/project.json` in the worktree.

## 2. What this resolves

The Refuter's open item in ETA-F5-CRASH-WINDOW-DEBUG — "which commit production runs:
remote main is 7ffb168 from 25 Aug, which has no diarize job, yet diarize jobs ran on
14 Sep" — is resolved. Diarize jobs ran because production is `vinay/s1-auto-drain`,
which has the diarize job. There is no mystery and no second deploy path.

## 3. What this changes, and it is not small

**The branch IS the release channel.** There is no separate gate between
`vinay/s1-auto-drain` and production. Anything on that branch ships the moment the
branch is promoted. Tonight that branch carries E17 (drain fairness) and E11 (e)(f),
both of which reached Vercel only as PREVIEW builds (`target: null`) — `3aa75c9`
built as `dpl_8xoPUM5q8AShCWmbdZE4N4HdUA1P` and was never promoted.

RULING R19 — **`vinay/s1-auto-drain` must not be promoted to production while E17
stands as it is at `3aa75c9`.** E17 at that commit hands a refused room 98-100 of 117
slots (ETA-E11-E17-REFUTATION §4, measured). scribe3's F1 fix is on `836188f` on the
same branch and is not yet refuted. Promotion waits for that refutation.

RULING R20 — **R16's ordering constraint binds at the E16 merge, not now.** Migration
0099 lives on `vinay/e16-emotion-speech-fraction`, not on `vinay/s1-auto-drain`, so
`3aa75c9` does not need it. The moment E24 merges into `vinay/s1-auto-drain`, the next
production promotion of that branch requires **0099 and 0097 applied first**, or every
diarize INSERT and every emotion `prepare` SELECT fails on a missing column. Write
that into ETA-E25-DEPLOY-ORDER-E24.md as a branch-level constraint, not a
migration-level one.

RULING R21 — **stop treating `main` as meaningful.** Every spec already names its
branch and worktree (standing rule). Add: every spec that changes behaviour also names
whether its branch is the production channel. "Merged to main" means nothing in this
repo today and must not appear in a ruling or a commit message as if it did.

## 4. A second workstream is live in this repo tonight

Preview deployments from 15 Sep carry `githubCommitAuthorName: Cursor Agent` on two
branches, under PRs #2 and #3:
- `cursor/scribe-fleet-rca-15sep-6a9c` (HEAD 37dc020) — fleet RCA: Home Office EMFILE,
  ~4847 leaked PIPEs against `ulimit -n 256`, `room-recorder.lock` held by a leaked pid
  since 12 Sep, Room 4.1 tapewriter failures, OPD 3 digital silence.
- `cursor/piece-pipeline-pipe-close-6a9c` (HEAD 0803d51) — stops using Foundation.Pipe
  on the live recording poll and cutter; `MachineFacts.runTool` runs three times per
  1.5 s poll and never closes its Pipe handles.

Both are PREVIEW only; neither has a production target. They do not collide with
`vinay/s1-auto-drain` or `vinay/e16-emotion-speech-fraction`. They are recorded here
because they touch the same repo on the same night and because that OPD 3 "digital
silence" work is adjacent to E13 (a dead mic cannot be told from a quiet room) and to
R1 (a silence verdict must be evidenced and revisitable). Whoever closes E13 should
read those two branches first.

## 5. Method note

This was established with three API calls and one git query, after an agent flagged it
as an unresolved assumption at the bottom of a report about something else. The
standing rule it confirms: **verify documented guarantees against running production.**
A deploy topology nobody has checked is a guarantee nobody has verified, and we spent
this entire evening reasoning about "what production does" from a repository.
