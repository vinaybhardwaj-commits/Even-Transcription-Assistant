/**
 * lib/triage/ot-admin-present.ts — pure presentation for the CAT admin OT Audit browser.
 *
 * Reads already-persisted NABH fields. Does not score. Surgeon hop is fail-closed:
 * a Pulse name is shown only when map_status is mapped AND doctor_uid is set.
 */

export type OtAdminMapStatus = 'mapped' | 'unmapped' | 'multi_surgeon_hold';
export type OtAdminScoreBand = 'ge80' | 'mid' | 'lt60';

export interface OtAdminListRow {
  id: string;
  uid: string;
  hospital_uid: string | null;
  uhid: string | null;
  surgery_name: string | null;
  surgeon_raw: string | null;
  note_day: string;
  doctor_uid: string | null;
  map_status: string;
  n_findings: number;
  engine_version: string;
  nabh_score_pct: number | null;
  nabh_engine_version: string | null;
}

export interface OtAdminFilters {
  map?: string;
  site?: string;
  surgeon?: string;
  band?: string;
}

export interface PulseSurgeonLabel {
  status: OtAdminMapStatus;
  /** Pulse display name. Null unless the curated hop is mapped. Never invented. */
  pulseName: string | null;
}

const MAPS = new Set<OtAdminMapStatus>(['mapped', 'unmapped', 'multi_surgeon_hold']);
const BANDS = new Set<OtAdminScoreBand>(['ge80', 'mid', 'lt60']);

export function asMapStatus(v: string | undefined): OtAdminMapStatus | undefined {
  return v && MAPS.has(v as OtAdminMapStatus) ? v as OtAdminMapStatus : undefined;
}

export function asScoreBand(v: string | undefined): OtAdminScoreBand | undefined {
  return v && BANDS.has(v as OtAdminScoreBand) ? v as OtAdminScoreBand : undefined;
}

/**
 * Fail-closed Pulse label. Unmapped and multi_surgeon_hold never surface a doctor,
 * even if a uid was stored. No fuzzy match, no treating-doctor fallback.
 */
export function pulseSurgeonLabel(input: {
  map_status: string;
  doctor_uid: string | null;
  pulseName?: string | null;
}): PulseSurgeonLabel {
  if (input.map_status === 'multi_surgeon_hold') {
    return { status: 'multi_surgeon_hold', pulseName: null };
  }
  const uid = (input.doctor_uid || '').trim();
  if (input.map_status !== 'mapped' || !uid) {
    return { status: 'unmapped', pulseName: null };
  }
  const name = (input.pulseName || '').trim();
  return { status: 'mapped', pulseName: name || null };
}

export function filterOtAdminList<T extends OtAdminListRow>(
  rows: readonly T[],
  filters: OtAdminFilters,
  pulseNames: Readonly<Record<string, string>>,
): T[] {
  const map = asMapStatus(filters.map);
  const site = (filters.site || '').trim();
  const band = asScoreBand(filters.band);
  const q = (filters.surgeon || '').trim().toLowerCase();
  return rows.filter((row) => {
    if (map && row.map_status !== map) return false;
    if (site && (row.hospital_uid || '') !== site) return false;
    if (band) {
      const pct = row.nabh_score_pct;
      if (pct == null) return false;
      if (band === 'ge80' && pct < 80) return false;
      if (band === 'mid' && (pct < 60 || pct >= 80)) return false;
      if (band === 'lt60' && pct >= 60) return false;
    }
    if (q) {
      const raw = (row.surgeon_raw || '').toLowerCase();
      const hop = pulseSurgeonLabel({
        map_status: row.map_status,
        doctor_uid: row.doctor_uid,
        pulseName: row.doctor_uid ? pulseNames[row.doctor_uid] : null,
      });
      const pulse = (hop.pulseName || '').toLowerCase();
      if (!raw.includes(q) && !pulse.includes(q)) return false;
    }
    return true;
  });
}

/** Mean of persisted percentages. Rows with no stored score are skipped, not scored here. */
export function meanPersistedNabhPct(rows: readonly { nabh_score_pct: number | null }[]): number | null {
  const vals = rows.map((r) => r.nabh_score_pct).filter((n): n is number => n != null && Number.isFinite(n));
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

export interface PersistedCriterion {
  score: 0 | 1 | 2 | null;
  na: boolean;
  evidence: string | null;
}

/** Pass through one stored criterion. Missing or unrecognised score stays null — never coerced to 0. */
export function readPersistedCriterion(raw: unknown): PersistedCriterion | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const na = o.na === true;
  let score: 0 | 1 | 2 | null = null;
  if (o.score === 0 || o.score === 1 || o.score === 2) score = o.score;
  else if (typeof o.score === 'string' && /^[012]$/.test(o.score)) score = Number(o.score) as 0 | 1 | 2;
  const evidence = typeof o.evidence === 'string' && o.evidence.trim() ? o.evidence.trim() : null;
  if (score == null && !na && !evidence) return null;
  return { score, na, evidence };
}

export function readPersistedCriteria(raw: unknown): Record<string, PersistedCriterion> {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, PersistedCriterion> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const cell = readPersistedCriterion(value);
    if (cell) out[key] = cell;
  }
  return out;
}

export function siteIds(rows: readonly { hospital_uid: string | null }[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = (row.hospital_uid || '').trim();
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}
