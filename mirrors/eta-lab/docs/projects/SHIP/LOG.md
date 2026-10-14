# LOG — SHIP (EvenScribe production releases)

Build and event log, newest first. Owner panes: scribe (deploy train), eta-refuter (checker), minibot (Mini monitor).

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
