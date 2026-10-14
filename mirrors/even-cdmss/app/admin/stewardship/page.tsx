import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fetchLvcCells, readRightCareExclusions, fetchRightCareCoverage } from '@/lib/opd-audit-doctor';
import { computeDoctorOE, FUNNEL_MIN_N, type DoctorOE } from '@/lib/opd-funnel-core';
import { canonicalDistinctOnSql } from '@/lib/audit-canonical';
import { OPD_ENGINE_VERSIONS_CURRENT } from '@/lib/opd-note-audit-core';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Stewardship · Admin · CAT' };

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const n = (v: unknown): number => Number(v ?? 0);

type DeptRow = {
  dept: string; n_notes: number; avg_nqi: number; pct_ab: number;
  avg_appr: number; avg_presc: number; avg_doc: number; avg_complete: number;
  pct_low: number; sum_low: number; sum_interactions: number;
};
type DoctorRow = DeptRow & { doctor_uid: string; doctor_name: string; speciality: string };

const WINDOW_DAYS = 90;

/** Read-side engine FAMILY (decision 21) — also excludes `-mini` before ranking, which is what
 *  makes the int[] cast in CANONICAL_RANK_SQL safe. */
const ENG_FAMILY_SQL = `ANY(ARRAY[${OPD_ENGINE_VERSIONS_CURRENT.map((v) => `'${v}'`).join(', ')}])`;

// Shared inner subquery: the CANONICAL audit per note over the window. Nested because Neon's HTTP
// driver can't GROUP BY over a DISTINCT ON in one pass. doctor_directory (synced from db13 via
// /api/admin/sync-doctor-directory) supplies the speciality + name; a missing table is caught →
// empty state.
//
// ⚠️ RE-POINTED 31 Jul 2026 (addendum D). This ordered by `uid, audited_at DESC` — newest by TIME —
// and carried NO engine filter at all, making it the third of three different rules over one table.
// Newest-by-time is not THE RULE: a later re-audit on an OLDER engine outranked the newer engine's
// score, and with no family filter a `-mini` backfill row could win the note outright — the exact
// trap audit-canonical.ts documents. Now uses the shared fragment, and the family filter both
// restores the convention and makes the int[] cast safe by excluding `-mini` before ranking.
const CANON_WHERE = `app_source = $1 AND engine_version = ${ENG_FAMILY_SQL} AND excluded_reason IS NULL AND note_date >= NOW() - ($2 || ' days')::interval`;
const INNER = canonicalDistinctOnSql({
  table: 'opd_note_audits',
  identity: 'uid',
  cols: `doctor_uid, note_quality_index, band,
    score_appropriateness, score_prescribing_safety, score_documentation,
    completeness_pct, n_low_value, n_interaction_alerts`,
  where: CANON_WHERE,
});

const AGG = `
  count(*)::int AS n_notes,
  round(avg(note_quality_index))::int AS avg_nqi,
  round(100.0 * avg(CASE WHEN band IN ('A','B') THEN 1 ELSE 0 END))::int AS pct_ab,
  round(avg(score_appropriateness))::int AS avg_appr,
  round(avg(score_prescribing_safety))::int AS avg_presc,
  round(avg(score_documentation))::int AS avg_doc,
  round(avg(completeness_pct))::int AS avg_complete,
  round(100.0 * avg(CASE WHEN n_low_value > 0 THEN 1 ELSE 0 END))::int AS pct_low,
  sum(n_low_value)::int AS sum_low,
  sum(n_interaction_alerts)::int AS sum_interactions`;

const DEPT_SQL = `
  SELECT COALESCE(NULLIF(dd.speciality, ''), 'Unspecified') AS dept, ${AGG}
  FROM ( ${INNER} ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  GROUP BY 1
  ORDER BY n_notes DESC`;

const DOCTOR_SQL = `
  SELECT t.doctor_uid AS doctor_uid,
    COALESCE(NULLIF(dd.doctor_name, ''), '(unknown)') AS doctor_name,
    COALESCE(NULLIF(dd.speciality, ''), 'Unspecified') AS speciality, ${AGG}
  FROM ( ${INNER} ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  GROUP BY t.doctor_uid, dd.doctor_name, dd.speciality
  ORDER BY n_notes DESC
  LIMIT 200`;

const TOTAL_SQL = `
  SELECT count(*)::int AS n_notes,
    round(avg(note_quality_index))::int AS avg_nqi,
    round(100.0 * avg(CASE WHEN band IN ('A','B') THEN 1 ELSE 0 END))::int AS pct_ab,
    round(100.0 * avg(CASE WHEN n_low_value > 0 THEN 1 ELSE 0 END))::int AS pct_low,
    sum(n_low_value)::int AS sum_low,
    sum(n_interaction_alerts)::int AS sum_interactions
  FROM ( ${canonicalDistinctOnSql({
    table: 'opd_note_audits',
    identity: 'uid',
    cols: 'note_quality_index, band, n_low_value, n_interaction_alerts',
    where: CANON_WHERE,
  })} ) t`;

