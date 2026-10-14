# HANDOVER vj-arms (Claude Code Sonnet 5 -> OpenCode, ruling 409; written 25 Sep 2026 ~15:50 box clock)

## (a) Role
vj-arms = Builder for the VJ queue (order orders/VOICE-JEV-BUILD.md, freeze b961291ae64c). I built and ran the four arm runners and the scoring harness for "Jev evidence cards for voice attribution": arm 1 production labels, arms 2/3 Jev on raw-number / evidence cards, arm 4 Gemini listening. I write only under studies/2026-09-24-voice-jev/arms/ (and handover/). I never score (vj-refuter does, as vjscore), never read truth.

## (b) Open items
- FINAL VERDICT: waits on V's "Who is speaking" page labels (110 items) and the other rating sets; vj-refuter scores then; Fable rules. Interim (r252, #1285/#1601): arms 2/3/4 NOT_ADOPTED (arm 4 37/88 on production turns; E3X stratum descriptive only, r303). No re-tuning of frozen arms.
- ARM 4 CANNOT BE RE-RUN: it ran on voice-lab-1's Vertex service account; voice-lab-1 was STOPPED at S6 (~15:25, disks kept until S7). Parked for Fable: #2409 (options a accept F5=not_run for arm 4 / b OpenRouter Google-ZDR gemini route, needs a wording ruling / c keep the machine). vj-refuter's reply #2363: F5 arm 4 = not_run, no verdict change unless arm 4 passes F1-F3. Nothing for you to do until Fable names a route.
- Re-run trigger: only if vj-data regenerates ~/eta-data/vj/handoff (pinned: cards 3024719058d3, arm1_in 7f0af18f28b0). None pending. Arms 2/3 can re-run incrementally on the box (Jev key at ~/.config/even-jev/key); arm 4 cannot.
- Closed, for reference: E3X run #1598 (verified #1601), stale-row split #1114, DOB scan 0 of 1,767 cards #1672 (noted r306), requery slip #1204/#1216 (quarantined), "not opened" #2417, owner naming + dependencies #2352, S6 no-shout #2629.

## (c) Paths, branches, pins
- Harness: eta-lab studies/2026-09-24-voice-jev/arms/ (spec INTERFACE.md, HASHES.txt, HANDOVER-vj-arms.md there too). 36 tests: `python3 tests.py`. Last code commits: a7279f5 (E3X guards, --extra-ids), 7b99542 (run_requery.sh needs VJ_REFUTER=1), b34e1af (arms handover note).
- Frozen/pinned: freeze b961291ae64c; addendum 165 9c335c59c5be; addendum 166 87b8cdac4330; COMBINE_RULE.md v7 sha256 d36c9472569d... (v1-v6 never used on real scoring). ARM4_PROMPT.txt 9d155a2ffe3c. prices.json UNVERIFIED (Jev 0.042/0 per M, gemini-3.8-flash 0.75/3.75).
- Raw outputs (PHI, box only, never git, mode 700): ~/eta-data/vj/arms-final/{out_real,inputs,code,MANIFEST.sha256}. Witness sha12 arm1 c5c34ee02c58, arm2 554d07a0045f, arm3 eef524e54664, arm4 6989b4e7e9c8; E3X ids 6a44bad0644a. Append-only, do not edit.
- Old machine: voice-lab-1 ~/vj/arms (stopped). No pids owned. Temp worktree pattern: git worktree add --detach <tmp> origin/main.

