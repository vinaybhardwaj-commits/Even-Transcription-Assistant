/**
 * lib/opd-ingest-core.ts — map an `individuals-prescriptions` (db13) row into a
 * DE-IDENTIFIED OPD case for the note-quality audit. PURE (no db/llm), unit-testable.
 *
 * IMPORTANT (fixed 29 Jun): for medical consults the clinically-entered content lives in
 * the TYPE-SPECIFIC nested columns, NOT the top-level ones:
 *   - presenting complaints + HPI  → general_practitioner_prescription__presenting_complaints[].symptoms (HTML)
 *   - diagnoses / impressions      → …__presenting_complaints[].diagnoses[].{icd_code, diagnosis_or_impression, general_advice, treatment_plan}
 *   - advice / plan                → …__plan_of_management[].management_plan (HTML)  (+ top-level general_advice)
 *   - examination                  → …__examination (HTML)
 * The top-level presenting_complaints / relevant_medical_history / patient_details__allergies
 * columns are structurally empty for these notes — reading them produced false "(none documented)"
 * gaps. We now read the nested fields and fall back to top-level only when present.
 *
 * PHI posture: the de-identified case (clinical content only) is what the LLM sees. The
 * re-identification keys (uid/consult_uid/doctor_uid/kx_encounter_id) + the prescription PDF
 * url are returned SEPARATELY and never sent to the model.
 */

import type { DosageForm } from './formulary-match-core';   // type-only — keeps this core pure (no cycle: formulary-match-core imports nothing)

export interface OpdMed {
  generic?: string; brand?: string; strength?: string; dose?: string;
  frequency?: string; duration?: string; route?: string; instruction?: string;
  // Formulary enrichment (populated by the orchestrator from lib/formulary; optional so the
  // pure cores never import the formulary loader). resolvedGeneric is the molecule recovered
  // for a brand-only line; the rest is its EHRC formulary class / schedule / safety profile.
  resolvedGeneric?: string;
  therapeuticClass?: string;   // formulary Major Grouping
  /** FORMULARY-CLASS-RESOLUTION §6, V ruling (b): EVERY class resolved from the line, one entry
   *  per resolving fragment in fragment order — a kit holding an antifungal and an antibiotic is
   *  both. therapeuticClass always equals therapeuticClasses[0]; single-class lines carry [class]. */
  therapeuticClasses?: string[];
  subClass?: string;           // formulary Minor Grouping
  schedule?: string;           // D&C schedule: OTC | H | H1 | X | Biological
  highAlert?: boolean;         // ISMP high-alert medication
  lasa?: string[];             // look-alike/sound-alike confusables
  ved?: string;                // V | E | D
  restricted?: boolean;        // reserve/restricted antimicrobial
  // 0.81.11 (Matcher-Scoping Audit Stage 1): the formulary dosage form, finally plumbed through the
  // enrichment (it used to be dropped at the FormularyRow projection). `form` is the raw string,
  // `dosageForm` the parsed coarse vocabulary. Populated for form-awareness in LATER fixes; NO matcher
  // reads either in Stage 1 (score-invariant).
  form?: string;
  dosageForm?: DosageForm;
  // Phase 1 (audit-integrity, bug 3): the EMR's own service category for the line, carried verbatim
  // from the medications JSON `default_opd_service_category`. Source-system enum (case-sensitive);
  // absent/null degrades to undefined — the form gate then decides. Never free text.
  serviceCategory?: string;
  formularyMatch?: 'source-generic' | 'brand-exact' | 'embedded-generic' | 'brand-token' | 'brand-prefix' | 'none';
  nonFormulary?: 'nutraceutical-cosmetic' | 'non-formulary';
}
export interface DeidOpdCase {
  consultType: string | null;
  reasonForConsult: string | null;
  presentingComplaints: string[];   // complaint + HPI (from nested symptoms)
  diagnosisCodes: string[];         // ICD-10
  impressionCodes: string[];        // ICD-10 (impression)
  impressions: string[];            // free-text impression / diagnosis names
  history: string[];
  comorbidities: string[];
  medications: OpdMed[];
  investigations: string[];         // ordered tests
  advice: string[];                 // CLINICIAN plan / management only (templated leaflets excluded)
  examination: string[];            // exam findings (often sparse)
  allergies: string | null;
  followUpType: string | null;
  followUpDateSet: boolean;
  // 0.6 — encounter context so the audit doesn't misread a teleconsult referral handoff as a
  // definitive in-person treatment episode. Optional so existing DeidOpdCase literals stay valid.
  patientEducation?: string[];      // auto-attached templated leaflets (self-care text, video links) — NOT clinician documentation
  isTeleconsult?: boolean;          // remote consult → no physical examination expected
  noteDate?: string | null;         // 0.81.8 bug 4 — the consult date (ISO), surfaced in opdCaseText as "today"
  consultTypes?: string[];          // db13 consult_types purpose markers (0.81.7 channel evidence)
  referrals?: string[];             // onward referrals, e.g. "In-Person Orthopedics (Even-recommended)"
  numReferrals?: number;
  isReferralHandoff?: boolean;      // triage/handoff (referred onward) — not definitive management
  // Obstetric-template adapter (CDMSS-OBGYN-TEMPLATE-EXTRACTION-FIX §4) — set ONLY when the flag is on
  // AND the note is on the HOSPITAL_GYNAECOLOGY_OBSTETRICS template. Optional so every existing literal
  // stays valid; when unset the note audits exactly as today.
  isObstetric?: boolean;
  obstetric?: ObstetricMeta;
  // 0.81.14 (CLINICAL-RULINGS §2.6, register A-9) — the raw last-menstrual-period string, read on the
  // obstetric AND gynae-assessment templates. Used by the deterministic possible-pregnancy advisory
  // (§2.7). Optional so existing literals stay valid; CREDITED-NEVER-REQUIRED (it never becomes a
  // mandatory completeness field for the assessment template — see opdCompleteness).
  lmp?: string | null;
  // U4-A1 (VITALS-SOURCE PRD §A.5) — nurse-recorded vitals + weight/height, set ONLY when
  // VITALS_EXTRACTION_ENABLED is on. NOTHING reads these yet — not opdCaseText, not any rule — so
  // A1 is score-invariant (the prompt line is A2). Optional so every existing literal stays valid.
  // vitalsRecorded is SEPARATE from vitals on purpose: "no record at all" (false + null) and "a
  // record with a blank measurement" (true + nulls inside) are different findings — absence is the
  // signal C7 needs later. A row exists → true, even if every measurement is null.
  vitals?: OpdVitals | null;
  vitalsRecorded?: boolean;
  weightKg?: number | null;
  heightCm?: number | null;
}
/** U4-A1 — one nurse-recorded vitals record: numbers only, never the chart's *_tag judgments (the
 *  nurse chart tags a systolic of 149 NORMAL; R-11 forbids passing another system's judgment into
 *  the dimension the engine grades). `recordedAt` is a RELATIVE offset in minutes from the note
 *  timestamp, as a string — a wall clock could re-identify; null whenever either time is missing. */
