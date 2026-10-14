# ETA LAB — MASTER ROADMAP

Written by the `roadmap` pane (records keeper). This is the one document any orchestrator reads to know where every project stands. Plain words: V is a doctor, not a programmer. Counts and ids only — no patient text anywhere in this file.

Last revision: **26 Sep 2026, ~10:45 IST** (rev 14).

## Changes since last revision

Rev 14 (vs rev 13; 27 Sep morning — Sunday wave; roadmap now 18 projects):
- **NEW PROJECT 17 FREESCRIPT** and **NEW PROJECT 18 ACOUSTICS** (added below; see their sections).
- **CLARITY — root cause found + fix built + automated scorecard ruled.** lid-debug found the router has no acoustic language ID: ~35% of English-tagged real windows are Indic speech (21/60 on label200, 95% CI 23-48%), from six mechanisms M1-M6 in router_server.py 400710ee (forced-English Whisper, a length-ratio override, an Indic-head short-circuit, non-deterministic temperature fallback, a re-decode that emits different text than was judged, and "longest text wins" for which Indic language) — full mechanism table on the bus #4108. router-fix built router-fix/lid removing M1-M5, pre-registered its offline eval (#4127/#4128), and is running S1/S2/S3 now; nothing ships to the Mini until Fable rules, earliest after 20:30 tonight. **V ruled (W33, 08:05 IST): no human listening today — every CLARITY change is judged by three pre-registered automatic scores** (S1 synthetic truth: WER/CER/hit-rate on SELFTEST dialogues with known text; S2 clinical truth: CAP capture score on real consults against Pulse, scorer efcc9c9 unchanged; S3 language truth: share of windows on the wrong language path, judged by Gemini 3.8 Flash via the ZDR route, itself proven on known-language audio first). **Win rule: a change ships only if S2 improves and S1/S3 do not get worse.** V's own labels become a later spot-check, not a gate. diar-lab built the S1 clinical suite (clinical1, 192 stimuli, PASS ef19d6a2) plus two confirmation suites for the S3 judge (confirm2 224 stimuli PASS ec965b16, confirm3 + confirm3diag PASS cc9b2822/7397c881) after two judge wordings (84.9%, then 91.7%) failed the ≥95%/≥90% usability gate on babble noise; linker built lang_judge.py and is running the frozen v3 judge on confirm3 now (one run, not yet read). lab-viewer built /clarity (LIVE 162ff4b8, then a SCORECARD panel LIVE fa5e58bb) showing S1/S2/S3 old vs new per language; clip data for 201 objects is loaded but the live scorecard load is blocked by lab-viewer's own pane classifier.
- **PRESCRIBE — CAP-2 Step 0 done, real/placebo running.** Pre-registration v4 frozen (sha256 cc0484c77c8f319d, #4009/#4010), vj-refuter confirmed the rebuild byte-identical. Step 0 (whisper baselines, both arms) done; ceiling checks Nflip 2 / A 9 / B 3 / LOSTMAX 2, all vj-refuter VERIFIED (#4154). GLOSS GO real+placebo launched on c3 (#4155); cap continuing. CAP-2 also gained a router arm (W33.3): score old vs new router on the same 24 consults with the frozen scorer.
- **SHIP — D4 candidate3 cac6c29 gated PASS, then POSTPONED to 21:00 tonight.** eta-refuter PASS on cac6c29 at 06:30 (#4083); scribe pushed it as a Vercel preview (fast-forward, not promoted, #4113) but could not promote (no Vercel access) and the env preconditions (SCRIBE_MCP_TOKENS_EXTRA, WHISPER_BULK_URLS) were unverifiable before the 07:45 hard stop, so Fable postponed the whole deploy to 21:00 tonight (#4120); production stays 1e75667, migration 0119 NOT applied. Home Office pre-check ran read-only 07:45 and PASSed (flags clear, both switches off, #4145).
- **RECORDER 0.1.25 — PASS at 1da7232**, Swift gate green on the Air (637 tests, 2 pre-existing load-sensitive flakes also present on the 0.1.24 baseline, #4276). Fable's GO: a signed test build for Home Office only (auto-start left on), minibot installs it, then the first self_test runs there. A separate server-side self_test command (self-test-server d82ef4c) is built but not yet pushable — eta-refuter's #4281 FAIL (the MCP tool group has no self_test variant) still stands, so sending a live self_test needs that fix plus a re-gate first.
- **SELFTEST — room self-test scorer PASS (adc6681df3c1)**; reads the app's real 16 kHz raw tape.pcm + manifest with a tone-corrected alignment (three FAIL rounds fixed: RT60 reliability, sweep-path gain, a 0.5 s manifest-offset bug that silently dropped measured SNR from 46 to 21 dB). Stimulus pack selftest-room-v2 ready and accepted by scribe's app loader. First digital report (13/13 stimuli through the box-twin router) ran: kn v3 correct, te/ta/code-mixed missed — the te miss is on the STT side, not the audio (#4004/#4005), which is what fed lid-debug's CLARITY root-cause work above.
- **ROOMS — room readiness 07:45-07:58**: 7 rooms + Home Office ready and kiosk-listening; ORB3 recording since 06:00; Cardiology and Dietary offline (Dietary expected, off by V); **OPD 4 still flags DEVICE_MISSING** at 07:58 despite reporting the C270 by name (needs a physical look before rooms open). fleet's single read-only `report_diag` to OPD 4 (W34.3) was refused by fleet's own pane classifier as a remote write — needs V/Fable to add a permission rule, or to run the one named command and hand fleet the reply.
- **BACKFILL — PARITY-389 compare NOT COMPUTABLE yet.** The Mini side is complete (48/48 captures); the HF side had no capture, so fleet's compare script (hardened twice for real integrity bugs eta-refuter-2 found: audio identity not checked against the ship manifest, and a golden/manifest pin) correctly returns NOT COMPUTABLE, not a false MATCH. Fable then launched the real HF job (a10g-large, cap $6, expected ~$2.3, #4234); fleet watches it and runs the compare once it lands.
- **FREESCRIPT (new, W35): study delivered.** /home/eta/oc/freescript/FREESCRIPT-STUDY.md (371 lines, sha256 b02072fb…) plus a bug note and a CAP→Pulse mapping and a first bridge design — see project 17.
- **ACOUSTICS (new, W34.2): per-room profiles from existing tape, in progress**, due ~14:00 — see project 18.

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
| 1 | CLARITY | at work | 78% | router root cause found (M1-M6) + fix built; automated S1/S2/S3 scorecard ruled (no human listening); router-fix's eval running |
| 2 | PRESCRIBE | at risk | 76% | CAP-1 FINAL 957f93c4; CAP-2 pre-registered cc0484c7, Step 0 done, real/placebo running |
| 3 | BACKFILL | on track | 87% | archive transcribed; PARITY-389 capture done (48/48); HF-side job running for the compare |
| 4 | ROOMS | at risk | 82% | 7 rooms + Home Office ready 07:58; OPD 4 DEVICE_MISSING persists; auto-start GO (V, RECORDER 0.1.25) |
| 5 | SPLIT | on track | 70% | 337e T4 run done, labels for 1,342 new windows next; phase-2 plan due |
| 6 | VOICEPRINT | blocked | 60% | truth sealed; arm 4 waits on V's Vertex credential + scoring venue ruling |
| 7 | ENCOUNTER | blocked | 50% | J-001/J-002/J-004 done; J-003 held on doctor-to-room mapping |
| 8 | SURGERY | paused | 70% | v5 frozen; 84 legacy de-id files await Fable's order; Link-3 sealed |
| 9 | NOTESAFE | on track | 60% | error-message fix rebased+PASS on D4's sha; medication-note bench PASS (b6581c5/8f17fbd) |
| 10 | TONE | paused | 90% | emotion study closed; service runs in background when enabled |
| 11 | SELFTEST | on track | 60% | room self-test scorer PASS (adc6681); clinical S1 suite + 2 confirm suites built for CLARITY's judge |
| 12 | LABVIEW | on track | 93% | /roadmap, speaker chips, rating hub, /clarity + SCORECARD panel all LIVE; PRESCRIBE cards built, load pending |
| 13 | FOUNDRY | on track | 80% | Pool C (Claude Max) carries PHI; Pool B (personal Go) small top-ups; Pool A (main Go) NO-PHI only; c3 bus-visible |
| 14 | SHIP | at risk | 90% | D4 candidate3 cac6c29 gate PASS but POSTPONED to 21:00 tonight (env preconditions, no promoter) |
| 15 | RECORDER | on track | 65% | 0.1.25 PASS 1da7232 (Swift gate green); Home Office signed test build + first self_test next |
| 16 | ORBOX | just started | 15% | design v2 done (orbox, W29.1): 2 hardware bundles priced, empty-OT test plan; V's purchase/consent call still open |
| 17 | FREESCRIPT | just started | 20% | Pulse FreeScript studied end to end (371-line study); a bridge design proposed; awaits V's ruling to prototype |
| 18 | ACOUSTICS | just started | 30% | per-room acoustic profiles from existing tape in progress, due ~14:00; script PASSed after 1 fix |

---

# 1. CLARITY — readable, accurate consult transcripts

- **Purpose:** turn raw mixed-language clinic audio into complete, human-readable transcripts, with English under each native line, correct speakers, and garbled lines hidden behind a precision floor.
- **Exit test:** 80% of V's sample reads acceptably; 85% PRESCRIBE capture. **Ruled 27 Sep (W33, V, 08:05 IST): no human listening today — every change judged by three pre-registered automatic scores instead** (see NOW).
- **Status:** at work. **% done:** 78%.
- **Owners:** lid-debug (router root cause, consultant now), router-fix (the fix + offline eval), diar-lab (S1 synthetic suites), linker (S3 language judge + bigger S2 sample), cap (S2 router arm), lab-viewer (/clarity + scorecard), stt-bench (engine bench, support role now), Fable (rulings, deploy word).
- **DONE:**
  - r337/337a-e, label200, 427L (see prior revisions — unchanged).
  - **Router root cause (lid-debug, W30.1, #4108):** the production router has no acoustic language ID. ~35% of English-tagged real windows are Indic speech (21/60 on label200). Six mechanisms in router_server.py sha 400710ee: M1 Whisper "auto" is actually forced English (no `-l` flag, json format carries no language key); M2 a length-ratio override keeps romanised English over longer native-script text; M3 a short-circuit skips other Indic heads once the first (kn) head is empty; M4 the forced-English judging call is non-deterministic (temperature fallback); M5 a re-decode after judging emits different text than was judged; M6 the Indic language is whichever head/SraVaani text is longest, not which one is right. Whisper's own auto-LID is not a truth source (wrong on 36/37 kn-tagged clips) but its p(en) confidence separates well: p(en)<0.9 flags 16/21 real misroutes vs 2/29 true English.
  - **router-fix built (W31.1) branch router-fix/lid**, removing M1-M5 as five separate commits with tests each (M6 deliberately untouched — separate change). Offline eval PRE-REGISTERED (#4127/#4128) before any result was read; eta-refuter-2 code-PASSed it for the box eval, with 4 conditions before any Mini deploy (#4130).
  - **CLARITY SCORECARD ruled + built (W33):** S1 synthetic truth, S2 clinical truth (CAP capture score, scorer efcc9c9 unchanged), S3 language truth (Gemini 3.8 Flash judge via ZDR, proven ≥95%/≥90% on known-language audio first). **Win rule: ships only if S2 improves and S1/S3 do not get worse.** diar-lab's S1 suite `clinical1` (192 stimuli, 6 languages + 2 code-mixed, drugs/dose/diagnosis/investigation truth) merged to main PASS (ef19d6a2, main 5d87140b). Two S3-judge confirmation suites built after two wordings failed the usability gate on babble noise (v1 84.9%, v2 91.7%, both < 95%): `confirm2` (224 stimuli, PASS ec965b16) and `confirm3` + `confirm3diag` (PASS cc9b2822 / 7397c881, the 0 dB diagnostic cell in its own suite dir per eta-refuter-2). linker's frozen v3 judge is running on confirm3 now — one run, result not yet read.
  - lab-viewer: `/clarity` page LIVE (162ff4b8, then fa5e58bb with the follow-up PASS folded in) showing router-fix's per-clip old-vs-new; the SCORECARD panel on top LIVE (fa5e58bb) after a real bug caught in review (S3 trusted the judge's own "usable" flag against its own numbers — fixed). A judge-only S3 loader (601c3500) lets the page show S3 while the judge is not yet usable, without inventing rows.
- **NOW:** router-fix's offline eval is running (S1 on clinical1 + digital1, per-window outputs for S2/cap and S3/linker on the 24 CAP consults and the 200 label200 clips); linker's S3 judge v3 is scoring confirm3 (one run, sealed from V until it either passes or is superseded); lab-viewer's clip data (201 objects) is loaded but the live scorecard load is blocked by the pane's own permission classifier — needs Fable or a permission rule.
- **NEXT:** read router-fix's S1/S2/S3 results once router-fix, cap and linker all post; if S3 judge v3 passes ≥95%/≥90%, run it on real audio only via the Fable shell pane (patient audio leaving the box needs that route, #3934-style rule); M6 fix (Indic language chosen by SraVaani's own script, lid-debug's W31.2 recommendation) is a separate, later change; nothing deploys to the Mini before Fable's word, earliest after 20:30 tonight.
- **Dependencies:** Fable's deploy word; the S3 judge clearing its usability gate; patient-audio runs routed through Fable's shell pane only.
- **Open decisions:** none new — the automatic-judging rule itself is the ruling (see DECISIONS, closed).

# 2. PRESCRIBE — CAP-1 audit + CAP-2 vocabularies

- **Purpose:** audit whether prescription items (drugs, doses, diagnoses, investigations, advice) are captured in the transcript, for clinical completeness; then steer STT/translation with vocabularies.
- **Exit test:** CAP-1 report with held-out false-link rate; weekly PRESCRIBE capture score; CAP-2 vocabularies feeding STT/translation. **New (W33.3): also scores router-fix's old-vs-new router as CLARITY's S2.**
- **Status:** at risk (CAP-1 closed; CAP-2 running). **% done:** 76%.
- **Owners:** cap (evaluator on c3), linker (bundle + Rx extract + S3 judge), vj-refuter (checker — reviews CAP-2 and stt-bench until V's Vertex shim lands), eta-refuter-2.
- **DONE:**
  - CAP-1 FINAL 957f93c4 (see rev 12/13 — unchanged).
  - **CAP-2 PRE-REGISTERED (cap, 27 Sep ~01:40 IST): sha256 cc0484c77c8f319d…** — four draft rounds (v1-v4), vj-refuter's 6-fix review on v3, rebuild verified byte-identical before registration (#4006-#4011).
  - Vocabulary source built and verified: linker's Pulse Rx extract (200,098 lines, cd012fae…, rev 13) plus a 65-id sample-patient exclusion list (be8816dd, PASS #3956) and sample audio for the 24 CAP consults (MANIFEST 0db5fb95, PASS #3983, hashes VERIFIED by vj-refuter #3981).
  - **Step 0 (whisper baselines, both arms) DONE.** Ceiling checks: Nflip 2, A 9, B 3, LOSTMAX 2 — vj-refuter VERIFIED (#4154), a scorer key bug found and fixed by cap after its own PASS (#4071, self-disclosed).
  - **GLOSS GO real+placebo** launched on c3 by Fable (#4155); gloss baselines g_base1/g_base2 also launched on the box (06:35).
- **NOW:** cap continuing CAP-2 (glossary runs, real vs placebo); router arm (W33.3) scores router-fix's old vs new router on the same 24 consults with the frozen scorer once router-fix's per-window outputs land.
- **NEXT:** CAP-2 before/after result; router-arm S2 numbers for the CLARITY scorecard; vj-refuter final review of the full CAP-2 run.
- **Dependencies:** router-fix's per-window output shape (agreed with cap, #4152); vj-refuter's continued availability (waits on V's Vertex shim for VOICEPRINT, not blocking here).
- **Open decisions:** none.

# 3. BACKFILL — every recorded hour transcribed

- **Purpose:** transcribe every recorded clinic hour (historical archive + daily incoming tape) with zero failures, no GCP.
- **Exit test:** each clinic day done by 07:00 next morning, 0 failures, no GCP.
- **Status:** on track. **% done:** 87%.
- **Owners:** hist-bulk (daily drain), lx (encounter re-score harness), lab-mover (archive/GCP exit), fleet (PARITY-389), eta-refuter-2 (checker).
- **DONE:**
  - Archive + GCP exit facts from rev 12/13 stand (c13/gpu-5 drained, l4 gap accepted for now).
  - **W28.1: 26 Sep backlog drained** by hist-bulk overnight while rooms were stopped (hist-bulk #4058, spot-check owed in the morning).
  - **W28.2: full-day encounter re-score harness** (lx/fullday-rescore) built and PASSed at d61975e8 (3 fix rounds), merged to main 46eae4dd, confirmed byte-identical (#4070). Reproduces the 23 Sep 3-room score exactly (3/14 found, fusion 3/7).
  - **PARITY-389 capture DONE early: 48/48, 0 skipped, rc 0** (fleet #4043), launched under the 21:15 waiver (driver pid 45877). fleet's compare script (parity389_compare.py) was hardened twice on real bugs eta-refuter-2 found by adversarial probing — B1: audio identity must be checked against the ship manifest per window, not just Mini-vs-HF equality (a shared wrong hash used to pass); B2: `--golden`/`--manifest` inputs must be pinned by sha and refuse on mismatch. Both fixed and PASSed (#4101).
- **NOW:** the compare correctly returns **NOT COMPUTABLE** — the HF side had no capture yet. Fable launched the real HF job (a10g-large, `hf jobs run`, cap $6 all-in, expected ~$2.3, herdr-kit agreed the cap, #4234/#4078); fleet is watching it and will run the compare the moment it lands. The verdict decides whether HF may carry overflow and whether the GCP disks may be deleted (deletion itself stays V's named approval).
- **NEXT:** PARITY-389 verdict (MATCH / NO MATCH with numbers); eta-refuter-2 spot-checks hist-bulk's 3 windows from the overnight drain; lab-mover's post-guard leg (a92ebae harness) still needs an owner for review (Fable's call, fleet offered).
- **Dependencies:** the HF job completing under budget; Fable naming the post-guard reviewer.
- **Open decisions:** eta-lab-l4 gap (retry or accept, Fable); post-guard leg reviewer.

# 4. ROOMS — every clinic hour recorded

- **Purpose:** ensure every room records during clinic hours, detect silent stalls, and fix hardware.
- **Exit test:** every clinic hour captured; 0 unexplained silent tape; room faults auto-alerted.
- **Status:** at risk. **% done:** 82%.
- **Owners:** fleet (fleet-watch monitor), scribe (RECORDER auto-start + self-test), minibot (Mini watch), acoustics (new, per-room profiles).
- **DONE:**
  - 7-day schedule (rev 13) stands.
  - **Auto-start ruled GO by V (26 Sep), built into RECORDER 0.1.25 (R25/W34.1):** per-room schedule from `lib/room-schedule.ts` (93a1f17) — 08:30 for clinic rooms, 06:00 for ORB3, never Dietary unless re-enabled, 10-min grace, a room already started by hand is left alone. **This closes D-1.**
  - Room readiness checked twice this morning: 07:45 (fleet #4146) and 07:58 (minibot #4180) — 7 rooms (OPD 1/3/5/6/7, Third Floor) + Home Office ready, kiosk listening; ORB3 recording since 06:00; Cardiology and Dietary offline (Dietary off by V, expected; Cardiology "no kiosk since 26 Sep" — not expected to start, V/Fable's call).
- **NOW:** **OPD 4 still flags DEVICE_MISSING** at 07:58, even though the app now reports the C270 by name — needs a physical look before clinic opens. fleet's single read-only `report_diag` to OPD 4 (W34.3, for a signature_mismatch check across several rooms per scribe's #4280) was refused by fleet's own pane classifier as a remote write — nothing was sent. acoustics is building per-room noise-floor/SNR/clipping/reverberation profiles from the last 7 days of existing tape (W34.2), tied to CLARITY's STT-outcome data where available — see project 18.
- **NEXT:** V/Fable adds a permission rule for fleet's one named `report_diag` command, or runs it directly and hands fleet the reply (exact command in #4221); physical check of OPD 4's C270; Cardiology decision (bring back or leave off); RECORDER's server-side `DEVICE_LOST` flag ships in the release after D4.
- **Dependencies:** a permission rule or manual run for report_diag; physical access for OPD 4.
- **Open decisions:** Cardiology restart (V/Fable); OPD 4 physical fix (D-8, updated).

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
- **Status:** on track. **% done:** 60%.
- **Owners:** notesafe (builder), eta-refuter (checker).
- **DONE:**
  - **Provider-text fix PASS.** Branch `notesafe/provider-text` closed two real leaks (a non-JSON 2xx body's SyntaxError quoting itself into the trace/shadow log; raw DB error text in a persisted error) behind an allowlist (`lib/jev/safe-error.ts`); eta-refuter PASS-with-fixes (#3916) then full PASS (#3922) after both required fixes; rebased onto D4's actual sha cac6c29 (head ebcd455, then reconfirmed at tree b6c1d0a0 = 6448ab1, #4069). Ships in the release AFTER D4, never inside it.
  - **Medication-note bench: V ruled (W30.3)** invented transcripts + CAP-1/Pulse items as vocabulary only = APPROVED; threshold rule (dev tunes, test scored once, frozen; false-flag ≤10% observed AND 95% upper bound <25%) = APPROVED; scored-items source = box scored_items.jsonl (54dca57d). Built as `notesafe/med-bench`, two review rounds (b16a9e2 PASS with 3 notes, then v2 b6581c5 with N1-N3 fixed, PASS #4105; head 8f17fbd after dropping 2 stray .pyc files, confirmed #4107).
- **NOW:** both deliverables are PASSed and waiting on the live run / D4's actual ship (notesafe is read-only on the fix until D4 settles a final sha).
- **NEXT:** run the medication-note bench for real numbers against the frozen threshold; confirm false-flag ≤10%/<25% before considering the flag live.
- **Dependencies:** D4's final ship sha (for the provider-text fix's home); the bench run itself.
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
- **Status:** on track. **% done:** 60%.
- **Owners:** diar-lab (suites + scorer), scribe (in-app self-test hook + server command), eta-refuter-2 (digital-path checker), eta-refuter (RECORDER/server checker).
- **DONE:**
  - Digital rig on main (rev 13) stands; first digital report (13/13 stimuli, box-twin router): kn v3 correct, te failed on the STT side (not the audio), ta/code-mixed missed — this finding is what pointed lid-debug at the router's language handling (#4004/#4005), feeding directly into CLARITY's root-cause work.
  - **W33.1 clinical S1 suite** `clinical1` (192 stimuli, 6 languages + 2 code-mixed, drug/dose/diagnosis/investigation truth, clean/fan10/babble5 variants) merged main 5d87140b, PASS bbcb0bba after 2 scorer fix rounds (script-fairness bias, then two systematic scoring-cell fixes; decoy false-hit rate driven to 0/2,472).
  - **S3-judge confirmation suites:** `confirm2` (224 stimuli, every cell ≥8, PASS ec965b16) and `confirm3` + `confirm3diag` (a same-language-babble vs truly-mixed split, plus a 0 dB diagnostic cell kept in its own suite dir; PASS cc9b2822/7397c881) — both went through several id/spec correction rounds with linker and eta-refuter-2 before synthesis, exactly as the process is meant to work.
  - **W34.4 room self-test stimulus pack** (`selftest-room-v1` then `-v2` matching scribe's app layout, sha 57d9bfbc…) plus `score_selftest_room.py`, which went through 3 FAIL/fix rounds (RT60 flagged "reliable" in a noisy room; sweep-based gain wrong; a 0.5 s manifest-offset bug that silently dropped measured SNR from 46 dB to 21 dB) to **PASS at adc6681df3c1** — it now reads the app's real 16 kHz raw tape.pcm + manifest with a tone-corrected alignment.
  - Nightly digital run (23:31, box twin) armed and PASSed (main b7184d37).
- **NOW:** linker's frozen S3 judge v3 is scoring confirm3 (one run, result not yet read); the room scorer is ready for real self-test recordings once RECORDER 0.1.25 ships the in-app hook and the server-side self_test command is fixed and pushed.
- **NEXT:** read the v3 judge result on confirm3; if it clears ≥95%/≥90%, S3 may run on real audio only via Fable's shell pane; Home Office canary of RECORDER 0.1.25's self-test hook (see RECORDER); first live self_test once the server command is pushable.
- **Dependencies:** RECORDER shipping the self-test hook + server command; Fable's shell pane for any real-audio S3 run.
- **Open decisions:** none new.

# 12. LABVIEW — lab viewer + rating pages

- **Purpose:** the authenticated web viewer V uses to read transcripts and rate quality.
- **Exit test:** V rates label200; consult view shows readable transcripts + speakers; /roadmap page renders this file; /clarity shows the automatic scorecard.
- **Status:** on track. **% done:** 93%.
- **Owners:** lab-viewer (builder), eta-refuter-2 (checker).
- **DONE:**
  - /roadmap, speaker chips, rating hub /rate — all LIVE (rev 12/13, unchanged).
  - **PRESCRIBE cards** built (branch lab-viewer/prescribe, 112b994f, PASS #3949): CAP-1 scored items (captured/misheard/absent) next to each of the 24 linked consults, PHI shown behind the existing Access gate; 7 prescribe objects loaded.
  - **/clarity page** built and LIVE (162ff4b8, refuter-2 PASS #4142/#4151 after a world-readable-permissions FAIL was corrected to a non-issue then genuinely fixed to 0700/0600) with a **SCORECARD panel** on top (LIVE fa5e58bb) — S1/S2/S3 old vs new per language, real bug caught in review (S3 trusted the judge's own "usable" flag against its own numbers) and fixed before PASS; a judge-only loader (601c3500) shows S3 honestly while the judge isn't usable yet.
- **NOW:** PRESCRIBE card data is loaded but not yet visible to lab-viewer itself (no Access session in its pane — expected); /clarity clip data (201 objects) is loaded, but the live scorecard load is **blocked by lab-viewer's own pane permission classifier** — needs Fable or a permission rule to finish.
- **NEXT:** unblock the scorecard load; fill in S1/S2/S3 rows as router-fix/cap/linker post them; PRESCRIBE card live check (V or someone with an Access session).
- **Dependencies:** a permission rule for the blocked load; Fable's continued deploy word on each build.
- **Open decisions:** none new.

# 13. FOUNDRY — machines, agents, bus, models, budget

- **Purpose:** the operational substrate everything runs on.
- **Exit test:** all panes on their cheapest passing model; budget tracked; GCP gone; no free-model leakage.
- **Status:** on track. **% done:** 80%.
- **Owners:** Fable (lead), herdr-kit, fleet, minibot, roadmap (records).
- **DONE:**
  - W27 Pool C move (rev 12/13) stands.
  - **Pool map now settled:** Pool A = V's main OpenCode Go (capped, resets ~21:30) — **NO-PHI, invented/public material only** (W29 rule; Pool A stays NO-PHI until Fable confirms otherwise). Pool B = personal OpenCode Go (capped, ~22:00) — small-dose lanes, **PHI OK, no training** (W28 rule). Pool C = V's personal Claude Max (CLAUDE_CONFIG_DIR=~/.claude-personal) — the main PHI harness. FREE = Yoga big-pickle, no PHI. LOCAL = T4 vLLM :8000 / Mini llama.cpp :8082, PHI-safe overflow.
  - **c3 bus visibility fixed (W28.3):** KNOWN_MACHINES now includes the c3 machine id; herdr-kit added a test proving a post to cap/stt-bench resolves and nudges instead of `unknown_agent`; box data shared to c3 read-only (readability/, indic-bakeoff/, cap/, cap2/ group-readable via the eta-sftp jail). Fable's c3-nudge.sh watcher retires once this is confirmed live for running panes.
  - New CC panes stood up for the Sunday wave: lid-debug (opus, debugger), router-fix (sonnet, builder), acoustics (sonnet), freescript (opus, researcher) — see SESSIONS.
- **NOW:** Pool A/B small-dose lanes running alongside Pool C (hist-bulk, lx, herdr-kit, orbox, surg-jev, tone) — one task each, then stop, per W28/W29's rules. local-organizer failed its FAIL-as-scheduled check (F1-F5); yoga-free fixing before any install.
- **NEXT:** confirm Pool A stays NO-PHI (standing, not a one-time ruling); GCP S7 disk delete still waits on V's gcloud auth; DeepSeek Go ZDR re-confirm date check.
- **Dependencies:** V's gcloud auth for S7.
- **Open decisions:** GCP S7 delete timing (V); Zen top-up cadence (standing, D-10).

# 14. SHIP — EvenScribe production releases

- **Purpose:** ship tested, verified production releases without disruption.
- **Exit test:** each train checked by an Opus checker on the exact sha, smoke green, no rollback needed.
- **Status:** at risk. **% done:** 90%.
- **Owners:** scribe (deploy train), eta-refuter (checker), minibot (Mini monitor).
- **DONE:** production 1e75667 live (unchanged). **D4 candidate3 cac6c29 gate PASS** (eta-refuter, 06:30 IST, #4083: merge adds nothing, full gate green); scribe pushed it as a Vercel preview (fast-forward push, `1e75667..cac6c29`, #4113) — this is a preview only, production is untouched.
- **NOW:** **D4 POSTPONED to 21:00 tonight** (Fable, 07:24, #4120). scribe could not promote from its pane (no Vercel access, #4115) and the two env preconditions — SCRIBE_MCP_TOKENS_EXTRA and WHISPER_BULK_URLS — were unverifiable before the 07:45 hard stop, so the preview build `dpl_BskTdL97osLbcSpeaABKAWWuYVVA` **must NOT be promoted**; production stays 1e75667; migration 0119 is **NOT applied** (minibot cancelled its apply on Fable's word, #4122). Home Office pre-check ran read-only 07:45 and PASSed (flags clear, both switches off, #4145). A related question is open: whether to fold the self-test-server fix into cac6c29 (which would void the existing PASS and need a re-gate) or ship it separately afterward — eta-refuter laid out the tradeoff, ruling is Fable's (#4284).
- **NEXT:** 21:00 tonight — confirm both env preconditions, apply migration 0119, promote the (possibly re-gated) build, smoke test; rollback = promote the previous deployment (migration stays).
- **Dependencies:** Vercel dashboard env edits (Fable/V, someone with promote access); migration 0119 by hand; Fable's ruling on folding the self-test-server fix in or shipping it after.
- **Open decisions:** D4's exact sha at 21:00 (cac6c29 as-is, or a re-gated combination with the self-test-server fix) — Fable.

# 15. RECORDER — next Room Recorder fleet release

- **Purpose:** the next release of the EvenScribe Room Recorder app that runs on the room Macs.
- **Exit test:** release ships with the queued fixes; self-update R3 proven; rollout clean.
- **Status:** on track. **% done:** 65%. Owner = scribe (build/deploy) + minibot (Mini monitor) + eta-refuter (checker).
- **Current version:** 0.1.24 live on all rooms. **0.1.25 PASSed at 1da7232cf3.**
- **DONE:**
  - Fable's rulings on the plan (W34.1): tape_advancing from tape.pcm (GO), same-uid reopen never from auto-recovery loops (GO), residual fixes (GO), device_state as an additive app-side poll field now with the server DEVICE_LOST flag shipping AFTER D4 (GO), **auto-start at clinic open GO** (closes D-1 — see ROOMS).
  - **New self-test hook built:** a `self_test` bench command that only runs with no session open or outside the room's clinic window — plays a fixed stimulus (1 kHz tone, log sweep, canary x3, call-and-response) through the Mac's speaker, records it through the room's own mic into a separate segment (never a patient session), uploads it with a manifest for scoring. Stimulus files ship inside the app bundle (diar-lab's invented ElevenLabs set, hashes pinned).
  - **Swift gate PASS at 1da7232** (eta-refuter, on the Air): 637 tests, 2 pre-existing load-sensitive flakes present on the 0.1.24 baseline too (not a regression) — 3 build/fix rounds (7d0c449 FAIL 3 blocking → 5fea782 → 1da7232 PASS).
  - Server-side counterpart `self-test-server` (d82ef4c, migration 0121 widening a check constraint, no new column) built separately, Yoga gate green — but **not yet pushable**: eta-refuter's FAIL stands (the scribe_room_command MCP tool group has no `self_test` variant, so it still answers `unknown_kind` after a deploy).
- **NOW:** Fable's GO (10:20): a signed test build of 1da7232 for **Home Office only**, auto-start left ON, minibot installs it, then the first `self_test` runs there. eta-refuter's canary check: build_sha = 1da7232, app_version still reads 0.1.24 until the self-update completes, and the update ledger must show no self-update back onto a 0.1.24 channel build.
- **NEXT:** minibot packages + installs the signed build on Home Office; first self_test recorded and scored by diar-lab's room scorer (adc6681, PASS); fix + re-gate self-test-server before any live self_test command can actually be sent; Fable picks the first real rollout room after Home Office.
- **Dependencies:** the self-test-server fix + re-gate; Fable's first-room choice after Home Office.
- **Open decisions:** self-test-server fix timing vs D4 (see SHIP); which room follows Home Office.

# 16. ORBOX — OT recorder upgrade for robotic surgery

- **Purpose:** upgrade the OT recorder (Linux orbox3 in ORB3) to capture robotic surgeries: separate USB webcam audio+video, dual audio (TONOR mic + webcam mic), more microphones around the room, possibly wireless directional mics.
- **Exit test:** a robotic surgery captured end-to-end (video + dual audio + room mics) through the pipeline, tested first with SELFTEST stimuli in the empty OT.
- **Status:** just started. **% done:** 15%. Owner to propose.
- **Owners:** orbox (Pool A, design only, NO-PHI) — build owner still to propose.
- **DONE:** **design v2 (W29.1):** every v1 product fact checked against a cited public source or kept UNVERIFIED; a shortlist of 2 hardware bundles (lean / full) priced in rupees; a one-page empty-OT test plan using SELFTEST sounds (tones, canary, clap for sync) checking audio/video sync drift over 60 minutes; the decisions V must make listed in plain words. Output: `~/oc/orbox/ORBOX-DESIGN-v2.md`.
- **NOW:** design complete, awaiting V's decisions.
- **NEXT:** V rules on "speakers" meaning microphones (D-2), consent/PHI policy for OT video (D-3), which hardware bundle to buy (D-4), and who builds it (D-5); hardware purchase; capture software.
- **Dependencies:** V's rulings (D-2..D-5).
- **Open decisions:** see DECISIONS (D-2..D-5) — unchanged, now answerable against a concrete design.

# 17. FREESCRIPT — ETA consult → doctor-voice English note → Pulse FreeScript prescription (NEW, W35)

- **Purpose:** turn a captured clinic encounter into input that Pulse's FreeScript can parse into a draft prescription for that exact patient, without an EvenScribe transcript ever passing for a doctor's own dictation unreviewed.
- **Exit test:** not yet set — first needs V's ruling on the bridge design below.
- **Status:** just started. **% done:** 20%.
- **Owners:** freescript (researcher, opus, read-only — no code changes).
- **DONE:** **FREESCRIPT-STUDY.md** (W35, 371 lines, sha256 b02072fb2026…, at `/home/eta/oc/freescript/FREESCRIPT-STUDY.md`, not a git repo) mapping FreeScript end to end from the Pulse snapshot:
  1. FreeScript is one free-text box in the Pulse v2 editor (HOSPITAL_GP only); dictation is the browser's own Web Speech API fixed to en-IN; only text ever reaches Pulse.
  2. Parse pipeline: text + the draft prescription → `POST /api/emr/parsePrescription` → LLM1 (Gemini 3.1 Pro, T=0.1, a section guide + schema) extracts → a catalogue search per item → LLM2 (Gemini 3.5 Flash) picks or abstains → merges into the draft with `ai_filled` markers. Parse never saves the prescription itself; it writes an audit snapshot. The doctor edits, saves, generates the PDF, and submits.
  3. Data model, IDs and patient/encounter binding mapped with file:line for each.
  4. `freescripteval` scores only entity→catalogue matching (best 91.4%); extraction, negation and dictation quality are not evaluated at all today.
  5. **No external API exists.** The endpoint sits behind Pulse's own doctor-session middleware, needs an existing draft, has no idempotency key, and every call writes an audit snapshot (a Slack alert fires on unmatched medicines).
  6. Gaps for ETA named: FreeScript expects the doctor's own dictation, not a two-speaker room conversation with patient speech and noise; English only; drug-name normalisation; where a human must confirm.
  - Follow-ups delivered: a real adjudicator bug (`BUG-ADJUDICATOR-ENTITYTYPE.md`, a string-mismatch dropping investigation/surgery domain rules, with a one-line fix, no code touched); a CAP→Pulse/FreeScript field mapping (`CAP-MAPPING.md`); a first bridge design (`W35b-ETA-TO-FREESCRIPT-DESIGN.md`): a ZDR LLM writes a doctor-voice note under FreeScript's 11 headings from the diarised English transcript with no prescription context, then a verifier checks evidence/speaker/negation so a stopped drug never lands under Medication; delivery options ranked A (doctor pastes into FreeScript, no Pulse change, recommended) > B (Even pre-fills the field) > C (a new server API); a 20-consult offline pilot plan with recall/precision and 3 zero-tolerance safety counts.
- **NOW:** study complete, awaiting eta-refuter-2's 10-file:line spot-check and V's answers to two open questions: is Gemini's ZDR route acceptable for the stage-A note-writer, and will Even run the staging parse.
- **NEXT:** V's ruling on the two open questions; if approved, a small offline pilot (option A) before any Pulse-side change is even considered.
- **Dependencies:** V's rulings above.
- **Open decisions:** Gemini ZDR for the note-writer; who runs the staging parse (see DECISIONS).

# 18. ACOUSTICS — what we already know about each room, from existing tape (NEW, W34.2)

- **Purpose:** characterise every room's recording acoustics from tape already on hand — no new sound played — and tie it to CLARITY's STT outcomes.
- **Exit test:** a profile per room (mic device, noise floor, SNR, clipping, spectral tilt, reverberation estimate, STT outcome share) covering the last 7 recorded days.
- **Status:** just started. **% done:** 30%. Due ~14:00 today.
- **Owners:** acoustics (builder), eta-refuter-2 (checker).
- **DONE:** room-profile scripts built (57b0f44c), one FAIL round (SNR definition + a VAD-coverage bias, #4228) fixed and PASSed at a9be680a (SNR now on median noise, VAD coverage shown alongside a VAD-free view, #4235).
- **NOW:** the per-room chunk run is in progress (numbers only, no transcript text, per the order).
- **NEXT:** deliver `~/eta-data/acoustics/ROOM-PROFILES-2026-09-27.md` + json for the viewer, due ~14:00; tie findings to lid-debug/stt-bench's per-room STT-outcome data where available.
- **Dependencies:** none blocking; run in progress.
- **Open decisions:** none yet.

---

## Critical path

1. **CLARITY router-fix eval (S1/S2/S3)** — router-fix's offline eval is running; a change ships only if S2 improves and S1/S3 do not get worse (V ruling, W33); nothing deploys to the Mini before Fable's word, earliest after 20:30 tonight.
2. **D4 deploy 21:00 tonight (SHIP)** — cac6c29 gate-PASSed, postponed for env preconditions; needs a promoter, SCRIBE_MCP_TOKENS_EXTRA + WHISPER_BULK_URLS confirmed, migration 0119.
3. **PARITY-389 HF compare (BACKFILL)** — Mini side done (48/48); HF job running (cap $6); verdict gates GCP disk deletion.
4. **OPD 4 recovery (ROOMS)** — DEVICE_MISSING persists; needs a physical look before clinic opens, plus a permission rule for fleet's report_diag.
5. **RECORDER 0.1.25 rollout (RECORDER)** — PASSed 1da7232; Home Office signed test build + first self_test next; self-test-server fix still owed before any live self_test command.
6. **CAP-2 real/placebo (PRESCRIBE)** — pre-registered cc0484c7, Step 0 done, running now.
7. **GCP S7 delete (FOUNDRY)** — V's gcloud auth, after 24h window; gated by the PARITY-389 verdict above.

## 14-day calendar (27 Sep – 10 Oct, IST; box clock)

- **27 Sep (today):** D4 deploy 21:00 (postponed from 07:00); PARITY-389 HF job + compare; CLARITY router-fix eval + S3 judge result; acoustics room profiles due ~14:00; Home Office RECORDER 0.1.25 signed test build + first self_test.
- **28 Sep:** CAP-2 before/after likely; first SELFTEST digital report on the new clinical suite; label200 rating in progress (V).
- **29 Sep:** VJ arm 4 if V's shim + Vertex credential landed; GCP S7 delete window (pending PARITY verdict).
- **30 Sep:** DeepSeek Go ZDR re-confirm date (r449 — check whether it lapses).
- **1–4 Oct:** RECORDER rollout past Home Office (room chosen by Fable); FREESCRIPT pilot if V approves; NOTESAFE fix ships in the release after D4.
- **5–7 Oct:** SPLIT own-model evals; ORBOX hardware purchase if V rules.
- **8–10 Oct:** ORBOX capture pilot in empty OT; NOTESAFE benchmark run for real numbers.

*Anything here that a project owner believes is wrong: say so on the bus to `roadmap` with the correcting evidence (bus id / ruling / sha), and I fix it in the next revision.*
