/**
 * lib/readmission-reconcile-core.ts — PURE Stage-2 provenance reconciliation (PRD
 * CDMSS-READMISSION-AGENT-PRD-v0.7 §5/§5a/§6, §8c.3, decisions 13/14).
 *
 * No DB, no model, no network. The Vertex passes propose claims (parsed JSON —
 * lib/readmission-prompts.ts); THIS module enforces the reconciliation rules on
 * them, deterministically:
 *
 *   1. Provenance: every evidence item is interested (treating-team prose) or
 *      disinterested (raw lab value, ADT fact, the OTHER team's readmit note).
 *      An avoidable verdict may not rest on interested evidence alone.
 *   2. Temporal provenance for "planned": planned counts ONLY when foreshadowed in
 *      the INDEX summary (written before the outcome). A readmit-note assertion
 *      does not make it planned.
 *   3. Omission audit with the §8c.3 lab-timing coverage gate: confidence scales
 *      with whether the contradicting value is actually near discharge.
 *      admission_only stays get a lower-confidence, clearly-labelled signal —
 *      never a hard "discharged unstable". Missing labs → prose-only track, and
 *      "no contradicting lab" is NEVER "confirmed stable".
 *   4. Same vs different condition by the failing-organ ANALYTE BUNDLE
 *      (renal = creatinine+BUN+K; cardiac = BNP+weight+Na; hepatic =
 *      bilirubin+INR+ammonia), never the diagnosis string a coder can rename.
 *   5. Exculpatory claims ("non-adherent", "justified") stay UNCORROBORATED until
 *      a disinterested source supports them — absent that, the case stays flagged.
 *   6. Two-pass money verdict: both passes must agree AND cite overlapping
 *      evidence ids; same label + disjoint evidence → needs_adjudication.
 *   · Lane D (decision 14): condition pass only; SAME condition → promote to full.
 *   · Out-of-network (decision 13): index-side omission audit only, planned/same
 *     from the CM note, NO avoidable verdict on the other hospital; identity is
 *     authoritative, readmit facts are patient-reported and say so.
 *
 * PHASE 1.5 (substrate addendum, 5 Aug 2026) — this module now consumes the real
 * substrate rather than the metadata table Phase 1 read:
 *   · THREE COVERAGE TIERS (§3). tier1 = structured LOINC-coded lab values inside
 *     the index window → a full NUMERIC omission audit. tier2 = no structured labs
 *     → labs as the doctor wrote them in the index ExtractedCase + the cross-author
 *     readmit case; a summary-vs-summary contradiction, so confidence is CAPPED at
 *     moderate. tier3 = no index discharge PDF → not auditable, never guessed.
 *   · The omission audit is DERIVED deterministically in tier 1 (a stability claim
 *     in the index case vs the latest structured value at/before discharge), not
 *     only proposed by the model. The §8c.3 lab-timing rule applies INSIDE tier 1.
 *   · Same-condition matches on the failing-organ ANALYTE BUNDLE (§4) — a coder
 *     renaming the diagnosis cannot move which organ is failing.
 *
 * LIVE VALIDATION, 6 Aug 2026 (V, on prod) — two corrections to what 1.5 assumed:
 *   · `data_normal_range_report` is a JSON OBJECT ({h, l, t, s}), not a range string.
 *     parseRefRange reads the numeric bounds from l/h. The string-only parser returned
 *     null for every structured row, which would have disabled the tier-1 numeric audit
 *     silently — every other signal would have kept working and nothing would have said
 *     the numbers had stopped being checked.
 *   · `loinc_id` is effectively ABSENT in db13, so same-condition resolves NAME-first
 *     (the analyte names are clean: "Creatinine", "Potassium", "Sodium", …). The LOINC
 *     table is kept as the fallback — harmless where the column is empty, correct the
 *     day it is populated. No numeric behaviour depends on it.
 */

// The only import: the R2 coverage TYPE (lib/readmission-template-core.ts is pure too).
import type { TemplateCoverage } from './readmission-template-core';

// ── Evidence ────────────────────────────────────────────────────────────────────

/** R2 (READMISSIONS-R2 PRD v1.0 §3.3, T-2): source 4 = KX clinical templates — 'ot_note' |
 *  'pac_note' | 'progress_note'. Their weight is decided by SIDE (R2-2, evidenceWeight
 *  below), never by the source name alone. Adding a value here without a case in
 *  evidenceWeight is a compile error — the old silent fall-through is gone. */
export type EvidenceSource = 'index_summary' | 'readmit_summary' | 'lab' | 'adt' | 'cm_form' | 'ot_note' | 'pac_note' | 'progress_note';

/**
 * Where a lab evidence item's number came from (Phase 1.5 §3).
 *   · 'structured'    — individuals-parameter_digital_values: a real numeric value
 *                       against its own reference range. The tier-1 substrate.
 *   · 'extracted_case'— the lab as the doctor WROTE it in the discharge PDF. Tier 2:
 *                       an interested transcription of a number, not an independent one.
 * ABSENT means 'structured': Phase-1 evidence carried numeric KX rows and is read
 * that way so pre-1.5 callers keep their behaviour exactly.
 */
export type LabProvenance = 'structured' | 'extracted_case';

export interface EvidenceItem {
  id: string;
  source: EvidenceSource;
  /** Which stay a lab/fact belongs to. Summaries imply their own side. */
  side?: 'index' | 'readmit' | null;
  text: string;
  at?: string | null;          // ISO timestamp (labs)
  analyte?: string | null;     // canonical analyte, from canonicalAnalyte()
  abnormal?: boolean | null;
  /** Labs only. Undefined = 'structured' (see LabProvenance). */
  labProvenance?: LabProvenance;
  /** Labs only: the numeric value and its reference range, for the derived audit.
   *  `refRange` is deliberately `unknown` — db13 hands back a JSON object
   *  ({h, l, t, s}), the tier-2 path extracts a plain string, and parseRefRange
   *  reads both. Typing it `string` is what hid the object shape in the first place. */
  value?: number | null;
  refRange?: unknown;
}

export interface EvidenceCatalog { items: EvidenceItem[] }

export type EvidenceWeight = 'interested' | 'disinterested' | 'neither';

