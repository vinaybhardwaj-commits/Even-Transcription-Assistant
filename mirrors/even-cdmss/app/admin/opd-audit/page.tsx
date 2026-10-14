import Link from 'next/link';
import { sql } from '@/lib/db';
import { isAdminUnlocked, adminTokenConfigured } from '@/lib/admin-cookie';
import { fetchDoctorNames } from '@/lib/metabase';
import { bandFor } from '@/lib/opd-note-score-core';
import { OPD_ENGINE_VERSIONS_CURRENT } from '@/lib/opd-note-audit-core';
import { formatEncounterChip } from '@/lib/opd-ingest-core';

// Decision 21: user-facing reads filter the current-engine FAMILY (inlined ARRAY of code constants),
// so a 0.81.x metadata bump doesn't empty the lists against the un-re-audited historical corpus.
const ENG_FAMILY_SQL = `ANY(ARRAY[${OPD_ENGINE_VERSIONS_CURRENT.map((v) => `'${v}'`).join(', ')}])`;
import { catsForRow, CAT_LABEL } from '@/lib/opd-audit-cats';
import {
  bandColor, scoreColor, istDateRange, parseJson, doctorLabel, fmtIstTime, fmtIstDateLong, PDQI9_LABEL,
  type Period,
} from '@/lib/opd-audit-ui';
import { fetchRightCareDay, fetchDeptFindingNotes } from '@/lib/opd-audit-doctor';
import { displayedBandColumnExists } from '@/lib/opd-audit-store';
import { canonicalDistinctOnSql } from '@/lib/audit-canonical';
import { fetchInvestigationsForUids, stateFor } from '@/lib/opd-audit/investigations-lookup';
import NotesExplorer, { type AuditRow } from './audit-table';
import DomainPillars, { type DomainDatum } from './domain-pillars';
import { RightCareTile } from './right-care-tile';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'OPD Audit · Admin' };

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
async function rowsOf<T>(text: string, params: unknown[]): Promise<T[]> {
  try { return (await run(text, params)) as T[]; } catch { return []; }
}
const n = (v: unknown): number => Number(v ?? 0);

function Locked({ configured, bad }: { configured: boolean; bad: boolean }) {
  return (
    <div>
      <h1 className="font-serif text-[26px] font-semibold text-slate-900">OPD Audit</h1>
      <p className="mt-1.5 text-sm text-slate-500">Daily OPD note-quality audit. This surface shows clinical-quality detail, so it is access-controlled.</p>
      <div className="mt-8 max-w-sm rounded-xl border border-slate-200 bg-white p-5">
        {!configured ? (
          <p className="text-sm text-red-700">Locked. Set the <code className="rounded bg-slate-100 px-1">ADMIN_TOKEN</code> environment variable to enable this surface.</p>
        ) : (
          <form method="POST" action="/api/admin/unlock">
            <label className="block text-sm font-medium text-slate-700">Admin token</label>
            <input type="password" name="token" autoFocus className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Enter admin token" />
            {bad && <p className="mt-2 text-xs text-red-600">Incorrect token.</p>}
            <button type="submit" className="mt-3 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark">Unlock</button>
          </form>
        )}
      </div>
    </div>
  );
}

function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}

const TYPE_SHORT: Record<string, string> = {
  GENERAL_PRACTITIONER: 'GP', HOSPITAL_GP: 'Hosp GP', HOSPITAL_GYNAECOLOGY_ASSESSMENT: 'Gynae',
  HOSPITAL_GYNAECOLOGY_OBSTETRICS: 'Obs-Gyn', HOSPITAL_PAEDIATRIC: 'Paeds', HOSPITAL_GP_INVESTIGATION_REFERRAL: 'GP-Ref',
};
const prettyType = (t: string | null) => (!t ? 'OPD' : TYPE_SHORT[t] || t.toLowerCase().replace(/_/g, ' '));
function issueFrom(findings: unknown, completenessPct: number): string {
  const fs = parseJson<{ subject?: string; verdict?: string }[]>(findings, []);
  const lv = fs.find((f) => f.verdict === 'low-value') || fs[0];
  if (lv?.subject) return lv.subject;
  if (completenessPct < 60) return 'Documentation gaps';
  return 'Review';
}

type DomCols = { d_doc: number; d_nq: number; d_appr: number; d_presc: number; d_pc: number };
type DocRow = { doctor_uid: string; nnotes: number; idx: number; low_value: number; completeness: number } & DomCols;
type TrendRow = { d: string; idx: number; c: number } & DomCols;
type ReviewRow = { id: string; note_date: string; doctor_uid: string | null; band: string; displayed_band?: string | null; note_quality_index: number; findings: unknown; n_low_value: number; completeness_pct: number };
type AllRow = { id: string; uid: string; note_date: string; doctor_uid: string | null; consult_type: string | null; prescription_type: string | null; band: string; displayed_band?: string | null; note_quality_index: number; n_low_value: number; completeness_pct: number; findings: unknown; missing_fields: unknown; score_documentation: number; score_note_quality: number; score_appropriateness: number; score_prescribing_safety: number; score_patient_centred: number; pdqi9: unknown; longitudinal: unknown };

