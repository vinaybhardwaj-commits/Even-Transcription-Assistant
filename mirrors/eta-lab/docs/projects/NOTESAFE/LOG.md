# LOG — NOTESAFE (note faithfulness / completeness)

Build and event log, newest first. Owner panes: fleet (builder), eta-refuter (checker).

## 27 Sep ~06:0x-08:0x IST — provider-text fix rebased+PASS; medication bench PASS
Session: notesafe, eta-refuter.
provider-text fix rebased onto D4's actual sha cac6c29 (head ebcd455, reconfirmed tree b6c1d0a0 = 6448ab1, #4069). V ruled the bench plan (W30.3): invented transcripts + CAP items as vocab APPROVED; threshold rule (<=10% observed, 95% upper bound <25%) APPROVED. med-bench PASS v2 b6581c5 (#4105), head 8f17fbd after dropping stray .pyc (#4107).
Refs: #4065, #4069, #4098, #4105, #4107.

## 26 Sep ~21:3x IST — provider-text fix PASS
Session: notesafe, eta-refuter.
Branch notesafe/provider-text on D4 train 5907cbc: 0283b36 -> PASS-WITH-FIXES (#3916: provider code field, MCP replay sink) -> 4c492be PASS (#3922) -> 6448ab1 with the advisory test (#3923). Ships in the release after D4. Medication-note bench design posted (#3912).
Refs: #3912, #3916, #3922, #3923.

## 24 Sep 05:00 IST — FINDING 1
Session: eta-refuter (checker).
Jev U4 (faithfulness) / U8 (completeness) evaluation logic is in production behind flag `JEV_NOTE_FAITHFULNESS`. FINDING 1: JevHttpError must never expose provider body text; choices must validate against schema.
Refs: r154 (related).

## Status
Shadow mode only, flags OFF. Next gate: medication-note benchmark with false-flag rate < 25% before any production enable. No recent movement (paused).
Refs: orders/PLAN-v3.md §3(F).
