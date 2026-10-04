# ETA encounter windows — build note (4 Oct 2026)

Branch `vinay/encounter-windows` (from `origin/main` e920a72). Not merged, not deployed, no migration applied to any database.

## What was built

A table, a resolver, a cron and a read route that turn `pulse_presence_events` into one row per consult: when it opened, when it closed, which room, which doctor, how sure we are.

| piece | where |
|---|---|
| Table + migration `0123` | `db/migrations/0123_eta_encounter_windows.sql`, drizzle table `etaEncounterWindows` in `db/schema.ts` |
| Resolver (pure) | `lib/encounter-windows/{types,occupancy,compute}.ts` — `computeWindows(events, {from,to})`, `computeWindowsDetailed` (rows + run summary) |
| DB adapter | `lib/encounter-windows/db.ts` — `refreshWindows(db, {from,to})`, `queryWindows`, `loadCrosswalk`, `fetchEvents` |
| Cron | `app/api/cron/encounter-windows/route.ts` (GET, `Bearer CRON_SECRET`, last 48 h), `vercel.json` every 5 min |
| Read route | `app/api/encounter-windows/route.ts` (GET, `ADMIN_TOKEN` bearer; `room_id`, `doctor_uid`, `from`, `to`, `quality`, `limit`) |
| Reference tooling kept | `tools/pulse-watch/{occupancy,watch,q-am,q-contract}.mjs` + README (honour `DATABASE_URL`) |
| Tests | `tests/unit/encounter-windows.test.ts` (32), `tests/unit/encounter-windows-routes.test.ts` (7), fixture `tests/fixtures/encounter-windows/` |

## Rules the resolver implements (all from the reference, `~/pulse-watch`)