// Stage 3 (D5c) — the audit-list "context" indicator: established | thin | none, from the stored
// longitudinal contextMeta.confidence (null when the note has no longitudinal block yet).
function contextIndicator(v: unknown): string | null {
  const block = parseJson<{ contextMeta?: { confidence?: string } } | null>(v, null);
  const c = block?.contextMeta?.confidence;
  return c === 'established' || c === 'thin' || c === 'none' ? c : null;
}
// 0.81.8 Part C — the frequent-flier signals off the SAME stored longitudinal block (no new SQL):
// prior-encounter count + longitudinal-finding count. Null when the note has no block yet.
function longEncounters(v: unknown): number | null {
  const b = parseJson<{ contextMeta?: { encounters?: number } } | null>(v, null);
  const e = b?.contextMeta?.encounters;
  return typeof e === 'number' ? e : null;
}
function longFindingCount(v: unknown): number | null {
  const b = parseJson<{ findings?: unknown[] } | null>(v, null);
  return Array.isArray(b?.findings) ? b!.findings!.length : null;
}

const PILLARS = [
  { col: 'd_doc', key: 'documentation', dom: 'documentation', label: 'Documentation\ncompleteness', short: 'documentation', weight: 0.25, scoreCol: 'score_documentation', catPrefix: 'doc:' },
  { col: 'd_nq', key: 'note_quality', dom: 'note_quality', label: 'Note quality\n(PDQI-9)', short: 'note quality', weight: 0.25, scoreCol: 'score_note_quality', catPrefix: '' },
  { col: 'd_appr', key: 'appropriateness', dom: 'appropriateness', label: 'Diagnostic\nappropriateness', short: 'diagnostic appropriateness', weight: 0.20, scoreCol: 'score_appropriateness', catPrefix: '' },
  { col: 'd_presc', key: 'prescribing_safety', dom: 'prescribing_safety', label: 'Prescribing\n& safety', short: 'prescribing safety', weight: 0.20, scoreCol: 'score_prescribing_safety', catPrefix: 'rx:' },
  { col: 'd_pc', key: 'patient_centred', dom: 'patient_centred', label: 'Continuity /\npatient-centred', short: 'continuity', weight: 0.10, scoreCol: 'score_patient_centred', catPrefix: '' },
] as const;
type DomKey = (typeof PILLARS)[number]['key'];

