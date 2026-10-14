// scripts/addendum-h-probe.mjs — addendum H, READ-ONLY probe. No writes anywhere.
//
//   node --env-file=.env.local --import tsx scripts/addendum-h-probe.mjs
//
// 1. model value distribution on opd_note_audits (active rows).
// 2. Does DISTINCT ON allow ORDER BY on a column absent from the select list?
// 3. Baselines: whole-table count, cohort, house_account, 26–30 Jul gap, the two H2 notes.
// 4. THE MEASUREMENT: notes whose canonical row flips under version → tier → audited_at.
import { sql } from '../lib/db.ts';

const log = (...a) => console.log(...a);
const APP = 'standalone';
const REF = `('google/gemini-2.5-pro','gemini-2.5-pro')`;

// ── 1. model distribution ──
log('== model distribution (active rows) ==');
log(await sql(
  `SELECT COALESCE(model,'<null>') AS model, count(*)::int rows, count(DISTINCT uid)::int notes,
          min(engine_version) min_ev, max(engine_version) max_ev
     FROM opd_note_audits WHERE excluded_reason IS NULL
    GROUP BY 1 ORDER BY rows DESC`, []));

// ── 2. DISTINCT ON + ORDER BY unselected column ──
log('\n== DISTINCT ON ordering by unselected column ==');
try {
  const r = await sql(
    `SELECT DISTINCT ON (uid) uid, id FROM opd_note_audits
      WHERE excluded_reason IS NULL AND app_source = $1
      ORDER BY uid, (CASE WHEN model IN ${REF} THEN 0 ELSE 1 END), audited_at DESC
      LIMIT 3`, [APP]);
  log('WORKS — rows:', r.length);
} catch (e) {
  log('FAILS —', String(e.message || e).slice(0, 200));
}

// ── 3. baselines ──
log('\n== whole-table row count ==');
log(await sql(`SELECT count(*)::int n FROM opd_note_audits`, []));

log('\n== house_account ==');
log(await sql(
  `SELECT count(*)::int rows, count(DISTINCT uid)::int uids FROM opd_note_audits
    WHERE excluded_reason = 'house_account'`, []));

log('\n== outage-exclusion cohort (0031) ==');
log(await sql(
  `SELECT excluded_reason, count(*)::int rows, count(DISTINCT uid)::int uids
     FROM opd_note_audits WHERE excluded_reason IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, []));

log('\n== notes without an active audit, 26–30 Jul (per addendum G measurement) ==');
log(await sql(
  `WITH days AS (SELECT d::date AS day FROM generate_series('2026-07-26'::date,'2026-07-30'::date,'1 day') d),
   notes AS (SELECT uid, (note_date AT TIME ZONE 'Asia/Kolkata')::date AS day
               FROM opd_note_audits WHERE app_source=$1 GROUP BY 1,2),
   active AS (SELECT DISTINCT uid FROM opd_note_audits WHERE app_source=$1 AND excluded_reason IS NULL)
   SELECT d.day, count(n.uid)::int notes,
          count(*) FILTER (WHERE a.uid IS NULL)::int without_audit
     FROM days d LEFT JOIN notes n ON n.day=d.day LEFT JOIN active a ON a.uid=n.uid
    GROUP BY 1 ORDER BY 1`, [APP]));

log('\n== H2 notes: every row ==');
log(await sql(
  `SELECT uid, engine_version, model, excluded_reason,
          to_char(audited_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') AS audited_ist,
          note_quality_index nqi, band
     FROM opd_note_audits WHERE uid IN ('lcw1Hmy8FkfktiqrFOv2','wFHiLa3eOZSgm8QgrAyd')
    ORDER BY uid, audited_at`, []));

// ── 4. flip count: current rule vs new rule, active rows, whole corpus ──
// Current: version desc, audited_at desc.  New: version desc, tier, audited_at desc.
// A note flips iff its top-version group holds BOTH tiers AND a non-reference row is newest.
log('\n== flip count under version → tier → audited_at (active rows, app db13) ==');
log(await sql(
  `WITH ranked AS (
     SELECT uid, model, audited_at, engine_version,
            string_to_array(split_part(engine_version,'/',2),'.')::int[] AS vtail,
            (CASE WHEN model IN ${REF} THEN 0 ELSE 1 END) AS tier
       FROM opd_note_audits
      WHERE app_source = $1 AND excluded_reason IS NULL
        AND split_part(engine_version,'/',2) ~ '^[0-9]+(\\.[0-9]+)*$'
   ), top AS (
     SELECT r.* FROM ranked r
     JOIN (SELECT uid, max(vtail) mv FROM ranked GROUP BY 1) m ON m.uid=r.uid AND r.vtail=m.mv
   ), pick AS (
     SELECT uid,
            (array_agg(tier ORDER BY audited_at DESC))[1] AS cur_tier,
            (array_agg(tier ORDER BY tier, audited_at DESC))[1] AS new_tier,
            (array_agg(audited_at ORDER BY audited_at DESC))[1] AS cur_at,
            (array_agg(audited_at ORDER BY tier, audited_at DESC))[1] AS new_at
       FROM top GROUP BY uid
   )
   SELECT count(*)::int notes_total,
          count(*) FILTER (WHERE cur_at IS DISTINCT FROM new_at)::int notes_flipping,
          count(*) FILTER (WHERE cur_tier=1 AND new_tier=0)::int candidate_to_reference
     FROM pick`, [APP]));

// The flipping notes themselves (capped list for the report).
log('\n== flipping notes, first 20 ==');
log(await sql(
  `WITH ranked AS (
     SELECT uid, model, audited_at, engine_version,
            string_to_array(split_part(engine_version,'/',2),'.')::int[] AS vtail,
            (CASE WHEN model IN ${REF} THEN 0 ELSE 1 END) AS tier
       FROM opd_note_audits
      WHERE app_source = $1 AND excluded_reason IS NULL
        AND split_part(engine_version,'/',2) ~ '^[0-9]+(\\.[0-9]+)*$'
   ), top AS (
     SELECT r.* FROM ranked r
     JOIN (SELECT uid, max(vtail) mv FROM ranked GROUP BY 1) m ON m.uid=r.uid AND r.vtail=m.mv
   ), pick AS (
     SELECT uid, max(engine_version) ev,
            (array_agg(audited_at ORDER BY audited_at DESC))[1] AS cur_at,
            (array_agg(audited_at ORDER BY tier, audited_at DESC))[1] AS new_at,
            (array_agg(model ORDER BY audited_at DESC))[1] AS cur_model,
            (array_agg(model ORDER BY tier, audited_at DESC))[1] AS new_model
       FROM top GROUP BY uid
   )
   SELECT uid, ev, cur_model, new_model,
          to_char(cur_at AT TIME ZONE 'Asia/Kolkata','MM-DD HH24:MI') cur_ist,
          to_char(new_at AT TIME ZONE 'Asia/Kolkata','MM-DD HH24:MI') new_ist
     FROM pick WHERE cur_at IS DISTINCT FROM new_at LIMIT 20`, [APP]));

// IPD: does the model column carry anything that would make the tier bite there?
log('\n== IPD model distribution (non-mini rows) ==');
log(await sql(
  `SELECT COALESCE(model,'<null>') AS model, count(*)::int rows
     FROM ipd_discharge_audits WHERE engine_version NOT LIKE '%-mini'
    GROUP BY 1 ORDER BY 2 DESC`, []).catch((e) => 'ipd query failed: ' + String(e.message).slice(0, 120)));