/**
 * PRD §5 rule 1, made EXHAUSTIVE in R2 (a new EvidenceSource without a branch here no
 * longer compiles, so it can no longer corrupt the provenance ratio silently):
 *   · index_summary — the audited team's own prose: interested.
 *   · lab / adt / readmit_summary — disinterested.
 *   · cm_form — interested-but-not-clinical (§5a): patient-reported, so NOT disinterested
 *     corroboration either.
 *   · ot_note / pac_note / progress_note (R2-2) — by SIDE, mirroring the two summaries:
 *     index-stay template items are interested (the audited team's contemporaneous
 *     record); readmit-stay items are disinterested (the other admission's record). PAC on
 *     pre-admit OPR is index-side. An item with NO side is read as index-side — the
 *     fail-closed weight, since interested evidence can never carry an avoidable verdict.
 */
export function evidenceWeight(item: Pick<EvidenceItem, 'source' | 'side'>): EvidenceWeight {
  switch (item.source) {
    case 'index_summary': return 'interested';
    case 'lab': case 'adt': case 'readmit_summary': return 'disinterested';
    case 'cm_form': return 'neither';
    case 'ot_note': case 'pac_note': case 'progress_note':
      return item.side === 'readmit' ? 'disinterested' : 'interested';
    default: {
      const exhaustive: never = item.source;
      return exhaustive;
    }
  }
}
export function isDisinterested(item: EvidenceItem): boolean {
  return evidenceWeight(item) === 'disinterested';
}
export function isInterested(item: EvidenceItem): boolean {
  return evidenceWeight(item) === 'interested';
}

// ── Analyte bundles (PRD §5 rule 4) ─────────────────────────────────────────────

export const ANALYTE_BUNDLES: Record<string, readonly string[]> = {
  renal: ['creatinine', 'bun', 'potassium'],
  cardiac: ['bnp', 'weight', 'sodium'],
  hepatic: ['bilirubin', 'inr', 'ammonia'],
};

/**
 * LOINC → canonical analyte (addendum §4). The bundle test matches on the CODE, so a
 * coder renaming the diagnosis — or the test — cannot move it. Codes resolve to the
 * SAME canonical analyte names as the name matcher below, so ANALYTE_BUNDLES stays
 * the single definition of what a bundle is.
 *
 * ⚠️ INFERRED that db13's `loinc_id` holds bare LOINC codes in this shape. Consequence
 * drawn: an unrecognised or absent code falls through to the NAME matcher, so a wrong
 * guess costs precision on that row, never a wrong bundle.
 */
export const LOINC_ANALYTES: Record<string, string> = {
  // renal — creatinine + urea/BUN + potassium
  '2160-0': 'creatinine', '38483-4': 'creatinine', '21232-4': 'creatinine',
  '3094-0': 'bun', '6299-2': 'bun', '22664-7': 'bun',
  '2823-3': 'potassium', '6298-4': 'potassium',
  // cardiac — BNP + sodium
  '30934-4': 'bnp', '33762-6': 'bnp', '33763-4': 'bnp',
  '2951-2': 'sodium', '2947-0': 'sodium',
  // hepatic — bilirubin + INR
  '1975-2': 'bilirubin', '1968-7': 'bilirubin', '1971-1': 'bilirubin',
  '6301-6': 'inr', '34714-6': 'inr',
};

/** The bundles as LOINC code sets — the addendum §4 statement of same-condition. */
export const LOINC_BUNDLES: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(ANALYTE_BUNDLES).map(([bundle, analytes]) => [
    bundle,
    Object.entries(LOINC_ANALYTES).filter(([, a]) => analytes.includes(a)).map(([code]) => code),
  ]),
);

const ANALYTE_PATTERNS: Array<[RegExp, string]> = [
  [/creatinin/i, 'creatinine'],
  [/\bbun\b|urea/i, 'bun'],
  [/potassium|\bk\+/i, 'potassium'],
  [/\bnt[- ]?pro[- ]?bnp\b|\bbnp\b/i, 'bnp'],
  [/sodium|\bna\+/i, 'sodium'],
  [/\bweight\b/i, 'weight'],
  [/bilirubin/i, 'bilirubin'],
  [/\binr\b|international normali[sz]ed ratio/i, 'inr'],
  [/ammonia/i, 'ammonia'],
];

/**
 * A different SPECIMEN is a different measurement with a different reference range: a
 * urine sodium is not a serum sodium, and a creatinine CLEARANCE is not a creatinine.
 * Names carrying one of these are left uncanonicalised rather than folded into an organ
 * bundle whose ranges do not apply to them — the wrong-flag risk is not worth the recall.
 */
const OTHER_SPECIMEN = /\b(urine|urinary|24[\s-]*(hr|hour)|clearance|csf|fluid|ascitic|pleural)\b/i;

/**
 * Canonical analyte for a lab test name, or null when it is outside every bundle.
 *
 * VALIDATED 6 Aug 2026 against the live analyte names db13 actually carries
 * ("Creatinine", "Potassium", "Sodium", "Haemoglobin", "Platelet Count", …). This is
 * now the PRIMARY same-condition path — see canonicalAnalyteFor. Names outside the
 * three organ bundles (haemoglobin, platelets) correctly return null: they are real
 * values, they are simply not what the same-condition test is about.
 */
export function canonicalAnalyte(testName: string | null | undefined): string | null {
  if (!testName) return null;
  if (OTHER_SPECIMEN.test(testName)) return null;
  for (const [re, canon] of ANALYTE_PATTERNS) if (re.test(testName)) return canon;
  return null;
}

/** Canonical analyte for a LOINC code. Null when the code is outside every bundle. */
export function analyteFromLoinc(loincId: string | null | undefined): string | null {
  if (!loincId) return null;
  return LOINC_ANALYTES[String(loincId).trim()] ?? null;
}

/**
 * ⚠️ RESOLUTION ORDER CORRECTED 6 Aug 2026 (live validation, V): loinc_id is effectively
 * ABSENT in db13, so the addendum §4 "code decides, name falls back" order had the
 * primary path landing on a column that is never populated. The NAME now decides and the
 * code is the fallback.
 *
 * The LOINC table is kept rather than deleted: it costs nothing where the column is
 * empty, and it is the right answer the day those codes start arriving. NO NUMERIC
 * BEHAVIOUR DEPENDS ON IT — abnormality comes from the value against its own reference
 * range, and same-condition now resolves through the validated name matcher.
 */
export function canonicalAnalyteFor(loincId: string | null | undefined, testName: string | null | undefined): string | null {
  return canonicalAnalyte(testName) ?? analyteFromLoinc(loincId);
}

/** Which bundles a LOINC code belongs to (empty when the code is outside all of them). */
export function bundlesForLoinc(loincId: string | null | undefined): string[] {
  const analyte = analyteFromLoinc(loincId);
  if (!analyte) return [];
  return Object.entries(ANALYTE_BUNDLES).filter(([, list]) => list.includes(analyte)).map(([b]) => b);
}