export interface OpdVitals {
  bp: string | null;                // as recorded, e.g. "120/80"
  systolic: number | null;          // parsed; null unless bp matches ^\d+\/\d+$
  diastolic: number | null;
  pulse: number | null;
  spo2: number | null;
  temperatureF: number | null;      // the source records Fahrenheit
  respiratoryRate: string | null;   // TEXT at source — stays a string
  ews: number | null;               // Early Warning Score
  recordedAt: string | null;        // minutes from the note timestamp, as a string; never a wall clock
}
/** Structured obstetric signals for the trimester-aware mandatory-field set (§8 decision 3). Every
 *  field is a documented/absent flag except `trimester` (1|2|3|null). Pure — populated in rowToOpdCase. */
export interface ObstetricMeta {
  trimester: number | null;             // 1 | 2 | 3 (from trimester_at_visit, else derived from GA weeks)
  gaDocumented: boolean;                // gestational age / POG present (GA text or a resolved trimester)
  lmpOrEddDocumented: boolean;          // LMP present (EDD column unconfirmed in §9 — see report flag)
  gravidityParityDocumented: boolean;   // obstetric history block populated (gravidity)
  weightDocumented: boolean;            // maternal weight (visit_notes.patient_weight_kgs)
  sfhDocumented: boolean;               // symphysis-fundal height
  fhrDocumented: boolean;               // fetal heart rate
  presentationDocumented: boolean;      // fetal presentation
}
export interface OpdKeys {
  uid: string | null; consultUid: string | null; doctorUid: string | null;
  kxEncounterId: string | null; consultType: string | null; prescriptionType: string | null;
  noteDate: string | null;          // ISO date string of the note (source timestamp)
  prescriptionUrl: string | null;   // link to the actual prescription PDF (for hand-audit)
}

// ── coercers tolerant of parsed-or-stringified JSONB ─────────────────────────
function asObj(v: unknown): Record<string, unknown> | unknown[] | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as Record<string, unknown> | unknown[];
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s || s === 'null') return null;
    try { return JSON.parse(s); } catch { return null; }
  }
  return null;
}
function asArr(v: unknown): unknown[] {
  const o = asObj(v);
  if (Array.isArray(o)) return o;
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
    return v.slice(1, -1).split(',').map((x) => x.replace(/^"|"$/g, '').trim()).filter(Boolean);
  }
  return o && typeof o === 'object' ? [] : [];
}
function str(v: unknown): string { return v == null ? '' : String(v).trim(); }
function strOrNull(v: unknown): string | null { const s = str(v); return s ? s : null; }
// U4-A1 — numeric coercer tolerant of Metabase's number-or-string values; anything non-finite → null.
function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function firstKey(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) { const s = str(o[k]); if (s) return s; }
  return '';
}
function uniq(a: string[]): string[] { return [...new Set(a.map((x) => x.trim()).filter(Boolean))]; }

