# ETA warehouse attribution — build note, 5 Oct 2026

Branch `vinay/warehouse-attribution` (from `origin/main` f06b392). Not merged, not deployed, no migration run against any database. Builder: Claude Fable 5.1.

## Why

`eta_encounter_windows` (0123) attributes each consult to the doctor the Pulse extension saw logged in on the machine. Measured 5 Oct: that disagrees with Pulse's own consult record for 77 of 162 attributed consults (OPD 6: the extension says one doctor, Pulse says another for 43 consults), and 17 consults have no extension doctor at all. Pulse writes the consulting doctor itself, in the Even warehouse (Metabase database 13): `"individuals-prescriptions"` (`consult_uid` = our consult_uid, `uid` = our prescription_ref, `doctor_uid`, `_create_time` at startConsult) and `doctors` (`uid`, `name_with_prefix`). This build reads it and stores it next to the extension view.

## What changed

| File | Change |
|---|---|
| `lib/metabase.ts` (new) | Port of the CDMSS client: `metabaseQuery(sql)` POST `/api/dataset`, db 13 as the constant `WAREHOUSE_DB_ID`, 25 s abort, env read per call and never in an error. `uidListLiteral()` is the only way a value reaches the SQL text: `[A-Za-z0-9_-]{1,128}` or it THROWS. |
| `db/migrations/0124_encounter_windows_warehouse_attribution.sql` (new) | Nine columns on `eta_encounter_windows` (below), CHECK on `attribution_source`, partial index `eta_encounter_windows_wh_unchecked_idx (t_open) WHERE warehouse_checked_at IS NULL`, comments incl. the precedence. Additive, idempotent, `schema_migrations` row 124. |
| `db/schema.ts` | Drizzle columns + the partial index. |
| `lib/encounter-windows/warehouse-attribution.ts` (new) | `attributeFromWarehouse(db, {hours=36, limit=500, chunkSize=200, deadlineMs, query})`, plus the pure `pickWarehouseRow`, `decideAttribution`, `warehouseQuerySql`. |
| `lib/encounter-windows/warehouse-cron.ts`, `app/api/cron/encounter-windows/warehouse/route.ts` (new) | The cron door. |
| `lib/encounter-windows/db.ts` | Refresh keeps the warehouse columns (below). `queryWindows` returns the new columns and takes `mismatch`. |
| `lib/encounter-windows/types.ts` | `AttributionSource`, `EncounterWindowRead` (the read row; the resolver's `EncounterWindowRow` is unchanged). |
| `app/api/encounter-windows/route.ts` | New columns in the response; `?mismatch=true|false` (true: doctor_mismatch only; false: agreeing rows only), and `?doctor_uid=` matches `consulting_doctor_uid` OR the extension's `doctor_uid`. |
| `lib/fleet-attention.ts` | R4 detail names `COALESCE(consulting_doctor_name, display_name)`. One SELECT changed; `WindowLite` unchanged. |
| `vercel.json` | `/api/cron/encounter-windows/warehouse` every 2 minutes. |

## The columns (0124)

`warehouse_doctor_uid`, `warehouse_doctor_name`, `warehouse_checked_at`, `warehouse_prescription_uid`, `consulting_doctor_uid`, `consulting_doctor_name`, `attribution_source` (`warehouse` | `extension` | `none`), `doctor_mismatch boolean NOT NULL DEFAULT false`, `warehouse_attempts integer NOT NULL DEFAULT 0` (lookups that found no warehouse doctor). `doctor_uid`, `display_name`, `attribution` are never written by this feature: the extension view stays.

## Precedence

1. `warehouse` — the warehouse names a doctor: `consulting_doctor` = that doctor (name from `doctors.name_with_prefix`; the extension's display name only when it is the same doctor and `doctors` had no name).
2. `extension` — the warehouse has nothing (no row, or a row with no doctor): `consulting_doctor` = `doctor_uid` / `display_name`.
3. `none` — neither.

`doctor_mismatch` = warehouse doctor AND extension doctor both present and different. A row the warehouse has not answered yet reads `extension` / `none` provisionally; `warehouse_checked_at IS NULL` marks it.

## Lookup rules

- Queue: `consult_uid` or `prescription_ref` present, `t_open` within `hours`, and `warehouse_checked_at IS NULL` OR (`warehouse_doctor_uid IS NULL` AND `warehouse_attempts < 12` AND checked more than 10 min ago). Newest first, `limit` rows.
- One Metabase query per chunk of 200 candidates: every `individuals-prescriptions` row with `consult_uid IN (...) OR uid IN (...)`, `LEFT JOIN doctors`, `ORDER BY _create_time`, `LIMIT 2000`. Per consult the earliest row that names a doctor wins (earliest overall if none does). `uid = prescription_ref` is the fallback for a consult with no `consult_uid`.
- A lookup that finds nothing still stamps `warehouse_checked_at`, so the queue drains; unresolved rows come back after 10 minutes. Answered rows are never asked again. RETRY CAP: each unresolved lookup adds 1 to `warehouse_attempts`; after the 12th the row is final (the summary counts it as `gave_up`), is never queued again, and keeps reading `extension` / `none` by the precedence rule. It is NOT rewritten to `none` when the extension named a doctor: a window refresh re-derives `attribution_source` from the stored warehouse doctor and the extension doctor, so a forced `none` would not survive the next refresh and would hide a doctor we do know.
- Mismatches are logged at info: `[warehouse-attribution] mismatch room=<slug> consult_uid=<id> extension=<uid>(<name>) warehouse=<uid>(<name>)`, once, when the row is written.

## Refresh no longer erases the warehouse columns

`refreshWindows` used to DELETE every row with `t_open` in range and re-INSERT. That would have blanked the new columns on every 5-minute cron. It now deletes only the rows the fresh compute no longer produces (`consult_key <> ALL(keys)`) and upserts the rest; the `DO UPDATE` never names `warehouse_*`. The upsert also re-derives `consulting_*` / `attribution_source` / `doctor_mismatch` from the STORED warehouse doctor and the fresh extension doctor, so a row the warehouse already answered stays `warehouse` and its mismatch follows a changed extension view. Visible change: `deleted` in the cron response now counts vanished consults, not every row in the range. Proven on real Postgres (`warehouse-attribution-pg.test.ts`: same `id`, every warehouse column unchanged after a refresh).

## Race guard

The write carries the extension `doctor_uid` read at queue time and skips a row whose `doctor_uid` changed since (a refresh landed while Metabase answered), because its mismatch flag would be stale. That row stays queued; the summary counts it as `raced`.

## The cron door

`GET /api/cron/encounter-windows/warehouse`, bearer `CRON_SECRET` (503 unset, 401 wrong). Default 36 h. `?hours=N` (1..720) is a backfill: batches of 500 for up to 28 s, stops early when a full batch wrote nothing or deferred work; `complete=false` means call again (written rows are out of the queue, so it resumes by itself). Response is counts only: `ok, hours, batches, complete, candidates, checked, resolved, unresolved, mismatches, raced, deferred, gave_up`.

## To deploy (Fable's steps, not done here)

1. Apply 0124 through `/api/run-migrations` BEFORE the deploy. Until it is applied the refresh cron's INSERT (which names the new columns) fails its transaction and writes nothing, and the warehouse door errors. `ls db/migrations` ends 0119, 0121, 0122, 0123 (there is no 0120), so 0124 is the next free number.
2. Deploy. `METABASE_URL` and `METABASE_API_KEY` are already in Vercel production.
3. Backfill once: `GET /api/cron/encounter-windows/warehouse?hours=720` with the cron bearer; repeat while `complete` is false.
4. Check: `GET /api/encounter-windows?mismatch=true&from=2026-10-02T00:00:00Z` should return roughly the 77 disagreeing consults, and `attribution_source=none` should be gone for the 17 `none` rows.

## Tests

| File | What it pins |
|---|---|
| `tests/unit/metabase-client.test.ts` (10) | The escaper (quote, space, semicolon, newline, unicode, empty, too long, non-string all THROW), request shape with a mocked fetch (URL, method, `x-api-key`, db 13 native body, abort signal), error messages free of key and URL, 25 s timeout. |
| `tests/unit/warehouse-attribution.test.ts` (21) | Precedence table, mismatch flag, earliest-row pick and the `uid = prescription_ref` fallback, query shape, queue SELECT bound values, the UPDATE's SET list never assigns `doctor_uid`/`display_name`/`attribution`, summary, chunk/deadline, race count, unsafe uid never reaches Metabase, Metabase failure writes nothing. |
| `tests/unit/warehouse-attribution-pg.test.ts` (14, real Postgres 16) | Migration 0124 (columns, default, partial-index predicate, CHECK, re-runnable); refresh preserves warehouse columns (same row id); refresh recomputes consulting/mismatch against the stored doctor; vanished consult still deleted; precedence on real rows; queue (answered rows not asked again, 10-minute retry, hours window); prescription_ref fallback; race guard; extension columns untouched; `queryWindows` + `mismatch` filter. Needs Docker like the other `*-sql` suites. |
| `tests/unit/warehouse-cron.test.ts` (7) | Auth, params, batching, early stop, counts-only response, generic 500, `vercel.json` schedule. |
| Changed: `encounter-windows-routes.test.ts` (+`mismatch`), `encounter-windows.test.ts` (the per-day delete's bound values now carry a keep-list as the third value), `fleet-attention-sql.test.ts` (loads 0124; new R4 consulting-name test). |

## Not done / UNVERIFIED

- The real Metabase has not been called: the column names in the warehouse query (`consult_uid`, `uid`, `doctor_uid`, `_create_time`, `doctors.uid`, `doctors.name_with_prefix`) come from the spec and the CDMSS client, not from a live probe. The 2000-row result cap is assumed from CDMSS's note.
- `doctors` rows duplicated by the Firestore sync would duplicate result rows; handled by taking the earliest row per consult, not measured.
- Whether `_create_time` really precedes any later duplicate row's by the margin the spec says (lag < 60 s) is taken from the spec.
- Vercel's 60 s function ceiling with a cold Metabase: every Metabase chunk (the first included) is gated on a 28 s deadline and each call has a 25 s timeout, so 28 + 25 = 53 s plus the queue read and write stays under 60 s. Not measured on Vercel.
