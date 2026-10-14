# SESSIONS — every agent/session in the ETA lab

Written by the `roadmap` pane. One table per harness group, then the CC re-migration plan. Machine names are real hostnames or herdr ids; PHI/account/hostname redaction rules still apply elsewhere — here I name only internal machine labels already used in the board and handovers.

Last revision: **26 Sep 2026, ~17:30 IST** (rev 1). Model state is post-r449 (checkers → opencode-go/deepseek-v4-pro) and post-r452 (all-Go sweep; Zen = overflow-only; -cc panes stopped).

## A. Agents today

| Agent | Role | Machine | Harness | Model (r449/r452) | Project(s) | Handover |
|---|---|---|---|---|---|---|
| Fable | orchestrator (only giver of orders) | Air/Cowork | Cowork/OpenCode | Opus 5.5; kimi-k3 reserved for Fable | all | — |
| roadmap | records keeper (this pane) | Mini | OpenCode | deepseek-v4-pro | all | ~/oc/roadmap/ |
| eta-refuter | checker / debugger | box (+ Mini side) | OpenCode (go) | deepseek-v4-pro | SHIP, FOUNDRY, SPLIT, ROOMS | HANDOVER-eta-refuter.md |
| eta-refuter-2 | checker (lab studies, pages, CI) | box | OpenCode (go) | deepseek-v4-pro | CLARITY, PRESCRIBE, BACKFILL, SPLIT, SURGERY, LABVIEW | HANDOVER-eta-refuter-2.md |
| vj-refuter | checker (VJ truth custodian — only pane that sees sealed truth) | box | OpenCode (go) | deepseek-v4-pro | VOICEPRINT | HANDOVER-vj-refuter.md |
| conductor | bookkeeping only (board/digest/NIGHT) | box | OpenCode | qwen3.8-flash | FOUNDRY (bookkeeping) | HANDOVER-conductor.md |
| fleet | room monitor + Zen meter | box | OpenCode | qwen3.8-flash; fleet-watch loop → opencode-go/glm-5.3-flash | ROOMS, SURGERY, NOTESAFE, FOUNDRY | HANDOVER-fleet.md |
| lab-viewer | builder: viewer + rating UI | box | OpenCode | qwen3.8-flash | CLARITY, LABVIEW | HANDOVER-lab-viewer.md |
| lab-mover | ops/mover (compute, GCP exit, PARITY) | box | OpenCode | glm-5.3-flash | BACKFILL, FOUNDRY, SELFTEST | HANDOVER-lab-mover.md |
| diar-lab | live lab runner (diarization) | box (T4) | OpenCode | glm-5.3-flash | SPLIT, SELFTEST | HANDOVER-diar-lab.md |
| indic-mt | live lab runner (337c re-transcription, emotion) | box | OpenCode | glm-5.3-flash | CLARITY, TONE | HANDOVER-indic-mt.md |
| hist-bulk | live lab runner (stage-2 STT + c3 loop) | box + c3 | OpenCode | glm-5.3-flash | BACKFILL | HANDOVER-hist-bulk.md |
| hist-miner | study builder (stage-1 anchors) | box | OpenCode | glm-5.3-flash | BACKFILL, ENCOUNTER | HANDOVER-hist-miner.md |
| linker / linker-oc | study builder (337b, Link-3, CAP bundles) | box | OpenCode | glm-5.3-flash | CLARITY, PRESCRIBE, SURGERY | HANDOVER-linker.md |
| cap | evaluator (CAP scoring) | eta-ci-c3 (w1:p1) | OpenCode | paid model (r430b) | PRESCRIBE | — |
| surg-deid | builder: local de-id CLI | box | OpenCode | glm-5.3-flash | SURGERY | (surg-deid HANDOVER) |
| surg-page | builder: surgery review page | box | OpenCode | qwen3.8-flash | SURGERY | HANDOVER-surg-page.md |
| join-shard | builder: audio-join sharding | box | OpenCode | qwen3.8-flash | BACKFILL | HANDOVER-join-shard.md |
| split-speaker | builder (337d metrics, filler/loop guards) | box | OpenCode | qwen3.8-flash | CLARITY, SPLIT | HANDOVER-split-speaker.md |
| scribe | production deploy train | box | OpenCode | minimax-m3 | SHIP, ROOMS, RECORDER | HANDOVER-scribe.md |
| mb-rx | Metabase Rx data scout | box | OpenCode | qwen3.8-flash | ENCOUNTER, PRESCRIBE | — |
| mb-ot | Metabase OT data scout | box | OpenCode | qwen3.8-flash | ENCOUNTER | — |
| mb-ipd | Metabase IPD data scout | box | OpenCode | qwen3.8-flash | ENCOUNTER | — |
| lx | E-7 truth owner + encounter study | box | OpenCode | glm-5.3-flash | ENCOUNTER | HANDOVER-lx.md |
| vj-data | VJ builder (data + cards) | box | OpenCode | qwen3.8-flash | VOICEPRINT | HANDOVER-vj-data.md |
| vj-arms | VJ builder (arm runners) | box | OpenCode | qwen3.8-flash | VOICEPRINT | HANDOVER-vj-arms.md |
| vj-link | VJ builder (Phase L linking) | box | OpenCode | qwen3.8-flash | VOICEPRINT | HANDOVER-vj-link.md |
| yoga-drain | live lab runner (Yoga drain) | box | OpenCode | glm-5.3-flash | BACKFILL | HANDOVER-yoga-drain.md |
| tunnel-ops | ops: Cloudflare tunnels | box | OpenCode | glm-5.3-flash | FOUNDRY | HANDOVER-tunnel-ops.md |
| minibot | Mini production STT stack + heartbeat watcher | Mini | OpenCode | glm-5.3-flash | SHIP, ROOMS, RECORDER | HANDOVER-minibot.md |
| radar-kit | Mini kit: herdr-radar + mic self-test | Mini | OpenCode | glm-5.3-flash | ROOMS, SELFTEST, FOUNDRY | HANDOVER-radar-kit.md |
| herdr-kit | Mini kit: herdr, OpenCode parity, HF infra | Mini | OpenCode | glm-5.3-flash | FOUNDRY | HANDOVER-herdr-kit.md |

Rollback panes: each migrated pane kept a `<name>-cc` Claude Code twin for 24 h. Per r452 these are all **STOPPED now** (process TERM, relaunchable, not deleted) — no Max spend until Tue 29 Sep 18:30 IST.

Note: the 26 Sep box-memory emergency (FABLE 442) TERM'd 17 done-state OpenCode panes to free RAM (197 MB → 20.7 GB); the r452 sweep relaunches only the panes needed tonight on Go. A pane stopped by 442 is relaunched fresh (`-s <sid>`), not waited-on.

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