// HTML (the symptoms/plan/exam fields are rich-text) → plain text lines.
function htmlToLines(html: unknown): string[] {
  const s = str(html);
  if (!s) return [];
  const text = s
    .replace(/<\/(li|p|div|h[1-6]|ul|ol|tr)>/gi, '\n')
    .replace(/<br\s*\/?>(?!\n)/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ');
  return text.split('\n').map((x) => x.trim().replace(/^[-•*]\s*/, '')).filter((x) => x && x !== '---');
}

/** Pull short strings out of an array of {…} complaint/history objects or plain strings. */
function textsFrom(v: unknown, keys: string[]): string[] {
  return asArr(v).map((it) => {
    if (it == null) return '';
    if (typeof it === 'string') return it.trim();
    if (typeof it === 'object') return firstKey(it as Record<string, unknown>, keys);
    return '';
  }).filter(Boolean);
}

// ── nested GP-structure readers (the canonical content for medical consults) ──
function gpComplaints(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; out.push(...htmlToLines(o.symptoms)); }
  return uniq(out);
}
function gpImpressions(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; for (const d of asArr(o.diagnoses)) { const dd = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>; const name = strOrNull(dd.diagnosis_or_impression); if (name) out.push(name); } }
  return uniq(out);
}
// v0.81.1 FIX D: ICD codes from the SAME nested diagnoses[] array (previously only names were pulled).
function gpDiagnosisCodes(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; for (const d of asArr(o.diagnoses)) { const dd = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>; const code = strOrNull(dd.icd_code); if (code) out.push(code); } }
  return uniq(out);
}
// The clinician's per-diagnosis treatment_plan (real documentation).
function gpDiagTreatment(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; for (const d of asArr(o.diagnoses)) { const dd = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>; out.push(...htmlToLines(dd.treatment_plan)); } }
  return out;
}
// The per-diagnosis general_advice — in this EMR this is an AUTO-ATTACHED templated patient leaflet
// (generic self-care text + video links), NOT clinician-authored. Kept OUT of clinician `advice` so
// the audit doesn't grade boilerplate as documentation quality. (0.6 bug fix — bit the Band-A lumbago
// referral note: plan was only "Medical management" but a full NHS back-pain leaflet was being graded.)
function gpDiagEducation(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; for (const d of asArr(o.diagnoses)) { const dd = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>; out.push(...htmlToLines(dd.general_advice)); } }
  return out;
}

// A line is templated patient-education if it carries a self-care video / external link.
const EDU_URL_RE = /(https?:\/\/|www\.|youtube\.com|youtu\.be)/i;

// v0.81 (BUG-0.8-04): only the app-based GP e-consult defaults to teleconsult. The HOSPITAL_* types are
// IN-HOSPITAL, IN-PERSON encounters — HOSPITAL_GP / HOSPITAL_GP_INVESTIGATION_REFERRAL were previously here
// and mislabelled ~178 in-person hospital OPD notes as teleconsult (consult_type is null corpus-wide).
const GP_TELE_TYPES = new Set(['GENERAL_PRACTITIONER']);
/**
 * Classify an encounter's channel (0.81.7 — DATA-QUALITY PRD Fix B). Precedence:
 *  (1) explicit consult_type regexes (unchanged; db13's consult_type is null corpus-wide anyway);
 *  (2) NEW db13 `consult_types` PURPOSE markers — VISITING_HOSPITAL / EMERGENCY → in-person, CHAT →
 *      tele. In-person markers WIN over CHAT (a hospital visit with a chat follow-up purpose is an
 *      in-person encounter), so they are checked first;
 *  (3) fallback = the existing form-type default (GENERAL_PRACTITIONER → tele).
 * The hands-on-exam DOWNGRADE (hasHandsOnExam) still applies AFTER this, at the call site, unchanged.
 */
export function isTeleconsultEncounter(prescriptionType: string | null, consultType: string | null, consultTypes: string[] | null = null): boolean {
  const ct = (consultType || '').toUpperCase();
  if (/IN[_\s-]?PERSON|PHYSICAL|WALK[_\s-]?IN/.test(ct)) return false;
  if (/TELE|VIDEO|AUDIO|CHAT|REMOTE|ONLINE/.test(ct)) return true;
  const purposes = (consultTypes || []).map((p) => String(p).trim().toUpperCase());
  if (purposes.some((p) => p === 'VISITING_HOSPITAL' || p === 'EMERGENCY')) return false; // in-person wins over CHAT
  if (purposes.includes('CHAT')) return true;
  return GP_TELE_TYPES.has((prescriptionType || '').toUpperCase());
}

// Short form-type labels for the encounter chip (channel · form). Distinct from the audit-UI labels.
const FORM_LABEL: Record<string, string> = {
  GENERAL_PRACTITIONER: 'GP app', HOSPITAL_GP: 'Hosp GP', HOSPITAL_GP_INVESTIGATION_REFERRAL: 'Hosp GP-Ref',
  HOSPITAL_GYNAECOLOGY_ASSESSMENT: 'Gyn', HOSPITAL_GYNAECOLOGY_OBSTETRICS: 'Obs-Gyn', HOSPITAL_PAEDIATRIC: 'Paeds',
};
/** Shared "type" chip helper (Fix D) — CLASSIFIED channel first, form type second: `Tele · GP app`,
 *  `In-person · Hosp GP`. Pure + reusable client/server. consult_types is not persisted on the audit
 *  row, so old + new rows derive channel identically from (prescription_type, consult_type). */
export function formatEncounterChip(prescriptionType: string | null, consultType: string | null, consultTypes: string[] | null = null): string {
  const channel = isTeleconsultEncounter(prescriptionType, consultType, consultTypes) ? 'Tele' : 'In-person';
  const pt = (prescriptionType || '').toUpperCase();
  const form = FORM_LABEL[pt] || (prescriptionType ? prescriptionType.toLowerCase().replace(/_/g, ' ') : 'OPD');
  return `${channel} · ${form}`;
}

