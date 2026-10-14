/**
 * GET /api/governance/opd-signals — daily governance signals (API-first).
 *
 * v1.0: PDQI-9 attribute signals. v1.1: ?speciality= / ?groupBy=speciality.
 * v1.1b: DOMAIN signals (documentation completeness, prescribing safety, interaction
 * alerts) merged into `report.signals` with `kind: 'domain'` (PDQI signals unmarked);
 * low-value HELD behind ?includeEstimates=1 (ships as confidence:'estimate' until LL.3).
 * generator bumped 0.1 → 0.2 (the default response now contains domain signals).
 *
 * The consumer view lives in the governance app (EPI / governance.evenos.app).
 * Contract: CDMSS-GOVERNANCE-SIGNALS-API-v1.1.md (+ v1.1b addendum).
 *
 * Auth (any one): admin session cookie · Bearer/?token=ADMIN_TOKEN · x-api-key GOV_API_KEY.
 */
import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { requireAdmin } from '@/lib/admin-gate';
import { fetchDoctorNames } from '@/lib/metabase';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import { istDateRange, parseJson, type Period } from '@/lib/opd-audit-ui';
import {
  computeGovernanceSignals, computeDomainSignals, PDQI9_GOV_ORDER, DOMAIN_GOV,
  type GovDoctorStat, type GovDomainDoctorStat, type GovDomainKey,
} from '@/lib/opd-governance-core';

export const dynamic = 'force-dynamic';

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

function govKeyValid(req: NextRequest): boolean {
  const key = process.env.GOV_API_KEY;
  if (!key) return false;
  const hdr = req.headers.get('x-api-key') || '';
  const auth = req.headers.get('authorization') || '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const presented = hdr || bearer;
  if (!presented) return false;
  const a = Buffer.from(presented); const b = Buffer.from(key);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}

type Pdqi = { attr: string; value: number };
type NoteRow = {
  doctor_uid: unknown; pdqi9: unknown;
  completeness_pct: unknown; score_prescribing_safety: unknown; n_interaction_alerts: unknown; n_low_value: unknown;
};
const num = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const normSpec = (s: string) => s.trim().toLowerCase();
const NOTE_COLS = 'doctor_uid, pdqi9, completeness_pct, score_prescribing_safety, n_interaction_alerts, n_low_value';

/** PDQI aggregation: hospital per-attr stats + per-doctor per-attr stats. */
function aggregate(rows: NoteRow[]) {
  const agg: Record<string, { s: number; c: number }> = {};
  const perDoc = new Map<string, Record<string, { s: number; c: number }>>();
  let assessed = 0;
  for (const row of rows) {
    const pd = parseJson<Pdqi[]>(row.pdqi9, []);
    if (pd.length === 0) continue;
    assessed += 1;
    const uid = row.doctor_uid ? String(row.doctor_uid) : '';
    const docAgg = uid ? (perDoc.get(uid) || {}) : null;
    for (const a of pd) {
      const k = String(a.attr); const v = Number(a.value) || 0;
      (agg[k] ||= { s: 0, c: 0 }); agg[k].s += v; agg[k].c += 1;
      if (docAgg) { (docAgg[k] ||= { s: 0, c: 0 }); docAgg[k].s += v; docAgg[k].c += 1; }
    }
    if (docAgg && uid) perDoc.set(uid, docAgg);
  }
  const current = PDQI9_GOV_ORDER
    .filter((attr) => agg[attr]?.c > 0)
    .map((attr) => ({ attr, mean: agg[attr].s / agg[attr].c, n: agg[attr].c }));
  return { current, perDoc, assessed };
}

function priorMeans(rows: NoteRow[]): Record<string, number> {
  const pAgg: Record<string, { s: number; c: number }> = {};
  for (const row of rows) {
    for (const a of parseJson<Pdqi[]>(row.pdqi9, [])) {
      const k = String(a.attr); const v = Number(a.value) || 0;
      (pAgg[k] ||= { s: 0, c: 0 }); pAgg[k].s += v; pAgg[k].c += 1;
    }
  }
  const out: Record<string, number> = {};
  for (const k of Object.keys(pAgg)) if (pAgg[k].c > 0) out[k] = pAgg[k].s / pAgg[k].c;
  return out;
}

function toDoctorStats(perDoc: Map<string, Record<string, { s: number; c: number }>>, names: Record<string, string>): GovDoctorStat[] {
  return [...perDoc.entries()].map(([uid, attrs]) => ({
    uid, name: names[uid] || undefined,
    attrs: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { mean: v.s / v.c, n: v.c }])),
  }));
}

