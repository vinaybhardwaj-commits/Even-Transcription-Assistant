# ETA encounter windows — build note (4 Oct 2026)

Branch `vinay/encounter-windows` (from `origin/main` e920a72). Not merged, not deployed, no migration applied to any database.

**Revision 2 (Refuter verdict PASS WITH FIXES on ffffe48): F1-F8 applied in a second commit. Revision 3 (re-check PASS WITH FIXES on f0ed283): F9-F12 in a third. See "Refuter fixes" below.**

## What was built

A table, a resolver, a cron and a read route that turn `pulse_presence_events` into one row per consult: when it opened, when it closed, which room, which doctor, how sure we are.

| piece | where |
|---|---|
| Table + migration `0123` | `db/migrations/0123_eta_encounter_windows.sql`, drizzle table `etaEncounterWindows` in `db/schema.ts` |
| Resolver (pure) | `lib/encounter-windows/{types,occupancy,compute}.ts` — `computeWindows(events, {from,to})`, `computeWindowsDetailed` (rows + run summary) |
| DB adapter | `lib/encounter-windows/db.ts` — `refreshWindows(db, {from,to})` (one range, one transaction), `refreshWindowsByDay` (one transaction per IST day), `queryWindows`, `loadCrosswalk`, `fetchEvents`; `filter.ts` — `keepFocusFlips`, the SQL load filter in TypeScript |
| Cron | two doors, no query string in `vercel.json`: `app/api/cron/encounter-windows/route.ts` every 5 min (recent mode, last 3 h) and `app/api/cron/encounter-windows/sweep/route.ts` at minute 7 of every hour (sweep mode, last 48 h); both GET with `Bearer CRON_SECRET`, both call `lib/encounter-windows/cron.ts`. Manual: `?mode=recent|sweep` on the base door, `?hours=N` backfill on either |
| Read route | `app/api/encounter-windows/route.ts` (GET, `ADMIN_TOKEN` bearer; `room_id`, `doctor_uid`, `from`, `to`, `quality`, `limit`) |
| Reference tooling kept | `tools/pulse-watch/{occupancy,watch,q-am,q-contract}.mjs` + README (honour `DATABASE_URL`) |
| Tests | `tests/unit/encounter-windows.test.ts` (42), `tests/unit/encounter-windows-routes.test.ts` (13), fixture `tests/fixtures/encounter-windows/` |

## Rules the resolver implements (all from the reference, `~/pulse-watch`)

