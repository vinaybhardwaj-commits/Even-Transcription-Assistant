/**
 * lib/opd-gov-read.ts — audit-side reads for the governance signal feed (Neon).
 *
 * A governance thread stores the (doctor, signal_type, window, note_class) key; the finding
 * INSTANCES are resolved at read time from the store for THAT class (so the thread never
 * duplicates finding text, and an OPD note is never attached to a discharge or OT thread):
 *   opd                → opd_note_audits
 *   discharge_summary  → ipd_discharge_audits, attributed by the treating-doctor hop
 *   ot                 → ot_note_audits, attributed only when map_status is mapped
 * Audit METRICS stay on the OPD canonical read. Re-stamps finding identity on read → legacy rows covered.
 */

import { sql } from './db';
import { OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT, stampFindingIdentity, type OpdFinding } from './opd-note-audit-core';
import { canonicalDistinctOnSql } from './audit-canonical';
import { parseJson } from './opd-audit-ui';
import type { Source } from './citations-core';
import type { SignalRepresentative } from './opd-gov-signal-core';
import { fetchIpdDoctorHop } from './ipd-doctor-hop';
import { landDischargeAudits, type DischargeAuditSource } from './triage/ds-lander';
import { landOtAudits } from './triage/ot-lander';
import { OT_ENGINE_VERSION } from './triage/ot-audit-core';

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

function emptyInstances(): { count: number; representative: SignalRepresentative | null; instances: Instance[] } {
  return { count: 0, representative: null, instances: [] };
}

interface LandedInstance {
  audit_id: string;
  doctor_uid: string;
  note_date: string;
  subject: string;
  verdict: string;
  rationale: string;
  signal_type: string;
  finding_ref: string;
  citation_ids?: number[];
  informational?: boolean;
}

/**
 * Keep findings that belong to this doctor, signal, and window. Newest note first; within a note,
 * lander order. A missing window bound is open on that side. Both bounds absent matches every
 * dated finding — callers that must not scan an unbounded corpus return before this.
 */
export function selectSignalInstances(
  findings: readonly LandedInstance[],
  doctorUid: string,
  signalType: string,
  windowFrom: string | null,
  windowTo: string | null,
): { count: number; representative: SignalRepresentative | null; instances: Instance[] } {
  const uid = doctorUid.trim();
  const from = windowFrom ? windowFrom.slice(0, 10) : '';
  const to = windowTo ? windowTo.slice(0, 10) : '';
  const ranked = (findings ?? []).filter((f) => {
    if (!f || f.informational) return false;
    if (f.doctor_uid !== uid || f.signal_type !== signalType) return false;
    const day = String(f.note_date || '').slice(0, 10);
    if (!day) return false;
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  }).slice().sort((a, b) => String(b.note_date).slice(0, 10).localeCompare(String(a.note_date).slice(0, 10)));
  const instances: Instance[] = ranked.map((f) => {
    const ids = Array.isArray(f.citation_ids) ? f.citation_ids : [];
    return {
      audit_id: f.audit_id,
      finding_ref: f.finding_ref,
      subject: f.subject,
      verdict: f.verdict,
      rationale: f.rationale,
      note_date: String(f.note_date).slice(0, 10),
      citations: ids.map((n) => ({ n, title: `Source ${n}`, url: '' })),
    };
  });
  return { count: instances.length, representative: instances[0] ?? null, instances };
}

function classWindowOpen(windowFrom: string | null, windowTo: string | null): boolean {
  return !!(windowFrom || windowTo);
}

/**
 * Discharge instances for one doctor × signal_type × window.
 * `ipd_discharge_audits` has no doctor_uid. Attribution is the read-time treating-doctor hop
 * (fail closed): an unresolved, ambiguous, or unavailable stay is not counted.
 * Does not read opd_note_audits.
 */
