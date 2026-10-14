# LOG — SHIP (EvenScribe production releases)

Build and event log, newest first. Owner panes: scribe (deploy train), eta-refuter (checker), minibot (Mini monitor).

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