- **Occupancy**: a (machine, doctor_uid) stream is out on logout, resolver stamp, idle/locked machine, 45 min without genuine activity, or last activity before the 00:00 IST cutoff. Occupant among several present streams: focused tab, then latest encounter event, then freshest; two focused streams that cannot be separated are `ambiguous`.
- **Pairing**: key on `encounter_id`; pair with the nearest unused `prescription_ref`-only open within 60 s on the same machine; open = earlier of the pair; reopens of one `encounter_id` merge (`reopen_count`). A ref-only open with no partner is not a consult (`unpaired_refs` in the run summary).
- **Close** (in order): first `encounter_close` for the `encounter_id` after the last open, bounded by the next other consult's open → `endConsult`; else the latest close of one of its refs → `url_clear`; else next other consult's open → `next_open`; else first logout / idle / locked after it → `logout` / `idle_timeout`; else open + 90 min → `cap_90m`. Any fallback later than 90 min is capped. Before 90 min have passed at the clock: `open`, `t_close` NULL.
- **Attribution**: `rows` (most frequent uid on the consult's own open/close rows) → `occupant` (occupancy at open) → `none`.
- **Key**: `consult_key = <encounter_id>@<machine>`, always; `consult_uid` keeps the bare encounter_id for the Pulse join.
- **Quality**: `ambiguous` (no doctor resolved and occupancy ambiguous) → `multi_doctor` (≥2 streams present at open or midpoint) → `unclosed` (close inferred, not an explicit close event) → `unattributed` → `clean`.

## Run it

```
npm test                         # typecheck:tests + vitest
npx vitest run tests/unit/encounter-windows.test.ts
npm run typecheck && npm run build
```

Apply order (V / Fable decide; not done here): run migration `0123` first (`POST /api/run-migrations` reads the deployed build, so either apply the SQL directly — it is idempotent — or deploy once and call the endpoint), then deploy; until it is applied each cron run fails its one transaction and writes nothing. Backfill: `GET /api/cron/encounter-windows?hours=720` with the cron bearer (either door); a run stops starting new IST days after 50 s and returns `complete:false` and `next_from`, resume with `?hours=720&from=<next_from>`.

Fixture refresh: the pseudonymising builder is deliberately NOT in git (it holds the salt and reads raw exports); it lives at `~/dev/eta-fixture-tools/encounter-windows-build-fixture.mjs` on the Mini (`node ... <dir with events.json + consults.json from ~/pulse-watch/gate-p1> tests/fixtures/encounter-windows`).

## Proof

Over the 2–4 Oct export (19,683 events), `computeWindows` reproduces the reference: 114 consults, every one matched by machine and open time within 1 s, close within 1 s, same close kind, same reopen count, same doctor uid; attribution 85 rows / 15 occupant / 14 none (all 14 at OPD 5); 21 `multi_doctor`, all at OPD 4 Ortho; 2 `unclosed`; no overlapping windows on a machine; 62 unpaired ref opens over the whole export.

Separately, migration 0123 and every statement in `refreshWindows` / `queryWindows` were run against a real Postgres engine (pglite, scratch test, not committed): idempotent migration, 114 inserted, second refresh deletes 114 and inserts 114, sub-range refresh replaces only its own rows, filters work, the CHECKs reject bad values, and a row outside the refreshed range holding the same `consult_key` is upserted rather than colliding.

## Deviations from the spec, and why

1. **`unclosed` counts every inferred close**, not only `cap_90m` / `open`. The spec's rule (cap or open) yields 1 on the reference data; the spec's own expected count is 2 and the reference counts the idle-closed consult too. Followed the reference: `quality = unclosed` unless the close was an explicit `endConsult` / `url_clear`.
2. **`unattributed` is 13 in `quality`, 14 in `attribution = 'none'`.** The idle-closed consult at OPD 5 has no doctor and an inferred close; quality takes one label and `unclosed` outranks `unattributed` (the spec's order). The 14 is asserted on `attribution`.
3. **`ambiguous` ranks above `multi_doctor`, but only when no doctor was resolved.** By the spec's order `ambiguous` would be unreachable (ambiguity needs ≥2 present streams, which is `multi_doctor`). A consult whose own rows name the doctor is `multi_doctor`; one left with no doctor because two focused profiles could not be separated is `ambiguous`.
4. **`close_reason` mapping** (spec silent): encounter_id close → `endConsult`, prescription_ref close → `url_clear`, idle/locked → `idle_timeout`.
5. **Third index** `eta_encounter_windows_open_idx (t_open)` for the range delete, beside the two required.
6. **`refreshWindows` insert is `ON CONFLICT (consult_key) DO UPDATE`**, so a consult whose `t_open` drifted across the range edge between runs updates its own row (the key is deterministic per consult, see F2).
7. **Migration `0123`**, not a number from the spec (none given): `origin/main` and `vinay/s1-auto-drain` stop at `0122`; no `vinay/*` branch holds `0123`. `0120` exists only on `vinay/level-log-device-context`.
8. **No grants** — repo convention for app-owned tables (see 0057, 0119); stated in the migration. Nothing but the app role touches it.
9. **Cron path** is `/api/cron/encounter-windows` as ordered, though every other cron lives under `/api/admin/*`.
10. **Fixture pseudonymises** encounter ids, refs, display names and doctor uids (salted SHA-256; uids keep their original order as `u<rank>-<hash>` because the occupancy tiebreak compares uid strings) and strips a doctor's name out of one room slug, because `tests/unit/no-identity-literals.test.ts` forbids names in tests. Display names are not asserted; pseudonymous uids are.

## Refuter fixes (revision 2)

| fix | status |
|---|---|
| F1 background heartbeats broke the focus tiebreak | `fetchEvents` now keeps a background heartbeat where `tab_focus` flips from the stream's previous non-logout ext event (SQL `LAG` over `(machine, doctor_uid)`); `keepFocusFlips` mirrors it. Refuter's case (A focused 0-5 min then background, B focused 6-20, consult at 20.2 min, no uid on rows) -> occupant B, `multi_doctor`; the old drop-all filter gives `ambiguous` (also a test). SQL and mirror keep identical ids on 6,000 random events in a scratch pglite run. |
| F2 fallback key assigned in run order | `consult_key` is always `<encounter_id>@<machine>`; migration comment, schema comment, tests updated (stability across run order, range and the other machine's events). |
| F3 cron load | `mode=recent` every 5 min refreshes 3 h; `mode=sweep` hourly (minute 7) refreshes 48 h; event read bounded to (IST midnight before `from`) - 24 h to `to` + 2 h, not a flat 72 h; backfill (`hours=`) and every other mode go through `refreshWindowsByDay`, one transaction per IST day, 50 s budget with `next_from`. Revised in F12: two doors instead of a query string. |
| F4 migration comments | `consult_key` description and index count (three) corrected; refresh cadence text corrected. |
| F5 dead code | `ComputeOptions.debug`, `Consult.unpaired` and the unused `all` in the per-machine result removed; the unpaired COUNT stays in the run summary. |
| F6 fixtures | doctor uids pseudonymised too, all hashes salted with a fixture-only constant; fixture regenerated; builder removed from git (kept at `~/dev/eta-fixture-tools/`). Parity still 114/114. |
| F7 tools/pulse-watch | `@neondatabase/serverless` pinned to 0.10.4 (the app's version); README states `lib/encounter-windows` is canonical and `tools/pulse-watch` the read-only historical reference. |
| F8 CLAUDE.md | First pass (one line); completed in F9. |

### Re-check fixes (revision 3)

| fix | status |
|---|---|
| F9 CLAUDE.md Deploy bullets | Rewritten per Fable ruling: a push to `main` IS a production deploy (Vercel Production Branch Tracking = `main` since 1 Oct 2026, ETA-GIT-RECONCILE-01-OCT-2026); `vinay/s1-auto-drain` is a retired mirror, do not push to it; the "do not deploy on your own" bullet now names `main`. Nothing else in the file was touched: the migration-numbering section still tells you to look at `vinay/s1-auto-drain`'s migrations, which is not a Deploy bullet and was left for the file's owner. |
| F10 filter.ts missing `tab_focus` | The TypeScript rule is now three-valued like the SQL (`payload->>'tab_focus' = 'true'` is NULL when missing or JSON null): NULL vs NULL is not a flip, so a flagless heartbeat first in a stream or after a flagless row is dropped; true->NULL, false->NULL, NULL->false and NULL->true are flips; a row with a NULL event is kept only when its flag is true. Tests assert the kept rows case by case, plus full == filtered resolver output for a stream whose heartbeats lose the flag. SQL == TypeScript on 6,000 random events (1,573 with the flag missing, 602 JSON null, 327 NULL event, empty-string uids) in a scratch pglite run. |
| F11 day chunks lost late closes | Every day chunk now reads events to the end of the WHOLE range + 2 h (`refreshWindows` option `eventsTo`). Test: consult opens 23:30 IST, explicit close 02:30 IST next day, range spans both days: one row, `t_close` 02:30, `endConsult`; the control (day 1 alone, reads to 02:00) shows `cap_90m`. Cost: a long backfill reads more per day than a short one (a 30-day backfill reads up to 30 days of events per day chunk); the explicit-close rule has no time limit in the resolver, so this follows it. |
| F12 query string in `vercel.json` | New `app/api/cron/encounter-windows/sweep/route.ts` (forced sweep mode, `?mode=` ignored there, `?hours=` still backfill); the shared handler moved to `lib/encounter-windows/cron.ts` (a Next route module may export only handlers). `vercel.json`: `/api/cron/encounter-windows` every 5 min, `/api/cron/encounter-windows/sweep` at `7 * * * *`. `?mode=` still works on the base door. |

The earlier note on cron payload is superseded: a 5-minute run now reads 27 to 51 h of events (the 3 h range plus 24 to 48 h of bounded lookback, depending on the time of day) instead of ~120 h, and background heartbeats are mostly dropped; the hourly sweep reads about 72 to 96 h.

## Unverified / open

- **Not run against the live database.** The SQL ran on pglite, not Neon. Neon-HTTP-specific behaviour (bigint[] column returning strings, `sql.transaction` response shape) is handled defensively but unproven live.
- **Bounded lookback is a change from the proven resolver default (72 h).** Events older than (IST midnight before the range) - 24 h are not read. The nightly cutoff makes older activity irrelevant, and a login/logout older than that with the stream active since is the one case that would read differently. By-day parity on the reference export is unchanged (85/15/14, 21 multi_doctor, 2 unclosed).
- **SQL load filter vs `keepFocusFlips`** are two copies of one rule; their agreement is checked by a scratch pglite run, not by the committed suite.
- **The old CLAUDE.md Deploy bullets** after the corrected line still say a push to `vinay/s1-auto-drain` deploys; they are stale and belong to whoever owns that file.
- **Second spelling of the same machine.** `EHRC-CONSUL4s-Mac-mini` maps to OPD 3 and `EHRC-CONSUL4s-Mac-mini-2` to OPD 4 Ortho in the reference crosswalk; the resolver trusts `room_install.hostname` as-is.
- **Suite failures that are not this change:** 21 test files need Docker (the Mini's Docker daemon is read-only: `read-only file system`) and one check, `no-identity-literals`, fails on `extensions/pulse-presence/test/*` fixtures. None touch these files.