function scoreClass(v: number): string {
  if (v >= 80) return 'text-emerald-700';
  if (v >= 60) return 'text-amber-600';
  return 'text-red-600';
}
function riskClass(pct: number): string {
  if (pct >= 40) return 'text-red-600 font-medium';
  if (pct >= 20) return 'text-amber-600';
  return 'text-slate-600';
}
function aggRow(r: Record<string, unknown>): DeptRow {
  return {
    dept: String(r.dept || 'Unspecified'), n_notes: n(r.n_notes), avg_nqi: n(r.avg_nqi), pct_ab: n(r.pct_ab),
    avg_appr: n(r.avg_appr), avg_presc: n(r.avg_presc), avg_doc: n(r.avg_doc), avg_complete: n(r.avg_complete),
    pct_low: n(r.pct_low), sum_low: n(r.sum_low), sum_interactions: n(r.sum_interactions),
  };
}

function Locked() {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">Stewardship</h1>
      <p className="mt-1.5 text-sm text-slate-500">Locked. <Link href="/admin/opd-audit" className="text-brand hover:underline">Unlock an admin surface</Link> first.</p>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 font-serif text-[24px] font-semibold text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-[11.5px] text-slate-500">{sub}</div>}
    </div>
  );
}

function MetricCells({ r }: { r: DeptRow }) {
  return (
    <>
      <td className="px-3 py-2.5 text-right text-slate-600">{r.n_notes.toLocaleString()}</td>
      <td className={`px-3 py-2.5 text-right font-medium ${scoreClass(r.avg_nqi)}`}>{r.avg_nqi}</td>
      <td className="px-3 py-2.5 text-right text-slate-600">{r.pct_ab}%</td>
      <td className={`px-3 py-2.5 text-right ${scoreClass(r.avg_appr)}`}>{r.avg_appr}</td>
      <td className={`px-3 py-2.5 text-right ${scoreClass(r.avg_presc)}`}>{r.avg_presc}</td>
      <td className={`px-3 py-2.5 text-right ${scoreClass(r.avg_complete)}`}>{r.avg_complete}%</td>
      <td className={`px-3 py-2.5 text-right ${riskClass(r.pct_low)}`}>{r.pct_low}%</td>
      <td className={`px-3 py-2.5 text-right ${r.sum_interactions > 0 ? 'text-amber-600' : 'text-slate-400'}`}>{r.sum_interactions}</td>
    </>
  );
}

const METRIC_HEADERS = (
  <>
    <th className="px-3 py-2.5 text-right font-medium">Notes</th>
    <th className="px-3 py-2.5 text-right font-medium">Avg NQI</th>
    <th className="px-3 py-2.5 text-right font-medium">% A–B</th>
    <th className="px-3 py-2.5 text-right font-medium">Appropriate&shy;ness</th>
    <th className="px-3 py-2.5 text-right font-medium">Prescribing safety</th>
    <th className="px-3 py-2.5 text-right font-medium">Complete&shy;ness</th>
    <th className="px-3 py-2.5 text-right font-medium">Low-value %</th>
    <th className="px-3 py-2.5 text-right font-medium">Interaction alerts</th>
  </>
);