/** Domain aggregation over ALL audited notes (not just PDQI-assessed). */
function domainValues(rows: NoteRow[]): { key: GovDomainKey; value: number; n: number }[] {
  if (rows.length === 0) return [];
  let compS = 0, compC = 0, rxS = 0, rxC = 0, intSum = 0, lowC = 0;
  for (const r of rows) {
    const c = num(r.completeness_pct); if (c != null) { compS += c; compC += 1; }
    const rx = num(r.score_prescribing_safety); if (rx != null) { rxS += rx; rxC += 1; }
    intSum += num(r.n_interaction_alerts) ?? 0;
    if ((num(r.n_low_value) ?? 0) > 0) lowC += 1;
  }
  const out: { key: GovDomainKey; value: number; n: number }[] = [];
  if (compC > 0) out.push({ key: 'documentation_completeness', value: compS / compC, n: compC });
  if (rxC > 0) out.push({ key: 'prescribing_safety', value: rxS / rxC, n: rxC });
  out.push({ key: 'interaction_alerts', value: (intSum / rows.length) * 100, n: rows.length });
  out.push({ key: 'low_value_rate', value: (lowC / rows.length) * 100, n: rows.length });
  return out;
}

function domainDoctorStats(rows: NoteRow[], names: Record<string, string>): GovDomainDoctorStat[] {
  const byDoc = new Map<string, NoteRow[]>();
  for (const r of rows) {
    const uid = r.doctor_uid ? String(r.doctor_uid) : '';
    if (!uid) continue;
    (byDoc.get(uid) || byDoc.set(uid, []).get(uid)!).push(r);
  }
  return [...byDoc.entries()].map(([uid, docRows]) => {
    const values: GovDomainDoctorStat['values'] = {};
    for (const d of domainValues(docRows)) values[d.key] = { value: d.value, n: docRows.length };
    return { uid, name: names[uid] || undefined, values };
  });
}

