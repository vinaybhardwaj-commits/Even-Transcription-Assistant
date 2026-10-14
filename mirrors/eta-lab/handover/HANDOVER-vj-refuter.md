# HANDOVER vj-refuter (Claude Code pane -> OpenCode, Fable 432), written 26 Sep 2026 ~12:05 IST


## (0) READ FIRST (added 26 Sep ~14:20, bus #3635)
- Your OpenCode config (~/oc/vj-refuter/opencode.jsonc) denies ~/.claude/* and *secrets-archive*, and the VJ seal KEY is at ~/.claude/secrets-archive/voice-lab-1/vj-truth-seal.key. So you CANNOT decrypt the seal until Fable 448's route exists: (a) ADOPTED, meaning herdr-kit builds ~/bin/vj-seal-decrypt and eta-refuter-2 reviews it; you verify the deployed sha before first use. Option (c) (Claude pane) is SUPERSEDED: no Claude Code work until Tue 18:30. VJ scoring/ingest WAITS for the wrapper; if urgent, it goes to V. Do NOT work around the deny.
- vj-data's config now HAS the vj-truth-sealed deny (herdr-kit #3641, verified #3643); and every vj-* launch needs the OPENCODE_CONFIG=~/oc/<name>/opencode.jsonc prefix (Fable 447). Re-check the VJ block + denies after each relaunch.
- 448a wrapper (installer kit/vj-seal-decrypt-apply.sh v2 @5e87c644, sha 181de4cd2c41...; supersedes 2247a7e0) is NOT installed. herdr-kit #3659 says done; vj-refuter-cc verified the 3 configs carry "*vj-seal-decrypt*". Still owed: eta-refuter-2 review + Fable GO, then YOU verify the installed sha. Conditions were (#3653): vj-data/vj-arms/vj-link bash deny "*vj-seal-decrypt*" (a relative outdir bypasses their *vj-truth-sealed* deny), and the wrapper refuses vj-* builder panes. Verify both, then the installed sha. Your model: opencode-go/deepseek-v4-pro (Fable 449).
- Arm 4 now also needs vj-arms relaunched (stopped by Fable 442).

## (a) Role
Checker (Refuter) for the VJ queue ("Voice Jev": can Jev/Gemini tell doctor vs not-doctor on doubtful turns), plus the VJ Phase L voice-linkage pages. Order: orders/VOICE-JEV-BUILD.md (freeze b961291ae64c); addenda 165 (9c335c59c5be) and 166 (87b8cdac4330); COMBINE_RULE v7 d36c9472569d (studies/2026-09-24-voice-jev/arms/COMBINE_RULE.md).
I am the ONLY pane that reads VJ truth (human labels) and the ONLY one that scores (r168, r248). I never edit builder files (vj-data, vj-arms, vj-link). The builders are on OpenCode and stay on the box (416.1). All my notes are in studies/2026-09-24-voice-jev/refute/ (00-35). Read refute/22, 33, 34 and 35 first.

## (b) Open items (bus ids, state)
1. **Arm-4 gcloud shim.** Fable 427.6 approved it. herdr-kit's shim was reviewed and PASSED at sha256 be2b6682057cf0a8912cc537a1bc05bfd692c910f42fb08e9d90468cc5c09331 (#3449; review copy ~/.gcloud-shim-DRAFT-for-review.py).
   - NEXT: V deploys it to /home/eta/bin/gcloud. You verify the deployed file: sha == be2b6682..., mode 755, owner eta.
   - Before the run, record the shim sha and the credential file's mode, mtime and sha (NEVER its contents).
   - Credential: Fable/V place a short-lived Vertex key at ~/.claude/secrets/vertex-arm4.json (600) just before the run and delete it right after DONE (#3427). Item 155 also covers the model id: it must be the '@' form "gemini-3.8-flash@<version>".
   - Run form (vj-arms): `PATH=/home/eta/bin:$PATH /usr/bin/python3 arm4_gemini.py <staged flags> --model gemini-3.8-flash@<version>`. Pre-run posts: the ls of ~/bin (the only delta is gcloud), which gcloud, the ffmpeg version (/usr/bin/ffmpeg 4.4.2; a caveat vs voice-lab-1's imageio build).
   - AFTER the run, check that ~/eta-data/vj/arms-final/out_real/arm4.jsonl has its first 1,838 rows unchanged (the whole-file sha before the run is 6989b4e7e9c8); +20 l1 rows == topup_confident_ids; prompt_sha 9d155a2ffe3c...; model == the pinned id; no error key.
   - Then re-check that the shim sha is unchanged. (#3339, #3343, #3394, #3400, #3424, #3427, #3444, #3449)
2. **eta-ci-c3 apply script 81207f53** (supersedes 36b8e7ea). It adds a ro sshfs mount ~/eta-data-ro on c3. After V runs it, repeat the box-side half AS eta-sftp and post it next to eta-refuter's real-key check:
   - Commands: `sudo -n -u eta-sftp -- ls /srv/eta-ci-c3-chroot/eta-data` (positive), a read of one group-readable file, `test -w /srv/eta-ci-c3-chroot/out`.
   - Then `ls` of each VJ dir in the jail (vj-truth-sealed(+/incoming), who-is-speaking(+-topup), doctor-voice-check, voice-linkage, voice-linkage/*-key); all must be DENIED.
   - Also the host paths /home/eta/eta-data/vj-truth-sealed, /home/eta/.claude/secrets-archive and /home/eta/.ssh: DENIED. Plus `test -w` on eta's authorized_keys and a touch in the jail's eta-data: both DENIED. /proc/mounts: eta-data ro, out rw. VJ dirs 700.
   - Last passing posts: #3319 and #3367. (#3488, #3495, #3505)
3. **Item 137, the scoring venue.** It is unruled. The default I announced: decrypt to a temp dir INSIDE ~/eta-data/vj-truth-sealed (700), score, then remove the temp dir; log each decrypt in refute/35.
4. **FINAL VJ SCORING (the main deliverable).** Truth is IN for "Who is speaking" (rater V). Runbook: refute/22 "Scoring-day runbook" + "Runbook addendum" and refute/35 (mapping rule).
   - Steps:
     - (a) decrypt the seal to temp;
     - (b) build truth_turns from the sources in priority order (v_existing, e3_recovered, vpilot_voice_verified, who_is_speaking);
     - (c) map page items to turn_ids with the PRE-REGISTERED rule in refute/35 (97 exact, 9 multi go to the SC30 id, 3 by mutual overlap >= 50%, 1 excluded: the top-up item whose sub-turn is t12cca6639e; that turn is carded but NOT scored);
     - (d) a fresh random 20% re-query of arms 2/3 over the scored doubtful turns via Jev (run_requery.sh needs VJ_REFUTER=1);
     - (e) run score.py AND refute/indep_score2.py (`indep_score2.py IN_DIR REQUERY_DIR WEIGHTS_JSON`; weights = data/role_shares_doubtful.json all_pool_doubtful); report WITH and WITHOUT vpilot_voice_verified (S9);
     - (f) post the verdict per arm.
   - Arm 4: F5 = not_run unless it passes F1-F3.
   - E3X descriptive stratum was already scored (refute/30).
   - Interim verdict (ruling 252): all arms FAIL.
5. **Doctor voice check (VJ Phase L)**: V's verdicts are not yet in (batch 1b live, 62 docs; batch 2 = 40 docs, seed 9d93db8c; passed #1704; r320 publish as passed). Scoring is pre-registered in refute/26 plus its batch-2 addendum: known-voice strata are separate; Ankit = ONE unit (g013+g077+g088); H05 is a candidate (Manoj); H04 is ordinary and a "yes" cannot make Prathik an anchor (R3). Yes-bias caveat: report the known-voice k/n next to the LOW-control "yes" rate.
6. Sandhya's "Who is speaking" labels have not been delivered yet; ingest them the same way as V's when Fable places them in incoming/.

## (c) Paths, shas, pids (no key values anywhere)
- Seal: ~/eta-data/vj-truth-sealed/ (700; mirrored ENCRYPTED to "/Volumes/Air Drive/gcp-archive/_vj-truth-sealed/", Mini-side verified #2778/#3273):
  - vj-truth-20260925.tar.gpg b4c44bbf75fce3a0... (49 files: E-3 + V-pilot truth + score/ with the scorer, inputs, interim outputs); MANIFEST.sha256 561c83506ce5bf6f...; plain_tar.sha256 01b3250aa576f222...
  - wis-labels-V-20260926.json.gpg a48c00b2a0d09ba4... (plaintext sha 45c08626bb5b2ff6...); INGEST-MANIFEST.txt 28b749f6...; incoming/ (700, empty).
  - KEY: ~/.claude/secrets-archive/voice-lab-1/vj-truth-seal.key. Box-only BY RULING (413.4a); never print it, never copy it. Decrypt with `gpg --batch --decrypt --passphrase-file <key> <file>`, streamed to a pipe or a temp dir inside the seal.
- Label ingest procedure (refute/35): verify sha, reconcile ids to the page keys (~/eta-data/who-is-speaking/key.json 90 + who-is-speaking-topup/key.json 20), gpg AES256 with the same key, round-trip check, append to INGEST-MANIFEST, rm the plaintext, ask lab-mover to mirror the .gpg, verify the Mini sha.
- Arms outputs (box): ~/eta-data/vj/arms-final/out_real/: arm1 c5c34ee02c58 (unchanged); arm2 bb7da6c4c3fc (1,787 rows); arm3 a2ace59ad657 (1,787); arm4 6989b4e7e9c8 (1,838). MANIFEST.sha256 d90692a6cd17 (the J-006 header cites "#3362"; the real PASS is #3364).
- Handoff: ~/eta-data/vj/handoff/: arm1_in 7f0af18f28b0, cards 467560040b5a, clips d95dc0b751ec, confident_labelled_ids 0b04566706f3 (42), topup_confident_ids 4403f96adc28 (20), e3x_ids 6a44bad0644a.
- voice-lab-1 is STOPPED (S6); /srv/vj-truth is gone with it at S7 (item 121: satisfied, #3141). The arm-4 original SA path is gone.
- No PIDs of mine running. Temp git worktree: /tmp/claude-1000/.../scratchpad/wt-refute (branch vj-refuter-ckpt; disposable).
- Bus: if the eta-bus MCP dies, the path still works by hand: pipe JSON-RPC (initialize, notifications/initialized, tools/call bus_inbox|bus_ack|bus_post) into ~/bin/eta-bus-mcp-tunnel.sh. kit/hsend.sh from the box reaches only box agents (not the Mini's).

## (d) Never do
- Never post label values, counts or truth content on the bus or in git (report counts only in final verdicts per the order).
- Never print, copy or move the seal key; never mirror it; never write plaintext truth outside the 700 seal dir; remove temp decrypts after use.
- Never edit builder files or another pane's directory (the only exception was r404: one dir, logged).
- Never push HEAD from the shared checkout: commit from a temp worktree off origin/main, `git log origin/main..HEAD` = only yours, pull --rebase on reject, no force.
- Never run fable-inbox.sh (it advances Fable's cursor); append to bus/for-fable.jsonl instead.
- Never restart your own pane. Never chmod data group-readable (item 110). Never accept "DENIED" results without a passing positive control first.
- In hsend, never guess a bus id: post on the bus first, then relay the real id.
- No re-tuning after results (ruling 252); pre-register any new rule BEFORE reading labels.

## (e) Last 10 decisions
1. The arm-4 shim is PASSED only with an absolute shebang (/usr/bin/python3) and a hardcoded token URI (#3444, #3449).
2. The arm-4 run uses an absolute interpreter + a command-scoped PATH, and records the ffmpeg version as a caveat.
3. The arm-4 model is pinned as the '@' form; storing the response modelVersion was dropped (it needs a code edit) (#3343).
4. The arm-4 top-up run on the box is accepted with procedural protection only (uid eta shared); mitigation = the key's lifetime + before/after sha checks (#3427).
5. J-005 PASS: vj-data's 20th top-up card (t12cca6639e) is carded, NOT scored (#3360).
6. J-006 arms 2/3 PASS: 20 + 20 new rows, the old prefix identical (#3364).
7. The page-to-turn mapping rule was pre-registered before any label was read (refute/35, 6578ee0).
8. V's WIS labels were ingested into the seal; the plaintext was removed; the mirror verified (r422; #3260, #3276).
9. eta-ci-c3 VJ denied set: box-side PASS twice (#3319, #3367); INSTALL-OK complete (#3372).
10. Item 121: voice-lab-1's S7 delete has no VJ objection (the mirror verified + the sealed copy re-checked) (#3141).

## (f) Checks I owe others
- herdr-kit/V: the deployed shim verify (item 1).
- eta-refuter/V: the box-side repeat after the 81207f53 run (item 2).
- vj-arms: the post-run arm-4 check (item 1).
- surg-page/Fable: nothing open (the batch-2 seed passed; it publishes as passed).
- Fable: item 137 (venue); the final VJ verdict once scored; the doctor-voice-check scoring when V's verdicts are exported.
