# ETA LAB — MASTER ROADMAP

Written by the `roadmap` pane (records keeper). This is the one document any orchestrator reads to know where every project stands. Plain words: V is a doctor, not a programmer. Counts and ids only — no patient text anywhere in this file.

Last revision: **26 Sep 2026, ~16:25 IST** (rev 8).

## Changes since last revision

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
| 1 | CLARITY | at risk | 75% | transcripts built; V's 200-row readability rating unblocks the final gate |
| 2 | PRESCRIBE | at risk | 60% | CAP-1 audit v3 bundle built; report due 20:00 tonight |
| 3 | BACKFILL | on track | 85% | archive transcribed; incoming tape catching up on c3; PARITY-389 tonight |
| 4 | ROOMS | at risk | 80% | 8 rooms recording; OPD 4 down ~6h (restart ruled, executor silent); auto-start manual |
| 5 | SPLIT | on track | 70% | 337e speaker labels done; own-model goal pending weekly evals |
| 6 | VOICEPRINT | blocked | 60% | truth sealed; arm 4 waits on V's Vertex credential + scoring venue ruling |
| 7 | ENCOUNTER | blocked | 50% | J-001/J-002/J-004 done; J-003 held on doctor-to-room mapping |
| 8 | SURGERY | paused | 70% | v5 frozen; 84 legacy de-id files await Fable's order; Link-3 sealed |
| 9 | NOTESAFE | paused | 40% | Jev U4/U8 shadow only, flags OFF |
| 10 | TONE | paused | 90% | emotion study closed; service runs in background when enabled |
| 11 | SELFTEST | just started | 25% | spec drafted (7e55ef3); awaiting Fable ruling + ElevenLabs key |
| 12 | LABVIEW | on track | 80% | 427L label200 fix deployed LIVE; V can rate; speaker display + /roadmap next |
| 13 | FOUNDRY | on track | 70% | OpenCode migration done; Zen=overflow-only; GCP exit done; S7 delete pending |
| 14 | SHIP | on track | 90% | production 1e75667 live; 5907cbc held on manual migration 0119 |
| 15 | RECORDER | just started | 10% | next Room Recorder release queued; owner + scope to confirm |
| 16 | ORBOX | just started | 5% | new: OT recorder upgrade for robotic surgery; owner + hardware to decide |

---

# 1. CLARITY — readable, accurate consult transcripts

- **Purpose:** turn raw mixed-language clinic audio into complete, human-readable transcripts, with English under each native line, correct speakers, and garbled lines hidden behind a precision floor.
- **Exit test:** 80% of V's sample reads acceptably; 85% PRESCRIBE capture (a prescription item said in the room appears in the transcript).
- **Status:** at risk. **% done:** 75%.
- **Owners:** lab-viewer (viewer + rating UI, OpenCode qwen3.8-flash), linker (337b English translation, OpenCode glm-5.3-flash), split-speaker (337c/d metrics), diar-lab (337e speakers), Fable (rulings).
- **DONE:**
  - r337 (25 Sep 07:45): declared the top programme.
  - 337a Consult View live; 337b Gemini 3.8 Flash translation of 2,611 windows; 337c 5,130 flagged segments re-transcribed; 337d English-hallucination guard drops 0 of 30 real windows; 337e speaker labels across all 4,167 vault windows (r418).
  - label200 (r414/421a/421c): 200-row sample frozen; calib30 FAILED (63.4% vs 86.7%) so V rates all 200 himself.
  - 427L label200 repair: PASSed by eta-refuter-2 (d5e82fe), merged 1e1a8518, deployed v6713bbe8 (FABLE 450). R5 after-deploy confirmed (16 rows, sha 93fdea08). Language display live. **V can rate now at /rate/label200.**
