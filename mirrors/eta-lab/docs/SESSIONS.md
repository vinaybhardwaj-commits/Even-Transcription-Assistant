# SESSIONS — every agent/session in the ETA lab

Written by the `roadmap` pane. Machine names are real hostnames or herdr ids; PHI/account/hostname redaction rules still apply elsewhere — here I name only internal machine labels already used in the board and handovers.

Last revision: **29 Sep 2026, ~23:10 IST** (rev 8, addendum only; the table below is still the rev 6 query of 28 Sep and is UNVERIFIED for today).

**Roster addendum, 29 Sep ~23:10 IST (rev 8, UNVERIFIED against a live query):** eta-refuter-2 and eta-refuter-3 are the active checkers (#7480, #7600); hf-fleet runs the Koyal pump (#7592); terms owns T-TERMS-40; Herdr on the Mini is 0.9.1 (spare 0.9.2 handoff failed, #7598). The table body below is still the 28 Sep query and is UNVERIFIED.

**Roster change of record, 29 Sep 18:30 IST (Fable handover, bus #6855-6857):** Mini-Fable stood down at 18:26; Cowork Fable on V's MacBook Air resumed as `fable` at 18:30. Added since rev 6: warden (dispatcher, sweeps ~10 min), hist-bulk, split, router-fix, lid-debug, sig-research, sig-debug, surg-link, scribe, terms, notesafe, tone, acoustics, freescript, stt-bench, yoga-free, vp-asus, hf-fleet, lab-viewer, lx, jev-audit, jev-fix, reb, diar-lab, linker, cap, three refuters (eta-refuter Mini, eta-refuter-2 box, eta-refuter-3 REB/terms/mint; vj-refuter for VOICEPRINT/CAP). `chronicle` (asus-ubuntu) is not a registered bus name; Fable relays. Whether each agent is idle or busy right now: UNVERIFIED (Fable's 19:40 audit names acoustics, freescript, jev-fix, fleet, lab-mover, stt-bench, terms, notesafe and surg-jev as idle, #7097).

## A. Agents today (Mini + box, live query)

Some herdr `group` labels are stale (an agent's opening-order label that never got updated as it moved to later orders) — where I know the real current work from the bus, I've corrected the Project(s) column and noted the stale label.

| Agent | Machine·ws | Pool · Model | Project(s) | State | Order | Handover |
|---|---|---|---|---|---|---|
| roadmap | Mini w12 | C · sonnet | all (records) | working | W27.9 | ~/oc/roadmap/ |
| eta-refuter | Mini w11 | C · opus | SHIP, RECORDER, FOUNDRY | done | standing | HANDOVER-eta-refuter.md |
| minibot | Mini w0 | C · sonnet | ROOMS, RECORDER, SHIP | done | standing | HANDOVER-minibot.md |
| herdr-kit | Mini w13 | B OpenCode glm-5.3-flash | FOUNDRY (bus latency fix, HF fleet support) | done | W28 | HANDOVER-herdr-kit.md |
| orbox | Mini w14 | A OpenCode glm-5.3-flash (NO PHI) | ORBOX | idle | W29.1 (done) | ~/oc/orbox/ |
| surg-jev | Mini w16 | C · sonnet | SURGERY (Jev wording trial, W40 skill handover) | done | W40 | ~/oc/surg-jev/ |
| lab-mover | box w16 | C · sonnet | BACKFILL, FOUNDRY (mirror scripts) | done | standing | HANDOVER-lab-mover.md |
| fleet | box w17 | C · sonnet | BACKFILL (PARITY-389), ROOMS | done | standing | HANDOVER-fleet.md |
| eta-refuter-2 | box w18 | C · opus | checker: CLARITY/REB/FUSER/W50/LABVIEW/ACOUSTICS/SELFTEST/most builder branches | done | standing | HANDOVER-eta-refuter-2.md |
| scribe | box w1C | C · sonnet | SHIP, RECORDER, ROOMS | done | R25 / D4 / post-D4 | HANDOVER-scribe.md |
| lab-viewer | box w1D | C · sonnet | LABVIEW (/timeline P1-P3, pitch25, /clarity) | done | W49 | HANDOVER-lab-viewer.md |
| diar-lab | box w1E | C · sonnet | SELFTEST, CLARITY (S1/confirm suites), W52 (diarization support) | working | S1 / W33.1 / W52 | HANDOVER-diar-lab.md |
| split | box w1H | C · sonnet | SPLIT | done | W27.6 | diar-lab's HANDOVER (337e state) |
| hist-bulk | box w1K | B OpenCode glm-5.3-flash | BACKFILL (daily drain) | working | W28.1 | HANDOVER-hist-bulk.md |
| lid-debug | box w1N | C · opus (DEBUGGER, no fixes) | CLARITY (router root cause, S1-REPORT), FUSER (design consultant) | done | W30.1 / W31.2 | ~/oc/lid-debug/ |
| router-fix | box w1Q | C · sonnet | CLARITY (S1 re-run), FUSER/G3 (builder) — *stale group label "M1-M5"* | done | W31.1 / FUSER | ~/oc/router-fix/ |
| acoustics | box w1S | C · sonnet | ACOUSTICS | done | W34.2 / W39 | ~/oc/acoustics/ |
| freescript | box w1T | C · opus (RESEARCHER, no code) | FREESCRIPT | done | W35 / W38 | ~/oc/freescript/ |
| jev-audit | box w1V | C · sonnet | NOTESAFE (W36 Jev audit, closed) | done | W36 | ~/oc/jev-audit/ |
| sig-debug | box w1W | C · opus (DEBUGGER) | RECORDER (W37 signature_mismatch, closed) | done | W37 | ~/oc/sig-bug/ |
| sig-research | box w1X | C · sonnet | RECORDER (W37 signature facts, closed) | done | W37 | ~/oc/sig-bug/ |
| notesafe | box w1Z | C · sonnet | NOTESAFE — *stale group label "W40 skill-aware"* | done | W27.7 / W40 | ~/oc/notesafe/ |
| vj-refuter | box w10 | C · opus | VOICEPRINT (W51/W52 checker, sealed-truth custodian), PRESCRIBE (CAP-2) — *stale group label "W40 skill-aware"* | working | W40 / W51 / W52 | HANDOVER-vj-refuter.md |
| lx | box w21 | C · sonnet | ENCOUNTER (W44 Jev loop), VOICEPRINT (W51/W52 voice scan + diarization) — *stale group label "W40 skill-aware"* | working | W40 / W44 / W51 / W52 | HANDOVER-lx.md |
| jev-fix | box w22 | C · sonnet | NOTESAFE (W41 Jev fixes, closed) | done | W41 | ~/oc/jev-audit/ |
| linker | box w23 | C · sonnet | PRESCRIBE, BACKFILL (nightly PQM), VOICEPRINT (W52 encounters+Rx), CLARITY (S3 judge) — *stale group label "W40 skill-aware"* | idle | W40 / W49 / W52 | HANDOVER-linker.md |
| tone | box w24 | C · sonnet | TONE | done | W45 | (tone HANDOVER, UNVERIFIED) |
| surg-link | box w25 | C · sonnet | SURGERY (W46 interventional pitch linking) | done | W46 | ~/oc/surg-link/ |
| reb | box w26 | C · sonnet | REB (W47), CLARITY, W52 (package integrator) | working | W47 | ~/oc/reb/ |
| hf-fleet | box w27 | C · sonnet | FOUNDRY (W48 HF GPU fleet), REB/W50/W52 (GPU jobs) | working | W48 | ~/oc/hf-fleet/ |
| terms | box w28 | C · sonnet | W50 clinical-language STT bake-off | done | W50 | ~/oc/terms/ |
| eta-refuter-3 | box w29 | C · opus | checker: REB + W50 (second checker, never the same branch as eta-refuter-2) | working | standing | HANDOVER-eta-refuter-3.md |

## B. Not queried this pass — carried forward from rev 5, UNVERIFIED

| Agent | Machine·ws (rev 5) | Pool · Model (rev 5) | Project(s) (rev 5) |
|---|---|---|---|
| cap | c3 w1 | C · sonnet | PRESCRIBE, CLARITY (S2 router arm) |
| stt-bench | c3 w4 | C · sonnet | CLARITY (engine bench, support) |
| yoga-free | Yoga w1 | FREE big-pickle (NO PHI) | FOUNDRY (free pool) |
| t4-serve | box w14 | LOCAL vLLM | FOUNDRY (Qwen2.5-7B serving) |
| mini-serve | Mini wY | LOCAL llama.cpp | FOUNDRY (Qwen2.5-Coder-14B serving) |

**Parked / not a live agent row in either query (workspace may still exist; last known role from earlier revisions):** conductor, indic-mt, hist-miner, join-shard, surg-deid, surg-page, split-speaker, mb-rx, mb-ot, mb-ipd, vj-data, vj-arms, vj-link, yoga-drain, tunnel-ops, radar-kit, linker-oc.

**New agents this revision (stood up since rev 5):** jev-audit, sig-debug, sig-research, jev-fix (all NOTESAFE/RECORDER threads, now closed/done), surg-link (SURGERY), reb (REB), hf-fleet (FOUNDRY/REB), terms (W50), eta-refuter-3 (second Opus checker — added because eta-refuter-2 alone could not keep up with REB + W50's parallel branch volume; the two checkers never review the same branch).

## Pool key (unchanged since rev 5)

**A** = main OpenCode Go (capped, resets ~21:30) — NO-PHI, invented/public only. **B** = personal OpenCode Go (capped, ~22:00) — PHI OK, no training, small-dose lanes (one task, then stop, no loops). **C** = V's personal Claude Max (Claude Code, `CLAUDE_CONFIG_DIR=~/.claude-personal`) — the main PHI harness, sonnet for builders, opus for checkers/debuggers/researchers. **FREE** = big-pickle on Yoga — NO-PHI. **LOCAL** = T4 vLLM :8000 / Mini llama.cpp :8082 — PHI-safe overflow (local Qwen models were later removed from both machines, 27 Sep 12:05 V ruling, to free T4 capacity for STT — these two rows may now be stale; UNVERIFIED this pass). **CLOUD** = $250 Claude Code web credits, GitHub repos only. **HF Jobs** (new, W48): pay-per-job L4 GPU (`l4x1`, $0.80/h), up to 5 concurrent, used by REB/W50/W52 — not an always-on pool, no idle billing.

## C. Non-pane processes (live, survive pane restarts)

| Process | Owner | Notes |
|---|---|---|
| fleet-watch loop | fleet | room polling, budget-capped |
| Zen usage export daemon | fleet | polls org usage every 15 min |
| eta-bus MCP server | V (restart only) | latency fix (Promise.all parallel herdr calls) shipped this revision |
| mirror_daily.sh (nightly backup mirror) | lab-mover | hardened this revision (4 real bugs fixed); runs after 20:30 |
| REB fan-out runner | reb | claim-once workers across box/c3/HF, used by REB/W50/W52 GPU jobs |

## Note on the CC re-migration plan (rev 4/5's section B)

That plan (the reverse OpenCode→Claude Code switch order) is now moot in practice: every substantive builder and checker role runs on Pool C (Claude Code) today, and has for two days straight. The only OpenCode rows left are genuinely small-dose lanes (Pool A/B, one task then stop) by design, not a migration backlog. The budget-guard rule still stands if that ever needs to reverse: switch only while Zen/pool runway is comfortable, log every move, checker roles first.
