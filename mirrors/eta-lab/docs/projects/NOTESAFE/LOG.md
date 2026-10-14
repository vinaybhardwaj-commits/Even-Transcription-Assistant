# LOG — NOTESAFE (note faithfulness / completeness)

Build and event log, newest first. Owner panes: fleet (builder), eta-refuter (checker).

## 24 Sep 05:00 IST — FINDING 1
Session: eta-refuter (checker).
Jev U4 (faithfulness) / U8 (completeness) evaluation logic is in production behind flag `JEV_NOTE_FAITHFULNESS`. FINDING 1: JevHttpError must never expose provider body text; choices must validate against schema.
Refs: r154 (related).

## Status
Shadow mode only, flags OFF. Next gate: medication-note benchmark with false-flag rate < 25% before any production enable. No recent movement (paused).
Refs: orders/PLAN-v3.md §3(F).