/** IST-day arithmetic for the trend's own 14-day canonical window. */
function addDaysIso(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export default async function OpdAuditAdmin({ searchParams }: { searchParams: Promise<{ day?: string; period?: string; locked?: string; doctor?: string; finding?: string; signal?: string; dept?: string }> }) {
  const sp = await searchParams;
  if (!(await isAdminUnlocked())) return <Locked configured={adminTokenConfigured()} bad={sp.locked === '1'} />;
  const initialDoctorUid = (sp.doctor && /^[A-Za-z0-9_-]{1,64}$/.test(sp.doctor)) ? sp.doctor : undefined;

  const period: Period = sp.period === 'week' ? 'week' : sp.period === 'month' ? 'month' : 'day';
  const latest = await rowsOf<{ d: string }>(
    `SELECT to_char(max((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') d FROM opd_note_audits WHERE app_source = $1 AND engine_version = ${ENG_FAMILY_SQL} AND excluded_reason IS NULL`, [APP]);
  const latestDay = latest[0]?.d || new Date().toISOString().slice(0, 10);
  const day = (sp.day && /^\d{4}-\d{2}-\d{2}$/.test(sp.day)) ? sp.day : latestDay;
  const { from, to } = istDateRange(day, period);
  const winParams = [APP, from, to];
  // ── FIX 0 (Phase C): ONE ROW PER NOTE. The engine-FAMILY filter below counts a re-audited note
  //    once per version — 52.9% duplicates over 90 days, and 532-vs-429 on 2026-07-25 alone. The
  //    canonical id set is computed by the SAME rule the IPD surface uses (lib/audit-canonical.ts,
  //    keyed on `uid`); every aggregate then filters on it. Null ⇒ the probe failed ⇒ no extra
  //    predicate, i.e. today's behaviour, rather than an empty page.
  // S1 deploy-tolerance: name displayed_band only once 0029 has run; a SELECT naming a missing
  // column fails whole and would blank these sections. Pre-migration ⇒ raw band, exactly as today.
  const withBand = await displayedBandColumnExists().catch(() => false);
  const DBAND = withBand ? ', displayed_band' : '';
  // ⚠️ FAIL-CLOSED CANONICAL FILTER (31 Jul 2026, addendum C §6). This previously fetched an id
  // allowlist through `canonicalOpdAuditIds` and, when that returned null, DROPPED the filter and
  // rendered inflated numbers anyway. A dedup that silently disables itself is worse than one that
  // errors: the page still renders and the figure is wrong. It also capped its scan at 20,000 rows,
  // so a wide window truncated the allowlist without erroring at all — silently showing FEWER notes.
  //
  // Both failure modes come from doing the dedup in a separate round trip. Expressing THE RULE as a
  // subquery removes them: there is no null to fall back from and no scan cap. The tuned aggregate
  // SQL below is untouched — this still slots in exactly where the id predicate did.
  //
  // The engine-family filter inside the subquery is load-bearing: it drops `-mini` rows before
  // ranking, which is what makes the int[] cast in CANONICAL_RANK_SQL safe (see audit-canonical.ts).
  const canonicalWhere = `app_source = $1 AND engine_version = ${ENG_FAMILY_SQL} AND excluded_reason IS NULL`;
  const CANON = ` AND id IN (SELECT id FROM (${canonicalDistinctOnSql({
    table: 'opd_note_audits',
    identity: 'uid',
    cols: 'id',
    where: `${canonicalWhere} AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3`,
  })}) canonical)`;
  const canonParams = winParams;
  const WIN = `app_source = $1 AND engine_version = ${ENG_FAMILY_SQL} AND excluded_reason IS NULL AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3${CANON}`;
  // The 14-day trend uses its own window, so it needs its own canonical subquery over that range.
  const TREND_CANON = ` AND id IN (SELECT id FROM (${canonicalDistinctOnSql({
    table: 'opd_note_audits',
    identity: 'uid',
    cols: 'id',
    where: `${canonicalWhere} AND (note_date AT TIME ZONE 'Asia/Kolkata')::date > $2::date - 14 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date <= $2::date`,
  })}) canonical)`;

  const [kpiR, bandsR, trendR, docsR, reviewR, allR, notAssessedR] = await Promise.all([
    rowsOf<Record<string, unknown>>(
      `SELECT count(*)::int total, count(DISTINCT doctor_uid)::int doctors,
              round(avg(note_quality_index))::int mean_index,
              round(100.0*avg((band IN ('A','B'))::int))::int pct_good,
              round(100.0*avg((n_low_value>0)::int))::int low_value_rate,
              coalesce(sum(n_interaction_alerts),0)::int interactions,
              round(avg(completeness_pct))::int mean_completeness,
              round(avg(score_documentation))::int d_doc, round(avg(score_note_quality))::int d_nq,
              round(avg(score_appropriateness))::int d_appr, round(avg(score_prescribing_safety))::int d_presc,
              round(avg(score_patient_centred))::int d_pc,
              count(*) FILTER (WHERE pdqi9 IS NOT NULL AND jsonb_array_length(pdqi9) > 0)::int pdqi_n
       FROM opd_note_audits WHERE ${WIN}`, canonParams),
    rowsOf<{ band: string; c: number }>(`SELECT band, count(*)::int c FROM opd_note_audits WHERE ${WIN} GROUP BY band`, canonParams),
    rowsOf<TrendRow>(
      `SELECT to_char((note_date AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') d, round(avg(note_quality_index))::int idx, count(*)::int c,
              round(avg(score_documentation))::int d_doc, round(avg(score_note_quality))::int d_nq,
              round(avg(score_appropriateness))::int d_appr, round(avg(score_prescribing_safety))::int d_presc,
              round(avg(score_patient_centred))::int d_pc
       FROM opd_note_audits WHERE app_source = $1 AND engine_version = ${ENG_FAMILY_SQL} AND excluded_reason IS NULL AND (note_date AT TIME ZONE 'Asia/Kolkata')::date > $2::date - 14 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date <= $2::date${TREND_CANON}
       GROUP BY 1 ORDER BY 1`, [APP, to]),
    rowsOf<DocRow>(
      `SELECT doctor_uid, count(*)::int nnotes, round(avg(note_quality_index))::int idx,
              round(100.0*avg((n_low_value>0)::int))::int low_value, round(avg(completeness_pct))::int completeness,
              round(avg(score_documentation))::int d_doc, round(avg(score_note_quality))::int d_nq,
              round(avg(score_appropriateness))::int d_appr, round(avg(score_prescribing_safety))::int d_presc,
              round(avg(score_patient_centred))::int d_pc
       FROM opd_note_audits WHERE ${WIN} AND doctor_uid IS NOT NULL
       GROUP BY doctor_uid ORDER BY nnotes DESC, idx ASC LIMIT 60`, canonParams),
    rowsOf<ReviewRow>(
      `SELECT id, note_date, doctor_uid, band${DBAND}, note_quality_index, findings, n_low_value, completeness_pct
       FROM opd_note_audits WHERE ${WIN} ORDER BY note_quality_index ASC, n_low_value DESC LIMIT 10`, canonParams),
    rowsOf<AllRow>(
      `SELECT id, uid, note_date, doctor_uid, consult_type, prescription_type, band${DBAND}, note_quality_index, n_low_value, completeness_pct, findings, missing_fields,
              score_documentation, score_note_quality, score_appropriateness, score_prescribing_safety, score_patient_centred, pdqi9, longitudinal
       FROM opd_note_audits WHERE ${WIN} ORDER BY note_date DESC LIMIT 600`, canonParams),
    // S0 (invalid-marking, V ruling on F-1): the NOT-ASSESSED COUNT for the selected period.
    // Marked rows are correctly invisible in the list and every aggregate above (the house_account
    // symmetry) — but invisibility is how the original defect survived for months, so the failure
    // RATE renders as a count a human notices if it moves from 4-in-75 to 20-in-75. Same period +
    // app_source + engine family as the page; deliberately NO canonical filter and NO
    // excluded_reason IS NULL (marked rows are exactly what it counts). A COUNT, never a score.
    // Its own params array, NOT winParams: the FIX 0 test rightly demands every WIN query take the
    // canonical set, and this one is deliberately outside both WIN and CANON.
    rowsOf<{ n: number }>(
      `SELECT count(DISTINCT uid)::int AS n FROM opd_note_audits
        WHERE app_source = $1 AND engine_version = ${ENG_FAMILY_SQL}
          AND excluded_reason = 'llm_leg_failed'
          AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3`, [APP, from, to]),
  ]);

  // Right Care day tile (§7 / decision 24) — the page's selected day drives BOTH the rate and the
  // category split (was mismatched: split hardcoded today). Family-basis distinct-note LVC rate.
  const rightCareDay = await fetchRightCareDay(to).catch(() => null);

  // Stewardship drill-through (NAVIGATOR-DRILL §2.2): finding+signal+dept ALL present → the notes list
  // switches to the stewardship basis; any missing → ignored, page renders exactly as today. The
  // KPI/trend/doctor sections above are unaffected (they read the normal window).
  const drillSubject = (sp.finding || '').trim();
  const drillDept = (sp.dept || '').trim();
  const drillActive = !!drillSubject && !!drillDept && sp.signal !== undefined;   // signal may be '' (folded key)
  const drillSignal = sp.signal ?? '';
  const drill = drillActive ? await fetchDeptFindingNotes(drillDept, drillSubject, drillSignal).catch(() => null) : null;
  const drillRowsRaw = drill?.rows ?? [];

  const docUids = Array.from(new Set(([...docsR.map((d) => d.doctor_uid), ...reviewR.map((r) => r.doctor_uid), ...allR.map((r) => r.doctor_uid), ...drillRowsRaw.map((r) => r.doctor_uid)].filter(Boolean)) as string[]));
  const names = await fetchDoctorNames(docUids).catch(() => ({} as Record<string, string>));
  const docName = (uid: string | null): string => (uid && names[uid]) || doctorLabel(uid);

  // one mapping for both the normal list and the drill list (identical AuditRow shape)
  const toAuditRow = (r: {
    id: string; note_date: string; doctor_uid: string | null; prescription_type: string | null; consult_type: string | null;
    uid: string; band: string; displayed_band?: string | null; note_quality_index: number; n_low_value: number; findings: unknown; completeness_pct: number; missing_fields: unknown; longitudinal?: unknown;
  }): AuditRow => ({
    id: String(r.id), time: fmtIstTime(r.note_date), doctor: docName(r.doctor_uid),
    consult: formatEncounterChip(r.prescription_type, r.consult_type), uid: String(r.uid || ''),
    // S1 — render the DISPLAYED band (hysteresis anchor); raw band is the fallback for rows
    // written before 0029 ran. The raw index renders beside it in the table, per the rule.
    band: r.displayed_band ?? r.band, index: n(r.note_quality_index), lowVal: n(r.n_low_value),
    issue: issueFrom(r.findings, n(r.completeness_pct)),
    cats: catsForRow(parseJson<string[]>(r.missing_fields, []), parseJson<{ subject?: string; verdict?: string; rationale?: string }[]>(r.findings, [])),
    doctorUid: r.doctor_uid ? String(r.doctor_uid) : null,
    context: contextIndicator(r.longitudinal),
    encounters: longEncounters(r.longitudinal),          // Part C — prior encounters
    longFindings: longFindingCount(r.longitudinal),      // Part C — longitudinal findings on this note
  });

  const allRows: AuditRow[] = allR.map(toAuditRow);
  const notesRows: AuditRow[] = drillActive ? drillRowsRaw.map(toAuditRow) : allRows;   // drill swaps the NOTES source only

  // Feature C (UX polish PRD §1C): which of the audits on screen already carry finding-scope triage —
  // one parameterized round-trip over the ids fetched for display. Read-only page query, NOT the MCP
  // guard path; .catch → [] so a pre-migration DB (no scope column) degrades to no ticks.
  const auditIds = notesRows.map((r) => r.id);

  // §7.1 — investigations-ordered, joined from db13 at read time (decision §1.11, so the filter
  // covers the full history immediately). ONE batched call for the page, never one per row.
  // Fail-soft: on any error the control disables itself and the list renders unfiltered.
  const investigations = await fetchInvestigationsForUids(notesRows.map((r) => r.uid));
  const notesRowsWithInv: AuditRow[] = notesRows.map((r) => ({ ...r, investigations: stateFor(investigations, r.uid) }));
  const triagedIds = auditIds.length
    ? (await rowsOf<{ audit_id: string }>(`SELECT DISTINCT audit_id FROM opd_audit_feedback WHERE scope = 'finding' AND app_source = $1 AND audit_id = ANY($2) AND study IS NOT DISTINCT FROM $3`, [APP, auditIds, null])).map((x) => String(x.audit_id))
    : [];

  const k = kpiR[0] || {};
  const total = n(k.total);
  // S0 — notes in the period whose grading could not be assessed (excluded from everything above).
  const notAssessed = n(notAssessedR[0]?.n ?? 0);
  const meanIndex = n(k.mean_index);
  const band = bandFor(meanIndex);
  const bandCounts: Record<string, number> = {};
  for (const b of bandsR) bandCounts[b.band] = n(b.c);
  const bandTotal = Object.values(bandCounts).reduce((s, x) => s + x, 0) || 1;
  const BANDS = ['A', 'B', 'C', 'D', 'E'];

  // worst two domains (for the summary)
  const domainVals = PILLARS.map((p) => ({ short: p.short, v: n(k[p.col]) })).sort((a, b) => a.v - b.v);
  const worstPhrase = domainVals.slice(0, 2).map((d) => `${d.short} (${d.v})`).join(' and ');
  // volume-aware outliers
  const outliers = docsR.filter((d) => n(d.nnotes) >= 10).sort((a, b) => n(b.low_value) - n(a.low_value)).slice(0, 2);

  // trend sparkline
  const trend = trendR.map((r) => ({ d: r.d, idx: n(r.idx) }));
  const tW = 360, tH = 64;
  const idxs = trend.map((p) => p.idx);
  const lo = Math.min(40, ...idxs, 100), hi = Math.max(85, ...idxs, 0);
  const pts = trend.map((p, i) => {
    const x = trend.length === 1 ? tW : (i / (trend.length - 1)) * tW;
    const y = tH - ((p.idx - lo) / Math.max(1, hi - lo)) * tH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  // ── per-domain drill-down data ──────────────────────────────────────────────
  const catCounts = new Map<string, number>();
  for (const r of allRows) for (const c of r.cats) catCounts.set(c, (catCounts.get(c) || 0) + 1);

  const PDQI_ATTRS = ['up_to_date', 'accurate', 'thorough', 'useful', 'organized', 'comprehensible', 'succinct', 'synthesized', 'internally_consistent'];
  const pdqiAgg: Record<string, { s: number; c: number }> = {};
  for (const r of allR) for (const a of parseJson<{ attr: string; value: number }[]>(r.pdqi9, [])) {
    const key = String(a.attr); if (!pdqiAgg[key]) pdqiAgg[key] = { s: 0, c: 0 };
    pdqiAgg[key].s += Number(a.value) || 0; pdqiAgg[key].c += 1;
  }
  const pdqiMeans = PDQI_ATTRS.map((a) => ({ label: PDQI9_LABEL[a] || a, mean: pdqiAgg[a] ? pdqiAgg[a].s / pdqiAgg[a].c : NaN }))
    .filter((x) => Number.isFinite(x.mean));

  const apprSubj = new Map<string, number>();
  for (const r of allR) for (const f of parseJson<{ subject?: string; verdict?: string; domain?: string }[]>(r.findings, []))
    if (f.domain === 'appropriateness' && (f.verdict === 'low-value' || f.verdict === 'context-dependent')) { const s = (f.subject || '').trim(); if (s) apprSubj.set(s, (apprSubj.get(s) || 0) + 1); }
  const apprDrivers = [...apprSubj.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label, value, pct: Math.round((value / (total || 1)) * 100) }));

  const perDoctor = docsR.map((d) => ({
    name: docName(d.doctor_uid), nnotes: n(d.nnotes),
    scores: { documentation: n(d.d_doc), note_quality: n(d.d_nq), appropriateness: n(d.d_appr), prescribing_safety: n(d.d_presc), patient_centred: n(d.d_pc) } as Record<DomKey, number>,
  }));
  const domTrendCols: Record<DomKey, keyof DomCols> = { documentation: 'd_doc', note_quality: 'd_nq', appropriateness: 'd_appr', prescribing_safety: 'd_presc', patient_centred: 'd_pc' };

  const domainsData: DomainDatum[] = PILLARS.map((p) => {
    const score = n(k[p.col]);
    const trend = trendR.map((t) => ({ d: t.d, v: n(t[domTrendCols[p.key]]) }));
    let drivers: DomainDatum['drivers'];
    if (p.key === 'note_quality') {
      drivers = { kind: 'rating', items: pdqiMeans.slice().sort((a, b) => a.mean - b.mean).map((x) => ({ label: x.label, value: Math.round(x.mean * 10) / 10, pct: Math.round((x.mean / 5) * 100) })) };
    } else if (p.key === 'appropriateness') {
      drivers = { kind: 'count', items: apprDrivers };
    } else if (p.key === 'patient_centred') {
      const items = ([['doc:advice', 'Advice / safety-net not recorded'], ['doc:followup', 'Follow-up missing or no date']] as [string, string][])
        .map(([c, label]) => ({ label, value: catCounts.get(c) || 0, pct: Math.round(((catCounts.get(c) || 0) / (total || 1)) * 100) }))
        .filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
      drivers = { kind: 'count', items };
    } else {
      const items = [...catCounts.entries()].filter(([c]) => c.startsWith(p.catPrefix))
        .map(([c, value]) => ({ label: CAT_LABEL[c] || c, value, pct: Math.round((value / (total || 1)) * 100) }))
        .sort((a, b) => b.value - a.value);
      drivers = { kind: 'count', items };
    }
    const elig = perDoctor.filter((d) => d.nnotes >= 5);
    const sorted = elig.slice().sort((a, b) => b.scores[p.key] - a.scores[p.key]);
    const topDoctors = sorted.slice(0, 3).map((d) => ({ name: d.name, score: d.scores[p.key], n: d.nnotes }));
    const bottomDoctors = sorted.slice(-3).reverse().map((d) => ({ name: d.name, score: d.scores[p.key], n: d.nnotes }));
    let best: { id: string; score: number } | null = null, worst: { id: string; score: number } | null = null;
    for (const r of allR) { const v = n(r[p.scoreCol]); if (best === null || v > best.score) best = { id: String(r.id), score: v }; if (worst === null || v < worst.score) worst = { id: String(r.id), score: v }; }
    let lever: string;
    if (p.key === 'documentation' || p.key === 'prescribing_safety' || p.key === 'patient_centred') {
      const t0 = drivers.items[0];
      if (t0) { const lift = p.key === 'documentation' ? Math.round((t0.value / (total || 1)) * (100 / 7)) : Math.round((t0.value / (total || 1)) * 30); lever = `Fixing "${t0.label}" on the ${t0.value} note(s) affected would lift this domain ~${Math.max(1, lift)} pts.`; }
      else lever = 'No dominant gap — this domain is healthy.';
    } else if (p.key === 'note_quality') {
      const lo0 = drivers.items[0];
      lever = lo0 ? `Lowest PDQI attribute: ${lo0.label} (${lo0.value}/5) — the main drag on note quality.` : 'PDQI not assessed in this window.';
    } else {
      const t0 = drivers.items[0];
      lever = t0 ? `Most common: ${t0.label} (${t0.value} note(s)).` : 'Few appropriateness issues — this domain is healthy.';
    }
    const coverage = p.key === 'note_quality' ? { measured: n(k.pdqi_n), total, basis: 'AI-rated' }
      : p.key === 'appropriateness' ? { measured: total, total, basis: 'AI-judged' }
        : p.key === 'prescribing_safety' ? { measured: total, total, basis: 'rules + AI' }
          : { measured: total, total, basis: 'deterministic' };
    return { key: p.key, label: p.label.replace('\n', ' '), short: p.short, score, weight: p.weight, contribPts: Math.round(score * p.weight), trend, drivers, topDoctors, bottomDoctors, best, worst, lever, coverage };
  });

  const periodLabel = period === 'day' ? fmtIstDateLong(day) : `${fmtIstDateLong(from)} → ${fmtIstDateLong(to)}`;

  return (
    <div>
      {/* header + controls */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-brand">OPD Audit</div>
          <h1 className="font-serif text-[28px] font-semibold leading-tight text-slate-900 sm:text-[31px]">OPD note quality</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] text-slate-500">{periodLabel} · every non-draft medical OPD note, read by Right Care. Advisory — a process &amp; documentation proxy, not a clinician scorecard. <Link href="/admin/opd-audit/doctors" className="text-brand hover:underline">Browse by doctor →</Link> · <Link href="/admin/opd-audit/how-it-works" className="text-brand hover:underline">How the audit works →</Link></p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex overflow-hidden rounded-lg border border-slate-200">
            {(['day', 'week', 'month'] as Period[]).map((p) => (
              <Link key={p} href={`/admin/opd-audit?day=${day}&period=${p}`} className={`px-3 py-1.5 text-xs capitalize ${period === p ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{p}</Link>
            ))}
          </span>
          <span className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600">
            <Link href={`/admin/opd-audit?day=${addDays(day, -1)}&period=${period}`} className="px-1 hover:text-brand">‹</Link>
            <span className="tabular-nums">{day}</span>
            <Link href={`/admin/opd-audit?day=${addDays(day, 1)}&period=${period}`} className="px-1 hover:text-brand">›</Link>
          </span>
          {day !== latestDay && <Link href={`/admin/opd-audit?period=${period}`} className="text-xs text-brand hover:underline">latest</Link>}
          {/* Re-audit button removed 2 Jul 2026 (V) — a one-click ~₹2k LLM burn (tripped the spend-spike alert).
              Re-audits now go through the worker endpoint with CRON_SECRET/admin token, deliberately. */}
          <form method="POST" action="/api/admin/unlock?action=logout"><button className="whitespace-nowrap text-xs text-slate-400 hover:text-brand">Lock</button></form>
        </div>
      </div>

      {total === 0 ? (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No audits for this {period}. The nightly worker audits the prior day overnight (00:30–05:25 IST); pick another date, or backfill with <code className="rounded bg-slate-100 px-1">/api/opd-audit/worker?day={day}</code>.
        </div>
      ) : (
        <>
          {/* HERO — verdict + plain-English summary */}
          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="flex flex-col gap-5 p-5 sm:flex-row">
              <div className="flex shrink-0 flex-row items-center gap-4 border-b border-slate-100 pb-4 sm:w-[132px] sm:flex-col sm:gap-1 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-5">
                <div className="font-serif text-[58px] font-semibold leading-none" style={{ color: bandColor(band) }}>{band}</div>
                <div className="flex flex-col sm:items-center">
                  <div className="text-[13px] text-slate-500"><span className="font-serif text-[18px] font-semibold text-slate-800">{meanIndex}</span> / 100</div>
                  <div className="mt-1 rounded-md px-2 py-0.5 text-[11px] font-semibold text-white" style={{ background: bandColor(band) }}>{meanIndex >= 70 ? 'On track' : meanIndex >= 55 ? 'Watch' : 'Needs attention'}</div>
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-serif text-[16.5px] font-semibold text-slate-900">{period === 'day' ? `How ${fmtIstDateLong(day)} looked` : 'How this period looked'}</h2>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-700">
                  <b>{total} notes</b> audited across <b>{n(k.doctors)}</b> doctors. A <b style={{ color: bandColor(band) }}>Band {band}</b> day (index {meanIndex}): the biggest drags are <b>{worstPhrase}</b>, with <b>{n(k.low_value_rate)}%</b> of notes carrying at least one low-value flag.{' '}
                  {outliers.length > 0 && (
                    <>{outliers.map((o, i) => (
                      <span key={o.doctor_uid}>{i > 0 ? ' and ' : ''}<b>{docName(o.doctor_uid)}</b> ({n(o.low_value)}% low-value, {n(o.nnotes)} notes)</span>
                    ))} {outliers.length > 1 ? 'are' : 'is'} the largest-volume {outliers.length > 1 ? 'outliers' : 'outlier'}.{' '}</>
                  )}
                  {n(k.interactions) > 0 && <><b>{n(k.interactions)}</b> possible drug interactions flagged.</>}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-[10px] text-slate-400">E</span>
                  <div className="relative h-2 flex-1 rounded-full" style={{ background: 'linear-gradient(90deg,#dc2626 0%,#ea580c 28%,#d97706 50%,#16a34a 74%,#0d9488 100%)' }}>
                    <span className="absolute top-[-3px] h-[14px] w-[3px] rounded-sm bg-slate-900 ring-2 ring-white" style={{ left: `${Math.max(0, Math.min(100, meanIndex))}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-400">A</span>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT CARE day tile (§7, top row) */}
          {rightCareDay && (
            <div className="mt-4">
              <RightCareTile data={rightCareDay} />
            </div>
          )}

          {/* DOMAIN PILLARS */}
          <div className="mt-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-slate-400">What's driving the grade · five domains</div>
            <DomainPillars data={domainsData} indexValue={meanIndex} />
            {/* legacy short labels retained: PILLARS used for queries/summary above */}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 px-0.5 text-[12px] text-slate-500">
              <span><b className="font-serif text-[15px] text-slate-800">{total}</b> notes · <b className="font-serif text-[15px] text-slate-800">{n(k.doctors)}</b> doctors</span>
              <span><b className="font-serif text-[15px]" style={{ color: '#b45309' }}>{n(k.low_value_rate)}%</b> ≥1 low-value flag</span>
              <span><b className="font-serif text-[15px]" style={{ color: '#b91c1c' }}>{n(k.interactions)}</b> interaction alerts</span>
              <span><b className="font-serif text-[15px] text-slate-800">{n(k.pct_good)}%</b> graded A/B</span>
              {/* S0 — a COUNT, never a score. Amber when non-zero so a human notices it moving. */}
              <span title="Notes whose grading model could not assess them at this engine version. Excluded from every number and list on this page; visible here so the failure rate is never invisible.">
                <b className="font-serif text-[15px]" style={{ color: notAssessed > 0 ? '#b45309' : '#94a3b8' }}>{notAssessed}</b> not assessed
              </span>
              <span className="ml-auto flex items-center gap-1 text-[10px] text-slate-400">
                {BANDS.map((b) => <span key={b} className="rounded px-1.5 py-0.5 font-semibold text-white" style={{ background: bandColor(b) }}>{b}</span>)}
                <span className="ml-1">excellent → poor</span>
              </span>
            </div>
          </div>

          {/* TOP ISSUES + browse */}
          <div className="mt-5">
            {drillActive && (
              <div className="mb-3 flex flex-wrap items-center gap-x-1 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
                <span>{`Notes with "${drillSubject}" · ${drillSignal} · ${drillDept} · last 90 days — ×${drill?.findings ?? 0} findings across ${drill?.notes ?? 0} notes${drill?.capped ? ', showing newest 600' : ''} · `}</span>
                <Link href="/admin/opd-audit" className="text-sky-700 hover:underline">clear</Link>
              </div>
            )}
            <NotesExplorer rows={notesRowsWithInv} initialDoctorUid={drillActive ? undefined : initialDoctorUid} triagedIds={triagedIds} investigationsUnavailable={investigations.unavailable} />
          </div>

          {/* trend + band distribution */}
          <div className="mt-4 flex flex-wrap gap-3">
            <div className="min-w-[260px] flex-[1.4] rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-slate-400">Quality index · last 14 days</div>
              <svg viewBox={`0 0 ${tW} ${tH}`} width="100%" height={tH} preserveAspectRatio="none">
                {pts && <polyline points={pts} fill="none" stroke="#0f766e" strokeWidth="2.5" />}
                {trend.map((p, i) => {
                  const x = trend.length === 1 ? tW : (i / (trend.length - 1)) * tW;
                  const y = tH - ((p.idx - lo) / Math.max(1, hi - lo)) * tH;
                  return <circle key={i} cx={x} cy={y} r="2" fill="#0f766e" />;
                })}
              </svg>
              <div className="text-[10.5px] text-slate-400">{trend.length > 1 ? `${trend[0].idx} → ${trend[trend.length - 1].idx} over ${trend.length} days` : 'building history — more days needed'}</div>
            </div>
            <div className="min-w-[220px] flex-1 rounded-xl border border-slate-200 bg-white p-4">
              <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-slate-400">Band distribution</div>
              <div className="flex h-5 overflow-hidden rounded-md">
                {BANDS.map((b) => bandCounts[b] ? <span key={b} title={`${b} ${bandCounts[b]}`} style={{ width: `${(bandCounts[b] / bandTotal) * 100}%`, background: bandColor(b) }} /> : null)}
              </div>
              <div className="mt-1.5 flex justify-between text-[10px] text-slate-400">
                {BANDS.map((b) => <span key={b}>{b} {Math.round(((bandCounts[b] || 0) / bandTotal) * 100)}%</span>)}
              </div>
            </div>
          </div>

          {/* by doctor + needs review */}
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="flex items-baseline justify-between border-b border-slate-100 px-4 py-2.5">
                <span className="font-serif text-[14px] font-semibold text-slate-900">By doctor</span>
                <span className="text-[11px] text-slate-400">{docsR.length} · highest volume first</span>
              </div>
              <div className="max-h-[340px] overflow-y-auto">
                <table className="w-full text-[11.5px]">
                  <thead className="sticky top-0 bg-white text-[10px] text-slate-400"><tr><th className="px-4 py-1.5 text-left font-normal">doctor</th><th className="px-2 py-1.5 text-right font-normal">notes</th><th className="px-2 py-1.5 text-right font-normal">index</th><th className="px-4 py-1.5 text-left font-normal">low-value</th></tr></thead>
                  <tbody>
                    {docsR.map((d) => {
                      const lv = n(d.low_value), vol = n(d.nnotes);
                      const outlier = vol >= 10 && lv >= 85;
                      return (
                        <tr key={d.doctor_uid} className="border-t border-slate-50">
                          <td className="px-4 py-1.5 text-slate-700">
                            <Link href={`/admin/opd-audit?day=${day}&period=${period}&doctor=${d.doctor_uid}#notes`} className="hover:text-brand hover:underline" title="Filter this day's notes to this doctor">{docName(d.doctor_uid)}</Link>
                            {outlier && <span className="ml-1.5 rounded bg-red-50 px-1 py-0.5 text-[9px] font-semibold text-red-700">outlier</span>}
                            <Link href={`/admin/opd-audit/doctor/${d.doctor_uid}`} className="ml-1.5 text-[10px] text-slate-400 hover:text-brand" title="All audits for this doctor">history →</Link>
                          </td>
                          <td className="px-2 py-1.5 text-right text-slate-500">{vol}</td>
                          <td className="px-2 py-1.5 text-right font-medium" style={{ color: scoreColor(n(d.idx)) }}>{n(d.idx)}</td>
                          <td className="px-4 py-1.5">
                            <div className="flex items-center gap-2"><span className="h-[5px] flex-1 rounded bg-slate-100"><span className="block h-full rounded" style={{ width: `${lv}%`, background: lv >= 70 ? '#dc2626' : '#d97706' }} /></span><span className="w-8 text-right text-[11px] text-slate-500">{lv}%</span></div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-amber-100 bg-amber-50/60 px-4 py-2.5"><span className="font-serif text-[14px] font-semibold text-amber-800">Needs review — lowest {period === 'day' ? 'today' : 'this ' + period}</span></div>
              <div>
                {reviewR.map((r) => (
                  <div key={r.id} className="flex items-center gap-1.5 border-b border-slate-50 px-4 py-2 text-[11.5px] hover:bg-slate-50">
                    <span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-white" style={{ background: bandColor(r.displayed_band ?? r.band) }}>{r.displayed_band ?? r.band}</span>
                    <Link href={`/admin/opd-audit/${r.id}`} className="whitespace-nowrap text-slate-500 hover:text-brand">{fmtIstTime(r.note_date)}</Link>
                    <span className="text-slate-300">·</span>
                    {r.doctor_uid
                      ? <Link href={`/admin/opd-audit?day=${day}&period=${period}&doctor=${r.doctor_uid}#notes`} className="whitespace-nowrap text-slate-700 hover:text-brand hover:underline" title="Filter this day's notes to this doctor">{docName(r.doctor_uid)}</Link>
                      : <span className="whitespace-nowrap text-slate-700">{docName(r.doctor_uid)}</span>}
                    <Link href={`/admin/opd-audit/${r.id}`} className="flex-1 truncate text-slate-600 hover:text-brand">· {issueFrom(r.findings, n(r.completeness_pct))}</Link>
                    <span className="text-slate-300">›</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
