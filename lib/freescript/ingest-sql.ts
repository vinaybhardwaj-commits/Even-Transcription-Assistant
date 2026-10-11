/**
 * lib/freescript/ingest-sql.ts — one statement loads a FreeScript payload (migration 0157).
 *
 * $1 is the payload jsonb. A re-post of the same consult_uid + input_sha256 inserts nothing and, when the payload
 * names a job_id, stamps it onto the existing row so a queued box job can finish. No transcript column is written.
 */
export const INGEST_SQL = `WITH p AS (SELECT $1::jsonb AS j),
prior AS (
  SELECT r.id FROM freescript_run r, p
   WHERE r.consult_uid = p.j->>'consult_uid' AND r.input_sha256 = p.j->>'input_sha256'
),
stamped AS (
  UPDATE freescript_run r
     SET job_id = COALESCE(r.job_id, NULLIF(p.j->>'job_id', ''))
    FROM p, prior
   WHERE r.id = prior.id AND NULLIF(p.j->>'job_id', '') IS NOT NULL AND r.job_id IS NULL
  RETURNING r.id
),
run AS (
  INSERT INTO freescript_run (
    consult_uid, prescription_uid, schema_version, room_slug, room_id, ist_date, doctor_uid8,
    state, validator_ok, validator_errors, generator_code_sha, generator_prompt_sha, model_id,
    cost_usd, input_sha256, job_id)
  SELECT p.j->>'consult_uid',
         NULLIF(p.j->>'prescription_uid', ''),
         p.j->>'schema_version',
         NULLIF(p.j->>'room_slug', ''),
         NULLIF(p.j->>'room_id', ''),
         NULLIF(p.j->>'ist_date', '')::date,
         NULLIF(p.j->>'doctor_uid8', ''),
         CASE WHEN (p.j->'validator'->>'ok')::boolean THEN 'ok' ELSE 'invalid' END,
         (p.j->'validator'->>'ok')::boolean,
         COALESCE(p.j->'validator'->'errors', '[]'::jsonb),
         p.j->'generator'->>'code_sha256',
         p.j->'generator'->>'prompt_sha256',
         NULLIF(p.j->'generator'->>'model', ''),
         CASE WHEN p.j->>'cost_usd' IS NULL OR p.j->>'cost_usd' = '' THEN NULL ELSE (p.j->>'cost_usd')::numeric END,
         p.j->>'input_sha256',
         NULLIF(p.j->>'job_id', '')
    FROM p
   WHERE NOT EXISTS (SELECT 1 FROM prior)
  RETURNING id
),
art AS (
  INSERT INTO freescript_artifact (
    run_id, consult_uid, prescription_uid, schema_version, artifact, completion_required, validator_ok, validator_errors)
  SELECT run.id, p.j->>'consult_uid', NULLIF(p.j->>'prescription_uid', ''), p.j->>'schema_version',
         p.j->'artifact', p.j->'completion_required',
         (p.j->'validator'->>'ok')::boolean, COALESCE(p.j->'validator'->'errors', '[]'::jsonb)
    FROM p, run
  RETURNING run_id
)
SELECT COALESCE((SELECT id FROM run), (SELECT id FROM prior)) AS run_id,
       (SELECT count(*) FROM run)::int AS inserted`;
