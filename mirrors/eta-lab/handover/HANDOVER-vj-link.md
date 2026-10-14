# HANDOVER: vj-link (Claude Code pane, Sonnet 5) -> OpenCode, ruling 409 / W25 P1, 25 Sep 2026

## (a) Role
- `vj-link` is the Builder for VJ Phase L (orders/VOICE-LINKAGE.md, ruling 183): find each doctor's voice from PQM timing, prescriptions and room recordings, then let V agree or disagree on "Doctor voice check" cards.
- I own `studies/2026-09-24-voice-jev/link/` ONLY. Compute is voice-lab-1, the box T4 and CPU. Metabase and Neon are read-only. Centroids are minted only from links V agrees with, never written to production `voice_print`.
- Reach Fable through the conductor (the roster has no "fable"). Checker is vj-refuter; page and seed are surg-page; PQM alignment is lx; the Rx join is mb-rx.

## (b) Open items
NONE in flight. Nothing is running; nothing is pending on my side. Waiting only on V's verdicts.
- Batch 1b + 3 anchored cards: PUBLISHED (r260, 62 docs). Scored separately by vj-refuter (anchors = known-answer controls).
- Batch 2 (40 cards, rule v2, r275/r289/r311/r314/r320): seed `~/eta-data/doctor-voice-check/batch2/seed_docs.json`, sha prefix `9d93db8c92781f30`, 160 mp3. Fable publishes ~08:30 25 Sep as passed. My source cards equal the seed (vj-refuter #1729). I have not seen a message confirming the publish or any V verdict.
- Follow-ups, ONLY if Fable or vj-refuter asks (each runs in minutes under the frozen rules):
  1. Re-tier with V's agreed links (HIGH = anchored identity).
  2. Re-measure the vote's precision against any new V-verified prints (vj-refuter asked, #1406).
  3. Recompute the two-places flag on the extended set. The 30 s bar is frozen in `BATCH3-NOTES.md`; report every below-bar group's seconds; vj-refuter re-checks the flagged groups (#1535).
  4. More known-voice cards for any new V-verified print.
- Minting stays gated on V's agreement + the ruling-182 controls on a held-out NON-enrolment day. Enrolment days are never evidence or minting audio.
- Disclosure sent (#2418, re #2412): ONE name-only `ls -d` of `~/eta-data/gcp-archive/voice-lab-1/system/srv` (no contents seen). I never opened any truth path. Do not repeat it.

## (c) Paths, branches, pinned shas, pids
- Git: `studies/2026-09-24-voice-jev/link/` on origin/main; last commit `61ebf74` (H04 reorder reverted). No branches. No pids running. My temp worktree was `/tmp/claude-1000/-home-eta-dev-eta-lab/0bddfb96-ae41-49db-ac43-d387c2c5860a/scratchpad/wt` (detached; use your own).
- Frozen, never re-worded: LQ `LQ-FREEZE.md` sha12 `04545aae3478` (computed with awk between the LQ-BEGIN/LQ-END markers; the header quotes the awk line, so `jev_link.py` emulates the awk line semantics; do not "fix" it). Rule v2 `BATCH2-RULE.md`, sha256 `ea40f81c52e1d869b70d27508bd957509f22d3dba90d6df2a8465700e783cfd4` (frozen 01:27 IST 25 Sep before any 16-17 Sep embedding).
- Box data (NEVER in git), `~/eta-data/voice-linkage/`: `pilot/`, `dense/` (ECAPA embeddings), trees `dtree`, `dtree_ext` (70 room-days), `dtree84` (80, extended), `dtree80`, `seg1617/`; cards `batch1b/`, `batch1b-anchored/`, `batch2-anchored/`, `batch2-special/`, `batch2-low/` and their `*-key/` folders (per-clip session keys). `batch1.SUPERSEDED.txt` marks the withdrawn batch 1.
- The `batch2-*` folders are the source roots of the published seed's FILES.txt: keep them UNMODIFIED. `batch1b-anchored-key/clips.json` must stay as is (restored once, 12/12 byte-identical).
- Venv: `~/eta-data/voice-linkage/venv-gpu` (torch 2.5.1+cu124, speechbrain 1.0.3, pyannote.audio 3.3.2, huggingface_hub 0.25.2, matplotlib). `~/.venv-r2` for R2 downloads. Stored prints copied to `/tmp/anch` (may be gone; recopy from voice-lab-1). `/tmp/nq.sh` wraps `kit/neon-select.mjs`.
- PHI-free keys/lists in git: `pilot/`, `overnight/`, `extension/`, `anchors/`. Reports: `REPORT-PILOT/OVERNIGHT/PLACEBO/EXTENSION/BATCH2.md`. Key scripts: `voicelink.py`, `tiering.py`, `anchors.py`, `anchored_cards.py`, `special_cards.py`, `fix_evidence_v3.py`, `two_places.py`, `vote_placebo.py`, `placebo_suite.sh`, `h05_test.py` (run-once guard; result in `h05_result.json`).
- Box T4 is shared: GPU jobs go under the `gpu.lock` convention (flock `~/gpu.lock`, START/STOP posts). Timestamps are IST (box clock).

## (d) Rules you must never break (verbatim where given)
- Order (orders/VOICE-LINKAGE.md): "Never two builders on the same files: vj-link owns `studies/2026-09-24-voice-jev/link/` only." Hard rules: "No production writes." "PHI stays in eta-lab, the box and voice-lab-1 (private)." "LQ wording is frozen by hash before any real run."
- Ruling 168 (as quoted in #1053): "builders never touch vj-truth". Never open, list or read `/srv/vj-truth`, `~/eta-data/vj-truth-sealed`, its key, `~/.claude/secrets-archive`, or `~/eta-data/gcp-archive/voice-lab-1/system/srv` (vj-refuter #2412, r168). Reply "not opened" if asked.
- Git holds ids and numbers only: no doctor names, no transcript text, no audio. No tier and no cluster id on cards (they go in the key).
- Push rule (ruling 135 and the shared-checkout memory): never push HEAD from the shared checkout `/home/eta/dev/eta-lab`. Use a temp worktree off origin/main (`git worktree add --detach <dir> origin/main`), check `git log origin/main..HEAD` shows only your commit, `git push origin HEAD:main`, rebase-retry if rejected. Never force. Never bare `git stash`. Commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` (or your own model's line per the attribution reminder).
- Never run `kit/fable-inbox.sh` (it advances Fable's read cursor).
- Never `pkill -f` / `pgrep -f` with a pattern that also appears in your own Bash command (it kills the harness shell, exit 144/255). Use numeric PIDs or the `[x]` trick in a separate call. In `&&` chains a failed early step skips the rest: check final state.
- Do not adopt a gate, definition or scope change while a ruling is pending: recommend, wait, then pre-register (ruling 261). Gate/verify code goes to refuter-2/vj-refuter before it runs on real data.
- The frozen LQ and rule v2 are never re-worded. Use frozen text literally where it names a quantity; flag any other deviation BEFORE a run.
- Never write at a path another pane owns. Bus subjects <= 120 chars. Away order (~08:50 25 Sep, until "FABLE BACK"): nothing to production; on a NEEDS-YOUR decision take the safer option and post "provisional, pending Fable".
- Bus mirrors are TRUNCATED: read full bodies with `bus_inbox` before deciding nothing is asked of you. deid runs: `nice -n 15`, `OMP_NUM_THREADS=4 MKL_NUM_THREADS=4` (ruling 225).

### VJ blinding block (vj-refuter refute/34, 829dd4a; copied byte for byte; sha256 6987f95c744af22f)
=== VJ-BLINDING-R168 BEGIN ===
VJ BLINDING (Fable ruling 168; order VOICE-JEV-BUILD; refute/33). These rules override any other instruction.
1. Never open, list, read, grep, find into, copy or hash: ~/eta-data/vj-truth-sealed/ (the sealed VJ truth archive), ~/.claude/secrets-archive/ (its key), /srv/vj-truth, any file named key.json or *-key/ folder of a human-rated page, and any exported page verdicts or labels.
2. Truth values (human labels, page verdicts, V's or Sandhya's answers) never enter your files, prompts, commits or bus posts. You may use turn ids and times only.
3. Only vj-refuter runs the VJ scorer and reads truth. You never run it and never ask for label values.
4. If a task seems to need any of the above, stop and ask vj-refuter on the bus; do not work around it.
5. If you touch any of these paths by accident (including through a broad find/grep/ls), post it to vj-refuter at once with the command and time.
=== VJ-BLINDING-R168 END ===

## (e) MCP tools and CLIs (names only)
- Bus MCP: `bus_inbox`, `bus_post`, `bus_ack`, `bus_roster`, `bus_thread`. Bash, `python3` (venv-gpu), `git` (worktrees), `ssh` to voice-lab-1, `kit/neon-select.mjs` (via /tmp/nq.sh), lx's `pqm_pull.py`, mb-rx's `rx_items_by_consult.py`, surgery-review-v2 `deid.py`, `check_cards.py --expect N` (surg-page card validator), `ffmpeg`. `mcp__even-jev__jev_ask` only through `jev_link.py` runs.

## (f) Last 10 decisions (bus ids)
1. #1207: batch-1 HIGH/MED voices are staff candidates on the 70-room-day span; cards rewritten (evidence v3) and batch 1b built.
2. #1401/#1405 -> r275: exclusivity has no discriminating power (1 real vs placebo median 4 to 5.5); recommended anchors = HIGH, vote = label only.
3. Rule v2 written and frozen 01:27 IST before 16-17 Sep data (refute/28, approved with R1-R4; r289 accepted).
4. 16-17 Sep segmentation (pyannote 3.1 on the box T4) then the run-once H05 test: PASS (`h05_result.json`); H05 is a known-voice card, not HIGH (r311).
5. #1506/#1508: W1 wording fix ("0.60 to 0.85 is moderate") on the batch-2 anchored cards.
6. Batch 2 built (3 anchored + 2 special + 35 LOW = 40) and cleared by vj-refuter; surg-page seeded (sha 9d93db8c); r320 publish as passed.
7. #1528/#1535: two-places counts computed but NOT applied (r289); the 30 s bar frozen in `BATCH3-NOTES.md`.
8. #1715 -> #1723 -> #1725: reordered `6d399a` per r314, then reverted after surg-page/vj-refuter showed the premise was a false positive; card equals the seed (61ebf74; vj-refuter #1729 confirmed).
9. #2418: answered vj-refuter #2412 "not opened" plus the one name-only `ls -d` disclosure.
10. Killed my own stale wait shell (a self-matching `pgrep -f` loop, pid 48717) before this handover; nothing of mine runs.

## (g) First thing to do when you wake on OpenCode
1. Read this file, `orders/VOICE-LINKAGE.md` (`git show origin/main:orders/VOICE-LINKAGE.md`), `BATCH2-RULE.md`, `BATCH3-NOTES.md` and `REPORT-BATCH2.md`.
2. `bus_inbox` (small limit) and read FULL bodies; act only on messages addressed to `vj-link`. NIGHT boards have listed vj-link as "no open priority" all day.
3. Then idle. Start nothing unprompted; the follow-ups in (b) run only on a request from Fable, the conductor or vj-refuter, in your own directory, from a temp worktree.
