# SESSIONS — every agent/session in the ETA lab

Written by the `roadmap` pane. One table per harness group, then the CC re-migration plan. Machine names are real hostnames or herdr ids; PHI/account/hostname redaction rules still apply elsewhere — here I name only internal machine labels already used in the board and handovers.

Last revision: **27 Sep 2026, ~10:45 IST** (rev 5). Rebuilt from herdr snapshot 2026-09-27-1030 (authoritative for who is live now, cross-checked against FLEET.md and the bus). Pool C move (W27, 26 Sep 20:10 IST) stands: agents run on Claude Code on V's personal Max ("Pool C"); OpenCode pools A and B are small-dose top-ups (see the pool key below); Pool A is NO-PHI, Pool B is PHI-OK.

## A. Agents today

Source: herdr snapshot 2026-09-27-1030 (`~/oc/fable/snapshots/2026-09-27-1030/HERDR-SUMMARY.md`) + FLEET.md, cross-checked against the bus. State = the snapshot's own claude/opencode + working/done/idle reading at 10:30 IST; a pane can move between DONE and WORKING within the hour without a new snapshot.

| Agent | Machine·ws | Pool · Model | Project(s) | State | Order | Handover |
|---|---|---|---|---|---|---|
| Fable | Air/Cowork | C · Opus 5.5 (kimi-k3 reserved) | all (orchestrator) | working | — | — |
| roadmap | Mini w12 | C · sonnet | all (records) | done | W27.9 | ~/oc/roadmap/ |
| eta-refuter | Mini w11 | C · opus | SHIP, RECORDER, FOUNDRY | done | standing | HANDOVER-eta-refuter.md |
| eta-refuter-2 | box w18 | C · opus | CLARITY, PRESCRIBE, BACKFILL, SELFTEST, LABVIEW, NOTESAFE, ACOUSTICS | working | standing | HANDOVER-eta-refuter-2.md |
| vj-refuter | box w1A | C · opus | VOICEPRINT, PRESCRIBE (CAP-2 checker) | done | waits V shim (Sun) | HANDOVER-vj-refuter.md |
| lab-mover | box w16 | C · sonnet | BACKFILL, FOUNDRY | done | 19:26 GCP | HANDOVER-lab-mover.md |
| fleet | box w17 | C · sonnet | ROOMS, BACKFILL, SHIP-adjacent (PARITY) | armed | standing | HANDOVER-fleet.md |
| scribe | box w1C | C · sonnet | SHIP, RECORDER, ROOMS | working | R25 / D4 | HANDOVER-scribe.md |
| lab-viewer | box w1D | C · sonnet | LABVIEW, CLARITY, PRESCRIBE | done | L1 / W27.4 / W33.5 | HANDOVER-lab-viewer.md |
| diar-lab | box w1E | C · sonnet | SELFTEST, CLARITY (S1 suites) | working | S1 / W33.1 | HANDOVER-diar-lab.md |
| linker | box w1G | C · sonnet | PRESCRIBE, CLARITY (S3 judge) | done | W27.2 / W33.4 | HANDOVER-linker.md |
| split | box w1H | C · sonnet | SPLIT | done | W27.6 | diar-lab's HANDOVER (337e state) |
| notesafe | box w1J | C · sonnet | NOTESAFE | idle | W27.7 / W30.3 | ~/oc/notesafe/ |
| lid-debug | box w1N | C · opus (DEBUGGER, no fixes) | CLARITY (router root cause) | done, on call | W30.1 / W31.2 | ~/oc/lid-debug/ |
| router-fix | box w1Q | C · sonnet | CLARITY (router fix + eval) | done (eval running) | W31.1 | ~/oc/router-fix/ |
| acoustics | box w1S | C · sonnet | ACOUSTICS | done (chunk run in progress) | W34.2 | ~/oc/acoustics/ |
| freescript | box w1T | C · opus (RESEARCHER, no code) | FREESCRIPT | done | W35 | ~/oc/freescript/ |
| cap | c3 w1 | C · sonnet | PRESCRIBE, CLARITY (S2 router arm) | idle | W27.1 / W30.7 / W33.3 | — |
| stt-bench | c3 w4 | C · sonnet | CLARITY (engine bench, support) | idle | W27.3 / W30.2 / W31.3 | ~/oc/stt-bench/ |
| minibot | Mini w0 | C · sonnet | ROOMS, RECORDER, SHIP | done | standing | HANDOVER-minibot.md |
| t4-serve | box w14 | LOCAL vLLM | FOUNDRY (serves Qwen2.5-7B) | up | — | — |
| mini-serve | Mini wY | LOCAL llama.cpp | FOUNDRY (serves Qwen2.5-Coder-14B) | up | — | — |
| hist-bulk | box w1K | B OpenCode glm-5.3-flash | BACKFILL | done | W28.1 | HANDOVER-hist-bulk.md |
| lx | box w1M | B OpenCode glm-5.3-flash | ENCOUNTER | done | W28.2 | HANDOVER-lx.md |
| herdr-kit | Mini w13 | B OpenCode glm-5.3-flash | FOUNDRY | idle | W28.3 (done) | HANDOVER-herdr-kit.md |
| tone | box w1R | B OpenCode glm-5.3-flash (PHI OK) | TONE | done | W32.1 | (tone HANDOVER, UNVERIFIED) |
| orbox | Mini w14 | A OpenCode glm-5.3-flash (NO PHI) | ORBOX | idle (done) | W29.1 | ~/oc/orbox/ |
| surg-jev | Mini w15 | A OpenCode glm-5.3-flash (NO PHI) | SURGERY | done | W29.2 | ~/oc/surg-jev/ |
| yoga-free | Yoga w1 | FREE big-pickle (NO PHI) | FOUNDRY (free pool: digest/pane-watch/historian/rotate) | idle | Y9-Y12 | — |