- **Occupancy**: a (machine, doctor_uid) stream is out on logout, resolver stamp, idle/locked machine, 45 min without genuine activity, or last activity before the 00:00 IST cutoff. Occupant among several present streams: focused tab, then latest encounter event, then freshest; two focused streams that cannot be separated are `ambiguous`.
- **Pairing**: key on `encounter_id`; pair with the nearest unused `prescription_ref`-only open within 60 s on the same machine; open = earlier of the pair; reopens of one `encounter_id` merge (`reopen_count`). A ref-only open with no partner is not a consult (`unpaired_refs` in the run summary).
- **Close** (in order): first `encounter_close` for the `encounter_id` after the last open, bounded by the next other consult's open → `endConsult`; else the latest close of one of its refs → `url_clear`; else next other consult's open → `next_open`; else first logout / idle / locked after it → `logout` / `idle_timeout`; else open + 90 min → `cap_90m`. Any fallback later than 90 min is capped. Before 90 min have passed at the clock: `open`, `t_close` NULL.
- **Attribution**: `rows` (most frequent uid on the consult's own open/close rows) → `occupant` (occupancy at open) → `none`.
- **Quality**: `ambiguous` (no doctor resolved and occupancy ambiguous) → `multi_doctor` (≥2 streams present at open or midpoint) → `unclosed` (close inferred, not an explicit close event) → `unattributed` → `clean`.

## Run it

```
npm test                         # typecheck:tests + vitest
npx vitest run tests/unit/encounter-windows.test.ts
npm run typecheck && npm run build
```

Apply order (V / Fable decide; not done here): run migration `0123` first (`POST /api/run-migrations` reads the deployed build, so either apply the SQL directly — it is idempotent — or deploy once and call the endpoint), then deploy; until it is applied each cron run fails its one transaction and writes nothing. Backfill: `GET /api/cron/encounter-windows?hours=720` with the cron bearer.

Fixture refresh: `node tests/fixtures/encounter-windows/build-fixture.mjs <dir with events.json + consults.json from ~/pulse-watch/gate-p1>`.

## Proof

Over the 2–4 Oct export (19,683 events), `computeWindows` reproduces the reference: 114 consults, every one matched by machine and open time within 1 s, close within 1 s, same close kind, same reopen count, same doctor uid; attribution 85 rows / 15 occupant / 14 none (all 14 at OPD 5); 21 `multi_doctor`, all at OPD 4 Ortho; 2 `unclosed`; no overlapping windows on a machine; 62 unpaired ref opens over the whole export.

Separately, migration 0123 and every statement in `refreshWindows` / `queryWindows` were run against a real Postgres engine (pglite, scratch test, not committed): idempotent migration, 114 inserted, second refresh deletes 114 and inserts 114, sub-range refresh replaces only its own rows, filters work, the CHECKs reject bad values, and a row outside the refreshed range holding the same `consult_key` is upserted rather than colliding.

## Deviations from the spec, and why

1. **`unclosed` counts every inferred close**, not only `cap_90m` / `open`. The spec's rule (cap or open) yields 1 on the reference data; the spec's own expected count is 2 and the reference counts the idle-closed consult too. Followed the reference: `quality = unclosed` unless the close was an explicit `endConsult` / `url_clear`.
2. **`unattributed` is 13 in `quality`, 14 in `attribution = 'none'`.** The idle-closed consult at OPD 5 has no doctor and an inferred close; quality takes one label and `unclosed` outranks `unattributed` (the spec's order). The 14 is asserted on `attribution`.
3. **`ambiguous` ranks above `multi_doctor`, but only when no doctor was resolved.** By the spec's order `ambiguous` would be unreachable (ambiguity needs ≥2 present streams, which is `multi_doctor`). A consult whose own rows name the doctor is `multi_doctor`; one left with no doctor because two focused profiles could not be separated is `ambiguous`.
4. **`close_reason` mapping** (spec silent): encounter_id close → `endConsult`, prescription_ref close → `url_clear`, idle/locked → `idle_timeout`.
5. **Third index** `eta_encounter_windows_open_idx (t_open)` for the range delete, beside the two required.
6. **`refreshWindows` insert is `ON CONFLICT (consult_key) DO UPDATE`**, so a consult whose `t_open` drifted across the range edge between runs cannot trip the unique key.
7. **Migration `0123`**, not a number from the spec (none given): `origin/main` and `vinay/s1-auto-drain` stop at `0122`; no `vinay/*` branch holds `0123`. `0120` exists only on `vinay/level-log-device-context`.
8. **No grants** — repo convention for app-owned tables (see 0057, 0119); stated in the migration. Nothing but the app role touches it.
9. **Cron path** is `/api/cron/encounter-windows` as ordered, though every other cron lives under `/api/admin/*`.
10. **Fixture pseudonymises** encounter ids, refs and display names (SHA-256 prefixes) and strips a doctor's name out of one room slug, because `tests/unit/no-identity-literals.test.ts` forbids names in tests. Display names therefore are not asserted; uids are.

## Unverified / open

- **Not run against the live database.** The SQL ran on pglite, not Neon. Neon-HTTP-specific behaviour (bigint[] column returning strings, `sql.transaction` response shape) is handled defensively but unproven live.
- **Cron payload.** Each run reads ~120 h of events (48 h + 72 h occupancy lookback), background heartbeats excluded; by fixture density that is roughly 30–40k rows per run. Fine for correctness; if egress matters, an incremental window is the next step.
- **Second spelling of the same machine.** `EHRC-CONSUL4s-Mac-mini` maps to OPD 3 and `EHRC-CONSUL4s-Mac-mini-2` to OPD 4 Ortho in the reference crosswalk; the resolver trusts `room_install.hostname` as-is.
- **Suite failures that are not this change:** 21 test files need Docker (the Mini's Docker daemon is read-only: `read-only file system`) and one check, `no-identity-literals`, fails on `extensions/pulse-presence/test/*` fixtures. None touch these files.
- `CLAUDE.md` says production runs `vinay/s1-auto-drain` and `main` is stale; the order says `origin/main` deploys. `origin/main` holds the extension and `/api/presence`, so it is the branch with the table this reads. The branch ruling is not mine.
