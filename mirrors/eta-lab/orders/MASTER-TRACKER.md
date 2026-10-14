# ETA master tracker (every workstream in flight)

**Updated:** 24 Sep 2026, 20:10 IST, by Fable (rows refreshed from rulings 200-218 by the conductor, evidence from the bus/board).
- **Rule:** Fable updates this at EVERY hourly review, together with ETA-STATE-OF-PLAY. At each review Fable reads ALL pane done-reports on the bus, not just conductor summaries.
- **Sources:** eta-lab orders/ (rulings 1–184), bus/for-fable.jsonl (cursor 1479), board/BOARD.md.

## 1. Workstreams

| # | Workstream | Owner panes | Status now | Next milestone (due) |
|---|---|---|---|---|
| W1 | **Production + trains** | scribe, eta-refuter(-2), minibot | Prod 5970852. Tonight 73868e4 is held for push. Tomorrow a92ebae (next2 + tokens-extra + loop-guard 035c5b7 + emotion-dedupe) is gated green. | 20:30 push 73868e4 → gate/deploy/smoke; 25 Sep morning a92ebae on Fable's order |
| W2 | **Night sequence (ruling 158)** | join-shard, minibot, yoga-drain, lx, radar-kit | Staged | 20:30 push; join-shard Worker; eta-indic plist; stale cancel + RECOVERY-3; eta-diarize restart (130); 21:00 lx rescore; 21:15 radar Mini step; overnight feeder-3 |
| W3 | **HIST mining** (old recordings, mining only, r146) | hist-miner, hist-bulk, lab-mover | Running: 0 failed, ~26 audio-h/wall-h (hist-bulk 74 of 99 link-3 windows done at ~20:05). 2nd process (10 group-C windows) on :30200 since 19:51, temperature_fallback on. **r212: DRAIN the main run with a STOP file at the 89/Tier-A boundary, restart with the 141-window coverage list (31 audio-h) first on 8 routers, then Tier A.** Harness bug: hist-miner's cut_window drops valid webm chunks with no duration header (4 Aug link-3 windows lost; hist-miner to fix). | Drain + restart (r212, hist-bulk); stage-1 last anchor frees :30100; hist-miner harness fix |
| W4 | **Surgery review** (v3 → v4) | fleet, surg-page, eta-refuter-2 | V rated 12/12 v3 (Jev agreed on 71/74 fields). v4 (named vs described) frozen b2ebc86f5a74. ±2 min audio re-cut PASS. | **Fable re-seeds + republishes v4 (same ids, V's ratings kept) before Sandhya's weekend.** v5 freeze after r172 (conditional status) |
| W5 | **Surgical chain** (encounter→Rx→OT→discharge) | linker, mb-rx/ot/ipd, eta-refuter-2 | P1 GO. A+ FINAL (r179), B as sensitivity. RXWIN 30 min. Plain CT in (r164), contrast CT in (r171), CT angio + MRI referred out (r163/181). **Link 3 (class SEALED): interim 18 items: 1 ACCEPTED, 1 tie, 8 below floor, 8 LANGUAGE_LIMITED (v7.12 withhold + flagged stratum; v7.13 coverage pass diagnostic: no item reaches 0.50 in the text that exists). r200: coverage pass on the 8 below-floor (141 new windows queued by r212) + translated stratum. r211: translation = Gemini 3.8 Flash then deid.py on the English (option 2; option 3 refused), after a 20-turn name-leak check and an intelligibility screen.** Jev v5 frozen 4830ae152bf4 (verified). | Coverage list transcribed (r212) then re-run; name-leak check + translated stratum (r211); class key unseals only with all 37 items + the 10 group-C windows, refuter-2 present |
| W6 | **VJ: Jev voice attribution** (4 arms) | vj-data, vj-arms, vj-refuter | Unblocked (r165–170, 182). Stored centroids fail on current audio (median 0.22). **r205: V's 'not me' = 'not V' only (46 answers -> cannot-tell). r206: page = 80 doubtful + 10 confident, role-stratified, blind (select90 PASSES). r214: +22 not-doctor truth turns (`vpilot_voice_verified`), applied by vj-refuter only. r215: F2 population-weighted doubtful accuracy, F3 unweighted McNemar, unweighted sign must agree.** Salanki profile leak fix partial; cards.py needs C1/C2 before render. | vj-data leak + cards fixes; vj-refuter re-checks; then render and publish the page |
| W7 | **VJ Phase L: doctor voice linkage** (PQM + Rx + audio + Jev → V agrees → mint centroids) | vj-link, lx, mb-rx, surg-page, vj-refuter | Pilot DONE 19:30 (10 cards, 0 HIGH / 0 MED, K1 confirmed). **r201: criterion 1 = shortlist/report field only; HIGH needs xday same voice + mutual exclusivity + n>=5 + Rx spoken or Jev LQ yes + stability; r202: Reading A; r204: overnight run 18-24 Sep on voice-lab-1, first page capped at 60 with >=12 LOW, published 12:00 even if <30 HIGH.** r203: LQ-void cause report due 21:30. | 21:30 LQ-void cause; overnight 18-24 Sep; **25 Sep 12:00 first page for V** |
| W8 | **Nemotron diarizer** | diar-lab, eta-refuter-2 | A not adopted; B/B2 no gain; C/C' (soft/sharp count loss): best-by-val checkpoint = step 0 (untuned base), soft-vs-hard loophole confirmed. **r210: stop count fine-tuning; pyannote.ai primary; ONE bounded option-3 try on gcp-l4 (DER-only + class-weighted BCE, keep <3 s speakers, 3 h cap, metric pre-registered first).** | Option-3 run then stop; score on the human page once ≥ 20 are rated |
| W9 | **Speaker-count page** (30 excerpts) | Fable | V 8/30; Sandhya over the weekend | ≥ 20 rated triggers scoring |
| W10 | **Lab results vault + viewer** (r184) | lab-viewer, join-shard, tunnel-ops, eta-refuter-2 | Vault part A DONE (checker c588110 PASS, ruling 195 met; main 12667ca). **Viewer LIVE at lab.llmvinayminihome.uk behind Access (23 unauthenticated probes all refused; viewer code review PASS). r208a: access list FINAL = V + Sandhya, no one else: Access policy (tunnel-ops #864, read back) and Worker ALLOWED_EMAILS (lab-viewer #863) both set; refuter-2 verifies before 13:00; the two real logins are untested.** (Conductor correction 20:2x: the 20:10 refresh here wrongly said Sandhya's email was still pending.) Addendum keys live. | 22:30 first index snapshot; V's logged-in check; refuter-2 live checks 10-13; refuter-2 access verification + V's and Sandhya's real logins; 25 Sep 13:00 viewer |
| W11 | **Mini ssh cap** (r129/152) | herdr-kit, eta-refuter | Lab sshd 2223/2224. System sshd 23/42 after pane restarts. | Keep restarting idle panes; later move MCPs to HTTP |
| W12 | **herdr-radar** (r145/177) | radar-kit, eta-refuter | Fork on eta-lab main (e8417c5 + 4a8b606, r193); t4 runs it; refuter PASS (identical tree) | **21:15 Mini step** (back up config.toml, copy config/mini.toml, read back POLL 1000 / FLOOR 900, link) |
| W13 | **Watchdog + relay** | scribe, herdr-kit | App side PASS; relay built, dormant | Own train after a92ebae; 0119 by hand first; tokens (Fable sets env) |
| W14 | **Tunnels P1** (r120/136) | tunnel-ops | Kit pinned by sha | **25 Sep 07:00–07:45 Fable runs tunnel-p1.sh** |
| W15 | **Filler / loops** | split-speaker | **BEFORE: 5.7% of 283 windows (max 7.7%), trigger 10% never reached.** Rerun armed (pre-registered, 323d137): P1 <=2% loop windows after, P2 every remaining loop number-protected. **r216: a92ebae go-live 25 Sep 07:50 IST** (after tunnel P1, before clinic; scribe gates -> deploy -> smoke on Fable's order) | 25 Sep 08:05-12:00 = AFTER |
| W16 | **Emotion** | indic-mt | 7/8 requeued OK; 21 windows wait for dedupe | Rides a92ebae |
| W17 | **Mini health flaps** (r130) | minibot, conductor | Rotating timeouts at batch peaks; swap high | eta-diarize restart tonight; Opus debugger if flaps continue 25 Sep |

## 2. Open questions for V
1. Where are the E-3 Cardiology doctor/patient labels (23 Sep, 83/104 clips)? split-speaker is searching the Mini + R2 (due 19:15).
2. ~~Data residency~~ CLOSED 18:50: V says any region is fine.
3. ~~Batch size~~ CLOSED 18:50: first batch 60, then rolling batches of 40.

## 3. Scheduled checks (Fable)
- 19:00 review (trig_01L2ogWtLyghZWfXtPu2eGXx), then hourly.
- 21:15 herdr-radar Mini step (trig_01XDQ4DwT9hZYPfitknFaZFW).
- 25 Sep 07:00 tunnel P1; morning summary to V; order the a92ebae train.

## 4. Artifacts for V
| Page | Link | Status |
|---|---|---|
| Surgery review | claude.ai/artifact/RajYseogAgBuVaF7xN5dNH | v3 rated; v4 re-seed pending |
| Speaker count | claude.ai/artifact/SiDazgRkh29bUrVEi1NUwg | 8/30 (V) |
| Jev voice proposal | claude.ai/code/artifact/4144ab93-68b6-404b-bdf7-ec8086e6a980 | Approved; building |
| Who is speaking | not published | On hold (r182) |
| Doctor voice check | not built | 25 Sep 12:00 |
| Lab transcripts viewer | not built | 25 Sep 13:00 |
