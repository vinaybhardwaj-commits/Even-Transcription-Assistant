/**
 * lib/ccb-dossier-core.ts — Care Conversation Brief: MEMBER DOSSIER core (pure).
 *
 * PURE, dependency-free. Assembles a care manager's WHOLE-PERSON view (not a single OPD episode):
 * a unified reverse-chronological care timeline + snapshot, stitched from every source we can key
 * to one member. Deterministic — no LLM, no PDF reads (the thin AI "before the call" synthesis is
 * a later, separate layer). The wired reads live in ccb-dossier.ts.
 *
 * DATA SPINE (verified live in db13, 1 Jul):
 *   • identity/demographics = `individuals` (by uid)                         → name/dob/gender/uhid/allergies
 *   • OPD episodes (all)    = `individuals-prescriptions` by _parent_id       → visit → speciality + dx
 *       clean complaint/dx  = `dpipe_prescription_pipeline` by presc_uid (join in JS, same as CAT)
 *   • diagnostics history   = `individuals-diagnostic_reports` by _parent_id  (document + date, is_draft=false)
 *   • radiology history     = `individuals-radiology_reports` by _parent_id
 *   • IPD admissions        = `kx_discharge_summary_records` by uhid          → admit/discharge/speciality/ward
 *
 * SECURITY: every interpolated id is validated before it reaches SQL (isUid/isUhidLike, shared
 * with ccb-search-core). Read-only. Identifiers stay in db13 / on the bundle — never sent to an LLM.
 */

// Self-contained validators/helpers (inlined so the strip-types test loader stays dependency-free;
// mirrors the identical helpers in ccb-search-core).
export const isUid = (u: string): boolean => /^[A-Za-z0-9_-]{6,64}$/.test(u);
export const isUhidLike = (u: string): boolean => /^[A-Za-z0-9][A-Za-z0-9/_-]{2,39}$/.test(u);

