# ETA LAB — MASTER ROADMAP

Written by the `roadmap` pane (records keeper). This is the one document any orchestrator reads to know where every project stands. Plain words: V is a doctor, not a programmer. Counts and ids only — no patient text anywhere in this file.

Last revision: **28 Sep 2026, ~13:20 IST** (rev 15).

## Where everything stands (plain English, one line each)

1. **CLARITY** — the fix for language mixing made real results worse, so it will NOT ship as-is; root cause is now understood (the Hindi/Tamil/Kannada engine gets confused by noise, plus real content loss even when routed correctly). Effort moved to a bigger system (REB, below) that runs every engine and lets a scorer pick the best output. Next: get that system running at full scale. *28 Sep.*
2. **PRESCRIBE** — drug-capture study (CAP-2) is running on real recordings; a companion test compares 3 outside medical speech engines against it. Next: finish both and read the before/after numbers. *28 Sep.*
3. **BACKFILL** — every clinic day is being transcribed on schedule (~40 min behind live). The cloud-vs-office-Mac comparison test came back **NO MATCH** (scope not met), so cloud computers are not yet trusted as a backup path; nightly linking of visits to prescriptions now runs itself. Next: decide whether to re-test cloud parity later. *28 Sep.*
4. **ROOMS** — all rooms recording; the "app won't update" scare in several rooms turned out to be old, already-fixed history, not a new bug — closed. The new room-status page (Room Timeline) is live for you. *28 Sep.*
5. **SPLIT** — steady, no change this period; the diarizer REB uses is the same one production uses. *28 Sep.*
6. **VOICEPRINT** — **your Manoj Kumar S package is the day's priority** (see W52 below); voice-matching speed is the risk to the 5pm deadline.
7. **ENCOUNTER** — a new system that spots consult start/end by listening for cues (greeting, exam, prescription) is built and being tested; it will surface inside Room Timeline. *28 Sep.*
8. **SURGERY** — widened to catch other procedures too (injections, endoscopy, etc), not just surgery; a real-case review page is live for rating; early conversion numbers are in (roughly a fifth to half of pitched cases get booked). *28 Sep.*
9. **NOTESAFE** — the safety check (no patient text leaking into error logs) is built and confirmed; a planned extra de-identification step was dropped because your AI vendor (Jev/TypeSafe) confirmed it never stores or trains on the data. *28 Sep.*
10. **TONE** — early results are weak: the emotion engine barely recognises anger/anxiety/sadness in this audio; a second engine does better on some emotions, worse on others. Also found: the system never labels anyone "patient", only "doctor" — a design gap being fixed. *28 Sep.*
11. **SELFTEST** — the automatic nightly test of the whole pipeline is running and passing every night; a bigger clinical-style test set was designed but paused (its voice-generation budget ran low). *28 Sep.*
12. **LABVIEW** — the Room Timeline page you approved is live with real data; it will grow to show every engine's output side-by-side as that data backfills. *28 Sep.*
13. **FOUNDRY** — cloud GPU strategy settled (pay-per-job, not always-on); several reliability fixes shipped; a Mac-disk housekeeping plan is written and runs tonight after clinic hours. *28 Sep.*
14. **SHIP** — yesterday's release is live and healthy; the deploy mistake that nearly happened is documented so it won't repeat; one more small release (device-status fix) is ready, waiting for the go-ahead. *28 Sep.*
15. **RECORDER** — the room "signature mismatch" bug is understood: old superseded app copies, not a new bug — closed. The in-app self-test feature is built; one permission gap still blocks sending a live test. *28 Sep.*
16. **ORBOX** — no change this period; still waiting on your decisions (microphones vs speakers, video consent, hardware budget).
17. **FREESCRIPT** — delivered: instead of a doctor pasting text, ETA will hand Pulse's team a structured data file per consult; the design is written up and ready to hand off. *28 Sep — closed for this phase.*
18. **ACOUSTICS** — finished: two rooms (OPD 1 mildly, Third Floor materially) miss real speech because the noise-detector cuts it; a tuning fix was tried and did not help, so it needs a different approach. *28 Sep — closed for this phase.*
19. **REB — Room Evidence Bundle** *(NEW)* — the "run every engine, keep every output" foundation for CLARITY is built and proven on a 222-clip test batch (0 crashes). Next: run it on a full day of real clinic tape. *28 Sep.*
20. **FUSER / G3 — the transcript-fusion scorer** *(NEW)* — the system that reads every engine's output and writes one trustworthy transcript is built and had its first full test run; a second run stopped early at a cost limit. You are the final human rater once it freezes.
21. **W50 — clinical speech-engine bake-off** *(NEW)* — testing 3 outside medical speech engines against your recordings; one was dropped (kept failing), the other two are now on the harder real-consult test.
22. **W52 — Manoj Kumar S package** *(NEW, your request, urgent)* — every recording, transcript and prescription of Dr Manoj Kumar S's OPD 4/7 consults, in one folder. Recordings cut (89 encounters) and prescriptions pulled (367 lines) are DONE; voice-matching is 22 of 39 room-days scanned; the remaining voice-matching step is running too slowly on the office computer to finish by 5pm without more cloud power — a decision on that is pending. First partial delivery due ~3pm regardless.
23. **W51 — Manoj voice study (formal)** *(NEW)* — the rigorous, scientific version of the voice check above; its first plan was invalidated by a shortcut found in the urgent package's own data, so it is paused until W52 ships.

## Changes since rev 14