**Parked / no active agent in the 10:30 snapshot (workspace exists, last known role unchanged from earlier revisions; not necessarily stopped, just not a live agent row today):** conductor, indic-mt, hist-miner, join-shard, surg-deid, surg-page, split-speaker, mb-rx, mb-ot, mb-ipd, vj-data, vj-arms, vj-link, yoga-drain, tunnel-ops, radar-kit, linker-oc. Their last confirmed role/model is in rev 12/13 of this file; treat as UNVERIFIED for today until they post or appear in a snapshot.

FLEET.md pool key (Fable, 26 Sep wave 27, current): **A** = main OpenCode Go (capped, resets ~21:30) — NO-PHI, invented/public only. **B** = personal OpenCode Go (capped, ~22:00) — PHI OK, no training, small-dose lanes (one task, then stop, no loops). **C** = V's personal Claude Max (Claude Code, `CLAUDE_CONFIG_DIR=~/.claude-personal`) — the main PHI harness. **FREE** = big-pickle on Yoga — NO-PHI. **LOCAL** = T4 vLLM :8000 / Mini llama.cpp :8082 — PHI-safe overflow. **CLOUD** = $250 Claude Code web credits, GitHub repos only.


## Pool C — Claude Code on V's personal Max (W27, 26 Sep 20:10 IST)

- **What changed:** the lab's agents are being brought back up on Claude Code (sonnet for builders, opus for checkers) on V's personal Max, which has headroom. PHI is allowed in these panes (training off, ZDR vendors only). Free models (Yoga big-pickle) stay NO-PHI. OpenCode pools A/B are small top-ups only (Zen stays overflow-only, r452).
- **Confirmed "back on CC-personal" on the bus (26 Sep 20:10-20:12):** lab-mover, fleet, eta-refuter-2, vj-refuter, cap, scribe, lab-viewer, diar-lab, minibot, eta-refuter, linker, split, notesafe, stt-bench, roadmap (#3837-#3886).
- **Not mentioned in W27, so state UNVERIFIED (rows below stay as last recorded):** conductor, herdr-kit, indic-mt, hist-bulk, hist-miner, surg-*, join-shard, split-speaker, mb-*, lx, vj-data/arms/link, yoga-drain, tunnel-ops, radar-kit.
- **Rules that still hold:** builders never review their own work; eta-refuter-2 (box) reviews lab code, eta-refuter (Mini) production/evenscribe code and herdr-kit, vj-refuter (box) CAP-2 and stt-bench; the Mini is off-limits 08:15-20:30; no secrets on argv.
- **Effect on section B:** step 1 (checkers) is already done in effect, and most builders came back at the same time, so the re-migration plan below is now a fallback and a reference for the panes not yet moved, not a to-do.

## B. CC RE-MIGRATION PLAN (when V's Claude Max recharges)

The reverse switch, in priority order — the same role split that moved to OpenCode, undone in the cheapest-safe order:

1. **Checkers first** (eta-refuter, eta-refuter-2, vj-refuter) → Claude Code / Opus 5.5. Cross-family checking is the whole point; without an Opus checker the builders' work is unrefuted.
2. **Orchestrator (Fable)** → Cowork / Opus 5.5 (kimi-k3 stays reserved for Fable + PHI/security/production checks).
3. **Production deploy train (scribe)** → Claude Code, with an Opus refuter on every push.
4. **Long-protocol study builders** (linker, surg-deid, hist-miner) → Claude Code / Sonnet or OpenCode glm-5.3 escalated.
5. **Everyone else** stays on OpenCode until a job actually fails twice on its OpenCode model (the r408 escalation rule).

### Per-pane reverse-switch procedure
- Mirror the forward tool: box `~/oc/oc-switch2.sh <name> <model> ~/oc/SECURITY-RULES.md`; Mini `zsh ~/oc/oc-switch-mini.sh <name> <model>`. Write a `cc-switch.sh` that is the reverse (OpenCode pane → Claude Code), same checks:
  1. Read the pane's handover from origin/main `handover/HANDOVER-<name>.md`.
  2. Verify the handover sha matches the live file.
  3. Stop the OpenCode pane cleanly; rename it `<name>-oc` (24 h rollback).
  4. Spawn the Claude Code pane as `<name>`; confirm model line reads the intended Claude model (no free fallback).
  5. First task on the new pane is checked by a refuter.
- **Budget guard rules:** switch only while Zen runway is comfortable; if Zen < $10 or < 24 h runway, Fable tells V at once (r407 standing rule). No auto-recharge. Log every overflow switch (pane, time, reason).
- **Handovers carry state both ways:** each handover must carry the pane's rules verbatim (VJ panes carry the three blinding rules + the sealed-path deny block; deploy train carries the never-push-without-Fable rule; checkers carry rerun-tests-yourself + positive-controls-first).

## C. Non-pane processes (live, survive pane restarts)

| Process | Owner | Model | Notes |
|---|---|---|---|
| fleet-watch loop (pid 9332, herdr wZ:p1) | fleet | opencode-go/glm-5.3-flash (was gemini-3.5-flash-lite) | 5-min room polling, $2/day cap |
| Zen usage export daemon | fleet | — | polls org usage every 15 min |
| eta-bus MCP server | V (restart only) | — | needs V's restart to fix `fable` addressing + async wake + timeouts |
