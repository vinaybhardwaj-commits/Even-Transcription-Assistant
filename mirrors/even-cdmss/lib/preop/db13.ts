/**
 * lib/preop/db13.ts — read-only db13 access for the Pre-op Risk Agent.
 * Server-only; goes through lib/metabase's metabaseQuery — the SAME connection layer
 * lib/readmission/db13.ts and lib/ipd-audit/db13.ts use. No new credential, no direct
 * pg driver, no write of any kind.
 *
 * SQL HONESTY. Unlike the readmission sibling, every query below was VALIDATED against
 * live db13 on 26 Aug 2026 while this file was being written, and the measurements are
 * recorded beside each one. What is still inferred is marked INFERRED.
 *
 * Fail-safe throughout — but NEVER silently. Every fetch returns { rows, error }, and a
 * fault degrades to an empty list WITH the reason attached, which the sweep then carries
 * into its report and its heartbeat row. A source that returns nothing because it is
 * empty and a source that returns nothing because it timed out look identical from the
 * outside, and the difference is the whole meaning of a coverage number: the first sweep
 * written here reported "0 episodes with OPD diagnoses" when the truth was that the
 * query had 504'd. A missing source must cost an INPUT — which widens an instrument to a
 * range and says so on the card — never a wrong score, never a 500, and never a coverage
 * figure that is quietly a lie.
 *
 * PHI: patient name / dob are read here because this is a clinician-facing Managed Care
 * board that identifies its patients by name — the same posture as the readmissions
 * board. Nothing here reaches a model; B1 and B2 make no model call at all.
 */

import { metabaseQuery } from '../metabase';

/** Every fetch's return: the rows it got, and — when it got none — WHY. */
export interface Fetched<T> { rows: T[]; error: string | null }