export default async function StewardshipPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  if (!(await isAdminUnlocked())) { adminTokenConfigured(); return <Locked />; }
  const sp = await searchParams;
  const view = sp.view === 'doctor' ? 'doctor' : 'dept';

  const [breakdownRaw, totalRaw, lvcCells, rcExclusions, rcCoverage] = await Promise.all([
    run(view === 'doctor' ? DOCTOR_SQL : DEPT_SQL, [APP, String(WINDOW_DAYS)]).catch(() => []),
    run(TOTAL_SQL, [APP, String(WINDOW_DAYS)]).catch(() => []),
    fetchLvcCells(), readRightCareExclusions(), fetchRightCareCoverage(),
  ]);
  const t = totalRaw[0] || {};
  const rowsCount = breakdownRaw.length;
  // Right Care "vs expected" — SAME O/E fn as the doctors index (decision 18: single implementation).
  const exclSet = new Set(rcExclusions);
  const oeMap = new Map<string, DoctorOE>(computeDoctorOE(lvcCells, exclSet).map((d) => [d.doctor_uid, d]));
  const vsExpected = (uid: string): { txt: string; tone: string; title: string } => {
    if (exclSet.has(uid)) return { txt: '—', tone: 'text-slate-300', title: 'excluded (house/non-clinician account)' };
    const oe = oeMap.get(uid);
    if (!oe || oe.n < FUNNEL_MIN_N) return { txt: '—', tone: 'text-slate-300', title: `building history (n<${FUNNEL_MIN_N} banded notes)` };
    const pts = Math.round((oe.raw_rate - oe.expected_rate) * 100);
    const txt = pts > 0 ? `+${pts}` : `${pts}`;
    const tone = pts >= 3 ? 'text-amber-700 font-medium' : pts <= -3 ? 'text-emerald-700' : 'text-slate-500';
    return { txt, tone, title: `observed ${Math.round(oe.raw_rate * 100)}% vs case-mix expected ${Math.round(oe.expected_rate * 100)}% (n=${oe.n} banded)` };
  };

  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-brand">STEWARDSHIP</div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">{view === 'doctor' ? 'Clinician stewardship' : 'Department stewardship'}</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-500">
        Note-quality and care-appropriateness from the daily OPD audits (last {WINDOW_DAYS} days, latest audit per note).
        {view === 'doctor'
          ? <span className="text-slate-600"> Individual-level — admin-only and advisory. A process &amp; appropriateness signal, not a standalone clinician score; small-sample clinicians read noisily.</span>
          : <span className="text-slate-600"> Department-level — a process &amp; appropriateness lens, not a clinician score.</span>}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {([['dept', 'By department'], ['doctor', 'By doctor']] as const).map(([v, label]) => (
          <Link key={v} href={`/admin/stewardship?view=${v}`}
            className={`rounded-full border px-2.5 py-1 text-[11.5px] ${view === v ? 'border-brand/40 bg-brand-faint text-brand' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
            {label}
          </Link>
        ))}
      </div>

      {rowsCount === 0 ? (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-6 text-center text-[13px] text-slate-500">
          No audits in the window yet.
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Notes audited" value={n(t.n_notes).toLocaleString()} sub={view === 'doctor' ? `${rowsCount} clinicians` : `${rowsCount} departments`} />
            <Stat label="Avg note-quality" value={String(n(t.avg_nqi))} sub={`${n(t.pct_ab)}% in band A–B`} />
            <Stat label="Notes w/ low-value" value={`${n(t.pct_low)}%`} sub={`${n(t.sum_low).toLocaleString()} findings total`} />
            <Stat label="Interaction alerts" value={n(t.sum_interactions).toLocaleString()} sub="across audited notes" />
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[10.5px] uppercase tracking-wide text-slate-400">
                  {view === 'doctor' ? (
                    <>
                      <th className="px-3 py-2.5 font-medium">Clinician</th>
                      <th className="px-3 py-2.5 font-medium">Speciality</th>
                    </>
                  ) : (
                    <th className="px-3 py-2.5 font-medium">Department</th>
                  )}
                  {METRIC_HEADERS}
                  {view === 'doctor' && <th className="px-3 py-2.5 text-right font-medium" title="observed minus case-mix-expected LVC rate, in points">vs expected</th>}
                </tr>
              </thead>
              <tbody>
                {view === 'doctor'
                  ? breakdownRaw.map((raw) => {
                      const r: DoctorRow = { ...aggRow(raw), doctor_uid: String(raw.doctor_uid || ''), doctor_name: String(raw.doctor_name || '(unknown)'), speciality: String(raw.speciality || 'Unspecified') };
                      return (
                        <tr key={r.doctor_uid || r.doctor_name} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                          <td className="px-3 py-2.5 font-medium text-slate-800">
                            {r.doctor_uid ? <Link href={`/admin/opd-audit/doctor/${r.doctor_uid}`} className="hover:text-brand hover:underline">{r.doctor_name}</Link> : r.doctor_name}
                          </td>
                          <td className="px-3 py-2.5 text-slate-500">{r.speciality}</td>
                          <MetricCells r={r} />
                          {(() => { const v = vsExpected(r.doctor_uid); return <td className={`px-3 py-2.5 text-right tabular-nums ${v.tone}`} title={v.title}>{v.txt}</td>; })()}
                        </tr>
                      );
                    })
                  : breakdownRaw.map((raw) => {
                      const r = aggRow(raw);
                      return (
                        <tr key={r.dept || 'none'} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                          <td className="px-3 py-2.5 font-medium text-slate-800">
                            <Link href={`/admin/stewardship/dept/${encodeURIComponent(r.dept)}`} className="hover:text-brand hover:underline">{r.dept}</Link>
                          </td>
                          <MetricCells r={r} />
                        </tr>
                      );
                    })}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-[11px] text-slate-400">
            Scores 0–100; green ≥80, amber 60–79, red &lt;60. {view === 'doctor' ? 'Clinicians' : 'Departments'} with few audited notes read noisily until volume builds.
            {view === 'doctor'
              ? ' Clinician names are staff data; this view is admin-only and advisory — use alongside the note-level evidence, not as a standalone score. “vs expected” = observed minus case-mix-expected LVC rate (points); em-dash when n<10 or excluded.'
              : ' Aggregated from de-identified audit records; no patient identifiers shown.'}
            {' '}Right Care banded coverage {rcCoverage.banded.toLocaleString()}/{rcCoverage.total.toLocaleString()}.
            {rcExclusions.length > 0 && ` ${rcExclusions.length} house/non-clinician account(s) excluded from vs-expected.`}
          </p>
        </>
      )}
    </div>
  );
}