export async function resolveDischargeInstances(
  doctorUid: string, signalType: string, windowFrom: string | null, windowTo: string | null,
): Promise<{ count: number; representative: SignalRepresentative | null; instances: Instance[] }> {
  if (!doctorUid.trim() || !signalType.trim() || !classWindowOpen(windowFrom, windowTo)) return emptyInstances();
  const params: unknown[] = [APP];
  let where = `app_source = $1 AND engine_version LIKE 'ipd-discharge-audit/%' AND engine_version NOT LIKE '%-mini'
    AND discharged_at IS NOT NULL`;
  if (windowFrom) {
    params.push(windowFrom.slice(0, 10));
    where += ` AND (discharged_at AT TIME ZONE 'Asia/Kolkata')::date >= $${params.length}::date`;
  }
  if (windowTo) {
    params.push(windowTo.slice(0, 10));
    where += ` AND (discharged_at AT TIME ZONE 'Asia/Kolkata')::date <= $${params.length}::date`;
  }
  const rows = await run(
    `SELECT id, ip_uid, speciality, note_date, findings
     FROM (${canonicalDistinctOnSql({
       table: 'ipd_discharge_audits',
       identity: 'document_id',
       cols: `id::text AS id, ip_uid, speciality,
              to_char((discharged_at AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS note_date,
              findings`,
       where,
     })}) canonical
     LIMIT 8000`,
    params,
  ).catch(() => []);
  const sources: DischargeAuditSource[] = (rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    ip_uid: r.ip_uid == null ? null : String(r.ip_uid),
    speciality: r.speciality == null ? null : String(r.speciality),
    note_date: String(r.note_date || ''),
    findings: r.findings,
  }));
  if (!sources.length) return emptyInstances();
  let hop: Awaited<ReturnType<typeof fetchIpdDoctorHop>>;
  try {
    hop = await fetchIpdDoctorHop(sources.map((s) => s.ip_uid || ''));
  } catch {
    hop = {
      byIpUid: {},
      coverage: { asked: sources.length, known: 0, resolved: 0, ambiguousPractitioner: 0, ambiguousStay: 0, unmatched: 0, noTreatingId: 0, unavailable: true },
      ambiguousIds: [],
    };
  }
  const landed = landDischargeAudits(sources, hop);
  return selectSignalInstances(landed.findings, doctorUid, signalType, windowFrom, windowTo);
}

/**
 * OT instances for one doctor × signal_type × window.
 * Only mapped surgeon-map rows (`ot_note_audits.map_status = 'mapped'` with a doctor_uid).
 * Does not read opd_note_audits and does not use the treating-doctor hop.
 */
export async function resolveOtInstances(
  doctorUid: string, signalType: string, windowFrom: string | null, windowTo: string | null,
): Promise<{ count: number; representative: SignalRepresentative | null; instances: Instance[] }> {
  if (!doctorUid.trim() || !signalType.trim() || !classWindowOpen(windowFrom, windowTo)) return emptyInstances();
  const params: unknown[] = [APP, OT_ENGINE_VERSION, doctorUid];
  let where = `app_source = $1 AND engine_version = $2 AND doctor_uid = $3 AND map_status = 'mapped'`;
  if (windowFrom) {
    params.push(windowFrom.slice(0, 10));
    where += ` AND note_day >= $${params.length}::date`;
  }
  if (windowTo) {
    params.push(windowTo.slice(0, 10));
    where += ` AND note_day <= $${params.length}::date`;
  }
  const rows = await run(
    `SELECT id, doctor_uid, map_status, note_day, findings
     FROM (${canonicalDistinctOnSql({
       table: 'ot_note_audits',
       identity: 'uid',
       cols: `id::text AS id, doctor_uid, map_status, to_char(note_day,'YYYY-MM-DD') AS note_day, findings`,
       where,
     })}) canonical
     LIMIT 8000`,
    params,
  ).catch(() => []);
  const landed = landOtAudits((rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    doctor_uid: r.doctor_uid == null ? null : String(r.doctor_uid),
    map_status: r.map_status == null ? 'unmapped' : String(r.map_status),
    note_day: String(r.note_day || ''),
    findings: r.findings,
  })));
  return selectSignalInstances(landed.findings, doctorUid, signalType, windowFrom, windowTo);
}

/**
 * Non-OPD fan-in. OPD stays on `resolveInstances` so a discharge or OT thread cannot receive
 * OPD finding text. An unknown class stays at zero rather than falling through to OPD.
 */
export async function resolveInstancesForNoteClass(
  noteClass: string | null | undefined,
  doctorUid: string, signalType: string, windowFrom: string | null, windowTo: string | null,
): Promise<{ count: number; representative: SignalRepresentative | null; instances: Instance[] }> {
  if (noteClass === 'discharge_summary') return resolveDischargeInstances(doctorUid, signalType, windowFrom, windowTo);
  if (noteClass === 'ot') return resolveOtInstances(doctorUid, signalType, windowFrom, windowTo);
  return emptyInstances();
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
