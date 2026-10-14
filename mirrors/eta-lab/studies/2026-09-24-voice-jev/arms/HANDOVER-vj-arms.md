# vj-arms handover (25 Sep 2026, for any successor pane, e.g. after the Claude Code -> OpenCode move, r407)

## What exists
- Harness in this directory (pushed to origin/main; INTERFACE.md is the detailed spec, HASHES.txt the pinned hashes). 36 tests: `python3 tests.py`. Mock end-to-end: `BACKEND=mock ./run_fixture.sh`.
- Frozen text: freeze.txt (b961291ae64c), addendum.txt (165, 9c335c59c5be), addendum166.txt (87b8cdac4330). Combine rule COMBINE_RULE.md v7, sha256 d36c9472569d... (any edit = new hash = post it BEFORE scoring). Later rulings that shape the run: 167-170, 182, 185-188, 214/215 (weights pinned in data/role_shares_doubtful.json), 248 (stability re-query = vj-refuter only; run_requery.sh needs VJ_REFUTER=1), 252 (interim: arms 2/3/4 NOT_ADOPTED, no re-tuning), 290/296 (E3X out of arm1_in, --extra-ids).
- Real raw outputs (append-only, PHI, never git): box `~/eta-data/vj/arms-final/out_real/arm{1,2,3,4}.jsonl` (+ inputs/, code/, MANIFEST.sha256). Witness sha12: arm1 c5c34ee02c58, arm2 554d07a0045f, arm3 eef524e54664, arm4 6989b4e7e9c8; inputs = vj-data hand-off 02:42 (arm1_in 7f0af18f28b0, cards 3024719058d3, clips a19d471f565d, e3x_ids 6a44bad0644a).
- voice-lab-1 (where they were run) is being stopped in the GCP exit; the copy on the box is the record.

## How to re-run (only if vj-data regenerates the hand-off; resume is per input sha, so only changed cards/clips run)
1. Copy the new hand-off (~/eta-data/vj/handoff on the box: arm1_in.jsonl, cards.jsonl, clips.jsonl, clips/, confident_labelled_ids.txt, e3x_ids.txt) to an `inputs/` dir. Never put E3X in arm1_in (arm1.py/score.py refuse production_row=false).
2. `arm1.py --in inputs/arm1_in.jsonl --out out/real/arm1.jsonl` (it re-checks vj-data's doubtful flags against the frozen rule + best>=0.50).
3. `arm_jev.py --arm 3` and `--arm 2 --in inputs/cards.jsonl --out out/real/armN.jsonl --arm1 out/real/arm1.jsonl --confident-ids inputs/confident_labelled_ids.txt --extra-ids inputs/e3x_ids.txt`; `arm4_gemini.py --in inputs/clips.jsonl ... (same flags) --clip-dir out/real/clips --model gemini-3.8-flash`. Jev needs ~/.config/even-jev/key (mode 600, never argv); arm 4 needs Vertex (project clinical-infra) via the machine's service account (only voice-lab-1 had it: after the stop arm 4 cannot run, r252 + parked item for Fable).
4. `split_stale.py --cards inputs/cards.jsonl out/real/armN.jsonl ...` when no arm is writing; then tell vj-refuter. I never score: vj-refuter runs score.py (--cards, --role-weights, --rule-sha, --truth) as `sudo -u vjscore`; truth is sealed and I never read it (r168).

## Rules of the road
Blinding: arm runners never see truth/key.json/human counts (blind_check refuses). PHI only on the box/eta-lab (private). Commit from a temp worktree off origin/main, one commit per checkpoint, `git log origin/main..HEAD` must list only yours; never pull/reset the shared checkout. Nothing to production. Wait for Fable's ruling before adopting any definition/gate change.