function sqlStr(s: string, max = 64): string {
  return String(s ?? '').slice(0, max).replace(/'/g, "''");
}

function computeAge(dob: string | null, now: Date = new Date()): number | null {
  if (!dob) return null;
  const m = String(dob).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  let age = now.getUTCFullYear() - y;
  const bdayPassed = (now.getUTCMonth() + 1 > mo) || (now.getUTCMonth() + 1 === mo && now.getUTCDate() >= d);
  if (!bdayPassed) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

function fullName(first: string | null, last: string | null, display: string | null): string {
  const dn = (display || '').trim();
  if (dn) return dn;
  const nm = [first, last].map((x) => (x || '').trim()).filter(Boolean).join(' ');
  return nm || 'Unknown member';
}

// ── Types ───────────────────────────────────────────────────────────────────────
// v2 Build B added 'order' | 'surgery' | 'hcu' | 'event'. A cached snapshot written before that
// simply carries none of them; consumers must treat an unknown kind and an absent docUrl as normal.
export type TimelineKind = 'opd' | 'ipd' | 'diagnostic' | 'radiology' | 'order' | 'surgery' | 'hcu' | 'event';

export interface TimelineItem {
  date: string | null;      // YYYY-MM-DD (IST)
  kind: TimelineKind;
  title: string;            // e.g. "Orthopedics" / "IPD discharge"
  subtitle: string | null;  // e.g. "knee pain → osteoarthritis" / "MRI right knee · 5 days"
  refUid: string | null;    // presc_uid for OPD rows → opens the conversation brief
  docUrl?: string;          // result PDF (report / HCU) — opened directly; absent when there is none
}

export interface DossierMember {
  individualUid: string;
  name: string;
  gender: string | null;
  age: number | null;
  mobile: string | null;
  uhid: string | null;
  membershipId: string | null;
  allergies: string[];
}

export interface DossierSnapshot {
  opdVisits: number;
  ipdAdmissions: number;
  diagnostics: number;
  radiology: number;
  lastContact: string | null;   // most recent date across all sources
  medsLastVisit: number | null; // medication lines on the most recent OPD note
}

export interface DossierBundle {
  member: DossierMember;
  snapshot: DossierSnapshot;
  timeline: TimelineItem[];
  latestEpisodeUid: string | null;  // most recent OPD presc_uid → the conversation brief
}

// ── SQL builders (pure; validated interpolation) ─────────────────────────────────
export function individualSql(individualUid: string): string {
  if (!isUid(individualUid)) throw new Error('bad individual uid');
  return `SELECT uid, first_name, last_name, display_name, gender, dob, kx_uhid, mobiles, allergies`
    + ` FROM individuals WHERE uid = '${individualUid}' LIMIT 1`;
}

/** All OPD episodes for a member (ip only; clean complaint/dx joined separately). */
export function episodesSql(individualUid: string, limit = 60): string {
  if (!isUid(individualUid)) throw new Error('bad individual uid');
  const lim = Math.max(1, Math.min(200, Math.floor(limit)));
  const nMeds = `coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(to_jsonb(medications)) = 'array' THEN to_jsonb(medications) ELSE '[]'::jsonb END), 0)`;
  return `SELECT uid, type_of_prescription, doctor_name_with_speciality,`
    + ` to_char(timestamp AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS visit_date,`
    + ` ${nMeds} AS n_meds`
    + ` FROM "individuals-prescriptions"`
    + ` WHERE _parent_id = '${individualUid}' AND is_draft = false`
    + ` ORDER BY timestamp DESC LIMIT ${lim}`;
}

/** Clean presenting-complaint + diagnosis for a set of presc uids (dpipe pipeline). */
export function dpipeByUidsSql(uids: string[]): string {
  const ok = Array.from(new Set((uids || []).filter(isUid)));
  if (!ok.length) throw new Error('no valid uid');
  const inList = ok.map((u) => `'${u}'`).join(', ');
  return `SELECT DISTINCT ON (presc_uid) presc_uid, presenting_complaint, diagnosis`
    + ` FROM dpipe_prescription_pipeline WHERE presc_uid IN (${inList})`
    + ` ORDER BY presc_uid, _update_time DESC`;
}

/** Diagnostic OR radiology result documents for a member (child tables share the shape). */
export function reportsSql(table: 'diagnostic' | 'radiology', individualUid: string, limit = 40): string {
  if (!isUid(individualUid)) throw new Error('bad individual uid');
  const tbl = table === 'radiology' ? '"individuals-radiology_reports"' : '"individuals-diagnostic_reports"';
  const lim = Math.max(1, Math.min(100, Math.floor(limit)));
  const dateExpr = `left(coalesce(collection_date, created_at, uploaded_at), 10)`;
  // v2 Build B: carry the result PDF so the timeline row can open it (docUrl).
  return `SELECT ${dateExpr} AS report_date, document_name, vendor, document_url, processed_report_url`
    + ` FROM ${tbl} WHERE _parent_id = '${individualUid}' AND is_draft = false`
    + ` ORDER BY coalesce(collection_date, created_at, uploaded_at) DESC LIMIT ${lim}`;
}

/** IPD admissions for a member (by uhid). Structured — no discharge PDF read.
 *  The source keeps MULTIPLE rows per admission (drafts + revised discharge-summary versions),
 *  so we DISTINCT ON the admission (ipd_no, fallback uid) and keep the best row — Final over draft,
 *  latest discharge, then most-recently-modified — then order the collapsed set newest-first. */
export function dischargeSql(kxUhid: string, limit = 30): string {
  if (!isUhidLike(kxUhid)) throw new Error('bad uhid');
  const lim = Math.max(1, Math.min(100, Math.floor(limit)));
  const inner = `SELECT DISTINCT ON (coalesce(nullif(ipd_no,''), uid)) ipd_no, discharge_type, status,`
    + ` to_char(admission_date_time AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS admit_date,`
    + ` to_char(discharge_date_time AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS discharge_date,`
    + ` treating_doctor_speciality, ward, coalesce(discharge_date_time, admission_date_time) AS sort_ts`
    + ` FROM kx_discharge_summary_records WHERE uhid = '${sqlStr(kxUhid, 40)}'`
    + ` ORDER BY coalesce(nullif(ipd_no,''), uid), (status = 'Final') DESC, discharge_date_time DESC NULLS LAST, modified_time DESC NULLS LAST`;
  return `SELECT ipd_no, discharge_type, status, admit_date, discharge_date, treating_doctor_speciality, ward`
    + ` FROM (${inner}) x ORDER BY sort_ts DESC NULLS LAST LIMIT ${lim}`;
}

// ── Pure transforms ──────────────────────────────────────────────────────────────
const asStr = (v: unknown): string | null => (v == null ? null : String(v));
const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);

/** "Dr. Reshma(General Physician)" → "General physician". Null if no trailing parens. */
export function parseSpeciality(label: string | null): string | null {
  if (!label) return null;
  const m = String(label).match(/\(([^)]*)\)\s*$/);
  const s = m ? m[1].trim() : '';
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Fallback OPD label from the prescription type. */
export function prettyPrescriptionType(t: string | null): string {
  const s = (t || '').replace(/^HOSPITAL_/, '').replace(/_/g, ' ').trim().toLowerCase();
  if (!s) return 'OPD visit';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const da = Date.parse(a + 'T00:00:00Z'); const db = Date.parse(b + 'T00:00:00Z');
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  const d = Math.round((db - da) / 86400000);
  return d >= 0 ? d : null;
}

export interface EpisodeRowLite { uid: string; type: string | null; speciality: string | null; date: string | null; nMeds: number; }

export function mapEpisodeRow(r: Record<string, unknown>): EpisodeRowLite | null {
  const uid = asStr(r.uid);
  if (!uid || !isUid(uid)) return null;
  return {
    uid,
    type: asStr(r.type_of_prescription),
    speciality: parseSpeciality(asStr(r.doctor_name_with_speciality)),
    date: asStr(r.visit_date),
    nMeds: Number(r.n_meds ?? 0) || 0,
  };
}

/** The dpipe `diagnosis` column is a JSON array of {diagnosis, icd_code, …} (same as the OPD
 *  audit's dpipeDx) — extract the readable names. Falls back to a plain string if it isn't JSON. */
export function parseDiagnosisNames(raw: string | null): string[] {
  const s = (raw || '').trim();
  if (!s) return [];
  if (!(s.startsWith('[') || s.startsWith('{'))) return [s];
  let parsed: unknown = null;
  try { parsed = JSON.parse(s); } catch { return [s]; }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const names: string[] = [];
  for (const it of list) {
    if (it && typeof it === 'object') {
      const nm = (it as Record<string, unknown>).diagnosis;
      if (nm != null && String(nm).trim()) names.push(String(nm).trim());
    } else if (typeof it === 'string' && it.trim()) {
      names.push(it.trim());
    }
  }
  return Array.from(new Set(names));
}

/** Collapse whitespace and truncate a free-text complaint for a one-line timeline subtitle. */
export function cleanComplaint(raw: string | null, max = 140): string | null {
  const s = (raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Build the OPD slice of the timeline, folding in clean complaint + parsed diagnosis names. */
export function opdTimeline(episodes: EpisodeRowLite[], dpipeByUid: Record<string, { pc: string | null; dx: string | null }>): TimelineItem[] {
  return episodes.map((e) => {
    const clean = dpipeByUid[e.uid] || { pc: null, dx: null };
    const complaint = cleanComplaint(clean.pc);
    const dxStr = parseDiagnosisNames(clean.dx).slice(0, 4).join(', ');
    let subtitle: string | null = null;
    if (complaint && dxStr) subtitle = `${complaint} → ${dxStr}`;
    else subtitle = dxStr || complaint || null;
    if (subtitle && subtitle.length > 200) subtitle = `${subtitle.slice(0, 199).trimEnd()}…`;
    return {
      date: e.date,
      kind: 'opd' as const,
      title: e.speciality || prettyPrescriptionType(e.type),
      subtitle,
      refUid: e.uid,
    };
  });
}

export function reportTimeline(rows: Record<string, unknown>[], kind: 'diagnostic' | 'radiology'): TimelineItem[] {
  const fallback = kind === 'radiology' ? 'Radiology report' : 'Diagnostic report';
  return rows.map((r) => {
    const name = asStr(r.document_name);
    const vendor = asStr(r.vendor);
    const label = (name && name.trim()) ? name.trim() : fallback;
    // v2 Build B: prefer the processed PDF over the raw upload.
    const url = asStr(r.processed_report_url) ?? asStr(r.document_url);
    const item: TimelineItem = {
      date: asStr(r.report_date),
      kind,
      title: kind === 'radiology' ? 'Radiology' : 'Diagnostic',
      subtitle: vendor ? `${label} · ${vendor}` : label,
      refUid: null,
    };
    if (url && url.trim()) item.docUrl = url.trim();
    return item;
  });
}

export function ipdTimeline(rows: Record<string, unknown>[]): TimelineItem[] {
  return rows.map((r) => {
    const admit = asStr(r.admit_date);
    const discharge = asStr(r.discharge_date);
    const spec = asStr(r.treating_doctor_speciality);
    const ward = asStr(r.ward);
    const dtype = asStr(r.discharge_type);
    const los = daysBetween(admit, discharge);
    const date = discharge || admit;
    const bits = [spec, ward, dtype].map((x) => (x || '').trim()).filter(Boolean);
    if (los != null) bits.push(`${los} day${los === 1 ? '' : 's'}`);
    return {
      date,
      kind: 'ipd' as const,
      title: discharge ? 'IPD discharge' : 'IPD admission',
      subtitle: bits.join(' · ') || null,
      refUid: null,
    };
  });
}

/** Merge all slices into one reverse-chronological timeline (undated rows sink to the bottom). */
export function mergeTimeline(...slices: TimelineItem[][]): TimelineItem[] {
  const all = ([] as TimelineItem[]).concat(...slices);
  return all.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });
}

export function computeSnapshot(episodes: EpisodeRowLite[], diagnostics: TimelineItem[], radiology: TimelineItem[], ipd: TimelineItem[], timeline: TimelineItem[]): DossierSnapshot {
  const lastContact = timeline.find((t) => t.date)?.date ?? null;
  return {
    opdVisits: episodes.length,
    ipdAdmissions: ipd.length,
    diagnostics: diagnostics.length,
    radiology: radiology.length,
    lastContact,
    medsLastVisit: episodes.length ? episodes[0].nMeds : null,
  };
}

export function buildMember(individualRow: Record<string, unknown>, membershipId: string | null, now?: Date): DossierMember {
  const uid = String(individualRow.uid || '');
  const mobiles = asArr(individualRow.mobiles);
  return {
    individualUid: uid,
    name: fullName(asStr(individualRow.first_name), asStr(individualRow.last_name), asStr(individualRow.display_name)),
    gender: asStr(individualRow.gender),
    age: computeAge(asStr(individualRow.dob), now),
    mobile: mobiles[0] ?? null,
    uhid: asStr(individualRow.kx_uhid),
    membershipId,
    allergies: asArr(individualRow.allergies),
  };
}