/** Parse db13 `consult_types` (text[]) into a clean string[] — tolerates a JS array, a JSON string,
 *  or a Postgres array literal like `{VISITING_HOSPITAL,CHAT}`. Empty/unknown → []. */
export function parseConsultTypes(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith('[')) { try { const j = JSON.parse(s); if (Array.isArray(j)) return j.map((x) => String(x).trim()).filter(Boolean); } catch { /* fall through */ } }
    return s.replace(/^\{|\}$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '').trim()).filter(Boolean);
  }
  return [];
}

// v0.81 (BUG-0.8-04 FIX I): a documented HANDS-ON physical exam is proof of an in-person encounter
// (you cannot palpate/percuss/auscultate over video) — used to DOWNGRADE a teleconsult classification
// so a genuine exam is never flagged as an "impossible on teleconsult" contradiction.
const HANDS_ON_EXAM_RE = /\b(p\s*\/?\s*a\b|per\s?abdomen|palpat|tender|percuss|auscult|hepatomegaly|splenomegaly|organomegaly|guarding|rebound|hernia|palpable|non[-\s]?tender|s1\s?s2|murmur|air\s+entry|breath\s+sounds|crepit|effusion|range\s+of\s+motion)/i;
export function hasHandsOnExam(examination: string[]): boolean {
  return examination.some((e) => HANDS_ON_EXAM_RE.test(e || ''));
}

/** refer_to (jsonb array) → readable onward-referral labels, e.g. "In-Person Orthopedics (Even-recommended)". */
export function parseReferrals(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const st = (o.specialist_type && typeof o.specialist_type === 'object' ? o.specialist_type : {}) as Record<string, unknown>;
    const name = strOrNull(st.name) || strOrNull(o.name) || 'specialist';
    const inHouse = st.is_in_house === true || o.is_in_house === true;
    const mode = inHouse ? 'In-house' : 'In-Person';
    const even = o.recommended_by_even === true ? ' (Even-recommended)' : '';
    out.push(`${mode} ${name}${even}`);
  }
  return uniq(out);
}
function planAdvice(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; out.push(...htmlToLines(o.management_plan)); }
  return out;
}

// ── flattened pipeline (dpipe_prescription_pipeline) readers — clean PRIMARY content ─────
// presenting_complaint is plain text (complaint + HOPI narrative); diagnosis carries readable
// names + icd codes; plan_of_management is the advice. Used first, with the nested/top-level
// source fields as fallback (so the ~11% of notes the pipeline leaves empty don't regress).
function dpipeText(v: unknown): string[] { const s = str(v); return s ? [s] : []; }
function dpipeDx(v: unknown): { names: string[]; codes: string[] } {
  const names: string[] = []; const codes: string[] = [];
  for (const it of asArr(v)) {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const nm = strOrNull(o.diagnosis); if (nm) names.push(nm);
    const code = strOrNull(o.icd_code); if (code) codes.push(code);
  }
  return { names: uniq(names), codes: uniq(codes) };
}
function dpipePlan(v: unknown): string[] {
  const out: string[] = [];
  for (const it of asArr(v)) { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; out.push(...htmlToLines(o.management_plan)); }
  return out;
}
function dpipeInvestigations(v: unknown): string[] {
  return asArr(v).map((it) => { const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>; return strOrNull(o.name) || ''; }).filter(Boolean);
}

function medsFrom(v: unknown): OpdMed[] {
  return asArr(v).map((it) => {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const m: OpdMed = {
      generic: strOrNull(o.generic_name) || undefined,
      brand: strOrNull(o.brand_name) || undefined,
      strength: strOrNull(o.strength) || undefined,
      dose: strOrNull(o.dosage) || undefined,
      frequency: strOrNull(o.frequency) || undefined,
      duration: strOrNull(o.duration) || undefined,
      route: strOrNull(o.route_of_administration) || undefined,
      instruction: strOrNull(o.instruction_to_patient) || undefined,
      // Phase 1 — fail-safe: a missing/null category ⇒ undefined ⇒ falls through to the form gate.
      serviceCategory: strOrNull(o.default_opd_service_category) || undefined,
    };
    return m;
  }).filter((m) => m.generic || m.brand);
}

function investigationsFrom(v: unknown): string[] {
  return asArr(v).map((it) => {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const inv = o.investigation;
    if (inv && typeof inv === 'object') return firstKey(inv as Record<string, unknown>, ['name', 'display_name']);
    return firstKey(o, ['name', 'investigation', 'display_name']);
  }).filter(Boolean);
}

function codesFrom(v: unknown): string[] {
  return asArr(v).map((x) => str(x)).filter(Boolean);
}

// ── obstetric-template adapter (CDMSS-OBGYN-TEMPLATE-EXTRACTION-FIX) ──────────────
export const OBSTETRIC_TYPE = 'HOSPITAL_GYNAECOLOGY_OBSTETRICS';
// 0.81.14 (CLINICAL-RULINGS §2.6, register A-9) — the gynaecology ASSESSMENT template (distinct from the
// obstetric one). LMP is read here and CREDITED but NEVER made a mandatory completeness field.
export const GYNAE_ASSESSMENT_TYPE = 'HOSPITAL_GYNAECOLOGY_ASSESSMENT';
/** Feature flag — the obstetric adapter ships OFF; the metabase projection widening + this mapping both
 *  gate on it, so with the flag off ingestion is byte-identical to today. */
