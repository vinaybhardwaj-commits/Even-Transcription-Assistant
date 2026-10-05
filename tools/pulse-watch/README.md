# tools/pulse-watch

Durable copy (4 Oct 2026) of the read-side Pulse Presence tooling that lived only in `~/pulse-watch` on V's MacBook Air.
**`lib/encounter-windows` is canonical. `tools/pulse-watch` is the read-only historical reference** it was ported from and
checked against: the `.mjs` scripts run against the live database with no build step, but they are not maintained in step with
the port and nothing in the app imports them.

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

`package.json` pins `@neondatabase/serverless` to 0.10.4, the version the app uses. That version has no `sql.query`, so
`occupancy.mjs` falls back to the call form; `node tools/pulse-watch/q-am.mjs` from the repo root also works after the
repo's own `npm install`.

Extension 0.1.1 signals (5 Oct 2026): an `identity_stale` event closes the cookie doctor's stream like a logout (out_reason `stale_cookie`); a row
whose reason contains `stale_cookie` is never a doctor's activity; each machine row carries `page_name` (the Pulse home greeting's first name, last 10
minutes; a witness, never an identity) and `instances` (distinct `instance_id`s reporting, i.e. Chrome profiles; > 1 prints `instances=N`, no alert).
`q-am.mjs` and `watch.mjs` show `page: <name>` dimmed when there is no warehouse doctor and no cookie identity. The same rules live in
`lib/encounter-windows/occupancy.ts`; `tests/unit/occupancy-mjs-sql.test.ts` proves the SQL against postgres and in lockstep with it.

Changes from the Air originals: `DATABASE_URL` is honoured first, the `sql.query` fallback, and the pinned driver version.
Nothing else.

The consult-pairing reference (`gate-p1/consults.mjs`) is not copied here; its behaviour is pinned by
`tests/unit/encounter-windows.test.ts` against `tests/fixtures/encounter-windows/`.
