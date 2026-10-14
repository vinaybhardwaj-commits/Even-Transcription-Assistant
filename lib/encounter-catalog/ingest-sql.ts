/**
 * lib/encounter-catalog/ingest-sql.ts — one statement upserts a batch of catalog rows (migration 0168).
 *
 * $1 is the rows jsonb array. FIELD-LEVEL: a row updates only the columns whose key it carries (jsonb_exists), so the prescription join
 * (C3, which sends {consult_uid, prescription}) never blanks what the box wrote, and the box never blanks the prescription. A key that is
 * present with null sets the column to NULL. A consult_uid that is new is inserted with the columns the row carries (the rest NULL).
 * STALE-WRITE GUARD (fable gate C3): when the incoming row carries generated_at and the stored generated_at is NEWER, the update is skipped (a replayed or reordered old batch cannot overwrite a newer row); a row
 * without generated_at (C3's partial rows) is never guarded. The guard is in the UPDATE's own WHERE, so Postgres re-checks it against the committed row when a concurrent writer held the lock.
 * Returns one row { updated, inserted, stale } (stale = rows skipped by the guard, counted from the statement's snapshot; a skip decided only on the re-check is accounted by the one rerun). No transcript text column exists; the identity columns (names, individual / prescription uid) are written only when the row carries them (the C3 join).
 */
type Col = { name: string; expr: string };

const j = (k: string) => `p.j->>'${k}'`;
const obj = (k: string) => `NULLIF(p.j->'${k}', 'null'::jsonb)`;
const ts = (k: string) =>
  `CASE jsonb_typeof(p.j->'${k}') WHEN 'number' THEN to_timestamp((p.j->>'${k}')::double precision / 1000.0) WHEN 'string' THEN (p.j->>'${k}')::timestamptz END`;

export const COLUMNS: Col[] = [
  { name: "ist_date", expr: `NULLIF(${j("ist_date")}, '')::date` },
  { name: "doctor_uid", expr: `NULLIF(${j("doctor_uid")}, '')` },
  { name: "room_id", expr: `NULLIF(${j("room_id")}, '')` },
  { name: "t_open", expr: ts("t_open") },
  { name: "t_close", expr: ts("t_close") },
  { name: "source", expr: `NULLIF(${j("source")}, '')` },
  { name: "clip", expr: obj("clip") },
  { name: "layers", expr: obj("layers") },
  { name: "freescript", expr: obj("freescript") },
  { name: "stages", expr: obj("stages") },
  { name: "first_gap", expr: `NULLIF(${j("first_gap")}, '')` },
  { name: "allowance", expr: obj("allowance") },
  { name: "prescription", expr: obj("prescription") },
  { name: "doctor_name", expr: `NULLIF(${j("doctor_name")}, '')` },
  { name: "patient_name", expr: `NULLIF(${j("patient_name")}, '')` },
  { name: "individual_uid", expr: `NULLIF(${j("individual_uid")}, '')` },
  { name: "prescription_uid", expr: `NULLIF(${j("prescription_uid")}, '')` },
  { name: "presc_state", expr: `NULLIF(${j("presc_state")}, '')` },
  { name: "catalog_version", expr: `NULLIF(${j("catalog_version")}, '')::integer` },
  { name: "generated_at", expr: `NULLIF(${j("generated_at")}, '')::timestamptz` },
];

const setList = COLUMNS.map((c) => `${c.name} = CASE WHEN jsonb_exists(p.j, '${c.name}') THEN ${c.expr} ELSE e.${c.name} END`).join(",\n    ");

export const INGEST_SQL = `WITH p AS (SELECT r AS j FROM jsonb_array_elements($1::jsonb) AS r),
upd AS (
  UPDATE encounter_catalog e SET
    ${setList},
    updated_at = now()
  FROM p
  WHERE e.consult_uid = p.j->>'consult_uid'
    AND NOT (NULLIF(p.j->>'generated_at', '') IS NOT NULL AND e.generated_at IS NOT NULL AND e.generated_at > (p.j->>'generated_at')::timestamptz)
  RETURNING e.consult_uid
),
stale AS (
  SELECT e.consult_uid FROM p JOIN encounter_catalog e ON e.consult_uid = p.j->>'consult_uid'
   WHERE NULLIF(p.j->>'generated_at', '') IS NOT NULL AND e.generated_at IS NOT NULL AND e.generated_at > (p.j->>'generated_at')::timestamptz
),
ins AS (
  INSERT INTO encounter_catalog (consult_uid, ${COLUMNS.map((c) => c.name).join(", ")})
  SELECT p.j->>'consult_uid', ${COLUMNS.map((c) => c.expr).join(", ")}
    FROM p
   WHERE NOT EXISTS (SELECT 1 FROM upd WHERE upd.consult_uid = p.j->>'consult_uid')
     AND NOT EXISTS (SELECT 1 FROM stale WHERE stale.consult_uid = p.j->>'consult_uid')
  ON CONFLICT (consult_uid) DO NOTHING
  RETURNING consult_uid
)
SELECT (SELECT count(*) FROM upd)::integer AS updated, (SELECT count(*) FROM ins)::integer AS inserted, (SELECT count(*) FROM stale)::integer AS stale`;