export function obstetricExtractionEnabled(): boolean { return process.env.OBSTETRIC_EXTRACTION_ENABLED === '1'; }
/** U4-A1 — the vitals-extraction flag (VITALS-SOURCE PRD §A.3), same shape as the obstetric flag. */
export function vitalsExtractionEnabled(): boolean { return process.env.VITALS_EXTRACTION_ENABLED === '1'; }

/** The "current visit" of an obstetric prescription's visit_notes[] (§4): the element with
 *  show_in_prescription === true; fallback = the latest date_of_visit that is NOT is_carried_over. */
export function currentVisitNote(visitNotes: unknown): Record<string, unknown> | null {
  const arr = asArr(visitNotes).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  if (!arr.length) return null;
  const shown = arr.find((v) => v.show_in_prescription === true || v.show_in_prescription === 'true');
  if (shown) return shown;
  const notCarried = arr.filter((v) => v.is_carried_over !== true && v.is_carried_over !== 'true');
  const pool = notCarried.length ? notCarried : arr;
  return pool.slice().sort((a, b) => str(b.date_of_visit).localeCompare(str(a.date_of_visit)))[0] ?? null;
}

/** Trimester (1|2|3) from `trimester_at_visit` (numeric or FIRST/SECOND/THIRD), else derived from GA
 *  weeks in `gestational_age_at_visit` (<14 → 1, 14–27 → 2, ≥28 → 3). Null when nothing is parseable. */
export function parseTrimester(cv: Record<string, unknown>): number | null {
  const raw = str(cv.trimester_at_visit);
  const n = parseInt(raw, 10);
  if (n === 1 || n === 2 || n === 3) return n;
  if (/\bfirst\b|1st/i.test(raw)) return 1;
  if (/\bsecond\b|2nd/i.test(raw)) return 2;
  if (/\bthird\b|3rd/i.test(raw)) return 3;
  const ga = str(cv.gestational_age_at_visit);
  const wk = ga.match(/(\d{1,2})\s*(?:w|week|\+|\/)/i) || ga.match(/^\s*(\d{1,2})\b/);
  if (wk) { const w = parseInt(wk[1], 10); if (w >= 4 && w <= 45) { if (w < 14) return 1; if (w < 28) return 2; return 3; } }
  return null;
}

/** Augment a base case with obstetric-template content (§4 step 2). Fills the canonical fields the GP
 *  mapping left empty (complaint/exam/assessment) from visit_notes + the gynae history block, and sets
 *  the ObstetricMeta for the mandatory-field set. Pure; never throws to the caller (caller wraps). */
function augmentObstetric(oc: DeidOpdCase, row: Record<string, unknown>): void {
  const cv = currentVisitNote(row.visit_notes);
  const symptomLines = cv ? htmlToLines(cv.symptoms_notes) : [];
  const trimester = cv ? parseTrimester(cv) : null;
  const gaRaw = cv ? strOrNull(cv.gestational_age_at_visit) : null;
  const weight = cv ? strOrNull(cv.patient_weight_kgs) : null;
  const sfh = cv ? strOrNull(cv.symphysis_fundal_height_cm) : null;
  const fhr = cv ? strOrNull(cv.fetal_heart_rate_bpm) : null;
  const presentation = cv ? strOrNull(cv.fetal_presentation) : null;
  const afi = cv ? strOrNull(cv.amniotic_fluid_index_cm) : null;
  const efw = cv ? strOrNull(cv.estimated_fetal_weight_g) : null;
  const lmp = strOrNull(row['gynae_patient_history__menstrual_history__last_menstrual_period']);
  const gravidity = strOrNull(row['gynae_patient_history__obstetric_history__gravidity']);
  const parity = strOrNull(row['gynae_patient_history__obstetric_history__parity']);

  const examBits = [
    gaRaw ? `POG ${gaRaw}` : (trimester ? `Trimester ${trimester}` : ''),
    weight ? `Weight ${weight} kg` : '', sfh ? `SFH ${sfh} cm` : '', fhr ? `FHR ${fhr} bpm` : '',
    presentation ? `Presentation ${presentation}` : '', afi ? `AFI ${afi} cm` : '', efw ? `EFW ${efw} g` : '',
  ].filter(Boolean);
  const assessmentBits = [
    gaRaw ? `POG ${gaRaw}` : (trimester ? `Trimester ${trimester}` : ''),
    (gravidity || parity) ? `Obstetric formula ${[gravidity && `G${gravidity}`, parity && `P${parity}`].filter(Boolean).join(' ')}` : '',
    lmp ? `LMP ${lmp}` : '',
  ].filter(Boolean);

  // AUGMENT (never overwrite real GP content on a mixed note): symptoms_notes → complaint AND exam narrative.
  if (symptomLines.length) oc.presentingComplaints = uniq([...oc.presentingComplaints, ...symptomLines]);
  if (symptomLines.length || examBits.length) oc.examination = uniq([...oc.examination, ...symptomLines, ...examBits]);
  if (assessmentBits.length) oc.impressions = uniq([...oc.impressions, ...assessmentBits]);

  oc.isObstetric = true;
  oc.lmp = lmp;   // 0.81.14 — surface the raw LMP for the possible-pregnancy advisory (§2.7); obstetric mandatory-field behaviour is unchanged (driven by oc.obstetric below)
  oc.obstetric = {
    trimester,
    gaDocumented: !!gaRaw || trimester != null,
    lmpOrEddDocumented: !!lmp,
    gravidityParityDocumented: !!gravidity,
    weightDocumented: !!weight,
    sfhDocumented: !!sfh,
    fhrDocumented: !!fhr,
    presentationDocumented: !!presentation,
  };
}