/**
 * Parse a reference range into numeric bounds. Null when unparseable — and an
 * unparseable range must yield NO numeric flag on that analyte, never a guessed one.
 *
 * ⚠️ CORRECTED 6 Aug 2026 (live validation, V). db13's `data_normal_range_report` is a
 * JSON OBJECT, not a range string:
 *
 *     {"h": 17, "l": 13, "t": "13.0 - 17.0", "s": 2}
 *
 * `l`/`h` are the numeric bounds, `t` a display string, `s` a scale. The original
 * string-only parser stringified the object to "[object Object]", matched nothing, and
 * returned null for EVERY structured row — which would have silently disabled the whole
 * tier-1 numeric audit while every other signal kept working. Bounds are read from l/h
 * numerically; `t` is parsed only when l/h are missing; a plain string still parses, so
 * the doctor-written ranges the tier-2 path extracts are unaffected.
 */
export function parseRefRange(range: unknown): { lo: number; hi: number } | null {
  if (range == null || range === '') return null;

  const ok = (lo: number, hi: number) =>
    Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo ? { lo, hi } : null;

  const fromString = (s: string): { lo: number; hi: number } | null => {
    const m = s.match(/(-?\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(-?\d+(?:\.\d+)?)/);
    return m ? ok(Number(m[1]), Number(m[2])) : null;
  };

  // A JSON object, or the same object handed back as text by a driver that did not parse it.
  let obj: Record<string, unknown> | null = null;
  if (typeof range === 'object') {
    obj = range as Record<string, unknown>;
  } else if (typeof range === 'string' && /^\s*\{/.test(range)) {
    try {
      const parsed: unknown = JSON.parse(range);
      if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>;
    } catch { return null; }   // looked like JSON and was not — refuse, never guess
  }

  if (obj) {
    const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    const lo = num(obj.l), hi = num(obj.h);
    const bounds = ok(lo, hi);
    if (bounds) return bounds;
    // l/h absent or unusable — the display string is the only remaining evidence.
    return typeof obj.t === 'string' ? fromString(obj.t) : null;
  }

  return typeof range === 'string' ? fromString(range) : null;
}

/**
 * The range as written, for the reviewer to read. Prefers the object's display string
 * (`t`) over re-rendering the bounds ourselves — a lab's own wording carries units and
 * sex/age qualifiers that reconstructed bounds would drop.
 */
export function refRangeDisplay(range: unknown): string | null {
  if (range == null || range === '') return null;
  let obj: Record<string, unknown> | null = null;
  if (typeof range === 'object') obj = range as Record<string, unknown>;
  else if (typeof range === 'string' && /^\s*\{/.test(range)) {
    try { const p: unknown = JSON.parse(range); if (p && typeof p === 'object') obj = p as Record<string, unknown>; } catch { /* fall through to the raw string */ }
  }
  if (obj) {
    if (typeof obj.t === 'string' && obj.t.trim()) return obj.t.trim();
    const b = parseRefRange(obj);
    return b ? `${b.lo} - ${b.hi}` : null;
  }
  return typeof range === 'string' ? range : null;
}

/** Abnormality from an explicit flag first, else value-vs-range. Null = unknown. */
export function labAbnormal(value: number | null, flag: string | null | undefined, range: unknown): boolean | null {
  if (flag != null && String(flag).trim() !== '') {
    const f = String(flag).trim().toLowerCase();
    if (/^(h|hh|l|ll|high|low|abnormal|critical|panic|\*)$/.test(f)) return true;
    if (/^(n|normal|wnl)$/.test(f)) return false;
  }
  const r = parseRefRange(range);
  if (r && value != null && Number.isFinite(value)) return value < r.lo || value > r.hi;
  return null;
}

/** Which bundles have at least one abnormal analyte among these lab items. */
export function abnormalBundles(items: EvidenceItem[]): string[] {
  const abnormalAnalytes = new Set(
    items.filter((i) => i.source === 'lab' && i.abnormal === true && i.analyte).map((i) => i.analyte as string),
  );
  return Object.entries(ANALYTE_BUNDLES)
    .filter(([, analytes]) => analytes.some((a) => abnormalAnalytes.has(a)))
    .map(([bundle]) => bundle);
}

// ── Lab-timing coverage gate (§8c.3) ────────────────────────────────────────────

export type LabTimingProfile = 'no_labs' | 'short_stay' | 'has_late_labs' | 'admission_only';

const H = 3_600_000;
const parseTs = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(s) ? s.replace(' ', 'T') : s);
  return Number.isFinite(t) ? t : null;
};

/**
 * Tag the index stay's lab-timing profile. Only 14% of LOS≥2 stays have any lab
 * after admission+24h (measured §8c.3) — the omission audit cannot assume a "last
 * value before discharge" exists.
 */
export function labTimingProfile(
  labs: Array<{ at: string | null }>,
  admitAt: string | null,
  dischargeAt: string | null,
): LabTimingProfile {
  if (!labs.length) return 'no_labs';
  const admit = parseTs(admitAt);
  const disch = parseTs(dischargeAt);
  // Short stay: admission bloods sit within 48h of discharge, so they ARE near-discharge.
  if (admit != null && disch != null && disch - admit <= 48 * H) return 'short_stay';
  if (admit != null && labs.some((l) => { const t = parseTs(l.at); return t != null && t > admit + 24 * H; })) {
    return 'has_late_labs';
  }
  return 'admission_only';
}

// ── Coverage tiers (addendum §3) ────────────────────────────────────────────────

export type LabTier = 'tier1' | 'tier2' | 'tier3';

/** What the omission audit was actually built from — carried onto the finding row. */
export interface LabSourceProvenance {
  tier: LabTier;
  /** Structured LOINC-coded values found inside the index window. */
  structuredLabCount: number;
  /** [index_admission − 14d, index_discharge + 2d], as sent to db13. Null when unresolved. */
  window: { from: string; to: string } | null;
  /** True when the window START was derived (no admission timestamp) — see run.ts. */
  windowStartInferred?: boolean;
  /** Labs read out of the index ExtractedCase's investigations[] (the tier-2 substrate). */
  caseLabCount: number;
  /** Where each ExtractedCase came from: the shared store, a fresh extract, or nowhere. */
  indexCase: 'store' | 'fresh_extract' | null;
  readmitCase: 'store' | 'fresh_extract' | null;
  extractionVersion: string | null;
  indexDocumentId: string | null;
  readmitDocumentId: string | null;
}

/**
 * The confidence FLOOR (§3), decided before a model is asked anything:
 *   no index case            → tier3, not auditable (never guessed)
 *   structured labs in window→ tier1, full numeric omission audit
 *   otherwise                → tier2, PDF-only, medium confidence
 */
export function resolveLabTier(args: { hasIndexCase: boolean; structuredLabsInWindow: number }): {
  tier: LabTier; notAuditableReason?: string;
} {
  if (!args.hasIndexCase) {
    return { tier: 'tier3', notAuditableReason: 'no index discharge-summary PDF could be read — not auditable' };
  }
  return { tier: args.structuredLabsInWindow > 0 ? 'tier1' : 'tier2' };
}

/** Labs whose number is an independent structured value (undefined provenance = structured). */
const isStructuredLab = (i: EvidenceItem): boolean =>
  i.source === 'lab' && (i.labProvenance == null || i.labProvenance === 'structured');

/**
 * Tier for a catalog when the caller did not state one (pre-1.5 callers and the pure
 * tests). Structured lab items ⇒ tier1; an index narrative but no structured value ⇒
 * tier2; nothing on the index side ⇒ tier3.
 */
export function inferLabTier(catalog: EvidenceCatalog): LabTier {
  if (catalog.items.some((i) => isStructuredLab(i) && i.side === 'index')) return 'tier1';
  const hasIndexNarrative = catalog.items.some((i) => i.source === 'index_summary');
  return hasIndexNarrative ? 'tier2' : 'tier3';
}

// ── The derived numeric omission audit (tier 1) ─────────────────────────────────

/**
 * Stability claims in the INDEX narrative — the sentences the numbers are checked
 * against. Deliberately narrow: a claim about the patient's condition AT DISCHARGE,
 * not any mention of the word "stable" (a stable-angina diagnosis is not a claim).
 */
export function findStabilityClaims(catalog: EvidenceCatalog): EvidenceItem[] {
  const CLAIM = /\b(stable|afebrile|improv(ed|ing)|uneventful|satisfactory|asymptomatic|well[- ]tolerated|vitals?\s+(are\s+|were\s+)?(normal|stable)|condition\s+(at|on)\s+discharge)\b/i;
  const NOT_A_CLAIM = /\b(stable angina|haemodynamically unstable|not stable|unstable)\b/i;
  return catalog.items.filter((i) =>
    i.source === 'index_summary' && CLAIM.test(i.text) && !NOT_A_CLAIM.test(i.text));
}

/**
 * The LATEST structured value per analyte at/before discharge — the number a "stable at
 * discharge" claim is actually answerable by. Labs with no timestamp are kept as
 * last resort (they are still the patient's own values) but sort behind timed ones.
 */
export function latestValuePerAnalyte(catalog: EvidenceCatalog, indexDischargeAt: string | null): Map<string, EvidenceItem> {
  const disch = parseTs(indexDischargeAt);
  const best = new Map<string, EvidenceItem>();
  for (const i of catalog.items) {
    if (!isStructuredLab(i) || i.side !== 'index' || !i.analyte) continue;
    const t = parseTs(i.at);
    if (disch != null && t != null && t > disch) continue;   // after discharge — not what discharge knew
    const cur = best.get(i.analyte);
    if (!cur) { best.set(i.analyte, i); continue; }
    const curT = parseTs(cur.at);
    if (t != null && (curT == null || t > curT)) best.set(i.analyte, i);
  }
  return best;
}

/**
 * TIER 1 ONLY. Flags each index stability claim the last real number contradicts —
 * deterministically, from the values themselves, so the finding does not depend on the
 * model having noticed. §8c.3 timing rule applies HERE: a value dated only at admission
 * is a low-confidence, clearly-labelled signal, never a "discharged unstable" claim.
 *
 * Danger ranks by whether the analyte sits in a failing-organ bundle, not by count.
 */
export function deriveNumericOmissions(args: {
  catalog: EvidenceCatalog;
  tier: LabTier;
  labProfile: LabTimingProfile;
  indexDischargeAt: string | null;
}): ReadmissionFinding['omissions'] {
  if (args.tier !== 'tier1') return [];
  const claims = findStabilityClaims(args.catalog);
  if (!claims.length) return [];   // nothing was claimed — there is no omission to audit
  const disch = parseTs(args.indexDischargeAt);
  const out: ReadmissionFinding['omissions'] = [];
  for (const [analyte, lab] of latestValuePerAnalyte(args.catalog, args.indexDischargeAt)) {
    if (lab.abnormal !== true) continue;
    const t = parseTs(lab.at);
    const nearDischarge = disch != null && t != null && t >= disch - 48 * H;
    let confidence: 'high' | 'moderate' | 'low';
    let caveat: string | undefined;
    if (nearDischarge || args.labProfile === 'short_stay') {
      confidence = 'high';
    } else if (args.labProfile === 'has_late_labs') {
      confidence = 'moderate';
      caveat = 'the last value for this analyte is not from the final 48h before discharge';
    } else {
      confidence = 'low';
      caveat = 'admission-only labs: the abnormal value is from the admission workup and may have corrected before discharge — not a "discharged unstable" claim';
    }
    const inBundle = Object.values(ANALYTE_BUNDLES).some((list) => list.includes(analyte));
    out.push({
      claim: `index summary claims stability; last ${analyte} at/before discharge is outside its reference range (${lab.text})`,
      danger: inBundle ? 'high' : 'moderate',
      confidence,
      ...(caveat ? { caveat } : {}),
      evidenceIds: [claims[0].id, lab.id],
      source: 'derived',
    });
  }
  const rank = { high: 0, moderate: 1, low: 2 };
  return out.sort((a, b) => rank[a.danger] - rank[b.danger]);
}

/**
 * Merge the deterministic tier-1 findings with the model's proposals. The DERIVED row
 * wins a collision (same contradicting lab): it is anchored to the number itself, where
 * the model's is anchored to its own reading of the number.
 */
export function mergeOmissions(
  derived: ReadmissionFinding['omissions'],
  modelScored: ReadmissionFinding['omissions'],
): ReadmissionFinding['omissions'] {
  const key = (o: ReadmissionFinding['omissions'][number]) => o.evidenceIds.slice().sort().join('|');
  const seen = new Set(derived.map(key));
  const merged = [...derived, ...modelScored.filter((o) => !seen.has(key(o)))];
  const rank = { high: 0, moderate: 1, low: 2 };
  return merged.sort((a, b) => rank[a.danger] - rank[b.danger]);
}

// ── Model-pass claims (parsed JSON — lib/readmission-prompts.ts) ────────────────

export interface PassClaims {
  planned?: { verdict: 'planned' | 'unplanned' | 'unknown'; evidenceIds: string[]; rationale?: string } | null;
  sameCondition?: { verdict: 'same' | 'different' | 'unknown'; organBundle?: string | null; evidenceIds: string[]; rationale?: string } | null;
  omissions?: Array<{ claim: string; claimEvidenceId?: string | null; contradictingEvidenceIds: string[]; danger: 'high' | 'moderate' | 'low'; rationale?: string }> | null;
  exculpatory?: Array<{ claim: string; claimEvidenceId?: string | null; corroboratingEvidenceIds: string[] }> | null;
  avoidable?: { verdict: 'avoidable' | 'justified' | 'uncertain'; evidenceIds: string[]; rationale?: string } | null;
  weakestStep?: string | null;
  refusalRecord?: Array<{ lookedFor: string; found: boolean; note?: string }> | null;
}

// ── The finding ─────────────────────────────────────────────────────────────────

export type AvoidableVerdict = 'avoidable' | 'justified' | 'needs_adjudication';

export interface ReadmissionFinding {
  findingClass: 'even_even' | 'out_of_network';
  verdictScope: 'pair' | 'index_side_only';
  planned: { verdict: 'planned' | 'unplanned' | 'unknown'; confidence: number; evidenceIds: string[]; enforcement?: string } | null;
  sameCondition: { verdict: 'same' | 'different' | 'unknown'; confidence: number; basis: 'analyte_bundle' | 'model_prose' | 'patient_reported'; bundles: string[]; evidenceIds: string[] } | null;
  /** `source` (1.5): 'derived' = computed from the numbers themselves (tier 1);
   *  'model' = proposed by a Vertex pass and then scored against the timing rule. */
  omissions: Array<{ claim: string; danger: 'high' | 'moderate' | 'low'; confidence: 'high' | 'moderate' | 'low'; caveat?: string; evidenceIds: string[]; source?: 'derived' | 'model' }>;
  exculpatory: Array<{ claim: string; corroborated: boolean; corroboratingIds: string[] }>;
  /** null on condition-only (lane D first pass) and ALWAYS null out-of-network. */
  avoidable: { verdict: AvoidableVerdict; evidenceIds: string[]; reason?: string } | null;
  /** Decision 14: lane-D condition pass came back SAME → run the full reconciliation. */
  promoteToFull?: boolean;
  labProfile: LabTimingProfile;
  /** Phase 1.5 §3 — the coverage tier this finding was built under, and what from. */
  labTier: LabTier;
  labSourceProvenance?: LabSourceProvenance | null;
  /** R2 §3.4 — what was looked for in db13 templates and what was found, five honest
   *  states per source. ABSENT from the blob = never looked (tier-3 / pre-R2 rows) → the
   *  chip reads `unknown`. Blob-only; no column, no migration. */
  templateCoverage?: TemplateCoverage | null;
  /** Never 'corroborated' from absence of labs (§5 rule 6). */
  stabilityAssessment: 'contradicted' | 'corroborated' | 'unverifiable';
  corroborationTrack: 'lab_corroborated' | 'prose_only';
  provenance: { interested: number; disinterested: number; ratio: number; needsHumanReview: boolean };
  weakestStep: string | null;
  refusalRecord: Array<{ lookedFor: string; found: boolean; note?: string }>;
  /** Out-of-network honesty (§5a). */
  readmitFactsPatientReported?: boolean;
  identityResolved?: boolean;
}

export interface ReconcileInput {
  findingClass: 'even_even' | 'out_of_network';
  catalog: EvidenceCatalog;
  labProfile: LabTimingProfile;
  indexDischargeAt: string | null;
  passA: PassClaims | null;
  /** The second, differently-prompted avoidable pass. Required for a full even_even audit. */
  passB: PassClaims | null;
  /** Lane D first pass (decision 9): same/different-condition only. */
  conditionOnly?: boolean;
  formFlags?: { isPlanned: boolean | null; sameCondition: boolean | null } | null;
  /** Phase 1.5 §3. Omitted → inferred from the catalog (inferLabTier), so pre-1.5
   *  callers keep their exact behaviour. */
  labTier?: LabTier;
  labSourceProvenance?: LabSourceProvenance | null;
  /** R2: rides the finding unchanged and writes the constraint-21 refusal lines. */
  templateCoverage?: TemplateCoverage | null;
}

const byId = (catalog: EvidenceCatalog) => {
  const m = new Map<string, EvidenceItem>();
  for (const i of catalog.items) m.set(i.id, i);
  return m;
};
const validIds = (ids: string[] | undefined | null, m: Map<string, EvidenceItem>): string[] =>
  Array.from(new Set((ids ?? []).filter((id) => m.has(id))));

// ── Rule 2: temporal provenance for "planned" ───────────────────────────────────

export function enforcePlanned(
  claim: PassClaims['planned'],
  catalog: EvidenceCatalog,
  findingClass: 'even_even' | 'out_of_network',
  formFlags?: ReconcileInput['formFlags'],
): ReadmissionFinding['planned'] {
  const m = byId(catalog);
  if (!claim) {
    // Out-of-network may classify planned from the form flag alone (§5a).
    if (findingClass === 'out_of_network' && formFlags?.isPlanned != null) {
      return { verdict: formFlags.isPlanned ? 'planned' : 'unplanned', confidence: 0.5, evidenceIds: [], enforcement: 'from-cm-form-flag' };
    }
    return null;
  }
  const ids = validIds(claim.evidenceIds, m);
  if (claim.verdict !== 'planned') {
    return { verdict: claim.verdict, confidence: 0.7, evidenceIds: ids };
  }
  // "Planned" must be foreshadowed BEFORE the outcome: index summary for even_even;
  // the CM note / form flag is the only record out-of-network has (§5a).
  const allowed: EvidenceSource[] = findingClass === 'out_of_network' ? ['cm_form', 'index_summary'] : ['index_summary'];
  const foreshadowed = ids.some((id) => allowed.includes(m.get(id)!.source));
  const formPlanned = findingClass === 'out_of_network' && formFlags?.isPlanned === true;
  if (foreshadowed || formPlanned) {
    return { verdict: 'planned', confidence: 0.8, evidenceIds: ids };
  }
  return {
    verdict: 'unplanned', confidence: 0.6, evidenceIds: ids,
    enforcement: 'planned-claim-rejected: intent asserted only after the outcome (readmit-side), not foreshadowed in the index summary',
  };
}

// ── Rule 4: same condition by physiology ────────────────────────────────────────

export function resolveSameCondition(
  claim: PassClaims['sameCondition'],
  catalog: EvidenceCatalog,
  formFlags?: ReconcileInput['formFlags'],
): ReadmissionFinding['sameCondition'] {
  const m = byId(catalog);
  const indexLabs = catalog.items.filter((i) => i.source === 'lab' && i.side === 'index');
  const readmitLabs = catalog.items.filter((i) => i.source === 'lab' && i.side === 'readmit');
  const idxBundles = abnormalBundles(indexLabs);
  const rdBundles = abnormalBundles(readmitLabs);
  const shared = idxBundles.filter((b) => rdBundles.includes(b));
  const labIds = (bundles: string[]) => catalog.items
    .filter((i) => i.source === 'lab' && i.abnormal === true && i.analyte
      && bundles.some((b) => ANALYTE_BUNDLES[b]?.includes(i.analyte as string)))
    .map((i) => i.id);

  // The analyte bundle DECIDES when it can (rule 4) — a renamed diagnosis string cannot move it.
  if (shared.length) {
    return { verdict: 'same', confidence: 0.9, basis: 'analyte_bundle', bundles: shared, evidenceIds: labIds(shared) };
  }
  if (idxBundles.length && rdBundles.length) {
    return { verdict: 'different', confidence: 0.7, basis: 'analyte_bundle', bundles: Array.from(new Set([...idxBundles, ...rdBundles])), evidenceIds: labIds([...idxBundles, ...rdBundles]) };
  }
  // Insufficient physiology on one/both sides → the model's prose judgment, at reduced confidence.
  if (claim) {
    return { verdict: claim.verdict, confidence: 0.6, basis: 'model_prose', bundles: [], evidenceIds: validIds(claim.evidenceIds, m) };
  }
  if (formFlags?.sameCondition != null) {
    return { verdict: formFlags.sameCondition ? 'same' : 'different', confidence: 0.4, basis: 'patient_reported', bundles: [], evidenceIds: [] };
  }
  return null;
}

// ── Rule 3 + coverage gate: the omission audit ──────────────────────────────────

export function scoreOmissions(
  omissions: NonNullable<PassClaims['omissions']>,
  catalog: EvidenceCatalog,
  labProfile: LabTimingProfile,
  indexDischargeAt: string | null,
  tier: LabTier = 'tier1',
): ReadmissionFinding['omissions'] {
  const m = byId(catalog);
  const disch = parseTs(indexDischargeAt);
  const out: ReadmissionFinding['omissions'] = [];
  // §3 tier 3: no index PDF was read at all, so there is nothing to audit an omission
  // against. Anything the model volunteered here rests on no index evidence.
  if (tier === 'tier3') return out;
  for (const o of omissions) {
    const ids = validIds(o.contradictingEvidenceIds, m);
    const labItems = ids.map((id) => m.get(id)!).filter((i) => i.source === 'lab');
    if (!labItems.length) continue;   // a lab-omission claim with no surviving lab evidence is dropped
    const nearDischarge = disch != null && labItems.some((l) => {
      const t = parseTs(l.at);
      return t != null && t <= disch && t >= disch - 48 * H;
    });
    let confidence: 'high' | 'moderate' | 'low';
    let caveat: string | undefined;
    if (nearDischarge || labProfile === 'short_stay') {
      confidence = 'high';
    } else if (labProfile === 'has_late_labs') {
      confidence = 'moderate';
      caveat = 'contradicting value is not from the final 48h before discharge';
    } else {
      // admission_only: an admission abnormality expected to correct is NOT evidence of
      // premature discharge (§8c.3) — lower-confidence, clearly labelled, never a hard claim.
      confidence = 'low';
      caveat = 'admission-only labs: the abnormal value is from the admission workup and may have corrected before discharge — not a "discharged unstable" claim';
    }
    // §3 tier 2 CEILING: with no structured value, the contradiction is summary-vs-summary
    // (the treating team's own transcription of a number, plus the other team's account).
    // That is a medium-confidence signal by construction — it can never read as high.
    if (tier === 'tier2' && confidence === 'high') {
      confidence = 'moderate';
      caveat = 'tier 2: no structured lab value exists for this stay — the contradiction rests on the labs as the doctor wrote them, not on an independent number';
    }
    const claimIds = o.claimEvidenceId && m.has(o.claimEvidenceId) ? [o.claimEvidenceId] : [];
    out.push({ claim: o.claim, danger: o.danger, confidence, ...(caveat ? { caveat } : {}), evidenceIds: [...claimIds, ...ids], source: 'model' });
  }
  const rank = { high: 0, moderate: 1, low: 2 };
  out.sort((a, b) => rank[a.danger] - rank[b.danger]);   // ranked by clinical danger, not count
  return out;
}

// ── Rule 5: exculpatory needs corroboration ─────────────────────────────────────

export function checkExculpatory(
  claims: NonNullable<PassClaims['exculpatory']>,
  catalog: EvidenceCatalog,
): ReadmissionFinding['exculpatory'] {
  const m = byId(catalog);
  return claims.map((c) => {
    const ids = validIds(c.corroboratingEvidenceIds, m).filter((id) => isDisinterested(m.get(id)!));
    return { claim: c.claim, corroborated: ids.length > 0, corroboratingIds: ids };
  });
}

// ── The two-pass money verdict (§5 two-pass rule + rules 1/5) ───────────────────

export function twoPassAvoidable(
  a: PassClaims['avoidable'],
  b: PassClaims['avoidable'],
  catalog: EvidenceCatalog,
  exculpatory: ReadmissionFinding['exculpatory'],
  omissions: ReadmissionFinding['omissions'],
): NonNullable<ReadmissionFinding['avoidable']> {
  const m = byId(catalog);
  if (!a || !b) {
    return { verdict: 'needs_adjudication', evidenceIds: [], reason: 'missing a pass — the money verdict is only ever produced twice' };
  }
  if (a.verdict !== b.verdict) {
    return { verdict: 'needs_adjudication', evidenceIds: [], reason: `passes disagree (${a.verdict} vs ${b.verdict})` };
  }
  const idsA = validIds(a.evidenceIds, m);
  const idsB = validIds(b.evidenceIds, m);
  const overlap = idsA.filter((id) => idsB.includes(id));
  if (a.verdict === 'avoidable') {
    if (!overlap.length) {
      return { verdict: 'needs_adjudication', evidenceIds: Array.from(new Set([...idsA, ...idsB])), reason: 'same label, disjoint evidence — a single hallucinated citation cannot survive this' };
    }
    // Rule 1: an avoidable verdict may not rest on interested evidence alone.
    if (overlap.every((id) => isInterested(m.get(id)!))) {
      return { verdict: 'needs_adjudication', evidenceIds: overlap, reason: 'avoidable rested on treating-team prose alone — no disinterested support' };
    }
    return { verdict: 'avoidable', evidenceIds: overlap };
  }
  if (a.verdict === 'justified') {
    // Rule 5: an uncorroborated exculpatory claim does not clear the case.
    if (exculpatory.length && exculpatory.every((e) => !e.corroborated) && omissions.length) {
      return { verdict: 'needs_adjudication', evidenceIds: Array.from(new Set([...idsA, ...idsB])), reason: 'justification rests on uncorroborated exculpatory claims while omission flags stand — stays flagged, not cleared' };
    }
    return { verdict: 'justified', evidenceIds: Array.from(new Set([...idsA, ...idsB])) };
  }
  return { verdict: 'needs_adjudication', evidenceIds: Array.from(new Set([...idsA, ...idsB])), reason: 'both passes uncertain' };
}

// ── Assembly ────────────────────────────────────────────────────────────────────

export function reconcileFinding(input: ReconcileInput): ReadmissionFinding {
  const { catalog, labProfile } = input;
  const m = byId(catalog);
  const oon = input.findingClass === 'out_of_network';
  const a = input.passA ?? {};
  const b = input.passB ?? {};

  const labTier = input.labTier ?? inferLabTier(catalog);
  const labSourceProvenance = input.labSourceProvenance ?? null;
  const templateCoverage = input.templateCoverage ?? null;

  const sameCondition = resolveSameCondition(a.sameCondition ?? null, catalog, input.formFlags);

  if (input.conditionOnly) {
    return {
      findingClass: input.findingClass, verdictScope: 'pair',
      planned: null, sameCondition, omissions: [], exculpatory: [], avoidable: null,
      promoteToFull: sameCondition?.verdict === 'same',
      labProfile, labTier, labSourceProvenance, templateCoverage,
      stabilityAssessment: 'unverifiable', corroborationTrack: labProfile === 'no_labs' ? 'prose_only' : 'lab_corroborated',
      provenance: provenanceOf([...(sameCondition?.evidenceIds ?? [])], m),
      weakestStep: a.weakestStep ?? null,
      refusalRecord: [...(a.refusalRecord ?? []), ...templateRefusalLines(templateCoverage)],
    };
  }

  const planned = enforcePlanned(a.planned ?? null, catalog, input.findingClass, input.formFlags);
  // The numbers speak first (tier 1), then the model's proposals are scored under the
  // same timing rule and merged behind them.
  //
  // The derived audit runs ONLY on an EXPLICITLY stated tier 1 — never on an inferred
  // one. A tier is an attestation that these numbers came from the structured lab
  // pipeline with a real reference range, and only lib/readmission/assemble.ts can make
  // it. An inferred tier is a guess about a catalog's shape; deriving a clinical finding
  // from a guess is exactly what §3 exists to prevent. It also means every pre-1.5
  // caller keeps its behaviour byte-for-byte.
  const derived = input.labTier === 'tier1'
    ? deriveNumericOmissions({ catalog, tier: 'tier1', labProfile, indexDischargeAt: input.indexDischargeAt })
    : [];
  const omissions = mergeOmissions(
    derived,
    scoreOmissions(a.omissions ?? [], catalog, labProfile, input.indexDischargeAt, labTier),
  );
  const exculpatory = checkExculpatory(a.exculpatory ?? [], catalog);

  // §5a: no avoidable/for-money verdict on the other hospital. Ever.
  const avoidable = oon ? null : twoPassAvoidable(a.avoidable ?? null, b.avoidable ?? null, catalog, exculpatory, omissions);

  const citedIds = Array.from(new Set([
    ...(planned?.evidenceIds ?? []),
    ...(sameCondition?.evidenceIds ?? []),
    ...omissions.flatMap((o) => o.evidenceIds),
    ...(avoidable?.evidenceIds ?? []),
  ]));
  const provenance = provenanceOf(citedIds, m);

  // Coverage honesty (§5 rule 6): absence of labs is never confirmation of stability.
  // Only a STRUCTURED value can corroborate a stability claim (§3): the doctor's own
  // transcription of a number cannot corroborate the doctor's own claim.
  const hasIndexLabs = catalog.items.some((i) => i.source === 'lab' && i.side === 'index');
  const stabilityAssessment: ReadmissionFinding['stabilityAssessment'] =
    omissions.length ? 'contradicted'
      : labTier === 'tier1' && (labProfile === 'short_stay' || labProfile === 'has_late_labs') ? 'corroborated'
        : 'unverifiable';
  const corroborationTrack: ReadmissionFinding['corroborationTrack'] = hasIndexLabs ? 'lab_corroborated' : 'prose_only';

  const refusal: ReadmissionFinding['refusalRecord'] = [...(a.refusalRecord ?? [])];
  if (labProfile === 'no_labs') refusal.push({ lookedFor: 'any lab result for the index stay', found: false, note: 'verdict rests on the treating team’s own prose (prose-only track)' });
  if (labProfile === 'admission_only') refusal.push({ lookedFor: 'labs drawn after admission+24h', found: false, note: 'admission workup only — no near-discharge values exist' });
  if (labTier === 'tier2') refusal.push({ lookedFor: 'structured lab values for this patient inside the index window', found: false, note: 'tier 2: labs are the ones the doctor wrote in the discharge summary, cross-read against the readmit team’s account — a summary-vs-summary contradiction, not an independent numeric one' });
  if (labTier === 'tier3') refusal.push({ lookedFor: 'an index discharge-summary PDF', found: false, note: 'tier 3: no index document could be read — this pair is not auditable' });
  if (oon) refusal.push({ lookedFor: 'a readmit discharge summary', found: false, note: 'the readmission happened outside Even; readmit facts are patient-reported via the CM note' });
  refusal.push(...templateRefusalLines(templateCoverage));

  return {
    findingClass: input.findingClass,
    verdictScope: oon ? 'index_side_only' : 'pair',
    planned, sameCondition, omissions, exculpatory, avoidable,
    labProfile, labTier, labSourceProvenance, templateCoverage, stabilityAssessment, corroborationTrack, provenance,
    weakestStep: a.weakestStep ?? null,
    refusalRecord: refusal,
    ...(oon ? { readmitFactsPatientReported: true, identityResolved: true } : {}),
  };
}

/**
 * R2 constraint 21: every template fetch that RAN writes a refusal-record line
 * `{ lookedFor: 'ot_note' | 'pac_note' | 'progress_note', found }`. A chip `absent` MUST
 * correspond to found:false; `empty` (rows exist, no usable text) is also found:false — no
 * usable text was found — with the note saying why; `present` writes found:true so the
 * record is complete; `fetch_failed` writes NOTHING (the look did not complete → chip
 * `unknown` ↔ unwritten line). Never-looked → coverage null → nothing written.
 */
export function templateRefusalLines(cov: TemplateCoverage | null | undefined): ReadmissionFinding['refusalRecord'] {
  if (!cov) return [];
  const out: ReadmissionFinding['refusalRecord'] = [];
  const one = (lookedFor: 'ot_note' | 'pac_note' | 'progress_note', e: TemplateCoverage[keyof TemplateCoverage] | undefined) => {
    if (!e) return;
    switch (e.status) {
      case 'present': out.push({ lookedFor, found: true, note: `${e.count} row(s) with usable text` }); break;
      case 'empty': out.push({ lookedFor, found: false, note: `${e.count} row(s) exist but none carries usable text` }); break;
      case 'absent': out.push({ lookedFor, found: false, note: 'no row in db13 for this stay/window' }); break;
      case 'fetch_failed': break;   // deliberately unwritten — the look did not complete
    }
  };
  one('ot_note', cov.ot);
  one('pac_note', cov.pac);
  one('progress_note', cov.progress);
  return out;
}

function provenanceOf(citedIds: string[], m: Map<string, EvidenceItem>): ReadmissionFinding['provenance'] {
  const items = citedIds.map((id) => m.get(id)).filter((i): i is EvidenceItem => !!i);
  const interested = items.filter(isInterested).length;
  const disinterested = items.filter(isDisinterested).length;
  // PRD §6: disinterested support divided by interested support. A verdict resting
  // only on treating-team prose scores low and auto-routes to human review.
  const ratio = interested > 0 ? disinterested / interested : disinterested;
  return { interested, disinterested, ratio, needsHumanReview: disinterested === 0 };
}

// ── R1 advisory judgements (CDMSS-READMISSIONS-R1-PRD v1.1 §4, ratified 17 Aug 2026) ────
//
// Two STORED, human-decided, advisory judgements derived deterministically from a finding
// — never a legal finding, never a court or council finding. Pure: no DB, no model. The
// same function runs at audit time (store.saveAuditResult) and in the versioned backfill
// (migrate-readmissions), reading the `finding` jsonb; the input type below is therefore
// a structural SUBSET with every field optional, so an older stored blob is data, not a
// type guarantee. A rule-list change bumps JUDGEMENT_RULE_VERSION and the same backfill
// re-derives every audited row — nothing goes silently stale.
//
// Medical justification is a DISPLAY mapping of `avoidable` (lib/readmission-surface-core.ts),
// not stored here — it is already the stored money verdict.

export type JudgementValue = 'suspected' | 'not_suggested' | 'unknown';

/** Bump when CLINICAL_HARM_STEMS / PERI_OP_EVENT_PATTERNS or the rule order change. */
export const JUDGEMENT_RULE_VERSION = 'readmit-judgement/1';

export interface Judgements {
  preventableInjury: JudgementValue;
  negligence: JudgementValue;
}

/** Everything deriveJudgements reads. ReadmissionFinding satisfies it structurally, and
 *  so does a parsed `finding` blob written by an older engine (all optional). */
export interface JudgementInput {
  planned?: { verdict?: string | null } | null;
  sameCondition?: { verdict?: string | null } | null;
  omissions?: Array<{ claim?: string | null; danger?: string | null }> | null;
  corroborationTrack?: string | null;
  stabilityAssessment?: string | null;
}

/** §4 preventable-injury rule 2 — clinical-HARM stems, case-insensitive. A moderate
 *  omission that is a documentation gap ("follow-up date not written") matches none of
 *  these and lands in `unknown`, not `suspected`. */
export const CLINICAL_HARM_STEMS: readonly RegExp[] = [
  /wound/i, /infect/i, /bleed/i, /sepsis/i, /dehisc/i, /implant fail/i, /intra-?op/i, /unstable/i, /\bSSI\b/i,
];

/** §4 negligence rule 3 — intra-op / peri-op EVENT patterns. Bare procedure nouns and
 *  all discharge-instruction language are deliberately NOT on this list (ratified
 *  clinical-safety rule, PRD §4 — the Khan fixture in the tests is what it protects). */
export const PERI_OP_EVENT_PATTERNS: readonly RegExp[] = [
  /intra-?op/i, /intraoperative/i, /operative finding/i, /calcar/i, /cerclage/i, /anastomot/i, /retained/i, /wrong[- ]site/i,
];

const matchesAny = (claim: string | null | undefined, patterns: readonly RegExp[]): boolean =>
  typeof claim === 'string' && patterns.some((rx) => rx.test(claim));

export function deriveJudgements(finding: JudgementInput | null | undefined): Judgements {
  const omissions = Array.isArray(finding?.omissions) ? finding!.omissions! : [];
  const cleanBaseline = omissions.length === 0
    && finding?.corroborationTrack === 'lab_corroborated'
    && finding?.stabilityAssessment === 'corroborated';

  // Preventable injury (§4 rules 1–4, in order).
  let preventableInjury: JudgementValue;
  if (omissions.some((o) => o?.danger === 'high')) preventableInjury = 'suspected';
  else if (omissions.some((o) => o?.danger === 'moderate' && matchesAny(o?.claim, CLINICAL_HARM_STEMS))) preventableInjury = 'suspected';
  else if (cleanBaseline) preventableInjury = 'not_suggested';
  else preventableInjury = 'unknown';

  // Negligence (§4) — `suspected` ONLY when all four hold; a missing peri-op event
  // pattern is `unknown`, never `suspected`.
  const unplanned = finding?.planned?.verdict === 'unplanned';
  const sameVerdict = finding?.sameCondition?.verdict;
  const conditionOk = sameVerdict !== 'different';   // 'same', absent, or 'unknown'
  const periOpEvent = omissions.some((o) => matchesAny(o?.claim, PERI_OP_EVENT_PATTERNS));
  let negligence: JudgementValue;
  if (unplanned && conditionOk && periOpEvent) negligence = 'suspected';
  else if (cleanBaseline) negligence = 'not_suggested';
  else negligence = 'unknown';

  return { preventableInjury, negligence };
}
