# LOG — NOTESAFE (note faithfulness / completeness)

Build and event log, newest first. Owner panes: fleet (builder), eta-refuter (checker).

28 Sep ~15:2x -- F4-prod PASSed and pinned
Session: jev-fix, eta-refuter.
Advisory finding fixed (an env-var test wasn't actually exercising the code it claimed to guard); re-verified with a mutation test proving the fix is real. df61b3f PASS, pinned.
Refs: #5423, #5425, #5446, #5449.

## 28 Sep ~14:0x-15:1x -- jev-fix F2 merged main, F3 ready, F4-prod rebased on prod
Session: jev-fix, eta-refuter.
F2 (jev-fix/f2-model-pin) PASS (mutation-killed), cherry-picked clean to eta-lab main 30ae7561. F3 (legacy askJev routing) PASS x2, ready to merge, held for next train. F4-prod (shared thresholds file, production side) rebased onto production 4d7d8e0 after one real import-conflict resolution; eta-refuter verified every moved value identical.
Refs: #5401-5415.

## 27-28 Sep -- W36 Jev audit done; ZDR ruling withdraws de-id fixes
Session: jev-audit, jev-fix, eta-refuter.
W36 audit: 43 Jev call sites, 17 PASS/23 GAP/2 UNVERIFIED/1 REFUTED; 2 real HIGH findings (surgery study bypassed its own de-id gate before calling Jev; prod logged raw error text that could echo PHI). W41 fixes: F2 (pin ETA_JEV_MODEL) + F3 (route legacy calls through logging) + F4 (one constants module) shipped. V ruled (27 Sep 12:55) Jev and OpenRouter/Gemini are ZDR for Even -- no de-identification is required before sending to them. This WITHDREW F1 and F5 (the de-id fixes) after F1 was already built.
Refs: #4312-4460, RULINGS-2026-09-27.

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