/** 0.81.14 (§2.6, register A-9) — LMP read for the gynae ASSESSMENT template. LIGHTWEIGHT by design:
 *  it reads the menstrual-history LMP (and its notes), stores the raw value on oc.lmp, and emits
 *  `LMP <date>` into the impression text exactly as the obstetric path does at :373 — but it sets
 *  NEITHER isObstetric NOR obstetric, so LMP stays CREDITED and never becomes a mandatory completeness
 *  field. Pure; never throws to the caller (caller wraps). */
function augmentGynaeAssessmentLmp(oc: DeidOpdCase, row: Record<string, unknown>): void {
  const lmp = strOrNull(row['gynae_patient_history__menstrual_history__last_menstrual_period'])
    || strOrNull(row['gynae_patient_history__menstrual_history__notes']);
  if (!lmp) return;
  oc.lmp = lmp;
  oc.impressions = uniq([...oc.impressions, `LMP ${lmp}`]);
}

/** U4-A1 — map the vitals join columns (aliased vitals_* + measurements__*) and the weight/height
 *  projection columns onto the case. Fail-safe in the augmentObstetric shape: the caller wraps, and
 *  any error resets to the safe state (vitalsRecorded false, vitals null) — never a throw into the
 *  audit path, never a wrong value. The LEFT-JOIN existence marker is vitals_consult_uid (the join
 *  key comes back non-null iff a vitals row matched): a row with every measurement blank is still
 *  vitalsRecorded true — "no record" and "a blank record" are different findings. */
function augmentVitals(oc: DeidOpdCase, row: Record<string, unknown>): void {
  oc.weightKg = numOrNull(row['patient_details__weight']);
  oc.heightCm = numOrNull(row['patient_details__height']);
  if (!strOrNull(row['vitals_consult_uid'])) { oc.vitalsRecorded = false; oc.vitals = null; return; }
  const bp = strOrNull(row['measurements__blood_pressure']);
  const m = bp ? bp.match(/^(\d+)\/(\d+)$/) : null;
  // recordedAt: minutes from the note timestamp, as a string — a wall clock could re-identify.
  const noteTs = strOrNull(row.timestamp);
  const vitTs = strOrNull(row['vitals_update_time']);
  let recordedAt: string | null = null;
  if (noteTs && vitTs) {
    const a = new Date(noteTs).getTime(), b = new Date(vitTs).getTime();
    if (Number.isFinite(a) && Number.isFinite(b)) recordedAt = String(Math.round((b - a) / 60000));
  }
  oc.vitalsRecorded = true;
  oc.vitals = {
    bp,
    systolic: m ? parseInt(m[1], 10) : null,
    diastolic: m ? parseInt(m[2], 10) : null,
    pulse: numOrNull(row['measurements__pulse_rate']),
    spo2: numOrNull(row['measurements__spo2_level']),
    temperatureF: numOrNull(row['measurements__temperature']),
    respiratoryRate: strOrNull(row['measurements__respiratory_value']),
    ews: numOrNull(row['measurements__early_warning_score']),
    recordedAt,
  };
}

