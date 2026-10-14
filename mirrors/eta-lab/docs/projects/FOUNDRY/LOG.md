# LOG — FOUNDRY (machines, agents, bus, models, budget)

Build and event log, newest first. Owner panes: Fable (lead), herdr-kit, fleet, tunnel-ops, radar-kit, lab-mover, conductor.

## 26 Sep ~16:00 IST — FABLE 452: all-Go sweep, Zen overflow-only
Session: Fable (orchestrator).
V's rulings executed: every remaining Zen pane switched by Fable; Zen = overflow-only (never default; overflow switches logged); all -cc Claude panes STOPPED (no Max spend until Tue 29 Sep 18:30); Zaki cleared (Access + app lists); Zen console anchor $194.76 (~16:00).
Refs: FABLE 452, #3671, #3679.

## 26 Sep ~16:00 IST — FABLE 449: checkers → deepseek-v4-pro
Session: Fable.
Checker model now opencode-go/deepseek-v4-pro (verified on Go). kimi-k3 reserved for Fable + PHI/security/production checks. $478 OpenRouter split closed (skip). 30 Sep = re-confirm date for the DeepSeek Go ZDR, not a known expiry.
Refs: FABLE 449, #3650.

## 26 Sep — zen-meter-go PASS; meter deployed
Session: eta-refuter-2 (checker) + fleet (deploy).
zen-meter-go 904f79b + 807d0b3 PASS: Go ledger (is_zen counts opencode + opencode-go, excludes openrouter) + FREE-MODEL-SEEN tripwire. Deployed 807d0b3 live; remaining computed $197.19.
Refs: #3661, #3665, #3681.

## 26 Sep 12:15 IST — FABLE 432: full OpenCode switch
Session: Fable + herdr-kit.
Claude Max nearly exhausted; all 12 Claude panes moved to OpenCode (r432). Handovers written for each; `<name>-cc` kept 24 h.
Refs: r432; handover/HANDOVER-*.md.

## 26 Sep ~03:00 IST — GCP exit complete (S6)
Session: lab-mover.
All 5 GCP VMs powered off; compute billing stopped. S7 (disk/snapshot delete) pending 24 h + V's gcloud auth. Archive mirrored to box (~388 GB) + Mini Air Drive (~144 GB).
Refs: r378, r386, r419.

## 26 Sep 09:07 IST — tunnel rotation
Session: tunnel-ops.
Test tunnel 44377ad1 deleted; exactly 5 live tunnels remain; rotation kit on main (7e13508).
Refs: #3359, r351.

## 26 Sep ~14:30 IST — 448 privacy PASS
Session: Fable + fleet.
Free-model fallback dead account-wide (server hard-400 on big-pickle; bad Go ids fail clean; 5 models message-level verified). All 14 free rows attributed (2 known 447 sessions + Fable's 448 probe) — no unmanaged launch, no pinning.
Refs: #3647, #3680, FABLE 448.

## Open
V restarts the eta-bus MCP server (fixes `fable` addressing + async wake + timeout). Zen top-up cadence (manual per r407). Box memory target.
