# Model downgrade to cut usage (Fable, 24 Sep 11:40 IST; V asked)

Rule: Refuters and root-cause Debuggers stay Opus. Builders, researchers and deploy runners → Sonnet. Watchers of a running script → Haiku.
Switch with `/model <name>` typed into the pane ONLY when the agent is idle (status done/idle). Context is kept. Never interrupt a working agent.

| Session | Machine | Now | New | When |
|---|---|---|---|---|
| eta-refuter | mini | Opus (1M) | **stays Opus**; `/model opus` (drop the 1M-context variant) | now if idle |
| eta-refuter-2 | box | Opus | **stays Opus** | — |
| minibot | mini | Opus | Sonnet | now (idle) |
| split-speaker | box | Opus | Sonnet | right after it delivers arms A–D (12:00) |
| lx | box | Opus | Sonnet | at its next idle (after encounter_bounds work) |
| scribe | box | Opus | Sonnet | AFTER the 12:30 deploy smoke passes |
| yoga-drain | box | Sonnet | Haiku | now (idle; feeder watcher) |
| hist-bulk | gcp-l4 | Sonnet | Haiku | once its queue runner is written, tested, and running unattended |
| conductor, fleet, surg-page, surg-deid, join-shard, hist-miner, lab-mover, diar-lab, indic-mt, herdr-kit | box / mini | Sonnet | stay Sonnet | — |

Also:
- Mini default `~/.claude/settings.json` "model": change `opus[1m]` → `sonnet`. New Mini sessions default to Sonnet; Refuters are launched with `--model opus` explicitly.
- Idle-cost hygiene: any session above ~150k context that is idle runs `/compact` at its next idle. The conductor tracks this.

Owner: herdr-kit executes the switches. It verifies each one by reading the pane's model line and reports a table (session, before, after, time).