/** Map a raw prescriptions row → { case (de-identified), keys (for join-back) }. */
export function rowToOpdCase(row: Record<string, unknown>): { case: DeidOpdCase; keys: OpdKeys } {
  const gpPc = row['general_practitioner_prescription__presenting_complaints'];
  const dpx = dpipeDx(row.dpipe_dx);

  const advObj = asObj(row.general_advice);
  const topAdvice: string[] = Array.isArray(advObj)
    ? advObj.map((x) => str(x)).filter(Boolean)
    : (advObj && typeof advObj === 'object' ? Object.values(advObj as Record<string, unknown>).map(str).filter(Boolean) : textsFrom(row.general_advice, ['text', 'advice']));

  // CONTENT: flattened pipeline (dpipe) primary → source nested → top-level fallback.
  // 0.6 — templated patient-education (per-dx general_advice leaflet + any line with a self-care
  // video/link) is separated OUT of the clinician plan so it isn't graded as documentation quality.
  const dPlan = dpipePlan(row.dpipe_pom);
  const clinicianAdviceRaw = uniq(dPlan.length ? dPlan : [...planAdvice(row['general_practitioner_prescription__plan_of_management']), ...gpDiagTreatment(gpPc), ...topAdvice]);
  const advice = clinicianAdviceRaw.filter((l) => !EDU_URL_RE.test(l));
  const patientEducation = uniq([...gpDiagEducation(gpPc), ...clinicianAdviceRaw.filter((l) => EDU_URL_RE.test(l))]);
  const referrals = parseReferrals(row.refer_to);
  const numReferrals = Number(row.num_referrals) || referrals.length;
  const followUpTypeVal = strOrNull(row.followup__followup_type) || strOrNull(row.follow_up_type);
  const isReferralHandoff = referrals.length > 0 || numReferrals > 0 || /referral/i.test(followUpTypeVal || '');
  const examination = htmlToLines(row['general_practitioner_prescription__examination']);
  // 0.81.7 (Fix B): consult_types purpose markers inform the channel; hands-on exam still downgrades.
  const consultTypes = parseConsultTypes(row.consult_types);
  const isTeleconsult = isTeleconsultEncounter(strOrNull(row.type_of_prescription), strOrNull(row.consult_type), consultTypes)
    && !hasHandsOnExam(examination);

  const dComplaints = dpipeText(row.dpipe_pc);
  const nestedComplaints = gpComplaints(gpPc);
  const presentingComplaints = dComplaints.length ? dComplaints
    : (nestedComplaints.length ? nestedComplaints : textsFrom(row.presenting_complaints, ['complaint', 'name', 'text', 'value', 'title']));

  const dInv = dpipeInvestigations(row.dpipe_inv);
  const investigations = dInv.length ? dInv : investigationsFrom(row.further_investigation);

  const followUpDateSet = !!strOrNull(row.next_follow_up_date) || !!strOrNull(row.followup__followup_date) || !!strOrNull(row.expected_resolution_date);

  const oc: DeidOpdCase = {
    consultType: strOrNull(row.consult_type),
    reasonForConsult: strOrNull(row.reason_for_consultation),
    presentingComplaints,
    diagnosisCodes: uniq([...codesFrom(row.diagnosis_icd_codes), ...dpx.codes, ...gpDiagnosisCodes(gpPc)]),
    impressionCodes: codesFrom(row.impression_icd_codes),
    impressions: uniq([...dpx.names, ...gpImpressions(gpPc)]),   // v0.81.1 FIX D: merge, not either/or (a nested diagnosis was dropped when dpipe captured only one)
    history: textsFrom(row.relevant_medical_history, ['text', 'name', 'value', 'condition']),
    comorbidities: textsFrom(row.comorbidities, ['name', 'text', 'condition', 'value']),
    medications: medsFrom(row.medications),
    investigations,
    advice,
    examination,
    allergies: strOrNull(row.patient_details__allergies),
    followUpType: followUpTypeVal,
    followUpDateSet,
    patientEducation,
    isTeleconsult,
    noteDate: strOrNull(row.timestamp) || strOrNull(row._create_time) || strOrNull(row.uploaded_at),   // 0.81.8 bug 4
    consultTypes,
    referrals,
    numReferrals,
    isReferralHandoff,
  };

  // Obstetric-template adapter (§4): when enabled + on the obstetric template, fill the canonical fields
  // the GP mapping left empty from the obstetric block. Fail-safe: any error leaves the GP-mapped case
  // exactly as-is (never a crash, never wrong data).
  // 0.81.14 (§2.6, register A-9): the gynae ASSESSMENT template also carries an LMP the audit was
  // discarding. Read it (CREDITED — emitted into the note text and stored on oc.lmp for the pregnancy
  // advisory) but NEVER make it a mandatory field: this path sets neither isObstetric nor obstetric, so
  // opdCompleteness uses the ordinary GP mandatory set (50.4% of these notes have no LMP and must not be
  // penalised). Same feature flag as the obstetric adapter.
  if (obstetricExtractionEnabled()) {
    const ptype = strOrNull(row.type_of_prescription);
    if (ptype === OBSTETRIC_TYPE) {
      try { augmentObstetric(oc, row); } catch { /* degrade to current behaviour */ }
    } else if (ptype === GYNAE_ASSESSMENT_TYPE) {
      try { augmentGynaeAssessmentLmp(oc, row); } catch { /* degrade to current behaviour */ }
    }
  }

  // U4-A1: vitals + weight/height enter the case ONLY when the flag is on. Fail-safe: any error
  // resets every A1 field to the safe state and touches nothing else on the case; with the flag off
  // the fields stay absent, so every existing literal and every current behaviour is unchanged.
  if (vitalsExtractionEnabled()) {
    try { augmentVitals(oc, row); } catch { oc.vitalsRecorded = false; oc.vitals = null; oc.weightKg = null; oc.heightCm = null; }
  }

  const keys: OpdKeys = {
    uid: strOrNull(row.uid) || strOrNull(row._id),
    consultUid: strOrNull(row.consult_uid),
    doctorUid: strOrNull(row.doctor_uid),
    kxEncounterId: strOrNull(row.kx_encounter_id),
    consultType: strOrNull(row.consult_type),
    prescriptionType: strOrNull(row.type_of_prescription),
    noteDate: strOrNull(row.timestamp) || strOrNull(row._create_time) || strOrNull(row.uploaded_at),
    prescriptionUrl: strOrNull(row.prescription_url),
  };

  return { case: oc, keys };
}

/** One medication line for the LLM, with formulary enrichment when present. */
export function formatOpdMed(m: OpdMed): string {
  const primary = m.resolvedGeneric || m.generic || m.brand || '?';
  const hasGeneric = !!(m.resolvedGeneric || m.generic);
  const brandPart = m.brand && hasGeneric && m.brand.toLowerCase() !== primary.toLowerCase()
    ? ` (brand: ${m.brand})` : '';
  const dosing = [m.strength, m.dose, m.frequency, m.duration, m.route].filter(Boolean).join(', ');
  const tags: string[] = [];
  if (m.therapeuticClass) tags.push(m.therapeuticClass);
  if (m.schedule && m.schedule !== '—') tags.push(`Sch ${m.schedule}`);
  if (m.highAlert) tags.push('HIGH-ALERT (ISMP)');
  if (m.restricted) tags.push('reserve antimicrobial');
  if (m.formularyMatch === 'brand-prefix') tags.push('≈approx match');
  if (m.nonFormulary === 'nutraceutical-cosmetic') tags.push('nutraceutical/cosmetic — not a formulary drug');
  else if (m.nonFormulary === 'non-formulary') tags.push('not in hospital formulary');
  return `${primary}${brandPart}${dosing ? `, ${dosing}` : ''}${m.instruction ? ` (${m.instruction})` : ''}${tags.length ? ` [${tags.join('; ')}]` : ''}`;
}

