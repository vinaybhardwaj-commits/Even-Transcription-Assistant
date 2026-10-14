# ETA LAB — MASTER ROADMAP

Written by the `roadmap` pane (records keeper). This is the one document any orchestrator reads to know where every project stands. Plain words: V is a doctor, not a programmer. Counts and ids only — no patient text anywhere in this file.

Last revision: **26 Sep 2026, ~21:50 IST** (rev 13).

## Changes since last revision

Rev 13 (vs rev 12; Fable pushed rev 12 as 6f495d77):
- LABVIEW: rating hub /rate LIVE (main 974b347a, eta-refuter-2 PASS #3910/#3911); lists what the viewer serves today (label200, rate20, ba106, calib30). Speaker-count, Doctor Voice Check and surgery v4 are not viewer sets, so the hub cannot list them yet (lab-viewer's question, #3909). CAP-1 items beside consults: blocked until cap's scored_items path arrived (#3925, c3 host); lab-viewer must get the file across.
- SELFTEST: diag-rig on main 8ae0e169 (byte-identical to the PASSed b542d96c, #3918); ElevenLabs change PASS and merged as main 5ba0ca1e; FIRST ElevenLabs voices synthesised: 8 stimuli, 1,068 of the 60,000-character cap (#3920/#3921). Google credential check was blocked by the pane classifier; ElevenLabs path used instead.
- NOTESAFE: provider-text error fix PASS — branch notesafe/provider-text 6448ab1 (on the D4 train 5907cbc; two required fixes closed, eta-refuter #3916/#3922). It ships in the release AFTER D4, never inside D4. Bench design (b) posted (#3912).
- PRESCRIBE: Pulse prescription extract built: 200,098 lines, sha256 cd012fae..., 91 days 26 Jun-24 Sep, 25+26 Sep excluded, 121 doctors, 30 specialties (linker #3914, independently verified by eta-refuter-2 #3915). Script 08cd6a18 PASS #3908. cap pulls it via the read-only jail once Fable OKs the dir/file permissions (#3905/#3926); cap will post the pre-registration sha before any hinted run (#3927).
- ROOMS: Dietary is NOT faulty — the Mac was switched off by V (minibot #3895: last heartbeat 17:25 IST today, session closed normally). D-8 part (b) closes. PARITY-389 gate NOT MET at 21:40: 7 rooms still recording (ORB3 records to 02:00); the six hashes match 6/6; fleet polls to 22:15 (#3924).
- SPLIT: 337e needed no new build — all 1,342 T4 windows were already labelled (231 speaker docs in the vault); phase-2 plan posted as 17083856 (#3896).
- CLARITY: stt-bench blocked at step 1 — label200 files are unreadable from its pane (EACCES on ~/eta-data-ro, #3899). Needs Fable or V for read access or a copy.

Rev 12 (vs rev 11):
- **WAVE 27 (W27, ~20:10 IST): agents now run on Claude Code on V's personal Max ("Pool C"); OpenCode pools A/B are small top-ups only.** Panes report "back on CC-personal": lab-mover, fleet, eta-refuter, eta-refuter-2, vj-refuter, cap, scribe, lab-viewer, diar-lab, minibot. New CC panes: linker (W27.2), split (W27.6), notesafe (W27.7), stt-bench (W27.3), roadmap (W27.9). PHI is allowed in these panes; free models stay NO-PHI (#3837-#3853, #3876-#3886; order file W27).
- PRESCRIBE: CAP-1 FINAL report 957f93c4 (#3855). Ceiling on 60 drawn ABSENT items: said-on-audio 6/60 = 10.0% (95% CI ~3.8-20.5%); decoys 1/60 = 1.7%; McNemar p=0.125, not significant. Reading: ~90% of drawn ABSENT items are also absent on raw audio, so most look truly unspoken; 10% is a LOWER bound on said-but-missed (no positive control). Headline unchanged: 50/169 captured (29.6%), drug 9.4%. Draw gate PASS (#3843), score check PASS (#3849). CAP-2 vocabularies opened (W27.1/W27.2): linker extracts Pulse prescription history since 26 Jun (excluding 25+26 Sep) for cap; vocab 28 Sep, before/after 29 Sep.
- LABVIEW: /roadmap page LIVE (version 0ea4917a, main 79fd7af9; unauthenticated request gets the Access login redirect, #3860). Speaker chips LIVE (Fable's deploy e07cff51, main 207821ba; refuter-2 FAIL #3865 then PASS 5213ea3e #3872). Next: CAP-1 items beside each consult, one rating hub page (W27.4).
- SELFTEST: diag-rig (kit/diag-rig, digital path only) PASS at b542d96c (#3877) after an initial FAIL (4 blocking, #3861) and three fix rounds; 23 tests; nothing has run on the Mini. Next: merge to main, first Google-TTS voice set, first digital report Mon 28 Sep, first nightly Wed 30 Sep 23:30 (W27.5).
- RECORDER: 0.1.25 plan pushed (a5009c4, later d7949f5); scribe retracted the "DEVICE_MISSING can never fire" finding (#3862; it does fire, so no code needed). Room-schedule code 93a1f17 built, NOT yet checked (#3879).
- SHIP: D4 runbook 4a2650c. New timings: D4 deploy + smoke end 07:45; Home Office pre-check + SELFTEST 07:45-08:15; nothing on the Mini queue after 08:15. Risk: PARITY's hard stop (07:25-07:30) leaves D4 only ~15-20 min (#3879).
- ROOMS: 7-day schedule adopted. Clinic 08:30-20:30 every day; fleet-watch config changed, code default still Mon-Sat (needs branch + PASS); ORB3 06:00-02:00 not modelled (#3868). OPD 4 still has no mic listed (physical, #3862). Dietary silent since 24 Sep 17:39 -> minibot diagnosing (W27.8).
- FOUNDRY: 9 PHI panes moved to Pool B Go, zero sessions on Zen (464, #3832); non-Go fallback sweep clean, 18 configs + 3 scripts repointed (466, #3836); T4 vLLM + Mini llama.cpp LIVE (460 report #3824, agent-side gate blocked on config weight); 455.A waste-guards integrated 7adb16a3 PASS (#3830).
- BACKFILL: c13 and gpu-5 final drain gate-1 PASS (#3859); eta-lab-l4 not swept (GPU stockout, still stopped, nothing billing). PARITY-389 launch readiness re-issued, 6/6 hashes MATCH (#3795).
- SPLIT: T4 337e run done (1,342 windows); label building moves from diar-lab to the new `split` pane (W27.6).
- VOICEPRINT: vj-refuter ruling recorded — arm 4 waits for V's gcloud shim (no fallback scoring); item 137 venue approved (#3845).

Rev 11 (vs rev 10):
- PRESCRIBE: CAP-1 SCORE COMPLETE — 169 scored items / 24 linked consults: CAPTURED 29.6%, ABSENT 55.6%, LOST-IN-TRANSLATION 0; weak class = drug 9.4% (3/32). Scorer efcc9c9 byte-identical on reruns, thresholds frozen. Ceiling chain running: ABSENT sha d5dbd361 → linker commit → draw 15 → refuter-2 gate → V. Report file 20:00 (#3783/#3784).
- LABVIEW: /roadmap page BUILT + PASS (ede99072) — renders docs/ROADMAP.md + DECISIONS.md; escape-first renderer, behind verifyAccess; holding for Fable's deploy word (#3776/#3781).
- FOUNDRY: FABLE 460 GO — local-model rollout (T4 vLLM Qwen2.5-7B-AWQ + Mini llama.cpp Qwen2.5-Coder-14B), four panes visible (t4-serve/mini-serve/t4-local/mini-coder), ETA ~40 min (#3780/#3787).
- FOUNDRY: 459.5 numbering collision confirmed 3-fold (D4 / PARITY / roadmap-page all stamped 459.5 by Fable's own orders); the CAP chain rides 459.1 — Fable/ledger renames (#3779/#3782).

Rev 10 (vs rev 9):
- FOUNDRY: c3/437 checker work COMPLETE both halves — vj-refuter box-side PASS (VJ denied set 7/7 denied, mounts ro, name-blinding holds) + eta-refuter c3-side (#3768/#3695).
- BACKFILL: PARITY-389 READY — fleet launches 21:15-21:30 box IST from the box driver; six pre-hashes 6/6 MATCH; binding re-hash at gate (any diff = NO LAUNCH); smoke ONE window first; hard stop 07:25-30 by PID; cap verdict = herdr-kit's (#3770).
- PRESCRIBE: cap ONLINE on c3 — v3 MANIFEST verify + scorer build started, 20:00 report path live (#3766).
- SHIP: D4 delta PASS on the SELFTEST pre-check; FLAG — the SELFTEST stimulus run owes its OWN refuter pass before running on the production Mini. Numbering settled: 459.5 = D4 runbook only; the CAP chain rides a different 459.x (#3767/#3769).

Rev 9 (vs rev 8):
- ROOMS: FABLE 453.0 EXECUTED — minibot restarted the OPD 4 engine 16:10 (ENCODER_STALLED + NOT_DELIVERING cleared); the C270 did NOT re-enumerate so start_day was correctly withheld; tape frozen since 10:59 (~6 h loss). end_day + hands-on-site mic = Fable/V (#3748/#3761).
- FOUNDRY: routing LIVE (FABLE 458) — yoga-free pane open on UbuntuYoga (big-pickle default, muse-spark fallback); Pool B Go live on the Mini (herdr-kit glm-5.3-flash + roadmap deepseek-v4-pro on the personal-account key); minibot gated to 30-min change-gated checks. UbuntuYoga reclassified CLEAN (V's correction). herdr-kit 455.A waste-guards BUILT @ dec41ca4 (watchdog/budget/loop-gate/reaper/usage/alert) — eta-refuter gate owed. T4 vLLM: nothing installed yet; plan = Qwen2.5-7B-Instruct-AWQ (~28 min once go) (#3740/#3743/#3745/#3751/#3752).
- PRESCRIBE: 459.5 report inputs delivered to cap (bundle v3 verified on disk; held-out +120 any-link 7.4% ABOVE the 5% target — must be called out); cap scoring v3 now, report due 20:00 (#3754/#3758/#3759).
- SHIP: D4 runbook FINAL + eta-refuter PASS (#3598 deploy+rollback) — 5907cbc ships Sunday 27 Sep 07:00-07:30 after PARITY's hard stop; Home Office SELFTEST pre-check added (#3762/#3763).
- BACKFILL/VOICEPRINT: 19:30 seal mirror = 4 sealed blobs (vj-refuter #3757); c13 gate-1 ruling DEFERRED on coverage (#3753/#3757/#3760).

Rev 8 (vs rev 7):
- ROOMS: FABLE 453.0 ruled OPD 4 RESTART (~15:45); relayed to minibot but no executor action ~20 min — escalated URGENT to Fable; minibot is the only Mini write-scope holder in the record (#3722/#3723/#3726/#3727).
- FOUNDRY: nophi-run account STOPPED per D.5 — free model refused on both paths ("free tier only from within OpenCode"), paid refused (insufficient funds); V's call whether it gets a device-login or is dropped (#3721).
- FOUNDRY: local-model plan handed to herdr-kit (Ollama on Mini/box T4 as OpenCode provider for loops/pollers; benchmark 5 tasks vs Go flash, eta-refuter checks) (#3721).
- FOUNDRY: 3rd free-model fire — big-pickle on `mini:dir:eta-lab`, 2nd Mini dir, both with Fable for attribution (#3725).
- BACKFILL: lab-mover relaunched clean (0aa69515) — six PARITY-389 hashes re-verified, tape pull/push cron healthy, box free 204G; c13 gate-1 gap posted for Fable (accept vs short-restart) (#3729/#3731).
- VOICEPRINT: tonight's 19:30 seal mirror question — a 4th sealed blob (wis-labels-V-20260926.json.gpg) is present; include it or strictly the 3 vj-refuter approved (#3730/#3731).

Rev 7 (vs rev 6):
- FOUNDRY: Zen meter bin moved to bd4c2e6 LIVE (#3712) — display nit fixed, ledger deployed.
- FOUNDRY: 452 bus channel confirmed — `fable` recipient resolves (stored_poll, #3711); the bus-server restart dependency is cleared.
- LABVIEW: 451 thread CLOSED — Zaki's successful login verified (#3716); the two email-list shas (AE6/R3) stay UNVERIFIED by design (entry string off-bus per Fable's 451 rule).
- FOUNDRY: FREE MODEL SEEN 2nd fire — big-pickle on `mini:dir:nophi-run`, first Mini-directory fire, escalated to Fable (#3719/#3720).
- FOUNDRY: FABLE 453a usage table posted; 453.B governance adopted (change-gated waves, id-paged bus reads) (#3716/#3717).

Rev 6 (vs rev 5): fleet-watch Go route PASS (#3710).
Rev 5 (vs rev 4): 451 spot-check PASS (#3703).
Rev 4 (vs rev 3): vj-seal-decrypt v3 PASS (#3697); zen meter bd4c2e6 ack (#3699).

Rev 3 (vs rev 2):
- Corrected the SHIP exit test — checkers no longer run on Claude "Opus"; per r449 the checker model is opencode-go/deepseek-v4-pro, with kimi-k3 reserved for Fable + PHI/security/production-deploy checks.
- FABLE 437 logged: V ran the three apply scripts (c3 81207f53 18/0, taghf eec46921 15/0, hf2 f51e9f30 11/0) — cap identity + eta-ci-c3 READY now checked by eta-refuter.
- RECORDER: version facts sharpened — macOS 0.1.24 (build c4a0289) on all 10 rooms, Linux 0.1.22.2 on ORB3; recorder releases ride their own branch `vinay/rr-*`, never the app branch.
- Fleet's tag map adopted ([ROOMS]/[FOUNDRY]/[SELFTEST]); fleet-watch's dead-room self-check is counted as built, not to-be.

Rev 2 (vs rev 1): RECORDER 0.1.25 queue (5 defects); Home Office = production Mini (D6); box-memory 442; go-switch `-s` blocker; vj-seal-decrypt v2 FAIL; 337b done.

---

## How to read this file

- **Project** = one of the 16 named programmes below.
- **Status** = on track / at risk / blocked / just started / paused.
- **% done** = my estimate against the project's exit test, not against a plan.
- **DONE / NOW / NEXT** = the latest facts, dated. Bus ids in `#…`, rulings as `r…`.
- Every statement comes from the bus, `orders/RULINGS-*.md`, `board/`, `handover/`, or `git log`. Anything I could not verify is marked **UNVERIFIED**.

---

## The 16 projects at a glance

| # | Project | Status | % done | One-line state |
|---|---|---|---|---|
| 1 | CLARITY | at risk | 75% | transcripts built; per-language STT bench being designed (stt-bench); V's 200-row rating unblocks the final gate |
| 2 | PRESCRIBE | at risk | 70% | CAP-1 FINAL (957f93c4; drug 9.4% weak; ceiling 10% lower bound); CAP-2 vocab started |
| 3 | BACKFILL | on track | 85% | archive transcribed; PARITY-389 READY (six hashes 6/6), launch 21:15 |
| 4 | ROOMS | at risk | 80% | 8 rooms; OPD 4 stall cleared but mic still missing (physical); auto-start manual |
| 5 | SPLIT | on track | 70% | 337e T4 run done, labels for 1,342 new windows next; phase-2 plan due |
| 6 | VOICEPRINT | blocked | 60% | truth sealed; arm 4 waits on V's Vertex credential + scoring venue ruling |
| 7 | ENCOUNTER | blocked | 50% | J-001/J-002/J-004 done; J-003 held on doctor-to-room mapping |
| 8 | SURGERY | paused | 70% | v5 frozen; 84 legacy de-id files await Fable's order; Link-3 sealed |
| 9 | NOTESAFE | on track | 50% | error-message fix PASS (6448ab1), ships after D4; bench design posted |
| 10 | TONE | paused | 90% | emotion study closed; service runs in background when enabled |
| 11 | SELFTEST | on track | 50% | diag-rig on main (5ba0ca1e); first ElevenLabs voices made; first digital report 28 Sep |
| 12 | LABVIEW | on track | 92% | /roadmap, speaker chips, rating hub /rate all LIVE; CAP items beside consults next |
| 13 | FOUNDRY | on track | 78% | Pool C wave 27 (Claude Code on personal Max); 460 servers live; S7 delete pending |
| 14 | SHIP | on track | 90% | D4 runbook 4a2650c; 5907cbc ships Sunday 07:00-07:45 after PARITY stop |
| 15 | RECORDER | just started | 20% | 0.1.25 plan a5009c4/d7949f5 pushed; hours + auto-start need V |
| 16 | ORBOX | just started | 5% | new: OT recorder upgrade for robotic surgery; owner + hardware to decide |

---

# 1. CLARITY — readable, accurate consult transcripts

- **Purpose:** turn raw mixed-language clinic audio into complete, human-readable transcripts, with English under each native line, correct speakers, and garbled lines hidden behind a precision floor.
- **Exit test:** 80% of V's sample reads acceptably; 85% PRESCRIBE capture (a prescription item said in the room appears in the transcript).
- **Status:** at risk. **% done:** 75%.
- **Owners:** lab-viewer (viewer + rating UI), linker (337b English translation), split (337e speaker labels, was diar-lab), stt-bench (per-language engine bench, new W27.3), split-speaker (337c/d metrics), Fable (rulings). Harness now Claude Code on personal Max (see SESSIONS).
- **DONE:**
  - r337 (25 Sep 07:45): declared the top programme.
  - 337a Consult View live; 337b Gemini 3.8 Flash translation of 2,611 windows; 337c 5,130 flagged segments re-transcribed; 337d English-hallucination guard drops 0 of 30 real windows; 337e speaker labels across all 4,167 vault windows (r418).
  - label200 (r414/421a/421c): 200-row sample frozen; calib30 FAILED (63.4% vs 86.7%) so V rates all 200 himself.
  - 427L label200 repair: PASSed by eta-refuter-2 (d5e82fe), merged 1e1a8518, deployed v6713bbe8 (FABLE 450). R5 after-deploy confirmed (16 rows, sha 93fdea08). Language display live. **V can rate now at /rate/label200.**
- **NOW:** V to rate the 200 label200 rows (readability). That single task unblocks the precision floor and the CLARITY exit test.
- **NEXT:** stt-bench Phase A design note to Fable (how V's labels become a per-engine, per-language score; no automatic judge may stand in for V), Phase B runs every engine on the 200 label200 clips + calib30 on c3 (W27.3); split-speaker scores the readability filter from V's export; wire the self-test exclusion filter. Speaker chips are LIVE (e07cff51).
- **Dependencies:** V's rating; Fable's rulings (speaker display, calib30 fix).
- **Open decisions:** none new — the R2 literal-vs-inclusive follow-mode reading was ruled KEEP literal (FABLE 450); the calib30 shared chunkPlan bug is queued as its own fix.

# 2. PRESCRIBE — CAP-1 audit + CAP-2 vocabularies

- **Purpose:** audit whether prescription items (drugs, doses, diagnoses, investigations, advice) are captured in the transcript, for clinical completeness; then steer STT/translation with vocabularies.
- **Exit test:** CAP-1 report with held-out false-link rate; weekly PRESCRIBE capture score; CAP-2 vocabularies feeding STT/translation.
- **Status:** at risk (CAP-1 closed; CAP-2 just started). **% done:** 72%.
- **Owners:** linker (bundle + links; now also the Pulse prescription history extract, W27.2), cap (evaluator on eta-ci-c3; CAP-2 vocabularies, W27.1), eta-refuter-2 (checker), vj-refuter (reviews CAP-2). All on Claude Code personal Max now.
- **DONE:**
  - **CAP-1 FINAL report 957f93c4 (26 Sep, #3855).** Ceiling on 60 drawn ABSENT items: said-on-audio 6/60 = 10.0% (95% CI ~3.8-20.5%), decoys 1/60 = 1.7%, McNemar p=0.125 (not significant). Most ABSENT items look truly unspoken; 10% is a lower bound on said-but-missed. Draw gate PASS #3843, score check PASS #3849. Process note: cap posted a from-memory ABSENT-id list (#3803); the sha check caught it (#3806) and the correct list was placed (#3819) — checks worked as designed.
  - r429/430 (26 Sep 09:30): workstream authorised.
  - Bundle v1 FAILED by refuter-2 (33.8% wrong-time false links, chance-level).
  - Bundle v2 posted (27/183 linked, false-link 4.2%); then **bundle v3 built (#3662): 24 linked / 15 confirmed, English complete 189/189, honest smaller n**.
  - Naming PASS (#3655/#3658): cap_link 2b96fdfd + cap_bundle 99023b74 + ceiling f363a3e; MANIFEST 7/7 sha-verified; #3506 re-check PASS (both refusal paths exercised; pins MATCH; selftest 0).
  - CAP-1 score complete (#3784): scorer efcc9c9, 169 items / 24 linked consults — CAPTURED 29.6%, ABSENT 55.6%, drug 9.4% (weak class).
- **NOW:** CAP-2 (W27.1/W27.2): the extract is BUILT (200,098 lines, sha256 cd012fae, verified by eta-refuter-2 #3915); linker was to extract Pulse prescription history since 26 Jun 2026 (excluding 25 + 26 Sep) and hands it to cap on c3 (transfer path being agreed, #3880/#3886); cap drafts vocab builder + pre-registration on invented fixtures meanwhile.
- **NEXT:** vocab built 28 Sep; PRE-REGISTER (same 24 consults, ~200-token hint budget, scorer efcc9c9 unchanged, drugs scored separately) and post its sha BEFORE any run; before/after 29 Sep; vj-refuter reviews. Hard rule: 25/26 Sep and any test day stay out of the vocab source; a consult's own note never feeds its own transcript.
- **Dependencies:** linker's Rx extract (built, 200,098 lines, cd012fae; awaiting Fable's permission OK for cap to read it); hash match at both ends; V's rating is not needed.
- **Open decisions:** none (see DECISIONS for V's manual steps).

# 3. BACKFILL — every recorded hour transcribed

- **Purpose:** transcribe every recorded clinic hour (historical archive + daily incoming tape) with zero failures, no GCP.
- **Exit test:** each clinic day done by 07:00 next morning, 0 failures, no GCP.
- **Status:** on track. **% done:** 85%.
- **Owners:** hist-miner (Stage 1 anchors), hist-bulk (Stage 2 bulk + c3 loop), lab-mover (compute), join-shard (audio-join sharding), eta-refuter-2 (checker).
- **DONE:**
  - 26 Sep 19:40: hist-cpu-13 and hist-gpu-5 final drain sweeps gate-1 PASS (0 missing, 0 changed), both stopped; eta-lab-l4 NOT swept (GPU stockout twice, still stopped, nothing billing). No disks or instances deleted (#3859).
  - Full archive accounting: 4,507/4,507 windows transcribed across Tier A/B on 62 cloud routers, 0 problems (r309).
  - c3 high-throughput loop live: 14.2 audio-hours/hour, 0 failures (J-hist-c3).
  - audio-join 32-shard Worker deployed (r220).
  - GCP fully exited; all 5 GCP nodes powered off (r386/r419); archive mirrored twice.
- **NOW:** incoming 25 Sep tape transcribing on c3; tier-C backlog caught up. lab-mover relaunched clean — PARITY path green (six hashes re-verified, tape cron healthy, HF credit OK). 19:30 seal mirror = 4 sealed blobs (vj-refuter #3757).
- **NEXT:** PARITY-389 READY — fleet launches 21:15-21:30 box IST (six pre-hashes 6/6; binding re-hash at gate, any diff = NO LAUNCH; smoke ONE window first; hard stop 07:25-30 by PID; cap $10 = herdr-kit's verdict) — proves the HF A10G STT stack matches Mini production. c13 gate-1 ruling DEFERRED — lab-mover checks coverage read-only (do the 9 missing files have a vault copy?).
- **Dependencies:** PARITY needs rooms stopped + empty Mini queue + fleet's GO; c13 coverage check.
- **Open decisions:** eta-lab-l4 gap: retry once more later or accept (Fable); Air Drive copy of c13/gpu-5 is now stale vs the box archive (re-sync on Fable's word). The c13 gate-1 question itself is now answered by the sweep.

# 4. ROOMS — every clinic hour recorded

- **Purpose:** ensure every room records during clinic hours, detect silent stalls, and fix hardware.
- **Exit test:** every clinic hour captured; 0 unexplained silent tape; room faults auto-alerted.
- **Status:** at risk. **% done:** 80%.
- **Owners:** fleet (fleet-watch 24x7 monitor), scribe (recording accounting + alarms), radar-kit (mic self-test), herdr-kit.
- **DONE:**
  - 7-day schedule (26 Sep 20:15 correction): clinic 08:30-20:30 EVERY day; fleet-watch config updated with no restart (#3868). ORB3 (06:00-02:00) is not modelled by fleet-watch yet.
  - fleet-watch live (r399), 5-min polling, $2/day cap; NOT_RECORDING/NOT_DELIVERING alerts working.
  - Exact-zero tape root cause: TONOR TM20 hardware mute (r255/280) — but OPD 4 uses a C270 webcam (no mute), cause re-opened (r336/355).
  - C270 mic proven functional by acoustic test (r368).
- **NOW:** 8 rooms recording. **OPD 4: FABLE 453.0 EXECUTED — engine restarted 16:10 (ENCODER_STALLED + NOT_DELIVERING cleared); the C270 did NOT re-enumerate so start_day was correctly withheld; DEVICE_MISSING persists (physical). Tape frozen since 10:59 (~6 h). end_day + hands-on-site mic = Fable/V.** Dietary Mac: switched off by V, not a fault (minibot #3895).
- **NEXT:** Dietary closed (W27.8 done: off by V, no person needed); OPD 4 physical mic (Fable/V); auto-start at clinic open (V's decision; scribe's room-schedule code 93a1f17 built, unchecked, not wired); fleet-watch code default Mon-Sat still to fix on a branch.
- **Dependencies:** V's ruling on auto-start; physical access; a live executor for the OPD 4 restart.
- **Open decisions:** OPD 4 end_day + physical mic (Fable/V); auto-start build.

# 5. SPLIT — diarization (who spoke when)

- **Purpose:** speaker labels + counts; own model within 3 DER points of pyannote.ai.
- **Exit test:** own diarization model within 3 DER points of pyannote.ai on 2 weekly evals.
- **Status:** on track. **% done:** 70%.
- **Owners:** split (NEW Claude Code pane, W27.6: 337e labels + phase-2 plan), diar-lab (hands its 337e notes to split; SELFTEST lead), eta-refuter-2 (checker). pyannote.ai primary now; Nemotron local shadow.
- **DONE:** Nemotron fine-tune halted (collapsed on minor speakers; untuned base beat tuned) — r94/210. 337e speaker labeling complete across 4,167 windows (r418).
- **NOW:** T4 337e run finished 15/15 (1,342 windows, full_nemo_t4.jsonl). split builds speaker labels for the new windows so the viewer's speaker chips (LIVE) cover them.
- **NEXT:** labels -> eta-refuter-2 review -> push; then the SPLIT phase-2 plan (max 60 lines) to Fable BEFORE any training: Nemotron turn-finding trained on pyannote.ai labels, data sizes, T4 GPU hours (vLLM holds 0.55 of it), weekly eval against the exit test.
- **Dependencies:** human rating of the 30-window benchmark (8/30 done).
- **Open decisions:** none.

# 6. VOICEPRINT — doctor identity by voice

- **Purpose:** attribute speech to doctor vs patient vs other, guarded by cryptographic blinding; mint permanent doctor voice centroids.
- **Exit test:** voice centroids that pass the r182 positive/negative controls; Who-is-speaking page rated by V.
- **Status:** blocked. **% done:** 60%.
- **Owners:** vj-data, vj-arms, vj-link (builders), vj-refuter (the ONLY pane that sees sealed truth).
- **DONE:** blinding architecture (unix user `vjscore`, mode 700 vault) — r168. Centroid controls pass (0.74-0.86 pos, <0.40 neg) — r182/186. 90-item "Who is speaking" page + 20 top-ups published. V's truth encrypted into sealed vault `~/eta-data/vj-truth-sealed` (r422). J-005/J-006 cards done (arms 2+3).
- **NOW:** Arm 4 (Gemini audio on Vertex AI) blocked on box credential plumbing. 19:30 seal mirror RESOLVED: all 4 sealed blobs (vj-refuter #3757). vj-refuter verifies seal-decrypt v3 tomorrow after V `--apply`.
- **NEXT:** V deploys the gcloud shim be2b6682 + Vertex credential (arm 4 WAITS for these — no fallback scoring, ruled 26 Sep #3845); pin Vertex model id; run arm 4; vj-refuter final scoring in the sealed vault (venue approved: temp decrypt inside the 0700 seal, removed after, each decrypt logged).
- **Dependencies:** V's credential deploy; scoring-venue ruling.
- **Open decisions:** none open for scoring venue (item 137 approved, #3845); V still owes the shim + credential.

# 7. ENCOUNTER — consult start/end vs PQM truth

- **Purpose:** find consult boundaries in the tape and match them to patient-queue truth (E-1..E-7).
- **Exit test:** E-7 rescore recall/precision agreed vs PQM truth across all windows.
- **Status:** blocked. **% done:** 50%.
- **Owners:** mb-rx (J-001 truth table), mb-ot (J-002 OT), lx (J-003 modeling), hist-miner (J-004 anchors).
- **DONE:** E-7 full-day rescore of 24 Sep (recall 18/23, precision 43%) — r213. J-001 encounter truth table (1 Aug–25 Sep, 189 consults). J-002 OT columns. J-004 anchors extended to 204 historical visits.
- **NOW:** J-003 re-run held waiting for doctor-to-room mapping (item 102).
- **NEXT:** resolve mapping → lx J-003 scoring → E-6/E-7 fusion decisions.
- **Dependencies:** doctor-to-room mapping question (item 102).
- **Open decisions:** item 102 (doctor-to-room mapping).

# 8. SURGERY — surgery advice + appropriateness

- **Purpose:** detect if a doctor advised a procedure, what it was, and whether it matches the hospital booking.
- **Exit test:** v5/v6 rated set; Link-3 chain check published.
- **Status:** paused. **% done:** 70%.
- **Owners:** fleet (selection/de-id/scoring), surg-page (review UI), eta-refuter-2 (leakage), linker (Link-3).
- **DONE:** v1→v4 rated (Jev agreement 96% at v3). v5 wording frozen with `conditional` status (4830ae15); de-id redactor with partial-DOB (0e9d530). Link-3 class join executed + sealed (cacfc94; T9 name-leak gate passed; s27 tables committed).
- **NOW:** parked pending Fable's direction on v5/v6 freeze + 84 legacy de-id file regeneration.
- **NEXT:** regenerate 84 de-id files on order; V + Sandhya rate the 9-item fresh set; publish chain-check page after Fable reviews s27.
- **Dependencies:** Fable's order; V's rating.
- **Open decisions:** none new.

# 9. NOTESAFE — note faithfulness / completeness

- **Purpose:** audit generated notes against transcripts (Jev U4 faithfulness, U8 completeness) to catch hallucinations before clinician review.
- **Exit test:** false-flag rate < 25% before any production flag.
- **Status:** just started (W27.7). **% done:** 40%.
- **Owners:** notesafe (NEW Claude Code pane), eta-refuter (checker). Earlier builder: fleet.
- **DONE:** Jev U4/U8 logic implemented behind flag `JEV_NOTE_FAITHFULNESS`. Refuter FINDING 1: JevHttpError must never expose provider body.
- **NOW:** shadow mode only, flags OFF. notesafe is read-only until scribe tells it which commit D4 ships Sunday (asked #3883).
- **NEXT:** (a) fix: Jev faithfulness/completeness error messages must never carry provider text — branch off the D4 commit (not stale main), tests proving it, eta-refuter reviews, ships in the release AFTER D4. (b) design the medication-note bench from CAP-1 scored items (dose/number/drug swaps; false-flag target well under 25%); plan to Fable, max 40 lines.
- **Dependencies:** benchmark completion; safety policy.
- **Open decisions:** none.

# 10. TONE — emotion / tonality

- **Purpose:** flag distressed or tense encounters from audio tone.
- **Exit test:** service scores windows correctly in background (study closed).
- **Status:** paused. **% done:** 90%.
- **Owners:** indic-mt (study), lab-mover (replica infra).
- **DONE:** service live on Mini 8086; dedupe fix 87a7215 deployed; study CLOSED.
- **NOW:** steady state; no active steps.
- **NEXT:** none unless re-opened.
- **Dependencies:** none.

# 11. SELFTEST — repeatable system diagnostics

- **Purpose:** a rig that proves STT, diarization, and mics work — without patient data.
- **Exit test:** nightly scored report; fleet self-check for dead rooms; all stimulus types (rising/fixed tones, canary word "supercalifragilisticexpialidocious", call-and-response, mute/silence/unplug, background noise at set SNRs, multi-speaker conversations, en/hi/kn/te/ta + code-mixed, ElevenLabs voices).
- **Status:** on track. **% done:** 40%.
- **Owners:** diar-lab (lead/spec), lab-mover (plumbing), fleet (device checks), radar-kit (mic self-test).
- **DONE:** authorised r428/428a; spec drafted and on main (058dcd4, spec draft 7e55ef3); Home Office Mac reserved as the acoustic rig; digital path on non-Google machines.
  - diag-rig (kit/diag-rig, stdlib only: generator, digital injector, scorer) on diar-lab/selftest-build: FAIL ee394e7e (#3861), fixed, PASS b542d96c (#3877), 23 tests. Mini addresses hard-refused unless explicitly allowed. Nothing has run on the Mini or any production endpoint.
- **NOW:** W27.5: (a) merge to main by cherry-pick onto 207821ba, rerun tests, post the main sha; (b) first voice set with Google TTS (en/hi/kn/te/ta + code-mixed, invented phrases, under 60,000 characters) — if no credential is reachable, tones + canary only; (c) first digital run on c3, scored. ElevenLabs key still returns 401 (V re-saves). Nightly window 23:00-06:00 IST; no weekday logic in the code (7-day). The Home Office acoustic pre-check rides Sunday D4 (07:45-08:15); the stimulus run owes its own refuter pass before touching the production Mini.
- **NEXT:** first digital report Mon 28 Sep; first nightly (23:30) Wed 30 Sep; Kanglish phrase set needs V's OK; acoustic runner, fleet self-check and shadow columns are NOT built yet.
- **Dependencies:** Fable ruling; ElevenLabs key.
- **Open decisions:** spec questions (Kanglish phrase set, TTS fallbacks, schedule).

# 12. LABVIEW — lab viewer + rating pages

- **Purpose:** the authenticated web viewer V uses to read transcripts and rate quality.
- **Exit test:** V rates label200; consult view shows readable transcripts + speakers; /roadmap page renders this file.
- **Status:** on track. **% done:** 90%.
- **Owners:** lab-viewer (builder), eta-refuter-2 (checker).
- **DONE:** viewer redesigned (r328) and live at lab.llmvinayminihome.uk behind Cloudflare Access; Consult View (337a); rating sets hosted (r359); 427L label200 fix LIVE (FABLE 450, v6713bbe8); 451 values applied (ALLOWED_EMAILS 6, RATERS 3). 451 thread CLOSED — Zaki's successful login verified (#3716); the two email-list shas stay UNVERIFIED by design. /roadmap page BUILT + PASS (ede99072, #3781) — renders docs/ROADMAP.md + DECISIONS.md.
- **NOW:** /roadmap LIVE (version 0ea4917a, main 79fd7af9; Access redirect verified). Speaker chips LIVE (e07cff51, main 207821ba). V can rate label200 at /rate/label200.
- **NEXT:** W27.4 in order: (a) CAP-1 scored items (captured / misheard / absent) beside each of the 24 linked consults (source: cap's scored_items 54dca57d); (b) one rating hub page listing every open rating task (label200, speaker-count, Doctor Voice Check, surgery v4) with V's and Sandhya's progress. Each: build -> eta-refuter-2 PASS -> 'READY TO DEPLOY <sha>' -> Fable deploys. Note: this pane's classifier blocks `wrangler deploy`, so Fable deploys.
- **Dependencies:** Fable rulings.
- **Open decisions:** none new.

# 13. FOUNDRY — machines, agents, bus, models, budget

- **Purpose:** the operational substrate everything runs on.
- **Exit test:** all panes on their cheapest passing model; budget tracked; GCP gone; no free-model leakage.
- **Status:** on track. **% done:** 78%.
- **Owners:** Fable (lead), herdr-kit, fleet, tunnel-ops, radar-kit, lab-mover, conductor.
- **DONE:** OpenCode migration complete (r432; FABLE 452 all-Go sweep, -cc panes stopped). Checkers → opencode-go/deepseek-v4-pro (r449). Zen = overflow-only from now (r452). GCP exit: compute stopped, disks awaiting S7 delete. Zen ledger live (zen-meter-go PASS 904f79b+807d0b3, bin moved to bd4c2e6). Privacy PASS (448): free-model fallback dead account-wide. Bus `fable` recipient confirmed resolving (stored_poll, #3711). Routing LIVE (FABLE 458): yoga-free pane + Pool B Go; herdr-kit 455.A waste-guards BUILT @ dec41ca4. c3/437 checker work COMPLETE both halves (vj-refuter box-side PASS + eta-refuter c3-side).
  - 26 Sep evening: 464 move — 9 box/c3 PHI panes on Pool B Go, zero Zen sessions (#3832); 466 non-Go fallback sweep CLEAN (#3836); 460 servers LIVE (T4 vLLM Qwen2.5-7B-AWQ bind-proven, Mini llama.cpp; agent-side gate blocked on config weight, #3824); 455.A waste-guards integrated 7adb16a3, eta-refuter PASS (#3830).
  - **W27 (20:10 IST): the lab moves to Claude Code on V's personal Max (Pool C).** PHI is allowed there; free models stay NO-PHI. OpenCode pools A/B are small top-ups only. See SESSIONS.
- **NOW:** routing LIVE: yoga-free pane open on UbuntuYoga (big-pickle default, muse-spark fallback), Pool B Go live on the Mini (herdr-kit glm-5.3-flash + roadmap deepseek-v4-pro on the personal-account key); minibot gated (458.2). FABLE 460 local-model rollout in flight: T4 vLLM Qwen2.5-7B-AWQ + Mini llama.cpp Qwen2.5-Coder-14B (four panes: t4-serve/mini-serve/t4-local/mini-coder; ETA ~40 min). FREE-MODEL fires: nophi-run locus STOPPED (V's call); fire #3 (`mini:dir:eta-lab`) still with Fable for attribution.
- **NEXT:** eta-refuter gates herdr-kit's 455.A waste-guards; Fable's go on the T4 vLLM install (minibot = consumer); GCP S7 disk/snapshot deletion (V's gcloud auth, after 24h window); eta-refuter reviews the 455.B NO-PHI/PHI placement draft; builder calibration evals.
- **Dependencies:** V's gcloud auth for S7; if V has not yet restarted the eta-bus server, the async-wake/timeout fixes still land on that restart (fable addressing already confirmed working).
- **Open decisions:** Zen top-up cadence (no auto-reload per r407); idle-pane memory target; the two Mini free-model fires are Fable's routing call; nophi-run account disposition (V).

# 14. SHIP — EvenScribe production releases

- **Purpose:** ship tested, verified production releases without disruption.
- **Exit test:** each train checked by a checker on the exact sha, smoke green, no rollback needed. Checker model = opencode-go/deepseek-v4-pro; kimi-k3 is reserved for production-deploy/security checks (r449).
- **Status:** on track. **% done:** 90%.
- **Owners:** scribe (deploy train), eta-refuter (checker), minibot (Mini monitor).
- **DONE:** production 1e75667 live (route fix, smoke 924/924). Trains 73868e4 (209/209) and a92ebae (loop-guard + emotion dedupe) shipped. D4 runbook FINAL + eta-refuter PASS (#3598 deploy+rollback) — D4(a) done.
- **NOW:** D4 = 5907cbc onto vinay/s1-auto-drain, Sunday 07:00 (only after PARITY's hard stop 07:25-07:30). Runbook 4a2650c. New timings: D4 deploy + smoke END 07:45; Home Office pre-check + SELFTEST 07:45-08:15; switch-off confirmed 08:15; nothing on the Mini queue after 08:15; rooms record from 08:30. RISK: only ~15-20 min for D4 if the stop lands on time; if late, D4 waits for Fable's word, never past 08:15 (#3879). Preconditions still open: SCRIBE_MCP_TOKENS_EXTRA (Vercel, UNVERIFIED), WHISPER_BULK_URLS r394 removal, migration 0119 by hand.
- **NEXT:** Sunday 07:00-07:30 pre-flight → 0119 → push (preview) → promote → smoke; rollback = promote prev dpl (migration STAYS); Home Office SELFTEST pre-check 07:35-08:55 (speech-only). The SELFTEST stimulus run itself owes its OWN refuter pass before running on the production Mini (diar-lab).
- **Dependencies:** manual migration 0119; Vercel env edits by Fable/V.
- **Open decisions:** 5907cbc deploy Sunday (Fable-gated by name); SCRIBE_MCP_TOKENS_EXTRA + WHISPER_BULK_URLS dashboard edits (Fable/V).

# 15. RECORDER — next Room Recorder fleet release

- **Purpose:** the next release of the EvenScribe Room Recorder app that runs on the room Macs.
- **Exit test:** release ships with the queued fixes; self-update R3 proven; rollout clean.
- **Status:** just started. **% done:** 20%. Owner = scribe (plan/build) + minibot (Mini monitor).
- **Current version:** 0.1.24 (confirmed from the DB install row). Next release = **0.1.25**.
- **Plan:** vinay/rr-0.1.25 a5009c4 (docs/recorder/0.1.25-PLAN.md, no code), repushed d7949f5 with 7-day hours and no Mon-Sat leftovers. Findings: same-uid no-op = RoomEngine.swift:3138 guard; DEVICE_MISSING DOES fire (scribe's own retraction #3862; measured on OPD 4), so that item drops; no clinic-open time existed anywhere. Room-schedule code vinay/room-schedule 93a1f17 (clinic 08:30-20:30 daily, orb3-29ac 06:00-02:00) is built, tests green, NOT refuter-reviewed, not in any train; ORB3 runs the Linux recorder 0.1.22.2, so it gets the alert, not app auto-start.
- **Queued for it (5 defects, confirmed):** #1-#4 from scribe's handover (tape_advancing follows tape.pcm not tape.idx; poll reports device_lost; same-uid set_audio_input is a no-op; DEVICE_MISSING may not fire) **+ #5 device-loss recovery** (no verified recovery path after USB loss — release must prove one). Plus self-test hooks (r368/369) and auto-start at clinic open if V approves (item 151).
- **Release process:** R3 self-update proven 10 Sep (UNVERIFIED exact date). Gates + rollout plan to be written.
- **NEXT:** confirm owner and the exact queued list; write gates + rollout plan.
- **Dependencies:** V's auto-start ruling; owner confirmation.
- **Open decisions:** auto-start inclusion; which fixes make the cut.

# 16. ORBOX — OT recorder upgrade for robotic surgery

- **Purpose:** upgrade the OT recorder (Linux orbox3 in ORB3) to capture robotic surgeries: separate USB webcam audio+video, dual audio (TONOR mic + webcam mic), more microphones around the room, possibly wireless directional mics.
- **Exit test:** a robotic surgery captured end-to-end (video + dual audio + room mics) through the pipeline, tested first with SELFTEST stimuli in the empty OT.
- **Status:** just started. **% done:** 5%. Owner to propose.
- **Owners:** none yet — **proposed: lab-mover or scribe/minibot for capture, herdr-kit for Linux install, fleet for monitoring**.
- **NOW:** requirements listed but no owner, no hardware, no software.
- **NEXT:** confirm with V that "speakers" means microphones (they collect audio); propose owner; hardware list + purchase (V); Linux capture software (multi-device sync + timebase + storage/hr + retention); how video joins pipeline (storage, viewer, PHI/consent — V's decision); test plan with SELFTEST stimuli in empty OT; phased delivery.
- **Dependencies:** V's hardware purchase + consent ruling; owner assignment.
- **Open decisions:** see DECISIONS (D-2..D-5).

---

## Critical path

1. **label200 rating (CLARITY)** — V rates 200 rows → unblocks the readability floor and CLARITY exit test.
2. **CAP-2 vocab (PRESCRIBE)** — CAP-1 FINAL 957f93c4 is done; linker's history extract → vocab 28 Sep → before/after 29 Sep.
3. **PARITY-389 tonight (BACKFILL)** — READY: fleet launches 21:15-21:30 box, six hashes 6/6, hard stop 07:25.
4. **D4 deploy Sunday 07:00 (SHIP)** — 5907cbc onto production after PARITY's hard stop; Home Office SELFTEST pre-check 07:35 (stimulus run owes its own refuter pass first).
5. **OPD 4 recovery (ROOMS)** — end_day + physical mic (Fable/V); recording resumes.
6. **GCP S7 delete (FOUNDRY)** — V's gcloud auth, after 24h window.

## 14-day calendar (27 Sep – 10 Oct, IST; box clock)

- **26 Sep (tonight):** CAP-1 FINAL out (957f93c4); seal mirror done (4 blobs); PARITY-389 launch 21:15-21:30, hard stop 27 Sep 07:25-07:30.
- **27 Sep:** D4 deploy 5907cbc 07:00-07:45 + Home Office SELFTEST pre-check 07:45-08:15 (Mini switch-off 08:15); PARITY verdict + report; ROOMS auto-start decision to V.
- **28 Sep:** CAP-2 vocab built; first SELFTEST digital report; label200 rating likely in progress (V).
- **29 Sep:** CAP-2 before/after; VJ arm 4 if V's shim + Vertex credential landed; GCP S7 delete window.
- **30 Sep:** first SELFTEST nightly 23:30; DeepSeek Go ZDR re-confirm date (r449 — check whether it lapses).
- **1–4 Oct:** CAP items beside consults + rating hub (LABVIEW); SPLIT phase-2 plan decision; NOTESAFE fix (after D4 release).
- **5–7 Oct:** SPLIT own-model evals begin; RECORDER release scoped.
- **8–10 Oct:** ORBOX capture pilot in empty OT; NOTESAFE benchmark (if resumed).

---

*Anything here that a project owner believes is wrong: say so on the bus to `roadmap` with the correcting evidence (bus id / ruling / sha), and I fix it in the next revision.*
