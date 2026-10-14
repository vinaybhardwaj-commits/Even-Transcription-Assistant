/**
 * lib/opd-gov-read.ts — audit-side reads for the governance signal feed (Neon).
 *
 * A governance thread stores the (doctor, signal_type, window) key; the actual finding INSTANCES
 * and the doctor's audit METRICS live in opd_note_audits and are resolved at read time here (so the
 * thread never duplicates finding text). Re-stamps finding identity on read → legacy rows covered.
 */

import { sql } from './db';
import { OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT, stampFindingIdentity, type OpdFinding } from './opd-note-audit-core';
import { canonicalDistinctOnSql } from './audit-canonical';
import { parseJson } from './opd-audit-ui';
import type { Source } from './citations-core';
import type { SignalRepresentative } from './opd-gov-signal-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';
/** Read-side engine FAMILY, as every other read surface uses (decision 21). Also excludes `-mini`
 *  before ranking, which is what makes the int[] cast in CANONICAL_RANK_SQL safe. */
const ENG_FAMILY_SQL = `ANY(ARRAY[${OPD_ENGINE_VERSIONS_CURRENT.map((v) => `'${v}'`).join(', ')}])`;

export interface Instance extends SignalRepresentative {}

function citationsFor(f: OpdFinding, sources: Source[]): { n: number; title: string; url: string }[] {
  const ids = Array.isArray(f.citation_ids) ? f.citation_ids : [];
  return ids.map((i) => {
    const s = sources.find((x) => x?.n === i);
    return { n: i, title: s ? (s.chapter ? `${s.book} — ${s.chapter}` : s.book) : `Source ${i}`, url: s?.url || '' };
  });
}

/**
 * All instances of one signal_type for a doctor in a window, newest note first. `representative`
 * is the first. Reads only de-identified finding text (no PHI, no patient identifiers).
 */
export async function resolveInstances(
  doctorUid: string, signalType: string, windowFrom: string | null, windowTo: string | null,
): Promise<{ count: number; representative: SignalRepresentative | null; instances: Instance[] }> {
  const params: unknown[] = [APP, OPD_ENGINE_VERSION, doctorUid];
  let where = `app_source=$1 AND engine_version=$2 AND doctor_uid=$3 AND excluded_reason IS NULL`;   // Fix C
  if (windowFrom) { params.push(windowFrom); where += ` AND (note_date AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}`; }
  if (windowTo) { params.push(windowTo); where += ` AND (note_date AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}`; }

  const rows = await run(
    `SELECT id::text AS id, to_char(note_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS note_date, findings, sources
     FROM opd_note_audits WHERE ${where} ORDER BY note_date DESC LIMIT 2000`, params).catch(() => []);

  const instances: Instance[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const audit_id = String(r.id);
    const note_date = String(r.note_date || '');
    const sources = parseJson<Source[]>(r.sources, []);
    const stamped = stampFindingIdentity(parseJson<OpdFinding[]>(r.findings, []));
    for (const f of stamped) {
      if (f.informational) continue;
      if (f.signal_type !== signalType) continue;
      instances.push({
        audit_id, finding_ref: f.finding_ref as string, subject: f.subject, verdict: f.verdict,
        rationale: f.rationale, note_date, citations: citationsFor(f, sources),
      });
    }
  }
  return { count: instances.length, representative: instances[0] ?? null, instances };
}

export interface AuditMetrics {
  notes_audited: number; nqi_mean: number | null; band_a_pct: number | null;
  documentation_completeness: number | null; prescribing_safety: number | null;
  top_gap: string | null; as_of: string | null;
  /**
   * THE MIX BEHIND THE NUMBER (31 Jul 2026, addendum D). These metrics are computed over the
   * CANONICAL row per note — the newest engine that has scored each one — so a window can mix
   * engine versions, and engine versions genuinely disagree with each other (audit-canonical.ts's
   * own example: one discharge scoring 95/C under 0.1 and 88/D under 0.2). That is a real
   * limitation of the figure, so it is DECLARED rather than hidden: surface, never resolve.
   *
   * A governance conversation built on notes scored by several engines is defensible; one that
   * conceals that it did is not. `engine_versions` counts the distinct versions contributing;
   * `oldest_engine_version` names the weakest link.
   */
  engine_versions: number; oldest_engine_version: string | null;
}

