// lib/member-state/icd-labels.ts — MemberState clinical-state redesign (member-present/0.2).
// PURE reference data + a resolver. NO I/O, NO Date, NO LLM. The GUARANTEED readable-label path
// for problems whose reconciled concept is a bare ICD-10 code (the "before" state the redesign fixes).
//
// Decision D: prefer the source diagnosis DISPLAY TEXT if the record already carries it (i.e. the
// snapshot concept.raw is human text, not a code); else the bundled map; else code + neutral label.
// The V-ratified ORDER is unchanged by ICD Master Slice 1 — only the "bundled map" layer got
// deeper: curated overrides first, then the full 98k-code db13 snapshot (icd-master.generated).
// Unknown code → the code itself renders with a neutral "(unmapped ICD-10 code)" descriptor —
// never a blank, never a guess.
//
// The master import is DATA ONLY (a generated const in this same module family) — no I/O, purity
// and boundary rule 1 preserved. Server-side only: the artifact is multi-MB.

import { ICD_MASTER } from './icd-master.generated';

/** Curated overrides — clinician-preferred phrasing that WINS over the master's short_desc.
 *  Keys are dotted, upper-case (e.g. "E55.9"). Extend only when the master's own wording reads
 *  badly in the product; everything else should fall through to ICD_MASTER. */
export const ICD_LABEL_OVERRIDES: Record<string, string> = {
  // ── Endocrine / metabolic / nutrition (E) ──
  'E03.9': 'Hypothyroidism',
  'E04.9': 'Goitre',
  'E05.9': 'Hyperthyroidism',
  'E10.9': 'Type 1 diabetes mellitus',
  'E11.9': 'Type 2 diabetes mellitus',
  'E11.65': 'Type 2 diabetes — poor control',
  'E16.2': 'Hypoglycaemia',
  'E27.40': 'Adrenal insufficiency',
  'E28.2': 'Polycystic ovary syndrome (PCOS)',
  'E53.8': 'B-group vitamin deficiency',
  'E55.9': 'Vitamin D deficiency',
  'E56.9': 'Vitamin deficiency',
  'E61.1': 'Iron deficiency',
  'E66.9': 'Obesity',
  'E66.3': 'Overweight',
  'E78.0': 'Hypercholesterolaemia',
  'E78.1': 'Hypertriglyceridaemia',
  'E78.2': 'Mixed hyperlipidaemia',
  'E78.5': 'Hyperlipidaemia',
  'E86.0': 'Dehydration',
  'E87.6': 'Hypokalaemia',
  // ── Blood (D) ──
  'D50.9': 'Iron-deficiency anaemia',
  'D51.9': 'Vitamin B12 deficiency anaemia',
  'D64.9': 'Anaemia',
  // ── Circulatory (I) ──
  'I10': 'Essential hypertension',
  'I10.X': 'Essential hypertension',
  'I25.10': 'Coronary artery disease',
  'I48.91': 'Atrial fibrillation',
  'I73.9': 'Peripheral vascular disease',
  'I83.90': 'Varicose veins',
  'I84.9': 'Haemorrhoids',
  // ── Respiratory (J) ──
  'J00': 'Common cold',
  'J02.9': 'Acute pharyngitis',
  'J03.90': 'Acute tonsillitis',
  'J06.9': 'Upper respiratory infection',
  'J11.1': 'Influenza',
  'J20.9': 'Acute bronchitis',
  'J30.9': 'Allergic rhinitis',
  'J45.909': 'Asthma',
  // ── Digestive (K) ──
  'K21.9': 'Gastro-oesophageal reflux (GERD)',
  'K29.70': 'Gastritis',
  'K30': 'Functional dyspepsia',
  'K52.9': 'Gastroenteritis / colitis',
  'K58.9': 'Irritable bowel syndrome',
  'K59.00': 'Constipation',
  'K80.20': 'Gallstones (cholelithiasis)',
  // ── Skin (L) — incl. cosmetic/incidental (drive the "historical/incidental" tier) ──
  'L20.9': 'Atopic dermatitis / eczema',
  'L23.9': 'Contact dermatitis',
  'L29.9': 'Pruritus',
  'L30.9': 'Dermatitis',
  'L40.9': 'Psoriasis',
  'L50.9': 'Urticaria',
  'L64.9': 'Androgenic alopecia',
  'L65.9': 'Hair loss',
  'L68.0': 'Hirsutism / excess hair',
  'L70.0': 'Acne',
  'L70.9': 'Acne',
  'L81.4': 'Hyperpigmentation',
  'L82.0': 'Seborrheic keratosis (inflamed)',
  'L82.1': 'Seborrheic keratosis (DPN)',
  'L98.9': 'Skin lesion',
  // ── Musculoskeletal (M) ──
  'M06.9': 'Rheumatoid arthritis',
  'M10.9': 'Gout',
  'M17.9': 'Knee osteoarthritis',
  'M25.50': 'Joint pain',
  'M54.5': 'Low back pain',
  'M54.9': 'Back pain',
  'M79.7': 'Fibromyalgia / myalgia',
  'M81.0': 'Osteoporosis',
  // ── Genitourinary (N) — incl. gynaecology ──
  'N39.0': 'Urinary tract infection',
  'N76.0': 'Vaginitis',
  'N77.1': 'Bacterial vaginosis',
  'N80.9': 'Endometriosis',
  'N83.20': 'Ovarian cyst',
  'N91.2': 'Amenorrhoea',
  'N92.0': 'Heavy menstrual bleeding',
  'N94.6': 'Dysmenorrhoea',
  'N95.1': 'Menopausal symptoms',
  'N97.9': 'Female infertility',
  // ── Pregnancy / reproductive counselling (O / Z3) ──
  'O26.9': 'Pregnancy-related condition',
  // ── Mental / behavioural (F) ──
  'F32.9': 'Depression',
  'F41.1': 'Generalised anxiety',
  'F41.9': 'Anxiety',
  'F43.2': 'Adjustment disorder',
  'F51.0': 'Insomnia',
  // ── Symptoms / signs (R) ──
  'R05': 'Cough',
  'R07.9': 'Chest pain',
  'R10.9': 'Abdominal pain',
  'R11.2': 'Nausea & vomiting',
  'R42': 'Dizziness',
  'R51': 'Headache',
  'R53.83': 'Fatigue',
  'R73.09': 'Raised blood glucose',
  // ── Factors / encounters / screening (Z) — incidental exam/screening codes ──
  'Z00.00': 'General health check',
  'Z01.89': 'Health-check examination',
  'Z13.220': 'Lipid-disorder screening',
  'Z30.9': 'Contraceptive counselling',
  'Z31.61': 'Preconception / fertility counselling',
  'Z34.90': 'Antenatal supervision',
  'Z71.3': 'Dietary counselling',
};

