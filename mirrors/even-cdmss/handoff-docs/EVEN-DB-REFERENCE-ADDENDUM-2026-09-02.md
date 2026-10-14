# Even data layer reference — Addendum (2026-09-02)

**Type:** evidence document. Corrects and extends `EVEN-DB-REFERENCE-2026-09-01.md`. Where the two conflict, this addendum wins.
**Status of facts:** every number below is MEASURED by a live query on 2026-09-02. Every Metabase count was run twice. None differed.

---

## A1. `kx_ip_admissions` has no discharge column

The table has 106 columns and none of them is `discharge_date_time`. All 1,348 rows carry `status = 'Admitted'`. The `event` values are `direct_admission` (563), null (488), and `er_to_ip` (297).

Closure comes from `kx_discharge_summary_records`, joined `d.ipd_no = a.encounter_id`. That row carries `discharge_date_time`, `discharge_type`, and `admission_date_time`. Its `admission_date_time` agrees with the admission row within 60 seconds on all 446 episodes tested.

The reference document §4 join recipe for the discharge summary (`LATERAL ... ORDER BY abs(... a.discharge_date_time)`) is void. Use the exact join.

Only 8 of 2,457 `ipd_no` values repeat (19 rows). Take the latest `_create_time` when they do.

## A2. Never rewrite an id prefix

Four id namespaces run concurrently from June to September 2026: `IPNO-` (583 admissions), `IP-` (277), `ERN-` (281), `ER-` (207). They are separate numbering series, not spellings of one id.

Test: rewrite `IPNO-n` to `IP-n` on admissions and join to discharge summaries. 585 rows joined. 0 shared a `uhid`. 585 were a different patient, admitted about six months earlier. The same test on `ERN-n` to `ER-n`: 44 joined, 0 shared a `uhid`. Rewriting billing ids: 54,339 joined, 0 shared a `uhid`.

Exact joins agree on `uhid` 100 percent: progress reports to admissions 1,464 of 1,464, billing `IPNO-` rows 51,517 of 51,517, native `IP-`/`ER-` admissions to summaries 294 of 294.

`kx_discharge_summary_records` and `kx_billing_records` hold a longer history than `kx_ip_admissions`, so low-numbered `IP-n` values exist there with no admission row. That is expected and harmless under exact joins.

## A3. The inpatient cohort under exact joins

| Measure | Count |
|---|---|
| Admissions | 1,349 |
| Closed (summary row with `discharge_date_time`) | 797 |
| Closed with at least one progress report | 446 |
| Of those, with a lab order | 411 |
| Of those, with an IP billing row | 445 |
| Of those, with a row in `discharge_extracted_cases` | 338 |

Length of stay of the 446, in whole days: 0 days 25, 1 day 135, 2 to 3 days 218, 4 to 7 days 61, 8 to 14 days 7, none longer.

Per episode among the 446: progress reports mean 2.8, max 25. IP billing rows mean 88, max 595. Lab report rows mean 6.7, max 39.

## A4. `discharge_extracted_cases` (Neon)

Columns: `document_id text, extraction_version text, ip_uid text, member_id text, extracted_json jsonb, extracted_at timestamptz, trace_id text`. Primary key `(document_id, extraction_version)`.

897 rows over 711 distinct `ip_uid`: 336 `IP-`, 356 `IPNO-`, 17 `ER-`, 2 junk `ADM2627/...`. Versions: `doc-extract/1` 560 rows (frozen, 06 to 28 Aug), `doc-extract/2` 337 rows (28 Aug onward). 201 episodes exist under both.

`ip_uid` is in the `kx_ip_admissions.encounter_id` namespace. Join it exactly.

`extracted_json` is an `ExtractedCase` (`lib/doc-audit-core.ts`). Outcome-bearing fields: `disposition`, `followUp`, `aftercare`, `adminFacts.lengthOfStayDays`. Free text that may carry outcome: `courseSummary`, `rawNotes`. Pre-outcome fields: `diagnosis`, `indication`, `procedure`, `investigations`, `treatments`, `medications`, `riskFactors`, `verbatimSections`.

## A5. Progress note timestamps

`component_json` is `text`. It holds a JSON array of `{"name": ..., "valueString": ...}` objects. `progressnote_date_time` is the `valueString` of the element named `progressnote_date_time`, as epoch milliseconds. It is present and parseable on 1,464 of 1,464 rows.

```sql
SELECT (SELECT e->>'valueString'
        FROM jsonb_array_elements(component_json::jsonb) e
        WHERE e->>'name' = 'progressnote_date_time' LIMIT 1) AS pn_raw
FROM kx_clinical_template_progress_reports
```

Comparison with other columns on 1,464 rows: `created_at` within 60 seconds of `progressnote_date_time` on 290 rows (20 percent), more than an hour off on 21, null on 148. Mean absolute gap 399 seconds. `_create_time` is the mirror ingest time (all rows show 2026-09-02) and is useless for clinical order.

The existing `fetchProgressNotes` in `lib/readmission/db13.ts` orders by `created_at`. Do not reuse its order.

## A6. Billing category repair is not viable

IP billing rows: 190,600. Pharmacy: 127,312. Pharmacy with blank `item_category`: 110,452. Of those, 84,376 carry an `ordered_item_code`. Joining `ordered_item_code` to `kx_medicine_items.item_code`: 33,146 find a row, and 2,148 of those rows carry a non-blank category. Yield: 1.9 percent.

`order_date_time` is non-null on all 190,600 IP rows.

## A7. Labs

`kx_lab_reports.visit_id` joins `kx_ip_admissions.encounter_id` exactly. 33,268 rows, 6,294 distinct `visit_id`, 1,962 distinct IP `visit_id`, 858 of which have an admission row (the rest predate the admissions mirror). Timestamps: `booking_date_time`, `sample_collection_date_time`, `sample_acknowledge_date_time`, `service_date`, `report_date`.

## A8. Other tables

`kx_clinical_template_initial_assessment_adults` exists: 115 `IP-`, 52 `IPNO-`, 1 `ER-` encounters.

`kx_ip_transfers` (50 columns) spells the ER namespace `ERN-`. The template tables spell it `ER-`. Under exact joins this simply means those rows do not join. Do not bridge them.

`kx_medicine_items` has 43 columns including `item_code`, `item_category`, `item_name`, `composition`.

## A9. Repository facts

`github.com/vinaybhardwaj-commits/Even-CDMSS`. Database 13 is reached only through `metabaseQuery` in `lib/metabase.ts` (Metabase `/api/dataset`, env `METABASE_URL`, `METABASE_API_KEY`). Neon is reached through `lib/db.ts` (`@neondatabase/serverless`, env `DATABASE_URL`). There is no direct Postgres connection to database 13 and no `uhid` hashing anywhere. The repo's de-identification posture is omission: PHI is joined at render time and never stored.
