# tools/pulse-watch

Durable copy (4 Oct 2026, refreshed 8 Oct 2026 from the Air) of the read-side Pulse Presence tooling that lived only in `~/pulse-watch` on V's MacBook Air.
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
| `snapshot.mjs` | cached per-machine facts and the board header/suffix helpers used by both watchers |
| `watch-classic.mjs` | the previous watcher layout, kept with its audio column |
| `audioState.mjs` / `audioState.test.mjs` | room audio-state column: latest state per room mapped to its machine (`node audioState.test.mjs`) |
| `stamp-logouts.mjs` | one-shot: stamps resolved logouts from `resolveSessions` |

Doctor shown per room (8 Oct 2026, matches Rooms Live v1.6 `lib/rooms-live/snapshot.ts`): an open warehouse consult shows
"consulting"; a consult closed within 90 minutes shows "last consult HH:MM"; otherwise the live Pulse sign-in.


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

Login rule (6 Oct 2026): an ext `login` opens presence only with console activity (the nearest poller row within 300 s has idle_s <= 600, or no poller row within
300 s) and no `identity_stale` within 10 s; otherwise it is the machine's PENDING session (`pending` on the machine row, `pendingLabel()`). It is promoted by any
ext `active` / encounter event after the login by the login's own uid (no expiry: it stays pending until promoted, logout, a replacing login, or the nightly cutoff; an event
of another uid or none promotes only within 45 min of the login) or by a poller row within 45 min with `idle_s < (poll ts - login ts) + 5 s`. An `identity_stale` session
(one within 10 s of the login, or one for its cookie uid at ANY later time while pending) promotes to a STALE-COOKIE stream instead (uid null, the page greeting is the identity,
`stale_occupant` on the machine row, `staleOccupantLabel()`: `page: <page_name> (cookie <name> stale)`), never the cookie doctor; an identity_stale for a PRESENT doctor's cookie
demotes him to that stream from then on. In the machine row (F11) that stream merges into a present doctor whose first name equals the page_name, else it is the occupant only when no doctor is present and is never counted as a doctor or in the ambiguity check (beside a real occupant it shows as `stale_occupant`). `occupancy.mjs` does it in two steps
(`loginEffects()` reads the logins, the identity_stale rows and ONE poller read bounded per login window (a LATERAL index range scan per window, ~1k rows for 46 logins; over 400 windows it splits by IST day), then `judgeMachine()` - a port of `resolveStreamsDetailed` - runs over only the
Macs that have a login the rule does not accept; `OCCUPANCY_SQL` applies the ignore list, the heartbeat-ignore intervals and the synthetic promotions; live calls cache the
judgement for 15 s). The lookback is 72 h, the same as `lib/encounter-windows/occupancy.ts`; proven in `tests/unit/occupancy-login-rule-sql.test.ts`.

Changes from the Air originals: `DATABASE_URL` is honoured first, the `sql.query` fallback, and the pinned driver version.
Nothing else.

The consult-pairing reference (`gate-p1/consults.mjs`) is not copied here; its behaviour is pinned by
`tests/unit/encounter-windows.test.ts` against `tests/fixtures/encounter-windows/`.