Rev 14 was 27 Sep ~10:45 IST (78e461e4). This revision covers a full day of work: the CLARITY router fix was tested and REJECTED; the whole CLARITY effort re-based onto a new multi-engine architecture (REB) with a scoring layer (FUSER/G3) on top; a clinical-STT bake-off (W50) and two brand-new, V-ordered, high-priority projects landed (W51/W52, Dr Manoj Kumar S's voice and encounter package); production shipped twice; RECORDER's signature bug was closed; ACOUSTICS and FREESCRIPT both finished their first phase; SURGERY, TONE and NOTESAFE all moved. Roadmap is now **23 projects** (added REB, FUSER, W50 BAKEOFF, W52 MANOJ PACKAGE, W51 MANOJ VOICE STUDY).

- **CLARITY — router fix M1-M5 REJECTED; root cause settled; effort moves to REB.** router-fix's pre-registered S1 re-run (ADDENDUM-3, pinned f972df6, witnessed #4584) reproduced **WORSE**: ALL-language hit rate 80.95%→73.13% (CI [-10.9,-5.0]), ml -25.4pt, hi-en -18.3pt — Fable ruled 12:50 the fix does not ship. M6 (wrong-Indic-language routing) was first blamed for 25-36% of the loss, then that measurement was found to rest on an unreliable field (segment-count tiebreak, not the router's real field, #4586/#4592/#4613); the corrected, FINAL reading (S1-REPORT.md) is: SraVaani itself mis-identifies Hindi as Tamil script under babble noise (≥12/64, a defect M6 structurally cannot fix) and correctly-routed content loss (~52/64, mechanism still provisional) is the larger factor. An ETR (English Token Recovery, numbers/units/day-counts) side-experiment passed its real-audio decoy sweep 0/100,000 false anchors but with near-zero recall — folded into FUSER v0 instead of shipping alone. **V approved (13:30) the REB — Room Evidence Bundle: run every engine independently, store every output, fuse downstream** — see project 19.
- **REB (NEW, W47) built end-to-end.** Spec `REB-SPEC-v1.md`. Sizing done (whisper 52-100x realtime, SraVaani 5.3x CPU-heaviest, pyannote-diar 14x; HF L4 IndicConformer+SraVaani validated at **18.7x realtime, $0.043/tape-hour** on real clinic audio). Library (schema+writer+validator+reb.py) built, hardened through 3 real-bug FAIL→PASS rounds (orphaned tracks on failed first write, R2-mirror rollback ordering, tracks() silently dropping failed-only engines), merged main **1ee3b4a4**. Fan-out runner (claim-once, lease+fencing) built and merged. **DEV ingest (222 windows: 192 clinical1 synthetic + 30 real DEV30 clips) COMPLETE: 222/222, 0 crashed, 1,998 stt tracks, 1,857 ok / 141 empty / 0 failed**, triple-verified. Full-day 26/27 Sep backfill (~260 tape-hours/day) not yet run at scale.
- **FUSER v1 / G3 (NEW) built, first scoring run done.** Design (lid-debug) + build (router-fix) witnessed through 4 addenda; B1 (pre-pass: tokens/agreement/LID/drug-matcher) and B2/B3 (schema/prompt/validator) complete and PASSed, closing two real safety holes (yes/no affirmations wrongly allow-listed; uncitable context tokens not rejected). **B4 RUN 1 complete: 222/222 windows, $6.85, 0 errors** — pass 39 (17.6%) / repair 130 (58.6%) / fallback 53 (23.9%); DEV30 stratum 30/30 pass. RUN 2 (prompt fix ce91eb1) **halted at cost cap**: 17/222 done, $0.757 spent, projected total $11.10 > $10 cap, driven by one outlier reply that hit the model's token ceiling — holding for Fable's call. **V ruled (28 Sep 06:27) he is the G3 rater** himself; lid-debug writes a dated addendum, then a blinded review page for lab-viewer, after the fuser freeze.
- **W50 clinical-engine bake-off (NEW, medasr / whisper-med-merged / parakeet-med).** parakeet-med **withdrawn** (deterministic truncation at smoke, 4-iteration debug cap spent, ADDENDUM-18). medasr + whisper-med-merged passed smoke on real HF Jobs. **Set (b) (192 clinical1 windows) SCORED: 384/384 tracks committed, 0 rejected**, independently verified. Set (c) (87 real consults / 102 drug items, capped at 60-min spans) built end-to-end (manifest resolution, decoder, upload guards) through a long pre-registration chain (17 addenda, both refuters witnessing every step) — the chain is now **closed**; scoring is running (3/87 windows done as of the last read). Truth set = 22-24 Sep CAP-linked consults (kept separate from the fuser's own 24-consult TEST set). MedASR terms are lab-evaluation only; production use needs Even's legal review if it wins.
- **W52 MANOJ PACKAGE (NEW, V priority, 28 Sep).** V minted a voice centroid for Dr Manoj Kumar S (ortho); asked for every OPD 4/7 encounter of his, across all recorded days, as audio + his-speech clips + transcripts + Pulse prescriptions, in one folder. **linker: 176 PQM consults (19 Aug-27 Sep), 174 linked to Rx, 367 Rx line items; encounter cut DONE — 89 final clips + 28 his-speech compilations** (176 rows: 89 ok, 30 no tape in span, 50 no tape inventory, 2 tape-gap artifact, 5 skipped). **lx: voice scan 22/39 OPD4+OPD7 room-days done — 28 FOUND, 2 WEAK, 47 no-evidence**, cross-verified exact-match by vj-refuter. **[URGENT BLOCKER, #5320]**: diarization is running at ~0.37x realtime on 4 CPU workers (14.06h of audio, only 1.5% done at last read) — will NOT hit the 16:30-17:00 full-package deadline without a GPU escalation (hf-fleet L4, within the already-approved $40 cap) or reordering FOUND/WEAK clips first. First cut still due ~15:00. Two real bugs found and fixed along the way (a stale summary key that mislogged every clip as FAIL; a 4-way "parallel" run with no real sharding, all 4 workers doing the same clips in lockstep) — both VERIFIED. vj-refuter's spot-check judged the 0.65 attribution bar miscalibrated and recommends treating unscanned room-days as **NOT SCANNED**, never "not him", until the GPU scan lands.
- **W51 MANOJ VOICE STUDY (NEW, formal).** Prereg v2 **FAILED** review (#5319): it was overtaken by W52's own stored voice-print and scan data (no longer blind test data), its ±180s pad conflicts with Fable's ±30s attribution ruling, and it has no placebo arm. lx acknowledges and defers a v3 prereg until after W52 ships (V's stated priority today).
- **SHIP — production shipped twice; a deploy lesson learned and documented.** Post-D4 train **4d7d8e0 live 21:48** (fast-forward ed869d2→4d7d8e0, health confirmed within ~11 min). **Lesson (now standing rule, Fable): any push to `vinay/s1-auto-drain` IS a production deploy** — migration 0119 was found already running live from 07:17 without it; Fable applied 0119 (21:14) and 0121 (21:22) and redeployed fresh (dpl_3s2o) before the next push. A self-test-server MCP room-scope fix (default-deny at the call boundary, closing a real session_id bypass eta-refuter reproduced) is merged onto the post-D4 branch, full gate green — **not yet pushed, waiting on Fable's GO**.
- **RECORDER — signature_mismatch bug root-caused and CLOSED.** Every failure traced to app build 0.1.8 (pre-0.1.18 anchor-trust fix); the "27 Sep" OPD1/OPD4 mismatches were stale 17-Sep launchd log text, not new failures — confirmed by source read + DB + an offline repro on the Air. W37 closed; a small 0.1.26 fix spec was written (save codesign stderr, ISO-UTC log lines) for later. Home Office's self_test is parked: minibot's MCP token lacks write scope (same underlying gap SHIP just fixed for room commands generally); scribe is designing the least-privilege fix.
- **ACOUSTICS — W39 finished.** A1 (VAD-blind check): OPD 1 misses 9.4% of real speech (mild), **Third Floor misses 23.7% (material)**. A VAD-threshold sweep (0.5/0.35/0.2) was pre-registered and **found no win** — neither alternative beats the current 0.5 setting without leaking more non-speech; Third Floor needs a physical remediation (mic placement/swap), not a software tune. A2 (acoustic-vs-transcript-quality correlation) initially reported backwards and was corrected by eta-refuter-2: empty transcripts correlate with **quieter**, not noisier, windows (nobody talking, not VAD starvation). Final report done, sha 3aceec (both refuters).
- **FREESCRIPT — W38 closed.** V ruled (27 Sep): no doctor-paste, no Pulse code change — ETA instead produces a versioned structured JSON artifact (`eta.freescript.v0.1`) that Pulse's own team integrates. Schema + docs (`README-FOR-PULSE.md`) + 3 example artifacts + an offline prototype (5 real linked CAP consults, scored for recall/precision/safety) all built, PASSed after fixing 3 real stopped-drug/order-guard holes. Handed off to Pulse/V; this ETA-side phase is done.
- **SURGERY — widened + real data flowing.** W46 (surg-link): scope now covers interventional procedures generally (injections, endoscopy, cath/angio, biopsies), not just surgery; a `pitch25` real-case review set (de-identified, 15 cases) is live on lab-viewer with inline provenance; interim conversion 21-53% by doctor/procedure (25-26 Sep CAP batch: 19 pitched, 3 booked, 1 referred, 15 not booked).
- **NOTESAFE — Jev audit done; ZDR ruling withdraws de-id work.** W36 audit: 43 Jev call sites, 17 PASS/23 GAP/2 UNVERIFIED/1 REFUTED, two real HIGH findings (surgery study sent pre-de-id text to Jev/OpenRouter; prod logged raw error text that could echo PHI). **V ruled (27 Sep 12:55): Jev (TypeSafe) and OpenRouter/Gemini are ZDR for Even — no de-identification is needed before sending to them.** This withdrew jev-fix F1 and F5 (the de-id fixes) after F1 was already built; F2 (pin the Jev model version), F3 (route legacy calls through logging) and F4 (one constants module) shipped.
- **TONE — W45 weak first results, a real design gap found.** wavlm scored 0/12 on anxious/angry/sad in every language tested; a Gemini arm improved angry (0→6/12) but broke neutral (→0/12) — per-language rankings flip between engines, an engine artifact, not a language fact. Pilot moved to 24 Sep (26 Sep had zero transcribed/diarized windows at pilot time) and found `room_turn_speaker.role` is **never** set to "patient", only "clinician" or null — the sentiment design is being corrected for this before it goes further.
- **ENCOUNTER — W44 Jev encounter-loop built.** lx's harness (keyword/state-machine + Jev per-chunk classification of consult phase) passed its offline selftest (27/27) with conditions; superseded as a *page* by /timeline (W49) but the detection loop itself continues independently and feeds it.
- **LABVIEW — /timeline shipped in 3 phases.** P1 (tape coverage, PQM truth, fleet alerts) **LIVE 78921667**; P2 (audio playback inside the existing Access-gated proxy, a Prescription/Sound/Technical inspector, an append-only view log) **LIVE cc416d93**; P3 (REB per-engine layers in the inspector) **LIVE 82936ec9** after 2 real bugs fixed (wrong track-selection key, segment-clock handling). `pitch25` (surgery review set) also shipped, 15/15 rows loaded. Several "X of Y" labels were caught overclaiming completeness and fixed.
- **BACKFILL — PARITY-389 final verdict: NO MATCH, scope not met; nightly PQM automation now live.** The retried HF-vs-Mini compare (fixed for 2 real bugs: a refused-key false-absence and a SraVaani-mode confound) still came back NO MATCH — the HF capture used `SRAVAANI_MODE=local` instead of the Mini's real instance, so SraVaani-routed windows are not comparable; **Fable ruled (17:25) SraVaani out of scope, no further capture spend**; a tailnet ACL gap (HF cannot reach the Yoga SraVaani instance) is the underlying blocker if this is ever revisited. Whisper-path divergence (content differs 1.4-21.2%, median ~9%, across windows) is a real, documented finding, not decode noise. Separately, hist-bulk confirmed live daily transcription on schedule (lag ~30-50 min, box T4 added as a second worker) and a nightly PQM-linking crontab (23:45 IST) is now live and self-healing.
- **FOUNDRY — HF GPU strategy settled; bus and mirror reliability fixed; Mini disk plan written.** HF compute = **HF Jobs (`l4x1`), not always-on Spaces** (Spaces hit a known mount bug on this image); up to 5 concurrent L4 jobs approved. A real bus-latency bug (3 serial remote calls per post) was found and fixed (parallelized, ~1.5x faster). The nightly backup-mirror script went through a real multi-bug hardening cycle (a patient-audio-path log leak, a return-code leak across days, a wrong process-kill scope, wrong midnight math) — fixed and running (rc=0, 0 failures on the last real run). Mini disk-hygiene plan (W42) is written (which stale dev trees are safe to move to the external SSDs) and scheduled to execute tonight after 20:30 + D4 healthy.

---

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

- **Project** = one of the 23 named programmes below.
- **Status** = on track / at risk / blocked / just started / paused.
- **% done** = my estimate against the project's exit test, not against a plan.
- **DONE / NOW / NEXT** = the latest facts, dated. Bus ids in `#…`, rulings as `r…`.
- Every statement comes from the bus, `orders/RULINGS-*.md`, `board/`, `handover/`, or `git log`. Anything I could not verify is marked **UNVERIFIED**.

---

## The 23 projects at a glance

| # | Project | Status | % done | One-line state |
|---|---|---|---|---|
| 1 | CLARITY | blocked | 55% | router fix M1-M5 REJECTED (S1 WORSE, confirmed); root cause settled; effort now rides REB/FUSER instead |
| 2 | PRESCRIBE | at risk | 78% | CAP-2 real/placebo running; router-arm S2 + W50 bake-off both feed off it |
| 3 | BACKFILL | at risk | 85% | daily transcription on schedule; PARITY-389 final verdict NO MATCH (scope not met, SraVaani excluded) |
| 4 | ROOMS | on track | 85% | all rooms recording; signature-mismatch bug closed (old app instances only); Room Timeline live |
| 5 | SPLIT | on track | 70% | steady; REB's diar layer of record = production's own pyannote.ai |
| 6 | VOICEPRINT | at risk | 55% | W52 Manoj package is the day's priority; diarization speed risks the 17:00 deadline |
| 7 | ENCOUNTER | at work | 60% | W44 Jev encounter-loop built + PASS-with-conditions; feeds /timeline |
| 8 | SURGERY | on track | 65% | widened to all interventional procedures; pitch25 real-case review live; interim conversion 21-53% |
| 9 | NOTESAFE | on track | 75% | provider-text fix + med-bench both live; de-id steps withdrawn (Jev/OpenRouter ruled ZDR) |
| 10 | TONE | at risk | 35% | wavlm weak on non-neutral emotions; Gemini arm inconsistent; "patient" role field never populated — design gap found |
| 11 | SELFTEST | on track | 65% | nightly digital run passing every night; bigger clinical suite designed, paused on TTS budget |
| 12 | LABVIEW | on track | 95% | /timeline P1+P2+P3 all LIVE; pitch25 live; /clarity scorecard live |
| 13 | FOUNDRY | on track | 85% | HF Jobs strategy settled; bus latency + mirror reliability fixed; Mini disk plan runs tonight |
| 14 | SHIP | on track | 92% | production live 4d7d8e0; deploy lesson documented; self-test-server fix PASSed, awaiting GO to push |
| 15 | RECORDER | on track | 75% | signature bug closed; self-test hook built; self_test write-scope gap still blocks a live run |
| 16 | ORBOX | just started | 15% | unchanged; still waiting on V's hardware/consent decisions |
| 17 | FREESCRIPT | on track | 95% | W38 closed — artifact schema + docs + prototype delivered, handed to Pulse/V |
| 18 | ACOUSTICS | on track | 90% | W39 closed — Third Floor material speech-loss found; VAD-tune attempt found no win, needs physical fix |
| 19 | REB | on track | 45% | Room Evidence Bundle infra built + DEV-ingest PASSed (222/222); full-day backfill not yet run at scale |
| 20 | FUSER / G3 | at work | 55% | B1-B3 PASSed; B4 RUN 1 done; RUN 2 halted at cost cap; V is the final rater |
| 21 | W50 BAKEOFF | at work | 55% | parakeet-med withdrawn; set (b) scored 384/384; set (c) real-consult scoring running |
| 22 | W52 MANOJ PACKAGE | at risk | 60% | encounters + Rx DONE; voice scan 22/39 room-days; diarization speed risks the 17:00 full-cut deadline |
| 23 | W51 MANOJ VOICE STUDY | blocked | 20% | prereg v2 FAILED (overtaken by W52's own data); v3 deferred until after W52 ships |

---

# 1. CLARITY — readable, accurate consult transcripts

- **Purpose:** turn raw mixed-language clinic audio into complete, human-readable transcripts, with English under each native line, correct speakers, and garbled lines hidden behind a precision floor.
- **Exit test:** judged by the automatic S1/S2/S3 scorecard (V ruling, W33, 27 Sep); win rule = S2 improves AND S1 not worse (S3 indicative only for now).
- **Status:** blocked. **% done:** 55%.
- **Owners:** lid-debug (root cause, consultant), router-fix (builder — now the FUSER builder too), diar-lab (S1 suites), linker (S3 judge), reb (the new architecture), eta-refuter-2/eta-refuter-3 (checkers).
- **DONE (through rev 14):** router root cause (M1-M6) found; router-fix/lid built removing M1-M5; SELFTEST clinical1 suite + 2 confirmation suites built for the S3 judge; /clarity + scorecard page live.
- **DONE (this revision):**
  - **S1 re-run REPRODUCED WORSE, addendum-witnessed (#4526-4590):** ALL hit rate 80.95%→73.13% (CI [-10.9,-5.0]), ml -25.4pt, hi-en -18.3pt. **Fable ruled 12:50: the M1-M5 fix does NOT ship.**
  - M6 (wrong-Indic-language routing) attribution corrected: first measured at 25-36% of the loss on an unreliable field (segment-count tiebreak, not the router's real `dominant_language`), then re-measured properly — its own marginal effect on S1 is ~0 (+0.11pt). **FINAL settled reading (S1-REPORT.md):** SraVaani itself mis-identifies Hindi as Tamil script under babble noise (≥12/64 net, a defect M6 structurally can't fix) plus correctly-routed content loss (~52/64 net, mechanism still provisional) account for the regression.
  - ETR (English Token Recovery for numbers/units/day-counts) built and tested: real-audio decoy sweep **0/100,000 false anchors** (all bands pass) but recall near-zero on real text (3 candidates in 50 real texts) — not worth shipping alone; folded into FUSER v0 instead.
  - **V approved (13:30) the Room Evidence Bundle (REB)** as the new backbone: run every engine independently, store every output, fuse downstream — see project 19. This is now where CLARITY's real progress happens.
- **NOW:** router-fix has moved to building FUSER (project 20) on top of REB tracks; lid-debug stays on as consultant for M6/SraVaani-under-babble; label200/S2 evals from the old router-fix branch are left running but not extended.
- **NEXT:** get REB's full-day backfill running (26/27 Sep, ~260 tape-hours/day) so FUSER has real production volume to fuse; FUSER's B4 freeze + V's G3 rating decide whether the new pipeline actually beats today's router on S2.
- **Dependencies:** REB backfill at scale; FUSER B4 freeze.
- **Open decisions:** none new for V — the win rule and REB approval are already ruled.

# 2. PRESCRIBE — CAP-1 audit + CAP-2 vocabularies

- **Purpose:** audit whether prescription items are captured in the transcript; steer STT/translation with vocabularies; supply the S2 truth set for CLARITY's scorecard and the W50 bake-off.
- **Exit test:** CAP-1 report (closed); CAP-2 vocabularies feeding STT/translation with a measured before/after.
- **Status:** at risk (CAP-2 running; 26 Sep is its own never-pooled stratum, ruled 27 Sep 12:50). **% done:** 78%.
- **Owners:** cap (evaluator, c3), linker (bundle + Rx extract), vj-refuter (checker until V's Vertex shim lands), eta-refuter-2.
- **DONE:** CAP-1 FINAL 957f93c4; CAP-2 pre-registered cc0484c77c8f319d, Step 0 (whisper baselines) done, ceiling checks VERIFIED, GLOSS real+placebo launched on c3.
- **NOW:** CAP-2 glossary runs continuing; its 24-consult and 22-24 Sep sets now double as truth for CLARITY's S2 router arm and the W50 clinical-engine bake-off's set (b)/(c) — kept as separate, never-pooled samples per Fable's ruling.
- **NEXT:** CAP-2 before/after result; vj-refuter final review.
- **Dependencies:** none blocking.
- **Open decisions:** none.

# 3. BACKFILL — every recorded hour transcribed

- **Purpose:** transcribe every recorded clinic hour with zero failures; keep the PQM-to-prescription linkage current.
- **Exit test:** each clinic day done by 07:00 next morning; a trusted parity path to cloud compute if the Mini needs overflow.
- **Status:** at risk. **% done:** 85%.
- **Owners:** hist-bulk (daily drain), fleet/herdr-kit (PARITY-389), linker (nightly PQM linking), eta-refuter-2.
- **DONE (this revision):**
  - **PARITY-389 FINAL VERDICT: NO MATCH; scope not met.** Two real compare-tool bugs fixed first (a refused-key false-absence bug, and per-window audio identity not checked against the ship manifest); the retried compare still failed because the HF capture used `SRAVAANI_MODE=local` instead of the Mini's real Yoga-hosted instance, so SraVaani-routed windows are not comparable. **Fable ruled (17:25) SraVaani out of scope; no further capture spend.** The underlying blocker (HF's tailnet cannot reach the Yoga SraVaani instance, SOCKS5 rc=97) is unresolved if this is ever revisited. Whisper-path content divergence (1.4-21.2%, median ~9%) is documented as a real finding, not decode noise (temperature-fallback ruled out). Record: `~/eta-data/hf-parity-389/PARITY-389-RECORD-27SEP.md`.
  - **Nightly PQM-linking automation live:** crontab installed (23:45 IST, box), a real overwrite bug fixed first (a rolling 3-day window would have clobbered the frozen 26 Sep CAP bundle — now every day gets its own frozen MANIFEST guard), pinned to live `main` not a moving tag after a second real bug. 27 Sep's nightly run completed (5 rows). `cap_bundle.py` also now refuses to silently regenerate a frozen day's bundle.
  - hist-bulk confirmed live daily transcription on schedule; box T4 added as a second STT worker alongside c3 for today's tape.
- **NOW:** steady-state daily transcription + nightly linking; PARITY-389 is parked.
- **NEXT:** decide (Fable/V) whether SraVaani's tailnet-ACL gap is worth fixing to re-attempt PARITY-389 later; no active work otherwise.
- **Dependencies:** none blocking.
- **Open decisions:** re-attempt PARITY-389 later, or accept HF as unproven backup indefinitely (Fable/V, not urgent).

# 4. ROOMS — every clinic hour recorded

- **Purpose:** ensure every room records during clinic hours, detect silent stalls, and fix hardware.
- **Exit test:** every clinic hour captured; 0 unexplained silent tape; room faults auto-alerted; V has a plain view of room health.
- **Status:** on track. **% done:** 85%.
- **Owners:** fleet (fleet-watch), scribe (RECORDER), minibot (Mini watch), lab-viewer (Room Timeline).
- **DONE (this revision):**
  - **signature_mismatch bug CLOSED.** Root-caused: every failure traced to app build **0.1.8** (pre-0.1.18 anchor-trust fix); the OPD1/OPD4 "27 Sep" mismatches were stale 17-Sep launchd log text, not new events — confirmed by source read, DB read, and an offline repro on the Air (exit 0 leaf-only vs exit 3 anchor-trusted). W37 closed (#4375); `SIG-ROOT-CAUSE.md` and `SIG-FACTS.md` final.
  - **Room Timeline (/timeline) shipped**, replacing the plan for a separate /encounters page — see LABVIEW project.
  - A real `now`-view bug fixed: cross-midnight sessions were dropped from the "currently recording" view (a same-IST-date filter mismatch), branch `vinay/scribe-rooms-now-bug` PASSed.
  - OPD1 ENCODER_STALLED and OPD3 mute both diagnosed via the standard playbook and confirmed healthy after fix; Dietary confirmed healthy.
- **NOW:** all rooms recording; V can see room status directly on `/timeline` instead of waiting on bus posts.
- **NEXT:** a small 0.1.26 RECORDER fix spec exists (better signature-failure logging) but is not urgent; Cardiology's restart status is unchanged from rev 14 (carry forward, not re-verified this pass).
- **Dependencies:** none blocking.
- **Open decisions:** Cardiology restart (V/Fable, carried forward — UNVERIFIED this revision); OPD 4 physical status (carried forward — UNVERIFIED this revision, not mentioned in today's bus range).

# 5. SPLIT — diarization (who spoke when)

- **Purpose:** speaker labels + counts; own model within 3 DER points of pyannote.ai.
- **Exit test:** own diarization model within 3 DER points of pyannote.ai on 2 weekly evals.
- **Status:** on track. **% done:** 70%.
- **Owners:** split, diar-lab, eta-refuter-2.
- **DONE:** (unchanged from rev 14 — 337e complete, phase-2 plan posted).
- **NOW:** REB's diar layer of record is **pyannote.ai hosted** (production's own engine, ruled 27 Sep 13:22); a local eta-diarize track exists only as an optional HF-only shadow. No own-model training has started.
- **NEXT:** SPLIT phase-2 plan (Nemotron turn-finding trained on pyannote.ai labels) remains pending Fable's go; W52's heavy real-world diarization load (Manoj package) is a live stress-test of the production pyannote.ai path in the meantime.
- **Dependencies:** none blocking.
- **Open decisions:** none.

# 6. VOICEPRINT — doctor identity by voice

- **Purpose:** attribute speech to a specific doctor's voice, guarded by cryptographic blinding where sealed truth is involved.
- **Exit test:** voice centroids that pass positive/negative controls; usable for real clinical questions (see W51/W52).
- **Status:** at risk. **% done:** 55%.
- **Owners:** vj-refuter (checker, sealed-truth custodian), lx (builder for W51/W52), linker, reb, hf-fleet.
- **DONE:** (unchanged base from rev 14 — blinding architecture, centroid controls, sealed vault). Arm 4 (Gemini/Vertex) status carried forward, UNVERIFIED this pass — no mention in today's bus range.
- **NOW:** the entire project's live energy is in two new V-ordered workstreams: **W52 Manoj Package** (urgent, deadline today) and **W51 Manoj Voice Study** (the formal version, now paused) — see projects 22 and 23 for full detail.
- **NEXT:** see W52/W51.
- **Dependencies:** see W52/W51.
- **Open decisions:** see W52/W51; arm 4's Vertex credential status carried forward unresolved (UNVERIFIED this pass).

# 7. ENCOUNTER — consult start/end detection

- **Purpose:** find consult boundaries in the tape from cues (greeting, exam, prescription readout, closing) and match them to patient-queue truth.
- **Exit test:** 80% of queue consults found within 2 minutes of start/end (W44 pre-registered bar).
- **Status:** at work. **% done:** 60%.
- **Owners:** lx (build), eta-refuter-2 (checker), lab-viewer (page).
- **DONE:** **W44 Jev encounter-loop built** (lx): STATE = ~60s transcript chunks with speaker labels + silence gaps; ONE Jev request per chunk (9-option phase Choice + 4 Nouls: new_patient/opening/closing/patient_present); keyword/regex candidates in multiple languages feed a state-machine layered over the Jev phase probabilities, snapped to silence boundaries. Pre-registration went through 2 real FAIL→fix rounds (26 Sep being both tuning set and exit test — contaminating; a phase-options shape mismatch) before **PASS-with-conditions** on the offline selftest (27/27). A back-to-back encounter timing bias is documented in the README rather than silently absorbed.
- **NOW:** shadow-only, runs over every transcribed room-day; nothing reaches clinicians. The dedicated /encounters page plan was **superseded by /timeline** (W49) — the detection loop itself is unaffected and feeds that page instead.
- **NEXT:** score against the 26 Sep full day (1,060 windows) vs the acoustic + E-6 fusion baselines (3/14, 3/7) using lx's full-day harness; surface results in /timeline.
- **Dependencies:** none blocking.
- **Open decisions:** none.

# 8. SURGERY — surgical/interventional pitch detection + linking

- **Purpose:** detect when a doctor pitches a surgery or other procedure, and whether it converts to a booking.
- **Exit test:** a rated review set + a published conversion chain from pitch to booking.
- **Status:** on track. **% done:** 65%.
- **Owners:** surg-link (build), lab-viewer (review page), eta-refuter-2 (checker).
- **DONE:**
  - **Scope widened (W46):** now covers interventional procedures generally — injections, endoscopy, cath/angio, biopsies, procedural referrals — not just surgery, using in-house-vs-refer-out knowledge so a missing booking doesn't automatically mean "not done."
  - Per-consult Jev scoring built: pitched_surgery / pitched_intervention Nouls, a procedure-family Choice, patient_agreed/deferred and doctor_recommended/patient_asked Nouls; keyword/regex candidates feed Jev.
  - Pitch linked to Pulse prescriptions/orders and on to the 595-case booking truth set; conversion reported by doctor/procedure family.
  - **`pitch25` real-case review set LIVE on lab-viewer** (15 de-identified cases, inline sha256/turns-processed provenance added after a review flagged the provenance guard as too weak). De-id pipeline (gliner NER) run on 15 real cases, doctor names resolved for all.
  - Interim numbers: 554 flagged Rx items; the 25-26 Sep CAP batch: 19 pitched, 3 booked, 1 referred, 15 not booked (conversion 21-53% depending on grouping).
- **NOW:** V/Sandhya can rate the 15-case pitch25 set; surg-link re-runs Link 3 once router-fix/FUSER's output is trusted (S2 win confirmed).
- **NEXT:** grow the review set; re-link on 26 Sep + FUSER transcripts once available.
- **Dependencies:** FUSER's S2 win confirmation (for a re-run on fused transcripts).
- **Open decisions:** none new.

# 9. NOTESAFE — note faithfulness / completeness

- **Purpose:** audit generated notes against transcripts to catch hallucinations before clinician review; audit every Jev call site for safety.
- **Exit test:** false-flag rate < 25% before any production flag; every Jev call site provably safe.
- **Status:** on track. **% done:** 75%.
- **Owners:** notesafe, jev-audit, jev-fix, eta-refuter.
- **DONE:**
  - **W36 Jev audit complete:** 43 call sites across production + lab studies, 17 PASS / 23 GAP / 2 UNVERIFIED / 1 REFUTED. Two real HIGH findings: the surgery study sent pre-de-identified patient text to Jev/OpenRouter, bypassing its own gate; production logged raw error text on Jev failures (could echo PHI).
  - **W41 fixes, then a ruling withdrew two of them:** F2 (pin `ETA_JEV_MODEL=jev-1.13.0`, now live in production), F3 (route the legacy client through the logged path), F4 (one shared constants module for Jev questions/thresholds, values unchanged) all shipped and PASSed. **F1 and F5 (de-identify before any Jev/OpenRouter call) were built, then WITHDRAWN** after V ruled (27 Sep 12:55) that Jev (TypeSafe) and OpenRouter/Gemini are both zero-data-retention for Even — no de-identification is required before sending to them.
  - Provider-text error fix (rev 13/14) and medication-note bench (rev 14) both PASSed and stand.
- **NOW:** every open Jev-audit item from W36 is either fixed, superseded by the ZDR ruling, or tracked in W41's paper trail — the audit's job is done.
- **NEXT:** run the medication-note bench for real numbers against its frozen threshold (≤10% observed / <25% upper bound).
- **Dependencies:** none blocking.
- **Open decisions:** none.

# 10. TONE — emotion / tonality

- **Purpose:** flag distressed or tense encounters from audio tone and text sentiment.
- **Exit test:** validated per-language reliability; a per-consult tone/sentiment summary shown only in shadow (never to clinicians yet).
- **Status:** at risk. **% done:** 35%.
- **Owners:** tone, eta-refuter-2.
- **DONE:**
  - **W45 coverage + validation run:** diarize+emotion queued on box GPU for every transcribed window. Synthetic validation via ElevenLabs (6 emotions × languages, room-acoustic versions via the SELFTEST rig) scored against wavlm: **0/12 on anxious/angry/sad in every language and condition** — only neutral/happy/calm partially pass. A second arm (Gemini) improves angry (0→6/12) but breaks neutral (→0/12); per-language rankings flip between the two engines entirely, which reads as an engine artifact, not a real language difference.
  - Text-sentiment pilot moved to 24 Sep (26 Sep had zero transcribed/diarized windows at the time) and found a real design bug: `room_turn_speaker.role` is **never** set to "patient" in the data, only "clinician" or null — the patient/attender side of the sentiment design needs correcting before it can be built as specified.
- **NOW:** neither the acoustic nor the text-sentiment arm is reliable enough yet to report per-consult tone; project is effectively back at a validation stage.
- **NEXT:** decide (with Fable) whether to keep tuning wavlm/Gemini or wait for REB's emotion layer to mature; fix the role-field design gap before any patient-side sentiment work continues.
- **Dependencies:** a working speaker-role field distinguishing patient from doctor.
- **Open decisions:** none for V yet — this is still an engineering validation problem.

# 11. SELFTEST — repeatable system diagnostics

- **Purpose:** a rig that proves STT, diarization, and mics work — without patient data.
- **Exit test:** nightly scored report; all stimulus types; clinical-realism suites feeding CLARITY's S1/S3.
- **Status:** on track. **% done:** 65%.
- **Owners:** diar-lab, lid-debug (clinical2 spec), eta-refuter-2.
- **DONE:** (rev 14 base — confirm2/confirm3/confirm4 suites, room self-test scorer PASS, nightly digital run armed) plus this revision: **confirm4 suite built (280 stimuli) and merged**; the S3 judge's v4 run on confirm4 scored 268/280=95.7% overall but **mixed-language cells only 72.5%** (below the 90% per-condition bar) — S3 stays indicative, not gating. A real scorer bug (fused numerals like "500mg" not recognised as a dose hit) was found and fixed, confirmed on main. Nightly runs are green (13/13 on the most recent, canary 1/1).
- **NOW:** a bigger, more clinically realistic suite (`clinical2`, lid-debug's spec, 108 stimuli weighted toward hi-en/hi/mr-en) was designed but hit a **TTS character-budget wall** (needs ~9,810 chars against 4,530 headroom in the 60,000-char ledger); two real allocation bugs were found and fixed along the way, and a cut-down 4,424-char version was proposed. Fable deferred it (zero further TTS spend for now) — parked, sealed.
- **NEXT:** resume clinical2 if/when Fable lifts the TTS-budget hold; keep the nightly digital run going as REB's own DEV-ingest data (which reuses clinical1) grows.
- **Dependencies:** Fable's word on the TTS-budget hold.
- **Open decisions:** none for V.

# 12. LABVIEW — lab viewer + rating pages

- **Purpose:** the authenticated web viewer V uses to read transcripts, rate quality, and now see room/day status directly.
- **Exit test:** every backfilled day visible with real data; V rates label200/pitch25 sets.
- **Status:** on track. **% done:** 95%.
- **Owners:** lab-viewer, eta-refuter-2/eta-refuter-3.
- **DONE (this revision):**
  - **V approved (14:00) the Room Timeline mockup** — ship it and fill with real data as it backfills. Built in the design's own layout/colours/legends (plain words first, engine names only in "Technical detail", blue-vs-orange never red-vs-green, IST everywhere, queue tokens not names at the top levels).
  - **P1 LIVE (78921667):** tape coverage, bench windows, speaker turns, PQM queue truth, CAP prescription links, fleet alerts, a date picker over every backfilled day.
  - **P2 LIVE (cc416d93):** an inspector — audio playback inside the existing Access-gated proxy (no new signed-URL surface), a synced transcript, Prescription/Sound tabs, and an append-only view log (a trail, not a gate) in its own guarded R2 prefix.
  - **P3 LIVE (82936ec9):** REB per-engine layers in the inspector — Compare-engines, an engine-agreement strip, a provenance-underlined stitched line, and a Technical-detail panel — after 2 real bugs (wrong track-selection grouping key, segment-clock handling) were caught and fixed.
  - `pitch25` (surgery review set, see SURGERY) shipped and loaded, 15/15 rows. Several labels were caught overclaiming completeness ("X of Y" implying finished when it wasn't) and fixed lab-wide.
- **NOW:** every phase of /timeline is live; data quality now depends on REB's backfill progress and the other projects feeding it (encounter loop, tone, FreeScript preview are all still "not shown yet" placeholders where their own data isn't ready).
- **NEXT:** grow real REB coverage so P3's layers stop showing "not processed yet"; wire in the encounter loop's output and the FreeScript artifact preview once those are ready.
- **Dependencies:** REB backfill scale; ENCOUNTER's scored output.
- **Open decisions:** none.

# 13. FOUNDRY — machines, agents, bus, models, budget

- **Purpose:** the operational substrate everything runs on.
- **Exit test:** reliable infra, budget tracked, no PHI leaks, cheapest passing model per job.
- **Status:** on track. **% done:** 85%.
- **Owners:** Fable (lead), herdr-kit, hf-fleet, minibot, roadmap (records).
- **DONE (this revision):**
  - **HF GPU strategy settled:** compute runs as **HF Jobs (`l4x1`, $0.80/h)**, not always-on GPU Spaces (a known mount bug blocks Spaces boot on this image); up to 5 concurrent L4 jobs approved for REB/W50/W52. hf-3..7 Spaces are paused (not deleted) as a fallback. Every HF job now copies each finished window to the bucket as it completes, not all-or-nothing at exit.
  - **Bus latency fixed:** posting was doing 3 serial remote `herdr agent list` calls per message (~11.3s); parallelized with `Promise.all` (~7.7s), with one real regression (bus_roster losing box model/task display) caught and being fixed.
  - **Nightly mirror hardened:** `mirror_daily.sh` went through a real multi-bug fix cycle (a patient-audio-path log leak, a return-code leak across days that made every day-2+ report a false success, a process-kill that could hit unrelated box processes, wrong midnight-boundary math) — fixed and PASSed; a one-off full mirror run completed clean (rc=0, 0 failures across all 4 streams).
  - **Mini disk-hygiene plan written (W42):** an audit of `~/dev` worktrees/repos for safe-to-archive candidates (never touching the named production repos or anything referenced by a launchd job), a plan to move the 13GB local-model cache to the external SSD, and an investigation into a ~62GB internal-disk drop that traced to an old rsync mirror script's quoting bug (harmless, self-recovered) rather than anything happening today. Scheduled to execute tonight after 20:30 + D4 confirmed healthy.
  - Small registry/tooling fixes: `herdr-ctl` resolves 32-hex machine ids to labels; `busctl.py` (the bus CLI) no longer silently exits 0 on a failed or lost post.
- **NOW:** infra is stable; the disk-hygiene execution and the bus_roster regression fix are the only open engineering items.
- **NEXT:** execute the approved Mini disk moves tonight; close the bus_roster regression.
- **Dependencies:** D4 confirmed healthy before disk moves execute.
- **Open decisions:** GCP S7 delete timing (V, carried forward, UNVERIFIED this pass); Zen top-up cadence (standing, D-10).

# 14. SHIP — EvenScribe production releases

- **Purpose:** ship tested, verified production releases without disruption.
- **Exit test:** each train checked by an Opus checker on the exact sha, smoke green, no rollback needed.
- **Status:** on track. **% done:** 92%.
- **Owners:** scribe (deploy train), eta-refuter (checker), minibot (Mini monitor).
- **DONE (this revision):**
  - **D4 shipped.** cac6c29 was found already live from 07:17 (a push to `vinay/s1-auto-drain` auto-deploys — this is now a standing rule everyone must remember). Fable applied migration 0119 (21:14) and 0121 (21:22), set `ETA_JEV_MODEL=jev-1.13.0`, and forced a fresh redeploy (dpl_3s2o, READY 21:16, smoke green). Self-test-server (ed869d2) shipped as a fast-forward onto that. **Post-D4 train 4d7d8e0 live 21:48**, health confirmed within ~11 minutes.
  - **A real MCP security bug found and fixed:** minibot's `self_test` room-command call exposed a general write-scope gap (any tool path reachable, not just self_test) — a `session_id`-based allowlist bypass was reproduced by eta-refuter-2, and scribe re-architected to **default-deny at the call boundary** instead, closing it. PASSed, merged onto the post-D4 branch (Yoga gate green, 4,771 tests), full gate green — **not yet pushed to production, waiting on Fable's GO.**
- **NOW:** production is healthy at 4d7d8e0; the room-scope security fix is the one release waiting to ship.
- **NEXT:** Fable's GO to push the room-scope fix; keep the "any push to s1-auto-drain is a deploy" rule visible in every future runbook.
- **Dependencies:** Fable's GO.
- **Open decisions:** none for V.

# 15. RECORDER — next Room Recorder fleet release

- **Purpose:** the next release of the EvenScribe Room Recorder app that runs on the room Macs.
- **Exit test:** release ships with the queued fixes; self-update proven; rollout clean; in-app self-test working end to end.
- **Status:** on track. **% done:** 75%.
- **Owners:** scribe, minibot, eta-refuter, sig-debug/sig-research (closed out this pass).
- **DONE (this revision):**
  - **signature_mismatch root-caused and CLOSED** (see ROOMS project for detail) — a real, but old and already-fixed, problem; nothing new to build.
  - Self-test hook (in-app) built and previously PASSed (1da7232, rev 14); server-side `self-test-server` shipped in the fast-forward to production.
  - A small 0.1.26 fix spec written for later (save codesign stderr to a file; ISO-UTC log-line format).
- **NOW:** Home Office's live self_test is **parked**: minibot's MCP token lacks write scope — the same class of gap SHIP just fixed generally for room commands; scribe is designing the least-privilege fix for this specific path.
- **NEXT:** land the least-privilege self_test fix; run the first real Home Office self_test; pick the next rollout room after Home Office.
- **Dependencies:** the self_test write-scope fix.
- **Open decisions:** which room follows Home Office (carried forward, Fable's call).

# 16. ORBOX — OT recorder upgrade for robotic surgery

- **Purpose:** upgrade the OT recorder (Linux orbox3 in ORB3) to capture robotic surgeries.
- **Exit test:** a robotic surgery captured end-to-end, tested first with SELFTEST stimuli in the empty OT.
- **Status:** just started. **% done:** 15%. No change this revision.
- **Owners:** orbox (design, Pool A, NO-PHI); build owner still to propose.
- **DONE:** design v2 (unchanged from rev 14).
- **NOW / NEXT:** unchanged — still waiting on V's rulings D-2..D-5.
- **Dependencies:** V's rulings.
- **Open decisions:** see DECISIONS (D-2..D-5), unchanged.

# 17. FREESCRIPT — ETA consult → structured artifact → Pulse FreeScript

- **Purpose:** turn a captured clinic encounter into a structured artifact Pulse's FreeScript can use, without an ETA transcript ever passing for a doctor's own dictation unreviewed.
- **Exit test:** a versioned artifact schema + prototype scored against real linked consults; handed to Pulse's team.
- **Status:** on track. **% done:** 95%.
- **Owners:** freescript (researcher/builder).
- **DONE (this revision, W38):**
  - **V ruled (27 Sep 11:05): no doctor-paste, no Pulse code change by the ETA team.** Instead ETA defines and produces a structured JSON artifact; Pulse's own team designs the integration.
  - Schema `eta.freescript.v0.1` built, mirroring FreeScript's own post-extraction shapes (medicines, investigations, procedures, advice, diagnoses, follow-up) plus the 11-heading English note and per-item provenance (evidence spans, speaker, status [prescribed/continued/stopped/not-given/discussed-only], negation flag, confidence, model+version).
  - `README-FOR-PULSE.md` written: field guarantees, versioning, open integration questions for Pulse (emit mechanism, draft-vs-submitted, auth, draft matching), a sequence diagram of options without choosing one.
  - 3 invented example artifacts (including a negation case and a stopped-drug case), schema-validated.
  - **Offline prototype run on 5 real linked CAP consults (box only, PHI never left the box):** scored against CAP prescriptions as truth. Two real fix rounds closed stopped-drug/not-given order-guard holes; final version v0.1.2 PASSed, W38 **CLOSED**.
- **NOW:** the artifact + docs are ready to hand to Pulse; ETA's own build phase is done.
- **NEXT:** V/Fable hands the artifact and docs to the Pulse team; ETA's part resumes only if Pulse asks follow-up questions.
- **Dependencies:** Pulse team's own integration decision.
- **Open decisions:** none — this phase is closed.

# 18. ACOUSTICS — what we already know about each room, from existing tape

- **Purpose:** characterise every room's recording acoustics from tape already on hand, and tie it to CLARITY's STT outcomes.
- **Exit test:** a profile per room; a measured, evidence-based VAD-blind-spot finding; a remediation list.
- **Status:** on track. **% done:** 90%.
- **Owners:** acoustics, eta-refuter-2.
- **DONE (this revision, W39):**
  - **A1 (VAD-blind check):** measured against a strong reference detector. **OPD 1 misses 9.4% of real speech (mild); Third Floor misses 23.7% (material)** — a real, measured gap between what the mic hears and what reaches STT.
  - A VAD-threshold sweep (0.5 baseline vs 0.35 vs 0.2) was **pre-registered and found no win** — neither alternative recovers materially more real speech without also leaking more non-speech; Third Floor's fix needs to be physical (mic placement/swap/echo reduction), not a software threshold tune.
  - **A2 (acoustic-vs-transcript-quality correlation):** initial finding was backwards and self-corrected by eta-refuter-2 — empty/garbled transcripts correlate with **quieter**, not noisier, windows (nobody talking, not the VAD starving on noise).
  - A real sample-mismatch bug was caught before it reached lab-viewer: the VAD sweep and a missed-speech-spans export had each independently drawn a *different* sample than A1's original 40 chunks (the underlying manifest had grown between runs); both were re-run against A1's exact chunk ids before anything was published.
  - Final report (`W39` sections A1-A4) done, 2 text fixes, both refuters' PASS.
- **NOW:** the room-acoustic-baseline JSON is built (feeds SELFTEST's room scorer, see project 11).
- **NEXT:** Third Floor physical remediation is a V/Fable hands-on decision; A5 (extend the tape window to 7 days, add Dietary/Home Office) not yet started.
- **Dependencies:** V/Fable for physical room work.
- **Open decisions:** Third Floor physical fix (V/Fable).

# 19. REB — Room Evidence Bundle *(NEW, W47)*

- **Purpose:** run every audio engine (STT, translate, diarization, emotion, terms) independently on every window, store all outputs on one clock, and build everything downstream (fused transcript, encounter analysis, FreeScript artifact, tone, viewer layers) from that one store, without ever re-touching the audio.
- **Exit test:** a full clinic day's worth of tape run through every v1 layer, stored, and readable by every downstream consumer, finishing before 07:00 the next morning without starving the live daily STT loop.
- **Status:** on track. **% done:** 45%.
- **Owners:** reb (builder), eta-refuter-2 + eta-refuter-3 (checkers, one per branch, never the same as the builder).
- **DONE:**
  - Spec settled: `REB-SPEC-v1.md`. Layout `reb/<date>/<room>/<window>/{manifest.json, tracks/<layer>.<engine>__<version>__<cfg8>.json}` + `index.jsonl`. Principles: never discard an output, append-only (a re-run adds a new track, nothing overwritten), one UTC-ms clock, every track records engine/model/version/config-hash/status.
  - **Sizing done:** whisper 52-100x realtime; SraVaani 5.3x (CPU-heaviest); pyannote-diar 14x; Nemotron-diar 141x (shadow only). On HF L4, IndicConformer (all 5 heads) + SraVaani validated on real clinic-hour content at **18.7x realtime, $0.043/tape-hour** (an initial concern about empty IndicConformer output was confirmed as real model behaviour on English-only heads, not a short-circuit bug).
  - **Library built and merged (main 1ee3b4a4):** schema + writer (append-only, sha256 per file) + validator + `reb.py` reader API, hardened through 3 real-bug fix cycles found by adversarial review (a failed first write orphaning a track and locking the window forever; an R2-mirror failure that could delete a track the manifest still listed; `tracks(latest_ok=True)` silently dropping engines that only ever failed).
  - **Fan-out runner built:** claim-once semantics across box/c3/HF workers, lease + fencing so a dead worker's claim can be stolen safely (a real empty-claim-file-never-stealable bug was found and fixed).
  - **DEV ingest COMPLETE: 222/222 windows (192 clinical1 synthetic + 30 real DEV30 clips), 0 crashed, 1,998 stt tracks, 1,857 ok / 141 empty / 0 failed**, independently triple-verified. (One real crash-at-193 bug was found and fixed first: a stub for the real DEV30 clips never wrote `source_windows`.)
  - A chunk-level `source_windows` addition (native `{r2_key}`-only entries) is pushed but not urgent/not merge-blocking.
- **NOW:** DEV-scale ingest is proven; full-day 26/27 Sep backfill (~260 tape-hours/day) has not yet been run at scale. FUSER (project 20) and W50 (project 21) both read REB tracks already, on a frozen pin (1ee3b4a4) that must not move without a new dated addendum.
- **NEXT:** run the full-day backfill without starving hist-bulk's live daily loop; hand lab-viewer any new track shapes as they land.
- **Dependencies:** HF Jobs capacity; care not to starve the live daily STT loop.
- **Open decisions:** none for V.

# 20. FUSER / G3 — the transcript-fusion scorer *(NEW)*

- **Purpose:** read every engine's REB track for a window and write one trustworthy fused transcript with word-level provenance, scored automatically the same way CLARITY's router fix was.
- **Exit test:** CLARITY's win rule (S2 improves, S1 not worse) applied to the fused output vs today's production router; V's final rating on a sample.
- **Status:** at work. **% done:** 55%.
- **Owners:** router-fix (builder), lid-debug (designer), eta-refuter-2/eta-refuter-3 (checkers).
- **DONE:**
  - Design (v0 = rules: SraVaani-script language pick + keep-Whisper-numbers; v1 = Gemini reads all tracks and writes one transcript with provenance) witnessed through 4 addenda, each closing real gaps found in review (yes/no/haan affirmations wrongly on the general-allow list — a safety hole; uncitable context tokens not rejected; a majority-overlap window widened to ±1500ms for interpolated SraVaani).
  - Step-1 freeze pinned: design + ADDENDUM-1/3 + DEV30 + fuser_v0 + ETR + the REB pin, all by sha, witnessed.
  - **B1 (pre-pass: tokens, agreement, LID, number parsing, drug matcher) complete, 73 tests.** **B2/B3 (schema/prompt/Gemini wrapper + validator V1-V6) complete**, closing 3 real safety/robustness holes found in review.
  - **B4 RUN 1 (the first full scoring pass) complete: 222/222 windows, $6.85, 0 errors** — 39 pass (17.6%) / 130 repair (58.6%) / 53 fallback (23.9%); the DEV30 real-clip stratum scored 30/30 pass. Key finding: 118/187 dropped items lack a "w" (word) field — fixed in the prompt for RUN 2.
- **NOW:** RUN 2 (on the fixed prompt, sha ce91eb1) **halted at its cost cap**: 17/222 done, $0.757 spent, a projected total of $11.10 against a $10 cap — driven by one outlier reply that hit the model's own output-token ceiling and came back truncated/unparseable. Holding for Fable's call (resume with a higher cap, or fix the outlier case and retry). **V ruled (28 Sep) he is the final G3 dose-audit rater**, once B4 freezes; lid-debug is writing a dated addendum and will spec a blinded review page for lab-viewer.
- **NEXT:** Fable's call on RUN 2's cost cap; once frozen, score S1/S2 the same way the router fix was scored; V's blinded rating pass.
- **Dependencies:** Fable's cost-cap decision; RUN 2 completion.
- **Open decisions:** RUN 2 cost-cap raise vs scope cut (Fable, not urgent for V beyond the rating commitment already made).

# 21. W50 — clinical speech-engine bake-off *(NEW)*

- **Purpose:** test outside medical-speech-trained engines (as a REB "terms" layer) against production's own engines, to see if any of them recover drug names production currently misses.
- **Exit test:** a candidate only "wins" if drug-name hit rate improves AND the false-drug rate doesn't get materially worse, judged on a pre-registered, chance-corrected comparison.
- **Status:** at work. **% done:** 55%.
- **Owners:** terms (builder), eta-refuter-2 + eta-refuter-3 (checkers, both witness every addendum).
- **DONE:**
  - Candidates: `medasr` (Google, HAI-DEF terms — **V accepted the terms for lab evaluation, 27 Sep 15:17**), `parakeet-med` (NVIDIA/community fine-tune), `whisper-arca-lora` → **later replaced/merged as `whisper-med-merged`** in practice.
  - Smoke test on real HF Jobs: medasr and whisper-med-merged passed; **parakeet-med FAILED at smoke (deterministic truncation)** after a 4-iteration debug budget was spent — **withdrawn (ADDENDUM-18)**. Bake-off proceeds with 2 candidates.
  - **Pre-registration closed** after an unusually long, thoroughly witnessed chain (17 addenda): the truth set is 22-24 Sep CAP-linked consults (122 drug items/49 consults, kept separate from FUSER's own 24-consult TEST set); metrics are drug-name hit, dose hit, and false-drug rate vs three baselines (whisper-auto, whisper-cap2, sravaani); a chance-corrected pairing scheme (excluding shared-drug contamination) and Fable's hard cap (false-drug rate not worse than 2× the best baseline) were adopted as the entry rule; a 60-minute span cap was set to keep long outlier consults from dominating cost; scoring is per-comparison-pair exclusion (only drop a consult from the one pair that failed on it, not from every comparison).
  - **Set (b) (192 clinical1 synthetic windows) SCORED: 384/384 tracks committed, 0 rejected**, independently verified twice.
  - Set (c) (87 real consults / 102 drug items) built end-to-end: manifest resolution, a decoder, upload guards, all reviewed and fixed through several real-bug rounds (drug-name-ceiling undercounted because of unit/strength text in the lexicon — fixed, ceiling rose 91→112/122; a 30-second Whisper feature-extractor truncation bug — fixed).
- **NOW:** set (c) scoring is running against production (3/87 windows done as of the last read); no scored verdict yet.
- **NEXT:** finish set (c) scoring; write `TERMS-BAKEOFF.md`; if a candidate wins, flag MedASR's production use for Even's legal/HAI-DEF-terms review (V/Kush).
- **Dependencies:** none blocking; budget ($10 total) has ample headroom left.
- **Open decisions:** none for V yet — legal review is a future step only if a candidate wins.

# 22. W52 — Manoj Kumar S encounter + voice package *(NEW, V priority, urgent)*

- **Purpose:** V asked for every recorded encounter of Dr Manoj Kumar S (Ortho, OPD 4 + OPD 7, all recorded days) as audio clips, his-speech-only clips, transcripts, and his Pulse prescriptions, in one folder for his own focused review.
- **Exit test:** first cut delivered to V's MacBook Air by **15:00 IST**; the complete package by **17:00 IST**, today (28 Sep).
- **Status:** at risk (deadline risk on one step). **% done:** 60%.
- **Owners:** linker (encounters + Rx), lx (voice scan + diarization), reb (integrator/package assembly), diar-lab (per-encounter diarization support), hf-fleet (GPU jobs), vj-refuter (attribution spot-check), eta-refuter-3 (package integrity check).
- **DONE:**
  - Target identified precisely: Dr Manoj Kumar S (ortho, uid keyed, never by name in code) vs a negative control, Dr Manoj C (physician, a different doctor, kept in a separate 0700 directory for PHI hygiene). V's own September schedule is treated as a **prior only** — a real counterexample was found (he was recorded in the "wrong" room on 16 Sep), so room-number assumptions are never trusted blind.
  - Attribution rule set by Fable (12:20): per-turn voice-match score ≥0.55 counts as a match; a token is FOUND if ≥3 matching turns or ≥15s of matching speech land inside the visit's time window (±30s), else WEAK.
  - **Encounters + prescriptions DONE:** 176 PQM consults (19 Aug-27 Sep, 28 days) found, 174 linked to a prescription, 367 Rx line items pulled. **Encounter audio cut is FINAL: 89 full-encounter clips + 28 his-speech-only compilations** (of 176 rows: 89 cut clean, 30 had no tape in the visit window, 50 had no tape inventory at all, 2 hit a tape-gap artifact, 5 were non-completed visits and skipped). A real data-column bug (a wrongly-read table made it look like there was no real patient-id column) was found and corrected; all 176 rows now carry the real linking id.
  - **Voice scan: 22 of 39 OPD4+OPD7 room-days scanned — 28 FOUND, 2 WEAK, 47 no-evidence, 0 double-room conflicts.** A positive control confirmed the scoring pipeline is sound (low scores are truly "not him," not a bug). vj-refuter's independent spot-check exactly matched lx's numbers.
  - Two real pipeline bugs found and fixed during the scan build: a stale summary key made every clip's log falsely say FAIL when it hadn't; and a first "4-way parallel" run had no real work-sharding, so all 4 workers processed the same clips in lockstep (fixed with proper hash-based sharding, now genuinely 4x).
- **NOW — the live risk:** diarization (the step that finds which parts of a room-day are him talking) is running on the office computer's CPU at roughly **0.37x realtime**; of 14.06 hours of audio, only about 1.5% was done at the last check. **At this rate it will not finish the remaining room-days by the 17:00 full-cut deadline.** Two ways forward are on the table: move the remaining diarization to cloud GPUs (already-approved budget, minutes not hours), or reorder the queue to finish the already-identified FOUND/WEAK clips first and mark the rest "diarization pending" for the 17:00 cut. Separately, vj-refuter flagged that his 0.65 default match-threshold looks miscalibrated against real data (his own precision estimate on a 10-item spot-check: about 6/10 supported) and recommends unscanned room-days be labelled **NOT SCANNED**, never "not him," until the GPU scan actually covers them — 17 room-days (~163 tape-hours) are still in that state.
- **NEXT:** the GPU-vs-reorder decision on diarization (needed within the hour to hit either deadline); finish the remaining 17 room-days; assemble and hand the final package to V's Air.
- **Dependencies:** the diarization speed decision; V's Air being online to receive the package (V is on a spotty hotspot today).
- **Open decisions:** none new for V beyond being told the 17:00 deadline is at risk — the GPU-vs-reorder call is an operational one already within Fable's approved budget.

# 23. W51 — Manoj voice study (formal) *(NEW)*

- **Purpose:** the rigorous, pre-registered, scientific version of "is this voice Dr Manoj Kumar S" — a proper study rather than an operational scan, done AFTER the urgent W52 package.
- **Exit test:** a pre-registered method that survives review, with a placebo/negative-control arm, run on data that was genuinely held out at the time of the prereg.
- **Status:** blocked. **% done:** 20%.
- **Owners:** lx (build), vj-refuter (checker/sealed-truth custodian).
- **DONE:** an early anchor-mixing check (H05) came back clean — no evidence of mixed identity in the older anchor data; the "room number = OPD number" shortcut was formally ruled UNVERIFIED (a real counterexample exists).
- **NOW:** **prereg v2 FAILED review (#5319):** it was overtaken by W52's own stored voice-print and scan data, which is no longer genuinely blind test data once W52 has used it; its ±180s padding window conflicts with Fable's own ±30s attribution ruling for W52; and it has no placebo arm. lx has acknowledged the FAIL and is deferring a v3 prereg.
- **NEXT:** v3 prereg, written only after W52 ships today, so it can be designed against data W52 has NOT already touched.
- **Dependencies:** W52 finishing first (by design, today's stated priority).
- **Open decisions:** none for V — this is intentionally paused.

---

## Critical path

1. **W52 Manoj package diarization (VOICEPRINT)** — will miss the 17:00 full-cut deadline on current CPU speed; a GPU-vs-reorder decision is needed within the hour. First partial cut still due 15:00.
2. **FUSER RUN 2 cost cap (CLARITY/FUSER)** — halted at $0.757/$10 projected $11.10; Fable's call on raising the cap or fixing the one outlier case, to reach the B4 freeze V's rating depends on.
3. **REB full-day backfill (CLARITY/REB)** — DEV-scale proven (222/222); running it on a real full clinic day (~260 tape-hours) is the next real step for CLARITY's actual improvement.
4. **SHIP room-scope security fix** — PASSed, waiting on Fable's GO to push to production.
5. **W50 set (c) scoring (PRESCRIBE)** — running now (3/87 done); the bake-off's real verdict depends on it finishing.
6. **RECORDER self_test write-scope fix** — blocks the first real Home Office self-test.
7. **Mini disk-hygiene execution (FOUNDRY)** — scheduled tonight after 20:30 + D4-healthy confirmation.

## 14-day calendar (28 Sep – 11 Oct, IST; box clock)

- **28 Sep (today):** W52 first cut 15:00, full package 17:00 (at risk); FUSER RUN 2 cap decision; W50 set (c) scoring continues; REB full-day backfill planning; Mini disk moves tonight after 20:30.
- **29 Sep:** W51 v3 prereg (after W52 ships); FUSER B4 freeze if RUN 2 completes; W50 bake-off verdict likely.
- **30 Sep:** REB full-day backfill in progress; SELFTEST clinical2 resumes if Fable lifts the TTS-budget hold.
- **1-4 Oct:** V's G3 dose-audit rating pass (after FUSER freeze); Third Floor acoustic remediation if V/Fable act; Cardiology room decision.
- **5-7 Oct:** SPLIT own-model evals begin (pending Fable's go on the phase-2 plan); ORBOX hardware decision if V rules.
- **8-11 Oct:** ORBOX capture pilot in empty OT if approved; NOTESAFE benchmark run for real numbers; MedASR legal review if W50 picks it as winner.

*Anything here that a project owner believes is wrong: say so on the bus to `roadmap` with the correcting evidence (bus id / ruling / sha), and I fix it in the next revision.*