function failed<T>(source: string, e: unknown): Fetched<T> {
  return { rows: [], error: `${source}: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
}

const esc = (s: string) => s.replace(/'/g, "''");
const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);
const isUhid = (u: string) => /^[A-Za-z0-9/_-]{2,40}$/.test(u);
const s = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const n = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** A quoted IN-list, or null when nothing survives validation (the caller then skips). */
function inList(values: string[], ok: (v: string) => boolean, cap = 400): string | null {
  const clean = Array.from(new Set(values.filter((v) => typeof v === 'string' && ok(v)))).slice(0, cap);
  return clean.length ? clean.map((v) => `'${esc(v)}'`).join(', ') : null;
}

/** The same list as `_parent_path` literals — the key BOTH per-individual child tables
 *  use in db13 (VALIDATED: neither carries an individual_uid column). */
function parentPathList(uids: string[], cap = 400): string | null {
  const clean = Array.from(new Set(uids.filter((v) => typeof v === 'string' && isUid(v)))).slice(0, cap);
  return clean.length ? clean.map((v) => `'/individuals/${esc(v)}'`).join(', ') : null;
}

/** A postgres text[] rendered by Metabase as '{A,B}' — or already an array. */
export function parsePgArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  const t = s(v);
  if (!t) return [];
  const inner = t.replace(/^\{|\}$/g, '');
  if (!inner) return [];
  return inner.split(',').map((x) => x.replace(/^"|"$/g, '').trim()).filter(Boolean);
}

// ── the episode anchor ──────────────────────────────────────────────────────────

export interface PreopEpisodeRow {
  /** episode key — surgery_cases._doc_id (Build Plan naming) */
  docId: string;
  individualUid: string;
  uhid: string | null;
  patientName: string | null;
  /** whole years at the sweep's own IST today, computed in SQL off individuals.dob */
  age: number | null;
  sex: string | null;
  procedure: string | null;
  hospitalUid: string | null;
  surgeryDate: string | null;     // YYYY-MM-DD
  status: string | null;
  urgency: string | null;
  pacWorkflowStatus: string | null;
  /** the booking row's last write — the proxy for "when the workflow status was logged" */
  pacWorkflowLoggedAt: string | null;
  comorbidities: string[];
  createdAt: string | null;
}

/**
 * Every upcoming, non-cancelled surgical episode.
 *
 * VALIDATED 26 Aug 2026: surgery_cases holds 342 rows / 300 patients
 * (planned_surgery_date 27 Jun – 31 Aug 2026); the upcoming, non-cancelled window is
 * 19 episodes / 19 patients; individuals joins 19/19 with dob, gender AND kx_uhid — the
 * PRD's UHID bridge is 100 % on this cohort, no fuzzy matching anywhere.
 * `individuals.dob` is TEXT 'YYYY-MM-DD', hence the ::date cast.
 * `status` vocabulary: ADMITTED 272 · FINANCIAL_DONE 37 · CANCELLED 21 · LEAD 7 ·
 * FINANCIAL_PENDING 5. Only CANCELLED is excluded — a LEAD with a booked date is still
 * a patient with a surgery date, and hiding thin cases is exactly what §8 forbids.
 */
/**
 * The episode SELECT, written ONCE. Two callers use it — the sweep's upcoming window and
 * the B7 golden set — and they differ only in their WHERE clause. Sharing the projection
 * and the mapper is what makes the golden-set measurement a measurement OF PRODUCTION
 * rather than of a second implementation that happens to resemble it.
 */
const EPISODE_SELECT = `
      SELECT sc._doc_id, sc.individual_uid, sc.procedure_name, sc.financial__procedure_name,
             sc.status, sc.clinical__urgency, sc.pac__status,
             sc.clinical__comorbidities::text AS comorbidities,
             sc.hospital_info__hospital_uid,
             sc.planned_surgery_date::date::text AS surgery_date,
             sc.created_at::text AS created_at, sc._update_time::text AS updated_at,
             i.kx_uhid, i.display_name, i.first_name, i.last_name, i.gender,
             date_part('year', age((NOW() AT TIME ZONE 'Asia/Kolkata')::date, i.dob::date))::int AS age_years
        FROM surgery_cases sc
        JOIN individuals i ON i._doc_id = sc.individual_uid`;

function toEpisodeRow(r: Record<string, unknown>): PreopEpisodeRow | null {
  const docId = s(r._doc_id);
  const individualUid = s(r.individual_uid);
  if (!docId || !individualUid) return null;     // unusable row — dropped, never guessed
  return {
    docId, individualUid,
    uhid: s(r.kx_uhid),
    // VALIDATED 26 Aug 2026: individuals.display_name is EMPTY on this cohort (0-length
    // or NULL on all 19 upcoming). first_name/last_name carry the name, so the board
    // would have rendered nineteen anonymous cards off display_name alone.
    patientName: s(r.display_name) ?? (s([s(r.first_name), s(r.last_name)].filter(Boolean).join(' '))),
    age: n(r.age_years),
    sex: s(r.gender),
    procedure: s(r.procedure_name) ?? s(r.financial__procedure_name),
    hospitalUid: s(r.hospital_info__hospital_uid),
    surgeryDate: s(r.surgery_date),
    status: s(r.status),
    urgency: s(r.clinical__urgency),
    pacWorkflowStatus: s(r.pac__status),
    pacWorkflowLoggedAt: s(r.updated_at),
    comorbidities: parsePgArray(r.comorbidities),
    createdAt: s(r.created_at),
  };
}

export async function fetchUpcomingEpisodes(horizonDays = 60): Promise<Fetched<PreopEpisodeRow>> {
  const days = Math.max(1, Math.min(365, Math.round(horizonDays)));
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(
      `${EPISODE_SELECT}
        WHERE sc.planned_surgery_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          AND sc.planned_surgery_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date + INTERVAL '${days} days'
          AND sc.status <> 'CANCELLED'
        ORDER BY sc.planned_surgery_date ASC, sc._doc_id ASC
        LIMIT 500`);
  } catch (e) {
    return failed('surgery_cases', e);
  }
  const out: PreopEpisodeRow[] = [];
  for (const r of rows) {
    const row = toEpisodeRow(r);
    if (row) out.push(row);
  }
  return { rows: out, error: null };
}

/**
 * B7 · THE GOLDEN SET's real half: every surgical episode belonging to a patient the UHID
 * bridge reaches a KareXpert PAC report for, whatever its surgery date. The upcoming
 * window is 15 episodes on 27 Aug; the PAC-covered cohort is much larger, and it is the
 * only population where the extraction rail has anything to read — so a golden set drawn
 * from the board alone would measure the rail on the cases it cannot help.
 *
 * Read-only, and used only by the harness. The sweep never calls it.
 */
export async function fetchPacCoveredEpisodes(limit = 300): Promise<Fetched<PreopEpisodeRow>> {
  const n = Math.max(1, Math.min(500, Math.round(limit)));
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(
      `${EPISODE_SELECT}
        WHERE sc.status <> 'CANCELLED'
          AND i.kx_uhid IS NOT NULL
          AND EXISTS (SELECT 1 FROM kx_clinical_template_pac_reports p WHERE p.uhid = i.kx_uhid)
        ORDER BY sc.planned_surgery_date DESC NULLS LAST, sc._doc_id ASC
        LIMIT ${n}`);
  } catch (e) {
    return failed('surgery_cases (golden set)', e);
  }
  const out: PreopEpisodeRow[] = [];
  for (const r of rows) {
    const row = toEpisodeRow(r);
    if (row) out.push(row);
  }
  return { rows: out, error: null };
}

/**
 * uid → name for the hospitals a surgical episode can be booked at.
 *
 * VALIDATED 26 Aug 2026: `even_hospitals` holds THREE rows, and the two that appear on
 * surgery_cases are vZmEPseTKP3vS3DrZzrv "Even Hospital" (318 cases) and
 * F8jrPHlVTWsvNtB1Iz0k "Altius Hospital, HBR Layout" (24). `facility_centres` does NOT
 * contain these ids — it is a different collection, and joining there returns nothing.
 *
 * Without this the board prints a firestore id where the mockup prints a hospital name.
 * Fail-safe: an empty map means every card falls back to showing the uid, which is ugly
 * but true, rather than showing a name we could not look up.
 */
export async function fetchHospitalNames(): Promise<Fetched<{ uid: string; name: string }>> {
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(`SELECT _doc_id, name FROM even_hospitals LIMIT 100`);
  } catch (e) {
    return failed('even_hospitals', e);
  }
  const out: Array<{ uid: string; name: string }> = [];
  for (const r of rows) {
    const uid = s(r._doc_id), name = s(r.name);
    if (uid && name) out.push({ uid, name });
  }
  return { rows: out, error: null };
}

// ── the PAC report (existence + status + time + the note's closing line) ────────

export interface PacRow {
  uid: string;
  uhid: string;
  status: string | null;
  createdAt: string | null;
  /** the LAST non-empty line of the flattened `note` render — quoted verbatim, never
   *  paraphrased. B3 replaces this with the mapped fitness field. */
  closingLine: string | null;
  templateName: string | null;
  /** the raw KareXpert form payload — parsed by lib/preop-pac-map-core.ts (B3) */
  componentJson: string | null;
}

/** Fitness language, so the banner can say whether the closing line IS a verdict. */
export function looksLikeFitnessVerdict(line: string | null): boolean {
  if (!line) return false;
  return /\b(can be taken for surgery|fit for (surgery|anaesthesia|ga|sa)|not fit|unfit|high[- ]risk consent|deferred)\b/i.test(line);
}

/** The last non-empty line of the PAC note, capped. */
export function pacClosingLine(note: string | null): string | null {
  if (!note) return null;
  const lines = note.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? last.slice(0, 300) : null;
}

/**
 * Every final PAC report for a set of UHIDs.
 *
 * VALIDATED 26 Aug 2026: kx_clinical_template_pac_reports holds 95 rows / 94 patients,
 * 13 Jul – 25 Aug 2026, ALL status 'final', ONE template — exactly the PRD §4 figures.
 * Joined to surgery_cases through individuals.kx_uhid it reaches 57 episodes / 52
 * patients across the whole cohort (the kickoff's expected ~52), but only 1 of the 19
 * UPCOMING episodes: the PAC corpus is retrospective, and the operational status on
 * surgery_cases (pac__status COMPLETED on 8 of those 19) is a DIFFERENT fact from a PAC
 * report existing in KareXpert. Both are surfaced; neither is allowed to stand in for
 * the other. Reported to V as the headline B2 finding.
 */
export async function fetchPacReports(uhids: string[]): Promise<Fetched<PacRow>> {
  const list = inList(uhids, isUhid);
  if (!list) return { rows: [], error: null };
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(
      `SELECT uid, uhid, status, template_name, created_at::text AS created_at, note,
              component_json::text AS component_json
         FROM kx_clinical_template_pac_reports
        WHERE uhid IN (${list}) AND status = 'final'
        ORDER BY created_at ASC
        LIMIT 500`);
  } catch (e) {
    return failed('kx_clinical_template_pac_reports', e);
  }
  const out: PacRow[] = [];
  for (const r of rows) {
    const uid = s(r.uid), uhid = s(r.uhid);
    if (!uid || !uhid) continue;
    out.push({
      uid, uhid, status: s(r.status), createdAt: s(r.created_at),
      closingLine: pacClosingLine(r.note == null ? null : String(r.note)),
      templateName: s(r.template_name),
      componentJson: r.component_json == null ? null : String(r.component_json),
    });
  }
  return { rows: out, error: null };
}

// ── structured labs (Eka) ───────────────────────────────────────────────────────

export interface PreopLabRow {
  individualUid: string;
  name: string;
  value: number | null;
  unit: string | null;
  at: string | null;
}

/**
 * Creatinine for a set of individuals, newest last.
 *
 * VALIDATED 26 Aug 2026: only 3 of the 19 upcoming episodes have ANY structured lab, and
 * the same 3 have a creatinine — so RCRI's renal factor is UNKNOWN on 16 of 19 upcoming
 * cases today and every one of those RCRI scores is a range. That is the PRD's own
 * "creatinine 18/105 at booking" reality, and the whole reason §8 exists.
 * Name variants live in db13 as free text ('Creatinine', 'Creatinine - Serum / Plasma');
 * the ratio analytes ('BUN Creatinine Ratio') are EXCLUDED — they are a different
 * quantity in a different unit and comparing them against 2.0 mg/dL would be nonsense.
 * result_date carries 1970-01-01 sentinels on some rows; they sort oldest and lose.
 */
export async function fetchCreatinine(individualUids: string[]): Promise<Fetched<PreopLabRow>> {
  const list = parentPathList(individualUids);
  if (!list) return { rows: [], error: null };
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(
      `SELECT replace(pv._parent_path, '/individuals/', '') AS individual_uid,
              pv.name, pv.data_value, pv.data_unit, pv.result_date::text AS at
         FROM "individuals-parameter_digital_values__parameters" pv
        WHERE pv._parent_path IN (${list})
          AND pv.name ILIKE '%creatinine%'
          AND pv.name NOT ILIKE '%ratio%'
        ORDER BY pv.result_date ASC
        LIMIT 500`);
  } catch (e) {
    return failed('parameter_digital_values', e);
  }
  const out: PreopLabRow[] = [];
  for (const r of rows) {
    const uid = s(r.individual_uid);
    const name = s(r.name);
    if (!uid || !name) continue;
    out.push({ individualUid: uid, name, value: n(r.data_value), unit: s(r.data_unit), at: s(r.at) });
  }
  return { rows: out, error: null };
}

// ── OPD diagnoses (structured ICD, no model) ────────────────────────────────────

export interface PreopIcdRow {
  individualUid: string;
  codes: string[];
  at: string | null;
  ref: string | null;
}

/**
 * ICD-10 codes off the member's OPD prescriptions.
 *
 * VALIDATED 26 Aug 2026: `individuals-prescriptions` is keyed by
 * `_parent_path = '/individuals/<individual_uid>'` (there is NO individual_uid column —
 * a query on one faults). For the 19 upcoming episodes: 33 prescriptions across 7
 * episodes, 28 rows carrying diagnosis_icd_codes and 1 carrying impression_icd_codes;
 * 23 distinct codes, of which the Charlson-relevant one today is J42 (chronic
 * bronchitis). Thin, real, and free — and it grows with every consult.
 */
/**
 * B8a · THE SIXTH DETERMINISTIC SOURCE — `individuals-prescriptions.comorbidities`, flagged
 * unmapped in the B7 report and mapped here. It is NOT free text: it is a structured array
 * of `{ comorbidity: { uid, name } }` over a small controlled vocabulary ("High BP",
 * "Thyroid Disorder"). Same table as the ICD codes, same rank, same source label.
 *
 * ── AND WHAT THIS REPLACED, recorded rather than deleted ─────────────────────────
 * B5 wired `doctor_notes` as an OPD FREE-TEXT source for the extraction rail. B8a drops it
 * on its own measurement: across the 855 non-draft prescriptions belonging to the surgical
 * cohort, `relevant_medical_history` was filled on 0 and `doctor_notes` on 1. A source that
 * yields one row in eight hundred is not coverage, it is a query. The rail reads the PAC's
 * verbatim boxes and nothing else now.
 */
export interface PreopOpdComorbidityRow { individualUid: string; names: string[]; at: string | null; ref: string | null }

export async function fetchOpdComorbidities(individualUids: string[]): Promise<Fetched<PreopOpdComorbidityRow>> {
  const list = parentPathList(individualUids);
  if (!list) return { rows: [], error: null };
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(
      `SELECT replace(p._parent_path, '/individuals/', '') AS individual_uid,
              p._doc_id, p.uploaded_at::text AS at, p.comorbidities::text AS comorbidities
         FROM "individuals-prescriptions" p
        WHERE p._parent_path IN (${list})
          AND p.is_draft = false
          AND p.comorbidities IS NOT NULL
          AND length(p.comorbidities::text) > 4
        ORDER BY p.uploaded_at ASC
        LIMIT 500`);
  } catch (e) {
    return failed('individuals-prescriptions.comorbidities', e);
  }
  const out: PreopOpdComorbidityRow[] = [];
  for (const r of rows) {
    const uid = s(r.individual_uid);
    if (!uid) continue;
    const names = comorbidityNames(s(r.comorbidities));
    if (!names.length) continue;
    out.push({ individualUid: uid, names, at: s(r.at), ref: s(r._doc_id) });
  }
  return { rows: out, error: null };
}

/** Pull the comorbidity NAMES out of the JSON array. Tolerant: a shape we do not recognise
 *  yields nothing rather than a stringified blob for a matcher to trip over. */
export function comorbidityNames(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const c = (item as Record<string, unknown>).comorbidity;
    if (!c || typeof c !== 'object') continue;
    const name = (c as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) out.push(name.trim());
  }
  return out;
}

export async function fetchOpdIcd(individualUids: string[]): Promise<Fetched<PreopIcdRow>> {
  const list = parentPathList(individualUids);
  if (!list) return { rows: [], error: null };
  let rows: Record<string, unknown>[];
  try {
    rows = await metabaseQuery(
      `SELECT replace(p._parent_path, '/individuals/', '') AS individual_uid,
              p._doc_id, p.uploaded_at::text AS at,
              p.diagnosis_icd_codes::text AS dx, p.impression_icd_codes::text AS imp
         FROM "individuals-prescriptions" p
        WHERE p._parent_path IN (${list})
          AND p.is_draft = false
        ORDER BY p.uploaded_at ASC
        LIMIT 1000`);
  } catch (e) {
    return failed('individuals-prescriptions', e);
  }
  const out: PreopIcdRow[] = [];
  for (const r of rows) {
    const uid = s(r.individual_uid);
    if (!uid) continue;
    const codes = [...parsePgArray(r.dx), ...parsePgArray(r.imp)];
    if (!codes.length) continue;
    out.push({ individualUid: uid, codes, at: s(r.at), ref: s(r._doc_id) });
  }
  return { rows: out, error: null };
}
