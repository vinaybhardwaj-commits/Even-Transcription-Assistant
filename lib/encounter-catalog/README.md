# Encounter catalog (migration 0168)

One searchable row per consult_uid, filled by the lab box's stage ledger (C1, `POST /api/encounter-catalog/ingest`, HMAC) and by the prescription join (C3, the same route, partial rows), read by `GET /api/encounter-catalog/search`.

## What it holds
Ids, UTC times, R2 object keys, per-layer status, stage states with reasons, allowance minutes and the C3 identity columns (`doctor_name`, `patient_name`, `individual_uid`, `prescription_uid`, `presc_state`). **No transcript text exists anywhere in it**: the ingest refuses any key named `text`, `transcript`, `note` or `content` (and their `_x` / plural forms) at any depth.

## Rules enforced
- **Ingest auth**: HMAC-SHA256 over `<ts>.<body>` with `ENCOUNTER_CATALOG_INGEST_SECRET`, headers `x-catalog-ts` / `x-catalog-signature`, 600 s skew; an unset secret answers 503 `not_configured`.
- **Search auth**: `ADMIN_TOKEN` in an `Authorization: Bearer` header **only**. A request that carries a `token` query parameter at all is refused (401), so the token can never travel in a URL. No other token (including `REB_INDEX_READ_TOKEN`) is accepted: rows carry identity.
- **Date floor**: `ist_date` before 2026-09-09 is refused (400 `before_floor`). The C3 join and the C1 feed carry the same floor.
- **Stale-write guard**: a row that carries `generated_at` does not update a stored row whose `generated_at` is newer (counted in the response as `stale`); a row without `generated_at` (C3's partial rows) is never guarded.
- **Field-level upsert**: a row updates only the columns whose key it carries; a present `null` clears the column.
- **Batch**: at most 500 rows and 4,000,000 characters; keep C1 batches at 500 rows (Vercel's edge limit is near 4.5 MB for non-ASCII bodies).

## Logs (by design)
`individual_uid` and `prescription_uid` are accepted as **search query parameters**, so they appear in Vercel request logs. That is deliberate and acceptable under V's internal-tool ruling (14 Oct 2026: the Encounter Explorer is for internal admins only, no PHI removal); it is not a leak. The admin token never appears in a URL (see above). Neither route nor lib logs a row value.

## Rollback
`db/rollbacks/0168_encounter_catalog.down.sql`, by hand only. It drops the table; the box re-derives the rows from its ledger (one full C1 refeed and one C3 rerun).