/** Compact one-line-ish text summary of the de-identified case for the LLM prompt.
 *  `opts.specialty` = the treating clinician's real specialty (from the doctor directory), so the
 *  audit judges a specialist's note against that specialty's standards, not GP defaults (bug B4). */
export function opdCaseText(c: DeidOpdCase, opts?: { specialty?: string | null }): string {
  const lines: string[] = [];
  const specialty = (opts?.specialty || '').trim();
  // BUG-0.81.8-4 (Decision 8): anchor the consult date so the auditor treats THIS encounter as "today" and
  // reads any other date in the narrative as historical. One line, added identically to the base-LLM and the
  // Stage-3 longitudinal digest (the only intended diff on the longitudinal plane).
  if (c.noteDate) lines.push(`Consultation date (the encounter being audited): ${String(c.noteDate).slice(0, 10)} — this is "today" for this note. Any OTHER date appearing in the narrative (history, prior results, past visits) is HISTORICAL context that predates this consult; never read a narrative date as the consult/appointment date or fault the note for a date that is merely older than today.`);
  if (specialty) lines.push(`Treating clinician specialty: ${specialty} — where relevant, judge appropriateness and prescribing against this specialty's standards; a specialist's focused note and specialty-appropriate choices are expected, not general-practice defaults.`);
  if (c.consultType) lines.push(`Consult type: ${c.consultType}`);
  if (c.consultTypes && c.consultTypes.length) lines.push(`Consult purposes: ${c.consultTypes.join(', ')}`);
  if (c.isTeleconsult) lines.push('Encounter modality: TELECONSULT (remote) — a physical examination is not expected; its absence is not a gap.');
  if (c.referrals && c.referrals.length) lines.push(`Referred onward to: ${c.referrals.join('; ')}`);
  if (c.isReferralHandoff) lines.push('Disposition: REFERRAL / HANDOFF encounter — the plan is the onward referral, not definitive treatment. The absence of medications, investigations or imaging is EXPECTED for a handoff and must NOT be read as a deliberate management decision or "avoidance".');
  if (c.isObstetric) lines.push('Encounter: ANTENATAL / OBSTETRIC visit on the hospital obstetric template — the "assessment" is the gestational status (period of gestation / trimester, gravidity–parity), NOT an ICD-coded disease; do NOT fault the absence of an ICD diagnosis code. "Examination" here is the obstetric exam (fundal height, fetal heart, presentation, maternal weight/BP) as appropriate to the trimester.');
  if (c.reasonForConsult) lines.push(`Reason for consult: ${c.reasonForConsult}`);
  lines.push(`Presenting complaints / history: ${c.presentingComplaints.length ? c.presentingComplaints.join('; ') : '(none documented)'}`);
  lines.push(`Diagnosis (ICD-10): ${c.diagnosisCodes.length ? c.diagnosisCodes.join(', ') : (c.impressions.length ? '(clinical diagnosis documented as the impression below; ICD code not auto-resolved)' : '(none documented)')}`);
  if (c.impressions.length) lines.push(`Impression: ${c.impressions.join('; ')}`);
  if (c.impressionCodes.length) lines.push(`Impression (ICD-10): ${c.impressionCodes.join(', ')}`);
  if (c.examination.length) lines.push(`Examination: ${c.examination.join('; ')}`);
  if (c.history.length) lines.push(`Relevant history: ${c.history.join('; ')}`);
  if (c.comorbidities.length) lines.push(`Comorbidities: ${c.comorbidities.join('; ')}`);
  if (c.allergies) lines.push(`Allergies documented: ${c.allergies}`);
  if (c.medications.length === 0) {
    lines.push('Medications (0): NONE prescribed this encounter — there is no prescription to assess for safety; do not raise a prescribing-safety finding.');
  } else {
    lines.push(`Medications (${c.medications.length})  [drug class · D&C schedule · safety tags from the EHRC formulary; "brand:" = the note gave only a proprietary name]:`);
    for (const m of c.medications) {
      lines.push(`  - ${formatOpdMed(m)}`);
    }
  }
  lines.push(`Investigations ordered: ${c.investigations.length ? c.investigations.join('; ') : '(none)'}`);
  lines.push(`Clinician advice / plan: ${c.advice.length ? c.advice.join('; ') : '(none documented)'}`);
  if (c.patientEducation && c.patientEducation.length) {
    lines.push(`Patient-education material attached: ${c.patientEducation.length} item(s) of AUTO-GENERATED templated self-care leaflet (generic exercises / video links). This is NOT clinician-authored documentation — do NOT count it toward note thoroughness, usefulness or synthesis.`);
  }
  lines.push(`Follow-up: ${c.followUpType || '(none)'}${c.followUpDateSet ? ' (date set)' : ' (no date)'}`);
  return lines.join('\n');
}