export async function GET(req: NextRequest) {
  if (!govKeyValid(req) && !(await isAdminUnlocked())) {
    const denied = requireAdmin(req);
    if (denied) return denied;
  }

  const sp = req.nextUrl.searchParams;
  const period: Period = sp.get('period') === 'week' ? 'week' : sp.get('period') === 'month' ? 'month' : 'day';
  const baselineDays = Math.max(1, Math.min(90, Number(sp.get('baselineDays')) || 14));
  const specialityParam = (sp.get('speciality') || '').trim();
  const groupBy = sp.get('groupBy') === 'speciality' && !specialityParam;
  const includeEstimates = sp.get('includeEstimates') === '1';

  const WIN = `app_source = $1 AND engine_version = '${OPD_ENGINE_VERSION}' AND excluded_reason IS NULL AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3`;

  let day = sp.get('day') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const latest = await run(
      `SELECT to_char(max((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') d FROM opd_note_audits WHERE app_source = $1 AND engine_version = '${OPD_ENGINE_VERSION}' AND excluded_reason IS NULL`,
      [APP]).catch(() => []);
    day = String(latest[0]?.d || new Date().toISOString().slice(0, 10));
  }
  const { from, to } = istDateRange(day, period);
  const baseTo = addDays(from, -1);
  const baseFrom = addDays(baseTo, -(baselineDays - 1));
  const winParams = [APP, from, to];

  const needDir = !!specialityParam || groupBy;
  // Placeholder histograms are computed SQL-side (findings/missing_fields never leave the DB in bulk).
  const topOf = (rows: Record<string, unknown>[]): string | undefined => (rows[0]?.s ? String(rows[0].s) : undefined);
  const [curR, priorR, dirR, gapDocR, gapRxR, pairsR, patternR] = await Promise.all([
    run(`SELECT ${NOTE_COLS} FROM opd_note_audits WHERE ${WIN} LIMIT 5000`, winParams).catch(() => []) as Promise<NoteRow[]>,
    run(`SELECT ${NOTE_COLS} FROM opd_note_audits WHERE ${WIN} LIMIT 10000`, [APP, baseFrom, baseTo]).catch(() => []) as Promise<NoteRow[]>,
    needDir ? run(`SELECT doctor_uid, speciality FROM doctor_directory WHERE speciality IS NOT NULL`, []).catch(() => []) : Promise.resolve([]),
    run(`SELECT x s, count(*) c FROM opd_note_audits, LATERAL jsonb_array_elements_text(missing_fields) x WHERE ${WIN} GROUP BY 1 ORDER BY c DESC LIMIT 1`, winParams).catch(() => []),
    run(`SELECT split_part(f->>'subject', ':', 1) s, count(*) c FROM opd_note_audits, LATERAL jsonb_array_elements(findings) f WHERE ${WIN} AND f->>'domain' = 'prescribing_safety' GROUP BY 1 ORDER BY c DESC LIMIT 1`, winParams).catch(() => []),
    run(`SELECT split_part(f->>'subject', ': ', 2) s, count(*) c FROM opd_note_audits, LATERAL jsonb_array_elements(findings) f WHERE ${WIN} AND f->>'subject' LIKE 'Interaction%' GROUP BY 1 ORDER BY c DESC LIMIT 1`, winParams).catch(() => []),
    includeEstimates
      ? run(`SELECT f->>'subject' s, count(*) c FROM opd_note_audits, LATERAL jsonb_array_elements(findings) f WHERE ${WIN} AND f->>'verdict' = 'low-value' GROUP BY 1 ORDER BY c DESC LIMIT 1`, winParams).catch(() => [])
      : Promise.resolve([]),
  ]);

  const specOf = new Map<string, string>();
  for (const r of dirR) specOf.set(String(r.doctor_uid), String(r.speciality));

  let curRows = curR, priorRows = priorR;
  if (specialityParam) {
    const want = normSpec(specialityParam);
    const keep = (r: NoteRow) => normSpec(specOf.get(String(r.doctor_uid || '')) || '') === want;
    curRows = curR.filter(keep);
    priorRows = priorR.filter(keep);
  }

  // ── PDQI signals ──────────────────────────────────────────────────────────────
  const { current, perDoc, assessed } = aggregate(curRows);
  const names = await fetchDoctorNames([...new Set(curRows.map((r) => String(r.doctor_uid || '')).filter(Boolean))]).catch(() => ({} as Record<string, string>));
  const pdqiReport = computeGovernanceSignals({ current, prior: priorMeans(priorRows), doctors: toDoctorStats(perDoc, names) });

  // ── Domain signals (v1.1b) — same rows, direction-aware metrics ───────────────
  // NOTE: when ?speciality= is set, the SQL placeholder histograms are hospital-wide
  // (the numeric signals are dept-scoped); dept-scoped histograms are a later refinement.
  const priorDomains: Partial<Record<GovDomainKey, number>> = {};
  for (const d of domainValues(priorRows)) priorDomains[d.key] = d.value;
  const domainReport = computeDomainSignals({
    domains: domainValues(curRows),
    prior: priorDomains,
    doctors: domainDoctorStats(curRows, names),
    placeholders: {
      top_gap_documentation: topOf(gapDocR),
      top_gap_prescribing: topOf(gapRxR),
      top_pairs: topOf(pairsR),
      top_pattern: topOf(patternR),
    },
    includeHeld: includeEstimates,
  });

  // Merge: act_now first, watch after; stable (PDQI before domain within a severity).
  const signals = [...pdqiReport.signals, ...domainReport.signals]
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'act_now' ? -1 : 1));

  // ── optional per-speciality mini-reports (PDQI-only, compact) ─────────────────
  let bySpeciality: unknown = undefined;
  if (groupBy) {
    const curBy = new Map<string, NoteRow[]>(); const priorBy = new Map<string, NoteRow[]>();
    const bucket = (m: Map<string, NoteRow[]>, r: NoteRow) => {
      const k = specOf.get(String(r.doctor_uid || '')) || 'Unattributed';
      (m.get(k) || m.set(k, []).get(k)!).push(r);
    };
    for (const r of curR) bucket(curBy, r);
    for (const r of priorR) bucket(priorBy, r);
    bySpeciality = [...curBy.entries()].map(([spec, rows]) => {
      const a = aggregate(rows);
      const rep = computeGovernanceSignals({
        current: a.current, prior: priorMeans(priorBy.get(spec) || []), doctors: toDoctorStats(a.perDoc, {}),
      });
      return {
        speciality: spec,
        notes_assessed: a.assessed,
        doctors_seen: a.perDoc.size,
        signals: rep.signals.map((s) => ({ attr: s.attr, label: s.label, mean: s.mean, n: s.n, severity: s.severity, trend: s.trend, delta: s.delta, scope: s.scope })),
        healthy: rep.healthy,
      };
    }).sort((x, y) => y.notes_assessed - x.notes_assessed);
  }

  return NextResponse.json({
    ok: true,
    generator: 'opd-governance/0.2',
    engine: OPD_ENGINE_VERSION,
    day, period,
    window: { from, to },
    baseline: { from: baseFrom, to: baseTo, days: baselineDays },
    ...(specialityParam ? { speciality: specialityParam } : {}),
    notes_total: curRows.length,
    notes_assessed: assessed,
    doctors_seen: new Set(curRows.map((r) => String(r.doctor_uid || '')).filter(Boolean)).size,
    report: {
      signals,
      healthy: pdqiReport.healthy,
      domain_healthy: domainReport.healthy,
      thresholds: pdqiReport.thresholds,
      domain_thresholds: Object.fromEntries(Object.entries(DOMAIN_GOV).map(([k, m]) => [k, {
        unit: m.unit, direction: m.direction, signalAt: m.signalAt, actNowAt: m.actNowAt,
        trendDelta: m.trendDelta, doctorAffectedAt: m.doctorAffectedAt, ...(m.held ? { held: true } : {}),
      }])),
    },
    ...(bySpeciality !== undefined ? { by_speciality: bySpeciality } : {}),
    advisory: 'Advisory process & documentation signals for clinical governance — not a clinician performance score. Concentrated signals name doctors for supportive, non-punitive follow-up.',
  });
}
