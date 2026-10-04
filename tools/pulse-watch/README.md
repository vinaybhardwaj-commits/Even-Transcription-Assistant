# tools/pulse-watch

Durable copy (4 Oct 2026) of the read-side Pulse Presence tooling that lived only in `~/pulse-watch` on V's MacBook Air.
The production resolver is the TypeScript port in `lib/encounter-windows/`; these `.mjs` scripts are the **reference
implementation** it was ported from and checked against. Keep them: they run against the live database with no build step.

| file | what it does |
|---|---|
| `occupancy.mjs` | the occupancy resolver: `OCCUPANCY_SQL`, `resolveSessions`, `resolveMachines`, `pickOccupant` (45-minute genuine-activity rule, nightly cutoff 00:00 IST, dual-profile focus tiebreak) |
| `watch.mjs` | live terminal watcher: who is logged into Pulse per machine and every change as it lands (`--once` for a single frame) |
| `q-am.mjs` | one-shot: resolved occupancy per machine plus the monitored rooms' last 6 minutes of extension events |
| `q-contract.mjs` | read-only contract/anomaly monitor for the extension sink (identity, open sessions, skew/lag, dual stream, silent hosts) |
| `package.json` | its own dependency (`@neondatabase/serverless`) |

## Run

Read-only. The database URL comes from the environment and is never printed:

```
export DATABASE_URL=...        # app database (Neon). If unset, falls back to ~/.claude/secrets/eta_database_url
cd tools/pulse-watch && npm install
node q-am.mjs
node watch.mjs
```

`occupancy.mjs` also works against the repo's older `@neondatabase/serverless` (no `sql.query`) through a call-form
fallback, so `node tools/pulse-watch/q-am.mjs` from the repo root works after the repo's own `npm install`.

Changes from the Air originals: `DATABASE_URL` is honoured first, and the `sql.query` fallback. Nothing else.

The consult-pairing reference (`gate-p1/consults.mjs`) is not copied here; its behaviour is pinned by
`tests/unit/encounter-windows.test.ts` against `tests/fixtures/encounter-windows/`.