/**
 * Audit-side per-doctor metrics over a trailing window (default 30d ending latest audited day).
 *
 * ⚠️ THE VERSION PIN WAS REMOVED, 31 Jul 2026 (addendum D). This read filtered
 * `engine_version = OPD_ENGINE_VERSION`. MEASURED: every duplicate in the table is CROSS-version
 * (zero within-version duplicates), so the pin did remove every duplicate — but it also removed
 * almost all the DATA. On a 30-day window it showed governance 4-7% of a doctor's notes (e.g. 39
 * of 613), and the denominator COLLAPSED at every engine bump — four last week — then refilled as
 * the worker caught up. `as_of` reported the window honestly; nothing reported the sample.
 *
 * No stated reason for the pin was found: no comment, no test, no ADR. It dates to the original
 * governance build (3 Jul), which PREDATES both conventions it violates — the read-side family
 * (introduced because an exact-match bump at 0.81.4 orphaned the validated corpus and emptied the
 * doctors index — the identical failure) and THE RULE in audit-canonical.ts (27 Jul).
 *
 * Now reads the canonical row per note through the shared fragment, like every other surface. The
 * family filter stays and is load-bearing twice over: it is the convention, and it excludes `-mini`
 * rows before ranking, which is what makes the int[] cast in CANONICAL_RANK_SQL safe.
 *
 * FAIL CLOSED (addendum C §6): the canonical filter is inline SQL, so there is no probe result to
 * fall back from — a failure yields no rows and a zeroed metric, never a silently unfiltered one.
 */
export async function doctorAuditMetrics(doctorUid: string, days = 30): Promise<AuditMetrics> {
  const EMPTY: AuditMetrics = {
    notes_audited: 0, nqi_mean: null, band_a_pct: null, documentation_completeness: null,
    prescribing_safety: null, top_gap: null, as_of: null, engine_versions: 0, oldest_engine_version: null,
  };
  const canonical = (cols: string, extra = '') => canonicalDistinctOnSql({
    table: 'opd_note_audits',
    identity: 'uid',
    cols,
    where: `app_source=$1 AND engine_version = ${ENG_FAMILY_SQL} AND doctor_uid=$2 AND excluded_reason IS NULL${extra}`,
  });

  const latest = await run(
    `SELECT to_char(max((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') d
     FROM (${canonical('note_date')}) canonical`,
    [APP, doctorUid]).catch(() => []);
  const to = String(latest[0]?.d || '');
  if (!to) return EMPTY;
  const fromD = new Date(to + 'T00:00:00Z'); fromD.setUTCDate(fromD.getUTCDate() - (Math.max(1, days) - 1));
  const from = fromD.toISOString().slice(0, 10);
  const winExtra = ` AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $3 AND $4`;
  const p = [APP, doctorUid, from, to];

  const [agg, gap] = await Promise.all([
    run(`SELECT count(*)::int n, avg(note_quality_index)::float nqi,
           (100.0*sum(CASE WHEN band='A' THEN 1 ELSE 0 END)/nullif(count(*),0))::float band_a,
           avg(completeness_pct)::float comp, avg(score_prescribing_safety)::float rx,
           count(DISTINCT engine_version)::int versions,
           min(string_to_array(split_part(engine_version, '/', 2), '.')::int[])::text oldest_tail
         FROM (${canonical(
           'note_date, note_quality_index, band, completeness_pct, score_prescribing_safety, engine_version',
           winExtra,
         )}) canonical`, p).catch(() => []),
    run(`SELECT x s, count(*) c
         FROM (${canonical('note_date, missing_fields', winExtra)}) canonical,
              LATERAL jsonb_array_elements_text(missing_fields) x
         GROUP BY 1 ORDER BY c DESC LIMIT 1`, p).catch(() => []),
  ]);
  const a = (agg[0] || {}) as Record<string, unknown>;
  const rnd = (v: unknown) => (v == null ? null : Math.round(Number(v)));
  // `min(int[])` returns the ranked tail (e.g. '{0,81,14}'); render it back as an engine string.
  const oldest = a.oldest_tail == null ? null
    : `opd-note-audit/${String(a.oldest_tail).replace(/[{}]/g, '').split(',').join('.')}`;
  return {
    notes_audited: Number(a.n || 0),
    nqi_mean: rnd(a.nqi), band_a_pct: rnd(a.band_a),
    documentation_completeness: rnd(a.comp), prescribing_safety: rnd(a.rx),
    top_gap: gap[0]?.s ? String(gap[0].s) : null, as_of: to,
    engine_versions: Number(a.versions || 0), oldest_engine_version: oldest,
  };
}
