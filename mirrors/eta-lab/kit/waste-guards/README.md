# waste-guards (Fable ORDER 455.A)

Owner: herdr-kit. Scripts, not instructions. No model calls anywhere.

## Pieces
| file | order item | what |
|---|---|---|
| `oc_usage.py` | A.1/A.4 lib | read-only opencode.db readers, mini + box + c3 (ssh stdin python, `mode=ro`) |
| `context_watchdog.py` | A.1 | every pass: last-assistant `tokens.total` per live session >= limit (default 150K) -> bus alert + handover/fresh-session command; 4 h dedup per session; Fable SERVER session (dir `*/_private/fable/*`) included and tagged (only Fable/V can re-seat it) |
| `token_budget.py` | A.4 | per-pane daily tokens+cost (message-level sums, IST day), 80%/100% bus alerts, 08:00 IST cross-machine table |
| `loop_gate.py` | A.2 | change-check helper: `check <loop> <hash>` exit 3 = same inputs < 30 min (floor NOT lowerable) -> skip the model call; `record` after a spend |
| `idle_reaper.py` | A.3 | herdr `done/idle` pane + session quiet > 60 min + empty queue -> DRY-RUN print; `--stop` sends `/exit`. v1 = Mini only (box herdr has no session ids) |
| `guards_main.py` | all | one 15-min pass = watchdog + budget + (first pass after 08:00 IST) the daily table |
| `bus_alert.py` | A.5 | one-shot eta-bus MCP post (ETA_BUS_AS=herdr-kit), body hard-capped 1500 chars |
| `com.eta-lab.waste-guards.plist.template` | install | V-run launchd template (herdr-kit never touches launchd) |
| `test_waste_guards.py` | gate | stdlib unittest, 9 tests |

## Verified live (26 Sep)
- alert path: bus id 3739 (fable stored_poll).
- watchdog found 32 fleet-wide breaches at 150K (mini 7 incl. the 468K Fable-server
  session, box 20s, c3 193K); budget table posted bus 3744 with real numbers.
- loop-gate floor: same-hash inside 30 min -> exit 3 (test proves the floor).

## Install (V, after eta-refuter PASS; dry-run first)
```
python3 .../waste-guards/context_watchdog.py --once        # dry: prints breaches
python3 .../waste-guards/token_budget.py table             # dry: prints table
python3 .../waste-guards/idle_reaper.py --once             # dry: prints stops
plutil -lint .../com.eta-lab.waste-guards.plist.template && cp ... ~/Library/LaunchAgents/com.eta-lab.waste-guards.plist && launchctl load ~/Library/LaunchAgents/com.eta-lab.waste-guards.plist
```
`--enforce` in the plist args is what turns bus posting on.

## A.5 hygiene (self-enforced)
- herdr-kit bus posts <= 1500 chars; review texts go to scratch files, bus carries
  the path + verdict only. bus_alert.py enforces the cap mechanically for guard posts.

## Flagged (not silently decided)
- The watchdog never executes the handover itself (herdr-kit's standing never-spawn
  rule beats the "handover + fresh session" automation in 455.A.1). If Fable wants
  full auto, an explicit order amends the rule; the script then calls the oc-switch
  pattern directly.
- idle_reaper v1 covers Mini panes only.
- Budget basis = billed tokens (input+output+cache_read summed per assistant message)
  + message-level $ (the meter's own basis). The budget default 800K tokens/pane/day
  is a PLACEHOLDER - Fable sets the real number.
