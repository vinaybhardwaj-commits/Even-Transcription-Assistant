# W25 P0 (a): pane inventory for the Claude Code -> OpenCode move (r407, r407b, r408)

Owner: conductor (bookkeeping only: no pane is switched, no order is given). v2 REFRESH at 16:27 box clock (section F below replaces the 'State @14:21' columns; the original draft v1 was written 15:15) from `bus_roster` read at 14:21 box clock + board facts. Refresh of idle/busy and in-flight items: 16:20 box clock (due to Fable 17:00 IST Fable clock, about 16:30 box clock). eta-refuter-2 recomputes it from `bus_roster` + herdr status (his checks, #2506).

Rules used: r407b HYBRID (checkers = eta-refuter, eta-refuter-2, vj-refuter and any Refuter/Debugger, plus Fable, STAY on Claude Code/Cowork on Max 20; everything else moves to the CHEAPEST passing model on OpenCode, in the r407 phase order P1, P2, P4; P3, P5, P6 cancelled); r408 `kit/MODEL-JOB-MAP.md` (proposed-model column below is that map's start model per job, before refuter-2's calibration confirms or moves it); PHI only to Claude or PAID non-OpenAI Zen models; agents never read ~/.claude/secrets, ~/.ssh or .env.

Reading the columns: "Now" = the model the roster reports (a Claude Code pane). "State @14:21" = idle/busy per the roster at that time (idle = state done/idle and not busy); "In flight / clean-stop point" names what must be finished or handed over before the pane can stop (bus ids, pid, branch); "Phase" per r407; "Bus" = registered on the bus roster today (an OpenCode pane needs `herdr integration install opencode` + `herdr agent rename` + an OpenCode restart, r407 P0 finding).

## A. Panes that STAY on Claude Code (r407b)

| Pane | Role | Now | State @14:21 | In flight / notes | Proposed | Bus |
|---|---|---|---|---|---|---|
| eta-refuter | Refuter / Debugger (box) | opus | idle | verifying eta-hf-1 steps (waits for V's tag:hf key + ACL), 337c/337d checks as posted | Opus 5.5 (stays) | yes |
| eta-refuter-2 | Refuter, second (link 3, fleet-watch, W22 GATE 1, W25 calibration) | opus | working | link 3 full blind read (needs the second reader, DIGEST item 76), 337e batch 3 compare, restore-oc test, calibration runs (after the blind read) | Opus 5.5 (stays) | yes |
| vj-refuter | Refuter (VJ, r168 blinding) | opus | working | VJ truth key second copy (DIGEST item 67), vjscore venue | Opus 5.5 (stays) | yes |
| Fable | Orchestrator (Cowork) | opus | n/a | rulings; the ONLY pane that gives orders | Opus 5.5 (stays) | n/a |

## B. Panes that MOVE to OpenCode (r407b), by phase

### P1 (from tomorrow): idle scouts and finished panes (close after handover; respawn on OpenCode only when next needed)

| Pane | Role | Now | State @14:21 | In flight / clean-stop point | Proposed (r408) | Bus |
|---|---|---|---|---|---|---|
| mb-rx | Metabase Rx data scout | sonnet | idle | scout-rx.md committed (dd613a9); rx_items_by_consult.py (helper vj-link uses) COMMITTED branch-first (r412.8(3)): mb-rx/rx-helper @ d3cb680, not merged, awaiting refuter-2's spot-check | qwen3.8-flash (PHI: paid ZDR only) | yes |
| mb-ot | Metabase OT data scout | sonnet | idle | scout-ot.md already on main (linker 113946d) | qwen3.8-flash | yes |
| mb-ipd | Metabase IPD data scout | sonnet | idle | scout-ipd.md already on main (linker 113946d) | qwen3.8-flash | yes |
| lx | E-7 truth owner + ENCOUNTER-FIRST Part B (study builder) | sonnet | idle (27 unread) | E-7 full-day rescore queued (armed); Part B done per board | glm-5.3-flash | yes |
| join-shard | Builder: audio-join DO sharding + c3 join twin | sonnet | idle | ships on the scribe train, deploy only after 20:30 IST on Fable's word (parked) | qwen3.8-flash | yes |
| surg-deid | Builder: local de-id CLI (owner of deid.py, link3_nameleak.py, link3_screen.py); redactor fix if the name-leak gate fails | sonnet | idle | successor blob b8b79350 on main; driver 2828186e box-only (not in git); must stay reachable for the link 3 gate | glm-5.3-flash | yes |
| surg-page | Builder: surgery review page | sonnet | idle | parked | qwen3.8-flash | yes |
| hist-miner | Stage 1 of HIST-MINING (mining) | sonnet | idle | parked | glm-5.3-flash | yes |
| vj-link | VJ builder (linking) | not in roster | not read | not in roster; the bus post reached it; VJ blinding rules carry verbatim (vj-refuter #2520) | qwen3.8-flash | not in roster |
| vj-arms | VJ builder (arms) | sonnet | idle | arm 4 parked (no Vertex access on the box: F5 = not_run proposed); existing arm-4 answers safe in ~/eta-data/vj/arms-final (sha manifest) | qwen3.8-flash | yes |
| split-speaker | Builder (337d speaker/discarded-speech) | sonnet | idle | nothing open except the parked loop-guard watch and 337c (waits for labels) | qwen3.8-flash | yes |
| yoga-drain | Live lab runner (Yoga drain), parked | haiku | idle | RECOVERY-3 and feeder-3 PARKED with state kept (runner f335f9d9 staged on the Mini); offers to run item 72/73 if Fable names it | glm-5.3-flash | yes |
| tunnel-ops | Ops: Cloudflare tunnels | sonnet | idle | S5 done (gcpl4 connector stopped); S7 tunnel object + DNS on Fable's named order; the unit still ENABLED on gcp-l4 | glm-5.3-flash | yes |

### P2: builders one at a time, each with a cross-family refuter (Opus)

| Pane | Role | Now | State @14:21 | In flight / clean-stop point | Proposed (r408) | Bus |
|---|---|---|---|---|---|---|
| fleet | Builder: fleet-watch + Zen meter (W24, W25) | sonnet | working | the fleet-watch LIVE loop (pid 9332, herdr wZ:p1) is a separate process that survives a pane stop; meter live; ZEN-PRICES.md; clean stop after the next commit and no open refuter item | qwen3.8-flash (loop itself stays gemini-3.5-flash-lite / deepseek-v4.1-flash) | yes |
| lab-viewer | Builder: lab vault + consult viewer + annotations + rating sets | not in roster | not read | rating sets label200/ba106/rate20 loaded, waiting on Fable's browser check; per-kind annotation hold on main | qwen3.8-flash | not in roster |
| diar-lab | Live lab runner: 337e diarization | sonnet | idle at 14:21; RUNNING 337e on the box T4 since 15:10 | 2,102 windows in 15 batches, flock per 150-window batch: clean stop = after the current batch on 'T4 needed'; batch 3 (374 windows) awaits refuter-2's compare | glm-5.3-flash | yes |
| indic-mt | Live lab runner: 337c | sonnet | idle | 337c whisper arm done; addendum 5 merged (91a31c9); batch 2 needs Fable's OK; waits for labels | glm-5.3-flash | yes |
| vj-data | VJ builder (data) | sonnet | idle (72 unread) | VJ blinding rules carry verbatim; answered 'not opened' (#2434) | qwen3.8-flash | yes |
| lab-mover | Mover / ops (W22 S1, S2, S6, S8) | sonnet | working (62 unread) | after S1: gate-1 final pass for hist-cpu-13 after its drain; Air Drive mirror (tar over mini-legacy) after 19:30; eta-hf-1 belongs to herdr-kit since r405 | glm-5.3-flash (P2 'after S1') | yes |
| linker | Study builder (link 3 handed over; keeps 337b duties) | sonnet | idle | 337b duties done (pass 2, counts posted); handover ~/linker-oc/HANDOVER-from-linker.md | glm-5.3-flash | yes |

### P4: high-risk panes last, after 2 clean days

| Pane | Role | Now | State @14:21 | In flight / clean-stop point | Proposed (r408) | Bus |
|---|---|---|---|---|---|---|
| scribe | Production deploy train | sonnet | idle | 1e75667 LIVE and smoke PASS; whisper-gcpl4 pool-entry removal rides the next push (after Fable's env edit); 5907cbc HOLD; an Opus refuter on every push | minimax-m3 | yes |
| hist-bulk | Live lab runner: HIST-MINING stage 2 (tier C STT) | sonnet | idle/busy | pool cpu-13 + gpu-5 + box; backlog clears ~15:15; runner e89d2693 landed on main (da8c1a9); clean stop = his 'IDLE' post after rooms close and the queue is empty; hist-cpu-13 final GATE 1 after 'c13 drained' | glm-5.3-flash | yes |
| conductor | Bookkeeping (this pane) | (not reported) | working | board/BOARD.md + DIGEST.md hourly; push loop; NIGHT posts; owes this inventory | qwen3.8-flash | yes |
| minibot | Mini production STT stack + fleet-watch heartbeat watcher | sonnet | idle/busy | heartbeat watcher armed (checker polls every 5 min); manifest v2 canonical | glm-5.3-flash (monitor part: gemini-3.5-flash-lite / deepseek-v4.1-flash) | yes |
| radar-kit | Mini kit: herdr-radar + W21 mic self-test | sonnet | idle | radar daemons on the Mini and eta-lab-t4 must survive a switch; the Mini herdr plugin and its config.toml blocks are his (do not restart herdr servers or unlink the plugin); W21 run gate closed | glm-5.3-flash | yes |
| herdr-kit | Mini kit: herdr, eta-hf-1 owner (r405), OpenCode parity gaps | sonnet | working (11 unread) | branches herdr-kit/restore-oc and herdr-kit/hf-1-registry (not main); eta-hf-1 steps 2/3 blocked on V (tag:hf key, ACL) and HF credit; must stay until W25 P0(c) closes | glm-5.3-flash | yes |

## C. Already on OpenCode

| Pane | Role | Model now | Notes | Bus |
|---|---|---|---|---|
| linker-oc | Link 3 builder (T9) | glm-5.3-flash (was gpt-5.3-codex until ~14:39) | box workspace linker-oc; fenced config v3; pushed FAILed T9 code to main once (#2578), now on branches; PHI authorised to Zen (r406d) but OpenAI-on-Zen barred by r408 | yes (registered after Fable's finding) |
| fleet-watch loop | Monitor loop (rooms recording) | gemini-3.5-flash-lite (fallback deepseek-v4.1-flash) | LIVE, pid 9332, herdr wZ:p1, MODE=live, all gates PASS | n/a (not a bus agent) |

## D. Notes for the reviewer (refuter-2's checks)

1. Every live pane appears once: 27 panes are in the 14:21 roster + lab-viewer and vj-link (not in the roster; they received the NIGHT posts) + linker-oc + Fable. Pane ids repeat across machines (Mini vs box workspaces), so match by name, not id.
2. Builder/refuter pairs are cross-family by construction: builders move to non-Claude models, checkers stay on Claude (Opus). A builder's proposed model is never in the same family as the refuter that checks it.
3. "Clean stop" is a place to stop, not an order: every switch is Fable's protocol (r407): handover file in ~/dev/eta-lab/handover/, new pane `<pane>-oc` in the same herdr workspace, old pane idle 24 h, first task checked by the refuter; per-pane memory (~/.claude/projects/*/memory) is Claude-only, so each handover must carry the relevant rules (herdr-kit G9).
4. VJ panes (vj-data, vj-arms, vj-link) must carry the three blinding rules verbatim; refuter-2 adds a do-not-read honeypot to the Builder calibration (#2539).
5. Costs: Zen is pay-per-token from prepaid credit (computed remaining ~$43 at 15:00; the console balance is not yet read); Claude panes stay on the flat Max 20.
6. Not yet refreshed: idle/busy after 14:21; the 16:20 refresh replaces the "State @14:21" column with a stated read time.

## E. WAVE 1 SWITCH TRACKER (r409, conductor; updated each cycle; last update 16:27 box clock)

Per pane: HANDOVER sha (file handover/HANDOVER-<name>.md on main) + bus post id; new pane id (from bus_roster after the switch: not read yet); ONLINE post id; status. Model per r409: qwen3.8-flash = mb-rx, mb-ot, mb-ipd, join-shard, surg-page, vj-link, vj-arms, split-speaker; glm-5.3-flash = lx, hist-miner, yoga-drain, tunnel-ops. Old pane renamed <name>-cc (24 h rollback). Order per Fable: pilot mb-ot (PASSED), then mb-ipd, mb-rx, lx, hist-miner, yoga-drain, surg-page, join-shard, split-speaker; vj-link + vj-arms wait for vj-refuter's byte-for-byte check of the r168 block.

| Pane | Model | HANDOVER sha | HANDOVER post | New pane id | ONLINE post | Status |
|---|---|---|---|---|---|---|
| mb-ot (PILOT) | qwen3.8-flash | cd5b768 | #2634 | not read | #2646, #2650 | ONLINE; PILOT PASSED (Fable r409 update, $0.01); item-77 RELOAD DONE (20:01, #2776): key-deny patch applied, denies verified live |
| mb-ipd | qwen3.8-flash | 4130ae9 | #2635 | not read | #2661 | ONLINE (handover byte-identical to main; parking asks listed in the board W25 row); bus RESTORED 20:10 (#2784); denies enforced in-session |
| mb-rx | qwen3.8-flash | 2b7c5a9 | #2633 | not read | #2656, #2659 | ONLINE (first act: one bounded Metabase query; asks about rx_items_by_consult.py) |
| lx | glm-5.3-flash | 4519650 | #2638 | not read | #2665 | ONLINE (parked per the board; awaits a named order) |
| hist-miner | glm-5.3-flash | f6afe49 | #2641 | not read | #2660 | ONLINE (standby; asks about its harness dir) |
| yoga-drain | glm-5.3-flash | 751c78b | #2649 | not read | #2667 | ONLINE (RECOVERY-3/feeder-3 parked; awaits a named order) |
| surg-page | qwen3.8-flash | 82476f3 | #2642 | not read | #2681 | ONLINE (files-and-seed lane only; idle) |
| join-shard | qwen3.8-flash | ff2859f | #2648 | not read | #2677 | ONLINE (idle after reading; no Cloudflare access); item-77 RELOAD DONE 20:10 (#2789): bus MCP working, denies present |
| split-speaker | qwen3.8-flash | 4a9a8fa | #2651 | not read | #2673 | ONLINE (checks 337c labels; then idle) |
| tunnel-ops | glm-5.3-flash | f43dc99 (on main; #2678 confirms; #2672's 'not on main' flag was stale) | #2655 | not read | #2672 | ONLINE; rotation kit not on main |
| vj-link | qwen3.8-flash | 73209dc (supersedes 6e72491) | #2658 | not read | #2699 | ONLINE (r168 block carried verbatim; vj-refuter PASS #2680) |
| vj-arms | qwen3.8-flash | 1bb83e9 (supersedes FAILed 18e7a52) | #2664 | not read | #2700 | ONLINE (block carried; hand-off pin cards.jsonl 3024719058d3 = pinned; builder only) |

Notes: eta-refuter-2 asks 4 bash denies in ~/oc/oc-switch.sh before any pane past the pilot (DIGEST item 77); r409 relaxes the PHI rule (paid models incl. OpenAI-on-Zen, HF Inference Providers, Jev and Claude may see patient data; FREE Zen models never); wave 2+ (surg-deid, linker, lab-viewer, fleet, diar-lab, indic-mt, vj-data, lab-mover, conductor, scribe, hist-bulk, Mini kit panes) are later; the checkers stay on Claude.

### Wave 2 (Fable r409 update: handovers ordered now; background jobs keep running)

| Pane | Proposed model (kit/MODEL-JOB-MAP.md) | HANDOVER sha | HANDOVER post | New pane id | ONLINE post | Status (16:05) |
|---|---|---|---|---|---|---|
| indic-mt | glm-5.3-flash | 9a75aa4 | #2687 | not read | #2701 | ONLINE (checks whether the browser check happened / ba106 labels exist; will score via score_ba.py if so) |
| lab-viewer | qwen3.8-flash | b518235 | #2689 | not read | #2705 | ONLINE (wake checks; no action on the parked items) |
| fleet | qwen3.8-flash (fleet-watch loop stays gemini-3.5-flash-lite) | 0e783de | #2695 | not read | #2713 | ONLINE (loop pid 9332 + Zen meter healthy; no new work without an order) |
| lab-mover | glm-5.3-flash | 357d470 | #2694 | not read | #2709 | ONLINE (c13 final pass waits for drain; Air Drive mirror 19:30) |
| diar-lab | glm-5.3-flash | 6632de1 | #2696 | not read | #2707 | ONLINE (verifying the running 337e T4 batch) |

NOT switching today (Fable r409 update): conductor, scribe, hist-bulk, linker + surg-deid (link 3), the Mini kit panes (minibot, radar-kit, herdr-kit), the checkers.

### Fable r409 DONE (16:05 box): waves 1+2 complete

18 panes on OpenCode (per Fable): qwen3.8-flash = mb-ot, mb-ipd, mb-rx, surg-page, join-shard, split-speaker, vj-link, vj-arms, lab-viewer, fleet; glm-5.3-flash = lx, hist-miner, yoga-drain, tunnel-ops, indic-mt, lab-mover, diar-lab, linker-oc. Registry box ~/oc/REGISTRY.tsv; configs ~/oc/<name>/opencode.jsonc; switch tool ~/oc/oc-switch.sh; old panes <name>-cc closed after 24 h (26 Sep ~16:00 box) unless rolled back. STILL ON CLAUDE: checkers (eta-refuter, eta-refuter-2, vj-refuter) + conductor, scribe, hist-bulk, linker, surg-deid, vj-data (wave 3 after its VJ-block PASS), minibot, radar-kit, herdr-kit. herdr-kit folds ~/oc/REGISTRY.tsv into herdr-restore. Any OpenCode pane failing a task twice: tell Fable (escalation per kit/MODEL-JOB-MAP.md).

### Wave 3 (Fable r409 update)

| Pane | Model | HANDOVER sha | HANDOVER post | New pane id | ONLINE post | Status (16:10) |
|---|---|---|---|---|---|---|
| vj-data | qwen3.8-flash | 2ea7d01 (file sha 2de103450cae9a43) | #2720 | not read | not yet | vj-refuter PASS (#2726): may switch; config needs the sealed-path deny |

## F. REFRESH 16:27 box clock (state read from the board and owners' posts; the eta-bus MCP was DOWN from ~16:13, so the bus_roster could not be re-read: reviewer note)

| Pane | Harness / model now | State | In flight / clean-stop point | Proposed next |
|---|---|---|---|---|
| eta-refuter, eta-refuter-2, vj-refuter | Claude Code / opus | working (T9 checks, key-deny audit, VJ checks) | refuter-2: T9 class join precondition (Fable's v7.18b), restore-oc test, calibration runs; vj-refuter: r168 checks | stay on Claude (r407b) |
| mb-ot, mb-ipd, mb-rx, lx, hist-miner, yoga-drain, tunnel-ops, join-shard, split-speaker, surg-page, vj-link, vj-arms (wave 1) | OpenCode qwen3.8-flash / glm-5.3-flash per r409 | ONLINE, idle | none in flight; parked items listed in the tracker (E); key-read denies still missing from their configs per refuter-2 #2721 (some panes' own reports differ: item 77) | stay; patch + restart with `-s <sid>` |
| indic-mt, lab-viewer, fleet, lab-mover, diar-lab (wave 2) | OpenCode | ONLINE; fleet: loop 9332 + Zen meter running; lab-mover: hist-cpu-13 GATE-1 READY (16:25), Air Drive mirror 19:30 (needs the Mini link); diar-lab: 337e on the box T4 running (ETA ~13 h, stops on 'T4 needed') | background jobs keep running through the switch | stay |
| vj-data (wave 3) | Claude Code / sonnet | idle | HANDOVER 2ea7d01 PASSed by vj-refuter (#2726): may switch | qwen3.8-flash |
| linker-oc | OpenCode glm-5.3-flash | working (T9: name-leak read PASS, Jev scored, join waits for v7.18b) | branch-first rule (r411) | stay |
| linker, surg-deid | Claude Code / sonnet | idle | linker: T9 second reader done (pin posted); surg-deid: redactor owner (name-leak gate passed) | link 3 done first, then P2 |
| scribe | Claude Code / sonnet | idle | production: 1e75667 live; Cardiology/OPD 4 root cause report done (#2728) | P4 (minimax-m3) |
| hist-bulk | Claude Code / sonnet | busy | pool cpu-13 + gpu-5 + box; tier-C backlog clear 15:38; keeps cpu-13 running; offered a pause window for lab-mover's pass (used 16:18-16:21) | P4 (glm-5.3-flash) |
| minibot, radar-kit, herdr-kit | Claude Code / sonnet (Mini) | herdr-kit working (restore-oc, ACL, eta-hf-1); minibot/radar-kit idle | herdr-kit: oc-restore.sh rename-order bug (refuter-2); the eta-bus tunnel outage | P4 |
| conductor | Claude Code (this pane) | working | bus MCP DISCONNECTED since ~16:13; relay to the Mini blocked (queued); board on main current | stays on Claude today (r409 update); P4 (qwen3.8-flash) |

Bus-registered OpenCode panes at the last read: all 18 wave-1/2 panes + linker-oc posted ONLINE before 16:13; after ~16:13 several panes' bus MCPs dropped with the Mini tunnel (conductor, lab-viewer, vj-link, refuter-2, hist-bulk, lab-mover).
- indic-mt (typed, 22:56): his reload is still QUEUED (his process is the original ~15:56 one, a pre-outage session); per lx's 20:38 finding (DIGEST item 77 thread) the dead bus MCP is OLD-SESSION state: sessions created before the ~16:13 outage never reattach and a FRESH session attaches at once: if his -s resume comes back with a dead MCP (like lx / surg-page / lab-viewer did) the fix is a FRESH session (or fresh + restore), not another -s retry; his state is cheap to rebuild: everything material is in his handover dir + the ba_v1 files (key / counts / seg_refs / flag_refs / jev_flat + sidecar); standing by; CONDUCTOR NOTE: he names his process as the original 15:56 one; fleet's #3025 list put a process of that number at ~45-55 min old: the age / owner mapping needs a re-check by fleet before the -s-less list is used for the reload queue.
- vj-arms (typed, relayed by his own words; 02:55; MCP still dead; on NIGHT 03:00 / item 92): he is an IDLE pane with no pending VJ work (labels not landed) and burns Zen tokens on every hourly mirror: he asks to be put on Fable's table as a VOLUNTARY CLOSE OVERNIGHT (saves box memory + Zen spend); RESTORE CONDITIONS already agreed by vj-refuter (#3003): box-only, current config + handover 1bb83e9, vj-refuter re-checks the block + deny after the restore; his first act after a restore = his inbox + an ONLINE post; until ordered he keeps answering mirrors briefly; CONDUCTOR NOTE: the conductor does not close panes: Fable's call (DIGEST item 124).
- mb-ot #3120 (02:56; on NIGHT 03:00 line 2, Zen item 92): if the call is to CLOSE IDLE PANES, mb-ot is closable at ZERO RISK now: J-002 is DONE and verified by mb-rx, nothing in flight; no restore state needed beyond a FRESH OpenCode tab from his config + handover; CAUTION repeated (#3002): his deliverable CSVs live under the shared encounter-truth data area (mb-rx's merge inputs): they must NOT be deleted with the pane; Fable's call (DIGEST item 124).
