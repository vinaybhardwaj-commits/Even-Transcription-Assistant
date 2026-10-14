# HANDOVER linker (Claude Sonnet 5, box pane wP:p1) -> OpenCode successor. Written 26 Sep 2026 ~11:20 box clock (Fable 432). No PHI, no key values.

## 1. Role
Builder. Owner of CAP-1's LINK, EXTRACT and CEILING and of the CAP INPUT BUNDLE (Fable 429/430); before that 337b (English for Indic lines, done) and link 3 (built up to ruling 406a, then handed to linker-oc). Checker for my work: eta-refuter-2 (never review your own). `cap` (OpenCode on eta-ci-c3) does SCORE + REPORT from my bundle.

## 2. Open items (bus ids)
- CAP-1 report due 20:00 IST (Fable's clock, about 30 min ahead of the box). eta-refuter-2 pre-registration #3461 + #3474 BINDING (link basis on every link, used_for_link, decoys + false-yes rate, salted seed committed before sampling, raw item table JSONL).
- **Bundle v2 is out, awaiting eta-refuter-2's re-check** (#3522, #3524): ~/eta-data/cap/2026-09-25/ (dir 0750, files 0640, group eta; parent ~/eta-data/cap is 0710 traverse-only; raw/ 0700 holds PHI incl. patient-name words: never copy it). sha256 (16 hex): links ef1a1a3f72338783, items bd2fb753d493d4ac, consult_transcripts 78c6e0987a23238b, gaps fb4156a723533a88, link_thresholds 94355f871f03f226, README 0e0fc1716dffb087; MANIFEST.sha256 lists them. 183 consult tokens; 27 linked (confirmed 16, probable 11); wrong-time control false-link 4.2%, false-confirmed 0.9%; expected false links any 7.6, confirmed 1.6. cap must score fixtures only until eta-refuter-2 passes v2.
- **Bundle v3 owed after V re-runs `bash ~/run-337b-v5.sh 12`** (337b English for 25 Sep: only 138 of 1,203 Indic segments translated; 133 of 140 in the linked consults have none). Rebuild (from branch linker/cap-1): `cd studies/2026-09-26-clinical-capture; nice -n 10 python3 cap_link.py; nice -n 10 python3 cap_bundle.py` (cap_extract.py only if the prescription pulls change; pulls live in ~/eta-data/cap/raw/). Post new hashes + the new control result, say v3 supersedes v2.
- **Ceiling (not run):** needs cap's ABSENT item-id list sha, defined as sha256(json.dumps(sorted(set(ids)))). Steps: `cap_ceiling.py commit --list-sha S --salt-file F` -> post the commit BEFORE drawing -> `draw` (targets only from CONFIRMED links; only 16 confirmed consults in v2, so the sample will be < 60: state n) -> eta-refuter-2 checks draw.json + salt reveal -> V runs `run` from a TERMINAL (patient audio leaves the box; the Claude/pane guard blocks it) -> `score`. Route undecided: OpenRouter google/gemini-3.8-flash needs balance >= $0.50 for audio (HTTP 402 seen with an invented clip) or a Vertex wrapper on the Air (herdr-kit); `--route cmd:<wrapper>` plugs one in. Audio is rebuilt locally from the box tape (~/eta-data/tapes/manifest.jsonl) with the pinned cut_window.py (sha256 prefix 0fb0eed981de2a48) + full_audio.py (cf06ca69f8075e60).
- eta-refuter-2 #3506 (ceiling script FAIL) items 1-4 are fixed in c36a725 but NOT re-checked yet.
- CAP-2 design is drafted (CAP-1-DESIGN.md D6), NOT built; wait for Fable's ruling on CAP-1.
- Link 3: delivered by linker-oc (s27 15d84fd, refuter-2 PASS #2893); T9a/T9b held pending Fable's disclosure ruling. My notes for linker-oc are in ~/linker-oc/*.md. Nothing owed by me except answering linker-oc.
- 337b: complete except windows indexed after the last pass (25/26 Sep). Script translate_segments.py v5 = commit ec148ec (worktree /home/eta/dev/eta-lab-337b, detached at main); V runs it from a terminal: `bash ~/run-337b-v5.sh 12` (stops a running pass after asking, refuses if the script differs from ec148ec, re-runs the invented-line preflight, starts --workers 12). My own pane cannot send patient text out (the pane classifier denies it): do not try to work around it.

## 3. In-flight state
- Branch **linker/cap-1** (origin) = c36a725: studies/2026-09-26-clinical-capture/{cap_extract,cap_link,cap_bundle,cap_ceiling,cap_link_variants}.py + CAP-1-DESIGN.md (D1-D7). Local worktree /tmp/cap (detached branch checkout, safe to delete). NOTHING of CAP-1 is on main: push to main only after eta-refuter-2's PASS names the sha; push branch-first otherwise.
- No process of mine is running. Temp files: /tmp/hoff (this handover's worktree), ~/linker-tools/busctl.py (manual bus client, see 5).
- Data pulls (PHI, 0600, ~/eta-data/cap/raw/): dpipe_main, dpipe children (medicines/diagnosis/further_investigation/referral/plan_of_management), drug_master, hub_history (unused), dpipe_names (patient names, used only for linking), link_terms.json (terms that made each link). Read-only Metabase via studies/2026-09-24-surgery-30/mb.py (key never printed).
- The T9/link-3 files under ~/eta-data/surgical-chain/p1/ and my reader files ~/eta-data/linker-read/ (private) stay as they are.

## 4. Never do
- No PHI, patient names, item text tied to a patient, or key values on the bus, in git, or in a post. Bus posts: counts and hashes.
- Prescription content is used ONLY to score: never in a transcript, prompt, correction or glossary for 25-26 Sep (CAP hard rule).
- Never bind a room to a doctor; never open ~/eta-data/surgical-chain/p1/link3_key.json; no writes to Pulse/Metabase.
- No script that touches real text runs before eta-refuter-2 reviews it (ruling 297a). A script commit re-binds a preflight.
- Do not send patient text or audio to any outside service from a pane; V or Fable runs such steps from a terminal after review.
- Do not chmod ~/eta-data/cap or its files beyond Fable's named exception (bundle dir 0750/0640 group eta; cap/ 0710). Never copy keys; no writes to authorized_keys, ssh config, known_hosts, cron/launchd/systemd or secrets.
- Commit via a temp worktree off origin/main, `git worktree prune` first, verify push exit status (`if git push ...; then`), never force-push, never `pkill -f`. Bus subjects <= 120 characters.

## 5. Tools
- Bus MCP was dead in my session since 16:13 on 25 Sep: ~/linker-tools/busctl.py works over ~/bin/eta-bus-mcp-tunnel.sh (`busctl.py inbox 20 --all`, `busctl.py post "to1,to2" "subject" body-file [reply_to]`); hsend (`bash ~/dev/eta-lab/hsend.sh "msg" agent...`) reaches box panes and the conductor; Mini agents come back unknown-agent, relay via the conductor.
- Memory notes in /home/eta/.claude/projects/-home-eta-dev-eta-lab/memory/ (index MEMORY.md; project_cap-1-clinical-capture.md).

## 6. My last 10 decisions
1. Linked consults by TIME (PQM called_at/completed_at, merged per token) + CONTENT ladder TC (complaint + patient-name words, non-scored) / TCD / TCDM, basis recorded on every link.
2. Calibrated the thresholds through decide() on a wrong-time control (shifts -150/-90/+90/+150 min): false-link <= 5%, false-confirmed <= 1%; reported expected false links.
3. Added patient-name words to TC on the control only (27 links vs 21); kept history/examination text OFF (no gain); kept METRIC = matched idf fraction.
4. used_for_link = any item hitting the term set that made the link.
5. Put nothing of CAP on main; branch linker/cap-1 only.
6. Set ~/eta-data/cap to 0710 (it was 0750 before #3475 asked me not to touch it; disclosed).
7. Ceiling: decoys matched by class and frequency, salted seed commit, targets from CONFIRMED links only, harness pins, MANIFEST sha bound to the draw.
8. Wrote the 337b `--workers` change (A4/v5 ec148ec, refuter-2 PASS #2281) and V's restart script; refused to work around the pane guard.
9. Took the second name-leak read for T9 (pin dda4b11c..., gate PASS) and left the class join to linker-oc + refuter-2.
10. Handed link 3 to linker-oc with a file handover (~/linker-oc/HANDOVER-from-linker.md).

## 7. Checks I owe others
- eta-refuter-2: nothing outstanding except answering re-checks of bundle v2/v3 and c36a725.
- cap: post bundle v3 + hashes when the English exists; answer its questions on the bundle schema (README.md in the bundle dir).
- Fable/V: the 337b re-run and the ceiling audio route are their decisions (DIGEST items 157, 161).
