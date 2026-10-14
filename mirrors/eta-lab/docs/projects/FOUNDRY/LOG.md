# LOG — FOUNDRY (machines, agents, bus, models, budget)

Build and event log, newest first. Owner panes: Fable (lead), herdr-kit, fleet, tunnel-ops, radar-kit, lab-mover, conductor.

## 26 Sep ~16:2x IST — nophi stopped; local-model plan; 3rd free-model fire
Session: Fable (ruling D.5 / C) + conductor (NF boarding).
nophi-run account STOPPED per D.5: free model (big-pickle) REFUSED on both headless and TUI paths ("OpenCode's free tier can only be used from within OpenCode"); paid refused "Insufficient account funds" — free tier unreachable by API-key configs; V's call on device-login vs drop. Local-model plan → herdr-kit (Ollama on Mini/box T4 as OpenCode provider for loops/pollers/formatting; benchmark 5 tasks vs Go flash; eta-refuter checks before any pane moves). FREE MODEL SEEN 3rd fire: big-pickle on `mini:dir:eta-lab` (2 calls/3h), 2nd Mini dir — with Fable for attribution. Also: >150K contexts fresh-sessioned (roadmap, eta-refuter).
Refs: #3721, #3725.

## 26 Sep ~15:5x IST — 452 bus channel live; zen bin moved; free-model 2nd fire
Session: conductor (bookkeeping) + fleet (meter) + Fable (usage).
FABLE 452's bus channel CONFIRMED: `fable` recipient resolves (stored_poll) — #3701/#3702. Zen meter bin moved to bd4c2e6 (27/27 here, first cron tick clean, remaining $181.00) — #3712. FABLE 453a usage table posted; 453.B governance adopted (change-gated waves, id-paged bus reads, 30-min NIGHT cap) — #3716/#3717. FREE MODEL SEEN 2nd fire: big-pickle on `mini:dir:nophi-run`, first Mini-directory fire, with Fable for routing — #3719/#3720.
Refs: #3701, #3702, #3711, #3712, #3716, #3717, #3719, #3720.

## 26 Sep ~18:15 IST — fleet-watch Go route PASS + live
Session: eta-refuter-2 (checker); fleet (owner).
fleet/452-go-model @ 8e8de659 PASS: fleet-watch loop now runs opencode-go/glm-5.3-flash (default), with a one-retry fallback to the proven Zen deepseek-v4.1-flash (452 overflow rule); live bin byte-identical to the branch except the disclosed r412.6 NOT_DELIVERING hunks. Suite rerun 30/30 + 16/16.
Refs: #3710.

## 26 Sep ~18:00 IST — zen meter display fix ack
Session: eta-refuter-2 (checker).
bd4c2e6 PASS (27/27 rerun): go_share_computed moved above the early return, one new regression test; spent math untouched. fleet may move the bin.
Refs: #3699.

## 26 Sep ~12:45 IST — FABLE 437: apply scripts run clean
Session: V (ran ~/run-setup-436.sh); Fable ordered.
All 3 trials dry-run clean, then applied: eta-ci-c3-apply 81207f53 OK 18/FAIL 0; taghf-apply eec46921 OK 15/0; hf2-gateway-apply f51e9f30 OK 11/0. Post-apply checks now with eta-refuter (cap identity resolves to eta-ci-c3; ro mount; hf-1 identity; hf-2 key lines) + vj-refuter (VJ denied set).
Refs: FABLE 437, #3579.

## 26 Sep ~13:00 IST — box memory emergency (FABLE 442)
Session: Fable (on V's order).
Box hit 197 MB free / load 121. V ordered Fable to TERM 17 done-state OpenCode panes → 20.7 GB free. Kept: conductor, indic-mt, lab-viewer, linker-oc, fleet, scribe, linker, eta-refuter-2, vj-refuter. -cc rollback panes untouched.
Refs: FABLE 442, #3615.

## 26 Sep ~13:45 IST — 337b re-run done (FABLE 443)
Session: linker (V ran the command).
25 Sep translation re-run complete: 255/261 windows done (final: 1,203/1,203 in-scope segments; all-date 3,069 done, 14 todo). English split for the CAP-1 report unblocked.
Refs: FABLE 443, #3623.

## 26 Sep — go-switch -s blocker + free-model incident (443/447)
Session: Fable + herdr-kit.
Proven: relaunching a pane with `-s <sid>` restores the OLD provider (stays on Zen); only fresh sessions take the Go route. Second failure mode: a pane that lost OPENCODE_CONFIG silently falls back to the free "big-pickle" model — bit eta-refuter-2 twice (14 calls, LOW severity, no patient text). Fix = fresh-session launch WITH the OPENCODE_CONFIG env prefix + db-pin verify.
Refs: FABLE 443 #3623, FABLE 447 #3634.

## 26 Sep — herdr-kit commits: Go route + fable-oc tick
Session: herdr-kit.
MODEL-JOB-MAP.md gains the Go-route section (never-for-PHI list, DeepSeek ZDR through 30 Sep, kimi-k3 fallback) — 0766f16e; SECURITY-RULES rule 7 → PAID model (Zen or Go). fable-oc tick installer DRAFT (09f14950, sha af2f65a1) — V-run, StartInterval 1800, not installed.
Refs: #3593.

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