- **NOW:** V to rate the 200 label200 rows (readability). That single task unblocks the precision floor and the CLARITY exit test.
- **NEXT:** split-speaker scores the readability filter precision from V's export; speaker-display chips in consult view (awaits Fable's "build speaker display"); wire the self-test exclusion filter so acoustic chirps don't show in clinical views.
- **Dependencies:** V's rating; Fable's rulings (speaker display, calib30 fix).
- **Open decisions:** none new — the R2 literal-vs-inclusive follow-mode reading was ruled KEEP literal (FABLE 450); the calib30 shared chunkPlan bug is queued as its own fix.

# 2. PRESCRIBE — CAP-1 audit + CAP-2 vocabularies

- **Purpose:** audit whether prescription items (drugs, doses, diagnoses, investigations, advice) are captured in the transcript, for clinical completeness; then steer STT/translation with vocabularies.
- **Exit test:** CAP-1 report with held-out false-link rate; weekly PRESCRIBE capture score; CAP-2 vocabularies feeding STT/translation.
- **Status:** at risk (report due 20:00 tonight). **% done:** 60%.
- **Owners:** linker (bundle + links, OpenCode glm-5.3-flash), cap (evaluator on eta-ci-c3), eta-refuter-2 (checker).
- **DONE:**
  - r429/430 (26 Sep 09:30): workstream authorised.
  - Bundle v1 FAILED by refuter-2 (33.8% wrong-time false links, chance-level).
  - Bundle v2 posted (27/183 linked, false-link 4.2%); then **bundle v3 built (#3662): 24 linked / 15 confirmed, English complete 189/189, honest smaller n**.
  - Naming PASS (#3655/#3658): cap_link 2b96fdfd + cap_bundle 99023b74 + ceiling f363a3e; MANIFEST 7/7 sha-verified; #3506 re-check PASS (both refusal paths exercised; pins MATCH; selftest 0).
- **NOW:** v3 re-check PASSed by refuter-2 (#3687): 183/183 exact, held-out false-link 1.8-7.4% / false-confirmed 0.6-3.3%. **cap may score v3 for the 20:00 report.** Before V runs `run` (patient audio leaves the machine): draw.json-vs-commit + salt reveal.
- **NEXT:** cap scores v3 → 20:00 report (must carry the held-out rates; the +120 shift any-link 7.4% sits above the 5% target, confirmed ≤3.3%) → refuter-2's 10-random-confirmed check.
- **Dependencies:** V runs 337b translation pass + c3 apply script 81207f53; OpenRouter top-up for ceiling audio.
- **Open decisions:** none (see DECISIONS for V's manual steps).

# 3. BACKFILL — every recorded hour transcribed

- **Purpose:** transcribe every recorded clinic hour (historical archive + daily incoming tape) with zero failures, no GCP.
- **Exit test:** each clinic day done by 07:00 next morning, 0 failures, no GCP.
- **Status:** on track. **% done:** 85%.
- **Owners:** hist-miner (Stage 1 anchors), hist-bulk (Stage 2 bulk + c3 loop), lab-mover (compute), join-shard (audio-join sharding), eta-refuter-2 (checker).
- **DONE:**
  - Full archive accounting: 4,507/4,507 windows transcribed across Tier A/B on 62 cloud routers, 0 problems (r309).
  - c3 high-throughput loop live: 14.2 audio-hours/hour, 0 failures (J-hist-c3).
  - audio-join 32-shard Worker deployed (r220).
  - GCP fully exited; all 5 GCP nodes powered off (r386/r419); archive mirrored twice.
- **NOW:** incoming 25 Sep tape transcribing on c3; tier-C backlog caught up. lab-mover relaunched clean — PARITY path green (six hashes re-verified, tape cron healthy, HF credit OK).
- **NEXT:** PARITY-389 tonight (~21:15-21:30, GO by fleet; six hashes; hard stop 07:25-07:30; cap $10) — proves the HF A10G STT stack matches Mini production. c13 gate-1 gap: accept (like l4) or short-restart — Fable's call.
- **Dependencies:** PARITY needs rooms stopped + empty Mini queue + fleet's GO; c13 gap ruling.
- **Open decisions:** c13 gate-1 accept-vs-restart (Fable).

# 4. ROOMS — every clinic hour recorded

- **Purpose:** ensure every room records during clinic hours, detect silent stalls, and fix hardware.
- **Exit test:** every clinic hour captured; 0 unexplained silent tape; room faults auto-alerted.
- **Status:** at risk. **% done:** 80%.
- **Owners:** fleet (fleet-watch 24x7 monitor), scribe (recording accounting + alarms), radar-kit (mic self-test), herdr-kit.
- **DONE:**
  - fleet-watch live (r399), 5-min polling, $2/day cap; NOT_RECORDING/NOT_DELIVERING alerts working.
  - Exact-zero tape root cause: TONOR TM20 hardware mute (r255/280) — but OPD 4 uses a C270 webcam (no mute), cause re-opened (r336/355).
  - C270 mic proven functional by acoustic test (r368).
- **NOW:** 8 rooms recording. **OPD 4 down since 10:59 IST (DEVICE_MISSING + ENCODER_STALLED; C270 not enumerated; audio loss ~6h). FABLE 453.0 ruled RESTART (~15:45) but no executor has acted ~20 min — minibot is the only Mini write-scope holder in the record; escalated URGENT to Fable.** Dietary Room Mac silent since 24 Sep (hostname unknown — ask V which Mac).
- **NEXT:** auto-start at clinic open (item 151, V's decision) — no auto-start mechanism exists today, staff press Start manually; device-missing + NOT_DELIVERING handling; Physical inspection of OPD 4 and Dietary Mac.
- **Dependencies:** V's ruling on auto-start; physical access; a live executor for the OPD 4 restart.
- **Open decisions:** OPD 4 restart executor (escalated to Fable); Dietary Mac identity; auto-start build.

# 5. SPLIT — diarization (who spoke when)

- **Purpose:** speaker labels + counts; own model within 3 DER points of pyannote.ai.
- **Exit test:** own diarization model within 3 DER points of pyannote.ai on 2 weekly evals.
- **Status:** on track. **% done:** 70%.
- **Owners:** diar-lab (runner), eta-refuter-2 (checker). pyannote.ai primary now; Nemotron local shadow.
- **DONE:** Nemotron fine-tune halted (collapsed on minor speakers; untuned base beat tuned) — r94/210. 337e speaker labeling complete across 4,167 windows (r418).
- **NOW:** pyannote.ai hybrid in production; speaker A/B/C labels stored under kind `speaker`.
- **NEXT:** score diarizer count accuracy vs 30-window human consensus (once ≥20 rated); own-model evals on 2 weekly windows.
- **Dependencies:** human rating of the 30-window benchmark (8/30 done).
- **Open decisions:** none.

# 6. VOICEPRINT — doctor identity by voice

- **Purpose:** attribute speech to doctor vs patient vs other, guarded by cryptographic blinding; mint permanent doctor voice centroids.
- **Exit test:** voice centroids that pass the r182 positive/negative controls; Who-is-speaking page rated by V.
- **Status:** blocked. **% done:** 60%.
- **Owners:** vj-data, vj-arms, vj-link (builders), vj-refuter (the ONLY pane that sees sealed truth).
- **DONE:** blinding architecture (unix user `vjscore`, mode 700 vault) — r168. Centroid controls pass (0.74-0.86 pos, <0.40 neg) — r182/186. 90-item "Who is speaking" page + 20 top-ups published. V's truth encrypted into sealed vault `~/eta-data/vj-truth-sealed` (r422). J-005/J-006 cards done (arms 2+3).
- **NOW:** Arm 4 (Gemini audio on Vertex AI) blocked on box credential plumbing; vj-arms asked to close voluntarily to save Zen. Tonight's 19:30 seal mirror pending — a 4th sealed blob (wis-labels-V-20260926.json.gpg) is present; mirror 3 approved or all 4 (Fable/vj-refuter call).
- **NEXT:** V deploy gcloud shim be2b6682 + temporary Vertex credentials (r425.5); pin Vertex model id; run arm 4; vj-refuter final scoring from sealed vault once venue ruled (item 137).
- **Dependencies:** V's credential deploy; scoring-venue ruling.
- **Open decisions:** VJ final scoring venue (item 137).

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
- **Status:** paused. **% done:** 40%.
- **Owners:** fleet (builder), eta-refuter (checker).
- **DONE:** Jev U4/U8 logic implemented behind flag `JEV_NOTE_FAITHFULNESS`. Refuter FINDING 1: JevHttpError must never expose provider body.
- **NOW:** shadow mode only, flags OFF.
- **NEXT:** finish medication-note benchmark; confirm false-flag <25%; then consider enabling.
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
- **Status:** just started. **% done:** 25%.
- **Owners:** diar-lab (lead/spec), lab-mover (plumbing), fleet (device checks), radar-kit (mic self-test).
- **DONE:** authorised r428/428a; spec drafted and on main (058dcd4, spec draft 7e55ef3); Home Office Mac reserved as the acoustic rig; digital path on non-Google machines.
- **NOW:** spec awaits Fable's ruling (phrase-set owner, Indic TTS fallbacks, cron schedule). ElevenLabs key returns HTTP 401 (V re-saves).
- **NEXT:** V re-save ElevenLabs key; Fable rule on spec; build stimulus generator + digital injector.
- **Dependencies:** Fable ruling; ElevenLabs key.
- **Open decisions:** spec questions (Kanglish phrase set, TTS fallbacks, schedule).

# 12. LABVIEW — lab viewer + rating pages

- **Purpose:** the authenticated web viewer V uses to read transcripts and rate quality.
- **Exit test:** V rates label200; consult view shows readable transcripts + speakers; /roadmap page renders this file.
- **Status:** on track. **% done:** 80%.
- **Owners:** lab-viewer (builder), eta-refuter-2 (checker).
- **DONE:** viewer redesigned (r328) and live at lab.llmvinayminihome.uk behind Cloudflare Access; Consult View (337a); rating sets hosted (r359); 427L label200 fix LIVE (FABLE 450, v6713bbe8); 451 values applied (ALLOWED_EMAILS 6, RATERS 3). 451 thread CLOSED — Zaki's successful login verified (#3716); the two email-list shas stay UNVERIFIED by design.
- **NOW:** V can rate label200 with language display working.
- **NEXT:** speaker A/B/C chips in consult view; add a `/roadmap` page that renders docs/ROADMAP.md for V; calib30 chunkPlan fix (queued, own check).
- **Dependencies:** Fable rulings.
- **Open decisions:** none new.

# 13. FOUNDRY — machines, agents, bus, models, budget

- **Purpose:** the operational substrate everything runs on.
- **Exit test:** all panes on their cheapest passing model; budget tracked; GCP gone; no free-model leakage.
- **Status:** on track. **% done:** 70%.
- **Owners:** Fable (lead), herdr-kit, fleet, tunnel-ops, radar-kit, lab-mover, conductor.
- **DONE:** OpenCode migration complete (r432; FABLE 452 all-Go sweep, -cc panes stopped). Checkers → opencode-go/deepseek-v4-pro (r449). Zen = overflow-only from now (r452). GCP exit: compute stopped, disks awaiting S7 delete. Zen ledger live (zen-meter-go PASS 904f79b+807d0b3, bin moved to bd4c2e6). Privacy PASS (448): free-model fallback dead account-wide. Bus `fable` recipient confirmed resolving (stored_poll, #3711).
- **NOW:** console Zen $181.00 anchor after bin move (#3712); fleet recomputes the delta. FREE MODEL SEEN 3 fires total, 2 on Mini dirs (`mini:dir:nophi-run`, `mini:dir:eta-lab`) — both with Fable for attribution (#3719/#3720/#3725). nophi-run account STOPPED per D.5 (free tier refused on both paths; paid refused insufficient funds) — V's call on device-login vs drop (#3721).
- **NEXT:** GCP S7 disk/snapshot deletion (V's gcloud auth, after 24h window); herdr-kit applies key-read denials + owns the local-model plan (Ollama on Mini/box T4; benchmark 5 tasks vs Go flash); builder calibration evals.
- **Dependencies:** V's gcloud auth for S7; if V has not yet restarted the eta-bus server, the async-wake/timeout fixes still land on that restart (fable addressing already confirmed working).
- **Open decisions:** Zen top-up cadence (no auto-reload per r407); idle-pane memory target; the two Mini free-model fires are Fable's routing call; nophi-run account disposition (V).

# 14. SHIP — EvenScribe production releases

- **Purpose:** ship tested, verified production releases without disruption.
- **Exit test:** each train checked by a checker on the exact sha, smoke green, no rollback needed. Checker model = opencode-go/deepseek-v4-pro; kimi-k3 is reserved for production-deploy/security checks (r449).
- **Status:** on track. **% done:** 90%.
- **Owners:** scribe (deploy train), eta-refuter (checker), minibot (Mini monitor).
- **DONE:** production 1e75667 live (route fix, smoke 924/924). Trains 73868e4 (209/209) and a92ebae (loop-guard + emotion dedupe) shipped.
- **NOW:** candidate 5907cbc (watchdog candidate 2, migration 0119, tokens-extra) held on Fable's order.
- **NEXT:** deploy 5907cbc once migration 0119 is manually executed (r339); whisper-gcpl4 removal from WHISPER_BULK_URLS on next push.
- **Dependencies:** manual migration 0119; Vercel env edits by Fable/V.
- **Open decisions:** 5907cbc deploy timing.

# 15. RECORDER — next Room Recorder fleet release

- **Purpose:** the next release of the EvenScribe Room Recorder app that runs on the room Macs.
- **Exit test:** release ships with the queued fixes; self-update R3 proven; rollout clean.
- **Status:** just started. **% done:** 15%. Owner = scribe (build/deploy) + minibot (Mini monitor).
- **Current version:** 0.1.24 (confirmed from the DB install row). Next release = **0.1.25**.
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
2. **CAP-1 report 20:00 (PRESCRIBE)** — v3 re-check PASSed; cap scores v3 → report.
3. **PARITY-389 tonight (BACKFILL)** — fleet GO → capture on Mini + HF A10G → parity verdict.
4. **OPD 4 recovery (ROOMS)** — physical; recording resumes.
5. **GCP S7 delete (FOUNDRY)** — V's gcloud auth, after 24h window.

## 14-day calendar (27 Sep – 10 Oct, IST; box clock)

- **26 Sep (tonight):** PARITY-389 (~21:15-21:30), hard stop 27 Sep 07:30.
- **27 Sep:** PARITY verdict + report; c3 backlog clear; ROOMS auto-start decision to V.
- **28 Sep:** CAP-1 report reviewed; label200 rating likely in progress (V).
- **29 Sep:** VJ arm 4 if Vertex credential landed; GCP S7 delete window.
- **30 Sep:** DeepSeek Go ZDR re-confirm date (r449 — check whether it lapses).
- **1–4 Oct:** speaker display + /roadmap page (LABVIEW); SELFTEST rig build.
- **5–7 Oct:** SPLIT own-model evals begin; RECORDER release scoped.
- **8–10 Oct:** ORBOX capture pilot in empty OT; NOTESAFE benchmark (if resumed).

---

*Anything here that a project owner believes is wrong: say so on the bus to `roadmap` with the correcting evidence (bus id / ruling / sha), and I fix it in the next revision.*
