# HANDOVER eta-refuter (Claude Code pane on the Mini, w2:p1 -> OpenCode deepseek-v4-pro, Fable 432) — written 26 Sep 2026 ~12:00 IST

## (a) Role
Independent checker (Refuter). I refute branches, apply scripts, studies and installs, then post verdicts on eta-bus (subject 120 chars or fewer). I append ONE ledger line per finding to ledger/ETA-FINDINGS-LEDGER.md. I never make design rulings: forks go to Fable via conductor.
Scope under r416.3: PARITY-389 (harness, capture runner, run result), the r414 gate + rate/label scorers, and the tag:hf / eta-ci-c3 / hf-2 installs Fable assigns. refuter-2 owns tunnels, the fleet, the hist-bulk c3 helper and page reviews; refuter-3 owns r416-new work. vj-refuter owns the VJ side.
Method: positive control first (a DENIED means nothing until the same path lets the right thing through). A mutation kill needs a failed assertion on code that still parses. Re-derive every premise myself (#3311 lesson). Trace which mode or arguments a command actually takes before listing a read as live (#3437 lesson). Truncated output is not evidence of absence (#3487 lesson).

## (b) Open items (bus ids, state)
1. V to apply three PASSED identity/mount scripts, each dry-run first with its sha pinned in his command:
   - kit/eta-ci-c3-apply.sh 81207f53dfaaa954 (#3496; supersedes 36b8e7ea, which V must NOT run);
   - kit/taghf-apply.sh eec46921f65e580e (#3490);
   - kit/hf2-gateway-apply.sh f51e9f30225d0e1b (#3490; my 78564ee8 PASS is void).
   Each puts the herdr machine ID into the Mini key line. The plain names eta-ci-c3/hf-1/hf-2 do not resolve in `herdr --machine`; ids: c3 85baa2e0..., hf-1 7a85bf5a..., hf-2 04f2e179... (#3472, #3484, #3487).
   AFTER THE APPLY run my prepared checks (section c). Then herdr-kit deletes the two restored .pub files from the Mini.
2. cap per-pane check (Fable 430(1)): after herdr-kit posts READY eta-ci-c3 w1:p1: bus name resolves to agent cap on machine eta-ci-c3; reads inputs through the jail; writes to out. Print counts and modes only: cap handles transcript text (PHI).
3. Item 110 / 158 fork for Fable (#3475): box eta-data/cap is 700, so 430's 0750 cap/2026-09-25 is unreachable to the jail. Smallest fix is cap/ 0710. linker is holding. When ruled, flip the cap/2026-09-25 line in my check script to expect OPEN.
4. hf-2 secret: Fable must NOT set it until herdr-kit's per-Space start.sh fingerprint fix is committed byte-identical to both Space repos and I have checked it (#3416, #3429). Current start.sh 337508c2 hardcodes hf-1's fp hCemxk8M... and deletes any other key. The fix must fail closed on an unknown SPACE_ID, and hf-2's arm must equal the fp I read myself from hf2_gateway_key.pub on the box.
5. hf-1 spoof positive (owed since Fable 425): after V re-runs taghf eec46921 and an agent is spawned in hf-1's pane: it resolves to its own name; a non-allowlisted pane id is refused; hf-1's key cannot claim hf-2.
6. PARITY-389 tonight: at fleet's GO (~21:15-21:30) re-hash the SIX (section c) and post the match. fleet re-hashes at GO and the launcher re-hashes just before the driver (#3452). Hard stop 27 Sep 07:25-07:30, cap $10. Then read the run report by my rule: golden_pin_overridden=false, golden d7964897, exit 0/1 = a result, exit 4/5 = incomplete, the 3 windows with covered_fraction < 0.5 reported separately.
   Box shared checkout ~/dev/eta-lab is FROZEN until 07:30 (#3432). Capture reads only node_route.py from it (#3437).
7. tape_pull pin: a branch task for lab-mover, refuter-2 reviews, before any re-ship. It needs a 16-char constant, both imports, a FAKE_R2-unset selftest. a497ab6 (13-char pin) FAILED and was reverted by 9f4ac02 (#3446, #3453, #3454).
8. hist-bulk c3 smoke result: #3409 routed it to me. The record shows stack sha 98db38bb per refuter-2 #3425. Not yet checked by me: run dir ~/eta-data/hist/runs/hist-bulk-20260926T1000-54e5708 on the box.
9. label200 DONE export: when V finishes, check with rate_seed --require-doc (rate_seed 42bd074d), recompute the partition and the subset-vs-surrogate check, then split-speaker scores.
10. With Fable, still open: #2502 address question; batch 2's fourth rating set; item 118 (air's unrestricted Mini key); allowlist ownership; occupancy labels.

## (c) Paths, shas, pids
- NO processes left running. The Monitor on run_capture ended on RESTORED.
- Prepared scripts (session scratchpad, will not survive; the logic is below if lost):
  - parity_go_recheck.sh: ssh e2e-lab, sha256 | cut -c1-16 for the SIX:
    ~/eta-data/hf-parity-389/capture/run_capture.py 9d5e421063e2331f; capture_driver.sh eb511d8e; whisper_bridge.ts 9265c7a6; package.json 3b9a5cf9;
    ~/eta-data/hf-parity-389/io/.window-audio/manifest.json 3f4a9ac7aa9b0b3d; ~/dev/eta-lab/studies/2026-09-24-hist-mining/harness/node_route.py cf4bc5cae187392a.
    vite.config.mjs is NOT in the set (the driver writes the payload copy from its own heredoc). Compare equal-length strings.
  - c3_postapply_checks.sh:
    (1) Mini authorized_keys: one c3 line with HERDR_MACHINE=85baa2e0..., none with =eta-ci-c3;
    (2) `herdr --machine 85baa2e0f8428b0b03a3e8606f826e43 agent list` shows cap at w1:p1;
    (3) from e2e-ci: ~/eta-data-ro findmnt fuse.sshfs, ro yes, no allow_other; POSITIVE ls count and a 1-byte read of one readable file (never printed); DENIED ls of vj-truth-sealed, vj-truth-sealed/incoming, who-is-speaking, who-is-speaking-topup, doctor-voice-check, voice-linkage, voice-linkage/batch2-special-key, cap, cap/2026-09-25; `touch` into the mount refused (vj-refuter #3495).
- Hosts: box = ssh e2e-lab; eta-ci-c3 = ssh e2e-ci (herdr id 85baa2e0...). Jail alias on c3: box-sftp (eta-sftp, chroot /srv/eta-ci-c3-chroot, eta-data bound ro, out rw).
- Frozen gate: studies/2026-09-25-jev414/gate/score_gate.py @065c1e9 (4a4b50f1b673c6bb); FREEZE.md on branch eta-refuter/calib30-gate @0fd4d3f. calib30 gate = FAIL (scored).
- Keys and fingerprints (public): eta-ci-c3 bus FdwDbP30, sftp 5gOzTxlq; hf-1 gateway hCemxk8M...; box host key UT2pDhdsS4ku..., Mini host key GlguKjyKTxK4....

## (d) Rules I must never break
- Never print transcript text, note text, patient or doctor labels: counts, ids, timings only. Paid ZDR models may see PHI (r409); printing it is still banned.
- Never read .env*; never print, grep or cat a secret (ruling 233). HF token only via a 0600 header file on the box (the token lives on the box, not the Mini). The Cloudflare token is loaded in-process only. Never cat ~/.claude/settings.json.
- No IP addresses and no key/output file PATHS in bus posts (Fable 425/426); name hosts and ports. Fingerprints are fine.
- Never write authorized_keys, ssh config, known_hosts, cron/launchd/systemd units or secrets; never copy keys. Those are V-run scripts I check first (Fable 432 SECURITY-RULES).
- Never edit, stage or run other panes' files or installed kits. Report; the owner fixes (#3446 lesson: no in-place fixes).
- Never touch the ETA repo's main. Ledger pushes only from a detached worktree at origin/main: check the line isn't on origin, cat >>, commit with the co-author trailer, origin/main..HEAD = 1, push HEAD:main (3 retries with fetch+rebase), confirm the line is on origin exactly once.
- No Docker on the Mini; full vitest only via yoga-test.sh. The Mini's live STT gets no extra load during clinic hours (Fable 423).
- Never SendMessage pane-to-pane: eta-bus, or kit/hsend.sh "<msg>" <agent> and check scratch/hsend.log.
- Checkers stay a different model family from the builders they check.

## (e) Tools
eta-bus MCP (bus_post, bus_inbox, bus_thread, bus_roster); ssh e2e-lab / e2e-ci; herdr (machine list, --machine <id> agent list); kit/hsend.sh; git worktrees for ledger pushes.

## (f) Last 10 decisions (bus ids)
1. #3416 hf2-gateway 78564ee8 PASS with a HOLD on the secret step (start.sh pins hf-1's fp); now void, re-passed as f51e9f30 (#3490).
2. #3422 merge b8a590b does not touch PARITY-389; flagged node_route.py pin and the stale stack draft.
3. #3431 then #3437: a 4-file checkout-read list, CORRECTED to node_route only (ship-mode vs capture).
4. #3443 GO set = six hashes (package.json in, vite.config out).
5. #3446 installed run_capture edited in place (13-char pin can never match); #3453 same defect on main a497ab6; restored and reverted, closed #3456.
6. #3464 fleet's 15-char hash typo; GO hashes must be copied from a live sha256sum.
7. #3472 root cause: herdr knows no machine by name; ids only.
8. #3475 c3 ~/eta-data-ro not mounted; cap/ 700 blocks 430's 0750 exception (a fork for Fable).
9. #3486 then #3496 eta-ci-c3-apply 36b8e7ea then 81207f53 PASS; #3490 taghf eec46921 + hf2 f51e9f30 PASS.
10. #3487 CORRECTION: hf-1/hf-2 ARE herdr machines (my list was truncated).

## (g) First thing when you wake on OpenCode
1. bus_inbox. Read the ledger tail (ledger/ETA-FINDINGS-LEDGER.md) for my last lines.
2. Check whether V applied the three scripts (the Mini authorized_keys HERDR_MACHINE values). If yes, run the c3 post-apply checks from section (c) and post.
3. Watch for READY eta-ci-c3 w1:p1 (cap check) and fleet's GO (the six-hash recheck).
