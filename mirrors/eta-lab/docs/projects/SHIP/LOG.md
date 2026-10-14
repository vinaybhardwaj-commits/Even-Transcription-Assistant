# LOG — SHIP (EvenScribe production releases)

Build and event log, newest first. Owner panes: scribe (deploy train), eta-refuter (checker), minibot (Mini monitor).

## 27-28 Sep -- D4 shipped; deploy lesson learned; room-scope security fix PASSed
Session: scribe, eta-refuter, Fable.
cac6c29 found already live from 07:17 (a push to vinay/s1-auto-drain auto-deploys -- now a standing rule). Fable applied migrations 0119 (21:14) + 0121 (21:22), pinned ETA_JEV_MODEL, forced a fresh redeploy (dpl_3s2o, smoke green). Post-D4 train 4d7d8e0 live 21:48. A real MCP security bug found+fixed: minibot's self_test call exposed a general write-scope gap (session_id bypass, reproduced); scribe re-architected to default-deny at the call boundary. PASSed, merged onto post-D4, full gate green -- not yet pushed, awaiting Fable's GO.
Refs: #4113-4145, #5012-5034, #5114-5126.

## 27 Sep ~06:2x-07:2x IST — D4 cac6c29 gate PASS, then postponed to 21:00
Session: scribe, eta-refuter.
eta-refuter PASS on cac6c29 06:30 (#4083); scribe pushed the preview (fast-forward 1e75667..cac6c29, #4113) but could not promote (no Vercel access, #4115) and the env preconditions were unverifiable before the 07:45 hard stop, so Fable postponed the whole deploy to 21:00 (#4120); production stays 1e75667, migration 0119 NOT applied. Home Office pre-check ran read-only 07:45, PASS (#4145).
Refs: #4083, #4113, #4115, #4120, #4145.

## 26 Sep ~19:5x IST — D4 timings and runbook 4a2650c
Session: scribe, eta-refuter.
D4 gate: eta-refuter PASS-WITH-FIXES (#3799, push is non-fast-forward). Runbook 4a2650c; D4 + smoke end 07:45, Home Office pre-check 07:45-08:15, nothing on the Mini after 08:15; PARITY hard stop leaves ~15-20 min (#3879).
Refs: #3799, #3879.

## 26 Sep ~18:0x IST — D4 delta PASS on SELFTEST pre-check; numbering settled
Session: eta-refuter (delta), scribe (correction).
eta-refuter delta PASS on D4 runbook section 4 (SELFTEST pre-check): read-only throughout, zero patient audio, fallback (Cardiology) not assumed, scope = pre-check only. FLAG: the SELFTEST stimulus run itself (diar-lab, spec 7e55ef3) owes its OWN refuter pass before running on the production Mini. Numbering collision resolved: 459.5 = the D4 runbook only; the CAP-1 chain rides a different 459.x (Fable's ledger names it). Runbook doc corrected per #3763 nit (a): route fix already live via 1e75667; D4's real delta = watchdog outbox+heartbeat (9 files).
Refs: #3767, #3769, #3775.

## 26 Sep ~17:2x IST — D4 runbook FINAL + eta-refuter PASS (#3598)
Session: scribe (runbook), eta-refuter (checker).
D4 = train 5907cbc onto vinay/s1-auto-drain (= production), Sunday 27 Sep 07:00-07:30, only AFTER PARITY-389's hard stop lands. eta-refuter PASS on the deploy+rollback steps (#3598) — D4(a) done; merge clean (the route fix is ALREADY live in 1e75667; the real delta is the watchdog outbox+heartbeat, 9 files). Runbook FINAL (untracked docs/handoff/ETA-D4-DEPLOY-RUNBOOK-27-SEP-2026.md): preconditions (refuter PASS, SCRIBE_MCP_TOKENS_EXTRA set in Vercel dashboard — UNVERIFIED, token hashes 1c249772/920fcbbe, WHISPER_BULK_URLS r394 removal, migration 0119 by hand on Mini, PARITY stop post landed) → pre-flight → 0119 → push (preview) → promote → smoke; rollback = promote prev dpl (migration STAYS). 459.5 addition: Home Office SELFTEST pre-check 07:35-08:55 (speech-only, zero patient audio).
Refs: #3762, #3763; r339, r357.

## 25 Sep 13:30 IST — production 1e75667 live
Session: scribe.
Single-commit route fix pushed + deployed; verified non-null zero_ratio on capturing logs. Smoke 924/924.
Refs: r263, r356.

## 25 Sep 07:50 IST — train a92ebae shipped
Session: scribe.
Train with loop-guard 035c5b7 + emotion dedupe 87a7215 deployed; smoke 1-3 passed.
Refs: r216, r330, r338.

## 24 Sep 20:30 IST — train 73868e4 shipped
Session: scribe.
Full gate 209/209 test files on Yoga runner.
Refs: #994, r221.

## NOW — 5907cbc held
Session: scribe.
Watchdog candidate 2 (outbox 8c49e93 + route fix) HELD on Fable's order (r339). Pre-steps: manual migration 0119 (a Mini pane with refuter-reviewed SQL) + SCRIBE_MCP_TOKENS_EXTRA set in Vercel dashboard BEFORE the push.
Refs: r339, r357.

## Production rules
Production runs from branch vinay/s1-auto-drain (not main). Migrations only via authenticated POST /api/run-migrations. Room live-transcription switches OFF (V r370).
- 29 Sep ~19:27 IST (rev 26): scribe bb62494 push at 20:30 IST; 30 Sep train F3 3d49523 + F4-prod df61b3f after verification.
- 29 Sep ~23:10 IST (rev 27): F3/F4 live at dfb7034 (scribe #7283).
