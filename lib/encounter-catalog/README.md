# Encounter catalog (migrations 0168, 0169)

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

## C4: jev, clef_affect, presence (migration 0169, ORDER 23N)
Three nullable jsonb columns, written by the same ingest route as field-level upserts and returned by the search route to admins only.
- `presence` (the lab box feed, `catalog_version` 2): `{encounter_open, encounter_close, boundary_source, close_reason}`, UTC ms and two tokens.
- `jev` (newcat's upsert job): `{sets: [{set_id, set_sha, band, label, model, at, state?}]}`. `band` and `label` may be null; `state` is optional and one of `current` | `retired` (anything else is `bad_jev`); no question text, no reasons.
- `clef_affect` (newcat's upsert job): `{lanes: [{lane, scores, model_rev, at}]}`; `scores` is an object of token keys to finite numbers.
The ingest validates these shapes strictly (only those keys; values are tokens of 1..60 characters `[A-Za-z0-9_:.-]`, `at` a strict ISO instant, at most 50 sets / 20 lanes / 64 scores) and the text-key refusal applies inside them. A bad block answers 400 `bad_jev` / `bad_clef_affect` / `bad_presence`; a present `null` clears the column. A row that carries only `jev` (or only `clef_affect`) never touches the box's columns, and the box's next row (which has no `jev` / `clef_affect` key) never blanks newcat's.
`presence.boundary_source` may also contain `+` (CAA's values are token+token); no other field may. **newcat's upsert rows must not send `generated_at`**: it belongs to the box feed's stale-write guard, and a partial row without it is never guarded or skipped.
Turn the feed's `--post-url` on only after 0169 is applied: an older ingest refuses the unknown `presence` key.

newcat's writer for `jev` and `clef_affect` runs in-process in Scribe, as the last step of the `jev-sweep` cron (`lib/jev/worker/catalog-sync.ts`), through `validateBatch` and `ingestCatalogRows` (no HTTP, no HMAC). Flag `CATALOG_C4_SYNC_ENABLED` (unset or 0 = off; an unrecognised value = off, counted as `error_class: "bad_flag"`). It only updates consults that already have a row, it ingests with `{updateOnly: true}` (a uid with no row is counted `missing`, never inserted) and carries every stored `jev` entry forward, flipping `state` to `retired` when its set leaves shadow/live or its sha is superseded (never `jev: null`; the 50-entry cap drops the oldest retired first). `state` is maintained only for consults inside the sync's 8-IST-day window; outside it, an entry's state may be stale or absent. The whole step ends by `CATALOG_SYNC_HARD_MS` (35 s), every statement included. The cron's ok body carries `catalog: {posted, updated, inserted, stale, unchanged, skipped_off_enum, skipped_bad_token, budget_hit, capped, missing, retried, retired, invariant_dropped, error_class}`.

`CATALOG_C4_BACKFILL_SINCE` (IST date `YYYY-MM-DD`, not before 2026-09-01, not in the future; absent, empty or invalid = off) adds a second paged scan over consults first opened from that date up to the start of the 8-day window, only after the live-window scan ended exhausted and uncapped; it shares the row, page and time budget, and the tick line's `backfill_rows` counts its rows.

## Logs (by design)
`individual_uid` and `prescription_uid` are accepted as **search query parameters**, so they appear in Vercel request logs. That is deliberate and acceptable under V's internal-tool ruling (14 Oct 2026: the Encounter Explorer is for internal admins only, no PHI removal); it is not a leak. The admin token never appears in a URL (see above). Neither route nor lib logs a row value.

## Rollback
`db/rollbacks/0169_encounter_catalog_c4.down.sql` drops only the three C4 columns. `db/rollbacks/0168_encounter_catalog.down.sql`, by hand only, drops the table; the box re-derives the rows from its ledger (one full C1 refeed and one C3 rerun).
