/**
 * lib/ccb-funnel.ts — CCB conversion funnel (P2.4): write-off vs internalize.
 *
 * A flagged candidate = a brief whose commercial layer opened (pitch_allowed) — i.e. the clinical
 * engine found a corpus-cited surgical/specialist indication. We then ask, per candidate, whether
 * the member converted to Even IP within `windowDays`:
 *   • EHRC IP admission   — db13 `kx_billing_records` (patient_type='IP') by `uhid`
 *   • Even surgery case   — db13 `surgery_cases` (status<>CANCELLED) by `individual_uid`
 * (prescription_uid is empty on surgery_cases, so attribution is member-level + time-window.)
 *
 * Cross-DB: candidates live in Neon (ccb_briefs); outcomes in db13 (Metabase). We pull both and
 * join in memory. Data-gated by design — most recent candidates' 90-day windows are still OPEN, so
 * they're 'pending'; written-off only counts once a window has fully elapsed with no conversion.
 */

import { sql } from './db';
import { metabaseQuery, istToday } from './metabase';
import { CCB_ENGINE_VERSION } from './ccb-brief-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const isUhid = (u: string) => /^[A-Za-z0-9/_-]{3,40}$/.test(u);
const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);

function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}

export type FunnelState = 'internalized' | 'written_off' | 'pending';
export interface FunnelCandidate {
  prescUid: string; uhid: string | null; individualUid: string;
  noteDate: string | null; priority: string | null; speciality: string | null;
  state: FunnelState; via: 'ehrc_ip' | 'surgery_case' | null;
}
export interface FunnelGroup { speciality: string; flagged: number; internalized: number; written_off: number; pending: number; conversion_pct: number | null }
export interface FunnelResult {
  windowDays: number;
  totals: { flagged: number; internalized: number; written_off: number; pending: number; conversion_pct: number | null };
  bySpeciality: FunnelGroup[];
  candidates: FunnelCandidate[];
}

function convPct(internalized: number, writtenOff: number): number | null {
  const denom = internalized + writtenOff;     // elapsed-window denominator (exclude still-open)
  return denom > 0 ? Math.round((internalized / denom) * 100) : null;
}

export async function computeFunnel(windowDays = 90): Promise<FunnelResult> {
  // 1. Flagged candidates from Neon.
  const rows = await run(
    `SELECT presc_uid, uhid, individual_uid,
            to_char(note_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS note_date,
            priority, doctor_speciality
     FROM ccb_briefs
     WHERE pitch_allowed = true AND engine_version = $1
     ORDER BY note_date DESC NULLS LAST LIMIT 2000`,
    [CCB_ENGINE_VERSION],
  ).catch(() => [] as Record<string, unknown>[]);

  const cands = rows.map((r) => ({
    prescUid: String(r.presc_uid),
    uhid: r.uhid ? String(r.uhid) : null,
    individualUid: String(r.individual_uid),
    noteDate: r.note_date ? String(r.note_date) : null,
    priority: r.priority ? String(r.priority) : null,
    speciality: r.doctor_speciality ? String(r.doctor_speciality) : null,
  }));

  const uhids = Array.from(new Set(cands.map((c) => c.uhid).filter((u): u is string => !!u && isUhid(u))));
  const iuids = Array.from(new Set(cands.map((c) => c.individualUid).filter((u) => isUid(u))));

  // 2. Outcomes from db13.
  const ipByUhid = new Map<string, string[]>();
  if (uhids.length) {
    const inList = uhids.map((u) => `'${u}'`).join(', ');
    const ip = await metabaseQuery(
      `SELECT DISTINCT uhid, admission_date_time::text AS adm FROM kx_billing_records
       WHERE patient_type='IP' AND uhid IN (${inList}) AND admission_date_time IS NOT NULL`,
    ).catch(() => [] as Record<string, unknown>[]);
    for (const r of ip) { const u = String(r.uhid); const d = String(r.adm).slice(0, 10); if (!ipByUhid.has(u)) ipByUhid.set(u, []); ipByUhid.get(u)!.push(d); }
  }
  const surgByIuid = new Map<string, string[]>();
  if (iuids.length) {
    const inList = iuids.map((u) => `'${u}'`).join(', ');
    const sc = await metabaseQuery(
      `SELECT individual_uid, _create_time::text AS dt FROM surgery_cases
       WHERE individual_uid IN (${inList}) AND status <> 'CANCELLED'`,
    ).catch(() => [] as Record<string, unknown>[]);
    for (const r of sc) { const u = String(r.individual_uid); const d = String(r.dt).slice(0, 10); if (!surgByIuid.has(u)) surgByIuid.set(u, []); surgByIuid.get(u)!.push(d); }
  }

  // 3. Per-candidate state.
  const today = istToday();
  const candidates: FunnelCandidate[] = cands.map((c) => {
    const within = (dates?: string[]) => !!c.noteDate && (dates || []).some((d) => d >= c.noteDate! && d <= addDays(c.noteDate!, windowDays));
    const ip = c.uhid ? within(ipByUhid.get(c.uhid)) : false;
    const surg = within(surgByIuid.get(c.individualUid));
    const internalized = ip || surg;
    const windowOpen = c.noteDate ? addDays(c.noteDate, windowDays) >= today : true;
    const state: FunnelState = internalized ? 'internalized' : (windowOpen ? 'pending' : 'written_off');
    return { ...c, state, via: ip ? 'ehrc_ip' : surg ? 'surgery_case' : null };
  });

  // 4. Aggregate.
  const count = (st: FunnelState, list = candidates) => list.filter((c) => c.state === st).length;
  const totals = {
    flagged: candidates.length,
    internalized: count('internalized'), written_off: count('written_off'), pending: count('pending'),
    conversion_pct: convPct(count('internalized'), count('written_off')),
  };

  const bySpec = new Map<string, FunnelCandidate[]>();
  for (const c of candidates) { const k = c.speciality || '(unknown)'; if (!bySpec.has(k)) bySpec.set(k, []); bySpec.get(k)!.push(c); }
  const bySpeciality: FunnelGroup[] = [...bySpec.entries()].map(([speciality, list]) => ({
    speciality, flagged: list.length,
    internalized: count('internalized', list), written_off: count('written_off', list), pending: count('pending', list),
    conversion_pct: convPct(count('internalized', list), count('written_off', list)),
  })).sort((a, b) => b.flagged - a.flagged);

  return { windowDays, totals, bySpeciality, candidates };
}