/** ICD-10-(CM) code shape: a letter, two digits, optional dotted 1–4 alphanumeric subclass. */
const ICD_RE = /^[A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?$/i;

/** Normalise a candidate to the dotted upper-case map key; '' if it is not code-shaped. */
export function normalizeIcd(code: string | null | undefined): string {
  const s = String(code ?? '').trim().toUpperCase();
  return ICD_RE.test(s) ? s : '';
}

/** Is this ICD code an incidental exam/screening or cosmetic-dermatologic concept? (feeds the
 *  "historical / incidental" tier — Decision E). Deterministic prefix/set rule. */
export function isIncidentalIcd(code: string | null | undefined): boolean {
  const c = normalizeIcd(code);
  if (!c) return false;
  // Z00–Z13 general exam / screening encounters (NOT counselling/contraception/antenatal).
  if (/^Z0[0-9]/.test(c) || /^Z13/.test(c)) return true;
  // Cosmetic-dermatologic lesions/appendage complaints seen as incidental in OPD.
  if (/^L(68|70|81|82)/.test(c)) return true;
  return false;
}

export interface ResolvedLabel { label: string; code: string | null; unmapped: boolean }

/** The layered label lookup: overrides → master, on the exact code first, then (dotted codes
 *  only) the bare 3-char category — but ONLY as an exact master/override key (the master ships
 *  real category rows like "E11"). Never a guess, never a truncation to a non-existent parent. */
function lookupLabel(code: string): string | null {
  const candidates = [code];
  const dot = code.indexOf('.');
  if (dot > 0) candidates.push(code.slice(0, dot));
  for (const c of candidates) {
    const hit = ICD_LABEL_OVERRIDES[c] ?? ICD_MASTER[c];
    if (hit) return hit;
  }
  return null;
}

/** Resolve a problem to a readable label (Decision D). A readable label ALWAYS renders.
 *  - source display text present (raw is human text, not a code) → use it verbatim.
 *  - raw / normalizedConceptId is an ICD code → overrides → master → code + neutral (`unmapped`).
 *  Deterministic; pure. */
export function resolveProblemLabel(problem: { raw: string; normalizedConceptId?: string | null }): ResolvedLabel {
  const raw = String(problem.raw ?? '').trim();
  const rawCode = normalizeIcd(raw);
  const idCode = normalizeIcd(problem.normalizedConceptId);

  // raw is already human display text (not a bare code) → prefer it (source display text).
  if (raw && !rawCode) {
    return { label: raw, code: idCode || null, unmapped: false };
  }
  // raw (or the concept id) is a code → the bundled layers are the guaranteed path.
  const code = rawCode || idCode;
  if (code) {
    const mapped = lookupLabel(code);
    if (mapped) return { label: mapped, code, unmapped: false };
    return { label: `${code} (unmapped ICD-10 code)`, code, unmapped: true };
  }
  // no raw, no code → last-resort neutral (should not happen for a real occurrence).
  return { label: raw || 'Unlabelled problem', code: null, unmapped: true };
}