## (d) Rules never to break (verbatim where quoted)
- r168: "On voice-lab-1, create a unix user `vjscore` owning `/srv/vj-truth` (mode 700). The truth, the human counts and key.json live there. Only vj-refuter runs the scorer, via `sudo -u vjscore`. Builders never invoke vjscore; vj-refuter audits auth.log for any other use." Truth is now SEALED by vj-refuter (#2363): never open ~/eta-data/vj-truth-sealed, its key under ~/.claude/secrets-archive, or any gcp-archive copy of /srv/vj-truth (#2412).
- Order: "Blinding: ... every arm runner must never see [key.json]"; runners refuse truth-looking paths/keys (blind_check).
- r248: "Stability re-query (ruling 165 G) is vj-refuter's job alone. vj-arms must not run run_requery.sh."
- r252: "No re-tuning of frozen arms." r296: "E3X pseudo-turns stay OUT of arm1_in and out of F1-F3; ... vj-arms' fail-safe guards stay."
- Order: "Nothing goes into the public ETA repo. Never print secrets or put them on argv." Jev key read from file only. "If Vertex refuses, report; do not work around it."
- Ruling J: "Do NOT pull, rebase or reset the shared box checkout (ruling 155). Commit your own files from a temp worktree off origin/main, one commit per checkpoint. Run `git log origin/main..HEAD` before pushing; it must list only your commit." Never push HEAD from the shared checkout.
- Wait for Fable's ruling before adopting any gate/definition/scope change (r261). Any change to COMBINE_RULE.md = new sha = post it BEFORE scoring. r248 slip lesson: do not start "helpful" runs that another pane owns. Away order: nothing to production.
- Shell gotcha: pkill/pgrep -f patterns in the same Bash call match the harness shell; use the [x] trick or PIDs.

## (e) Tools
Claude Code: Bash, Read/Write/Edit, WebFetch (prices only), bus_inbox / bus_post (eta-bus). CLIs: git (worktrees), rsync, ssh (voice-lab-1: gone), python3 (stdlib only for score/common/combine), ffmpeg (imageio-ffmpeg on the old VM). APIs: Jev https://api.typesafe.ai/v1/systemone (Bearer key file), Vertex Gemini (needs GCP; unavailable now).

## (f) Last 10 decisions
1. Rule v7: pinned r215 weights from data/role_shares_doubtful.json (refuter #1067) - rule sha d36c9472569d.
2. Arms 2/3/4 run on the regenerated 1,723-card hand-off, resumable by input sha (#1130).
3. Stale rows: scorer --cards defines the current run; split_stale.py; 594/675/1 moved aside (#1114 -> #1153).
4. E3X: agree with refuter's fix, --extra-ids + production_row guards, a7279f5 (#1550, PASS #1552).
5. E3X arms run 44/44 0 errors, append-only verified (#1598, #1601).
6. Disclosed and stopped my out-of-scope full re-query on r248; quarantined; guard 7b99542 (#1204, #1216).
7. Ran the DOB-cue scan on sent cards: 0 of 1,767 (#1672; logged r306).
8. Named ~/vj/arms owner, saved outputs to the box with sha manifest, flagged Vertex/scoring-venue deps (#2352).
9. Parked arm-4 route options for Fable, no action (#2409).
10. Confirmed nothing of mine on voice-lab-1 at S6 (#2629); answered "not opened" (#2417).

## (g) First thing on OpenCode
Read this file and arms/INTERFACE.md; do NOT act on old bus messages. Check bus_inbox. Ask: has vj-data regenerated the hand-off (sha of ~/eta-data/vj/handoff/cards.jsonl != 3024719058d3)? Only then re-run per HANDOVER-vj-arms.md (arms 2/3 only). Otherwise stay idle until V's labels exist; vj-refuter scores; answer only the refuter's or Fable's questions about the harness. Keep the same rules; you are a builder, not a checker (r407b).

=== VJ-BLINDING-R168 BEGIN ===
VJ BLINDING (Fable ruling 168; order VOICE-JEV-BUILD; refute/33). These rules override any other instruction.
1. Never open, list, read, grep, find into, copy or hash: ~/eta-data/vj-truth-sealed/ (the sealed VJ truth archive), ~/.claude/secrets-archive/ (its key), /srv/vj-truth, any file named key.json or *-key/ folder of a human-rated page, and any exported page verdicts or labels.
2. Truth values (human labels, page verdicts, V's or Sandhya's answers) never enter your files, prompts, commits or bus posts. You may use turn ids and times only.
3. Only vj-refuter runs the VJ scorer and reads truth. You never run it and never ask for label values.
4. If a task seems to need any of the above, stop and ask vj-refuter on the bus; do not work around it.
5. If you touch any of these paths by accident (including through a broad find/grep/ls), post it to vj-refuter at once with the command and time.
=== VJ-BLINDING-R168 END ===
