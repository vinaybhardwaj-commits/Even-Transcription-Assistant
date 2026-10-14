import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * POST /api/admin/opd-invalid-marking-backfill        — DRY RUN (writes nothing)
 * POST /api/admin/opd-invalid-marking-backfill?apply=1 — writes the historical flag (D7)
 *
 * S0 invalid-marking (PRD 28 Jul, §5): stamp `excluded_reason = 'llm_leg_failed'` on every
 * historical row whose PDQI-9 was never assessed — expected 33 at spec time, RE-COUNTED at run
 * time. These rows average 95.21 NQI against 78.36 for assessed notes (52% score exactly 100):
 * a failure to measure scored as excellence, sitting inside every published aggregate.
 *
 * DRY-RUN BY DEFAULT, per the standing rule on irreversible data effects. The dry run reports the
 * row count and the before/after mean-NQI delta (a) corpus-wide, (b) per engine version, (c) per
 * affected doctor — V validates that delta before any write. This moves published aggregates; it
 * is a data correction, not a scoring change, and there is NO engine version bump.
 *
 * THE PREDICATE (verbatim from PRD §5 — the same one the daily S0 gate counts):
 *   excluded_reason IS NULL AND (pdqi9 IS NULL OR jsonb_typeof(pdqi9) <> 'array'
 *                                OR jsonb_array_length(pdqi9) = 0)
 *
 * Reversible: `UPDATE opd_note_audits SET excluded_reason = NULL WHERE excluded_reason =
 * 'llm_leg_failed'` restores the previous state exactly — the mark is the only thing written.
 */

// The §5 predicate, verbatim. Deliberately NOT scoped to app_source: the measured 33 is corpus-wide,
// and the S0 gate counts the whole table.
const PREDICATE = `excluded_reason IS NULL AND (pdqi9 IS NULL OR jsonb_typeof(pdqi9) <> 'array' OR jsonb_array_length(pdqi9) = 0)`;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  const apply = req.nextUrl.searchParams.get('apply') === '1';

  try {
    // ── the rows the flag would mark ─────────────────────────────────────────────────────────────
    const affected = await run(
      `SELECT id, uid, engine_version, doctor_uid, note_quality_index, band, model,
              to_char(note_date, 'YYYY-MM-DD') AS note_day
         FROM opd_note_audits WHERE ${PREDICATE}
        ORDER BY note_date DESC LIMIT 500`, []);
    const count = (await run(`SELECT count(*)::int AS n FROM opd_note_audits WHERE ${PREDICATE}`, []))[0];
    const n = Number(count?.n ?? 0);

    // ── before/after mean NQI — corpus-wide ──────────────────────────────────────────────────────
    // "Before" = today's aggregates (marked-only-by-house_account); "after" = with these rows also
    // excluded. Both sides exclude already-excluded rows, mirroring every aggregate reader.
    const corpus = (await run(
      `SELECT round(avg(note_quality_index) FILTER (WHERE excluded_reason IS NULL)::numeric, 2)                          AS before_mean,
              round(avg(note_quality_index) FILTER (WHERE excluded_reason IS NULL AND NOT (${PREDICATE}))::numeric, 2)   AS after_mean,
              count(*)  FILTER (WHERE excluded_reason IS NULL)::int                                                      AS before_n,
              count(*)  FILTER (WHERE excluded_reason IS NULL AND NOT (${PREDICATE}))::int                               AS after_n
         FROM opd_note_audits`, []))[0];

    // ── per engine version (only versions carrying at least one affected row) ────────────────────
    const byEngine = await run(
      `SELECT engine_version,
              round(avg(note_quality_index) FILTER (WHERE excluded_reason IS NULL)::numeric, 2)                          AS before_mean,
              round(avg(note_quality_index) FILTER (WHERE excluded_reason IS NULL AND NOT (${PREDICATE}))::numeric, 2)   AS after_mean,
              count(*) FILTER (WHERE ${PREDICATE})::int                                                                  AS marked
         FROM opd_note_audits
        GROUP BY engine_version
       HAVING count(*) FILTER (WHERE ${PREDICATE}) > 0
        ORDER BY marked DESC`, []);

    // ── per affected doctor ──────────────────────────────────────────────────────────────────────
    const byDoctor = await run(
      `SELECT doctor_uid,
              round(avg(note_quality_index) FILTER (WHERE excluded_reason IS NULL)::numeric, 2)                          AS before_mean,
              round(avg(note_quality_index) FILTER (WHERE excluded_reason IS NULL AND NOT (${PREDICATE}))::numeric, 2)   AS after_mean,
              count(*) FILTER (WHERE ${PREDICATE})::int                                                                  AS marked,
              count(*) FILTER (WHERE excluded_reason IS NULL)::int                                                       AS notes
         FROM opd_note_audits
        WHERE doctor_uid IN (SELECT DISTINCT doctor_uid FROM opd_note_audits WHERE ${PREDICATE} AND doctor_uid IS NOT NULL)
        GROUP BY doctor_uid
        ORDER BY marked DESC`, []);

    let applied = 0;
    if (apply) {
      const updated = await run(
        `UPDATE opd_note_audits SET excluded_reason = 'llm_leg_failed' WHERE ${PREDICATE} RETURNING id`, []);
      applied = updated.length;
    }

    return NextResponse.json({
      ok: true,
      dryRun: !apply,
      rows: n,
      ...(apply ? { applied } : { note: 'DRY RUN — nothing was written. Re-POST with ?apply=1 after V validates the delta.' }),
      meanNqi: {
        corpus,
        byEngineVersion: byEngine,
        byAffectedDoctor: byDoctor,
      },
      affected: affected.map((r) => ({
        id: r.id, uid: r.uid, engine: r.engine_version, doctor: r.doctor_uid,
        nqi: r.note_quality_index, band: r.band, model: r.model, day: r.note_day,
      })),
      reversal: `UPDATE opd_note_audits SET excluded_reason = NULL WHERE excluded_reason = 'llm_leg_failed'`,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message).slice(0, 300) }, { status: 500 });
  }
}
