/**
 * lib/dose-aggregation-core.ts — molecule-level daily-dose aggregation (PURE).
 *
 * Today's audit flags simple *duplicates* (same generic twice) but has no notion of the
 * TOTAL daily dose of a molecule delivered ACROSS co-prescribed products. The clinical case:
 * a scheduled antipyretic (Dolo 650, paracetamol 650 mg TID = 1950 mg) plus a paracetamol-
 * containing combo (Zerodol-SP, paracetamol 325 mg BD = 650 mg) plus a decongestant combo
 * (Sinarest, paracetamol 500 mg BD = 1000 mg) sums to 3600 mg — each product is fine alone,
 * the STACK is what needs a second look. This core resolves every med to its molecule(s) +
 * per-unit strength, parses the regimen into doses/day (grid `1-0-1`, OD/BD/TDS/QID/HS, and
 * SOS as a CEILING not a fixed dose), aggregates Σ(strength × units × doses/day) per molecule,
 * and flags a molecule only when the aggregate exceeds a per-molecule daily ceiling.
 *
 * PURE: type-only cross-import + INJECTED limits table (data/dose-limits.json is loaded by the
 * orchestrator, not here), so this file loads under `node --experimental-strip-types` for tests.
 *
 * SOS handling (V decision, 3 Jul): a fixed-schedule total over the ceiling is a HIGH-confidence
 * flag; an "if every SOS dose were taken" total over the ceiling is a LOWER-confidence advisory
 * (SOS is a ceiling, rarely all taken). Bare "sos"/"as needed" with no explicit cap assumes a
 * default cap (from the limits file) and is marked assumed.
 */

import type { OpdMed } from './opd-ingest-core';
import type { OpdFinding } from './opd-note-audit-core';
import type { CorpusCitation, FindingProvenance } from './provenance-tier-core';

/** Provenance for a dose finding, from its DoseLimit entry (Deterministic-Citations §7;
 *  PRD CDMSS-PHARMACY-ROUND1 §2). `clinician` carries the signature and routes to `clinician_signed`.
 *  A signature (signed_by/signed_on) is surfaced whenever present — a corpus citation PLUS a
 *  signature is strictly better than either alone (§5.4), so `external` entries keep resolving to
 *  `deterministic` and simply also carry the clinician's name. */
function doseProvenance(lim: DoseLimit): FindingProvenance | undefined {
  const sig = (lim.signed_by || lim.signed_on) ? { signed_by: lim.signed_by, signed_on: lim.signed_on } : {};
  if (lim.derivation === 'external') return { citation: lim.citation ?? null, derivation: 'external', ...sig };
  if (lim.derivation === 'llm') return { citation: null, derivation: 'llm', ...sig };
  if (lim.derivation === 'clinician') return { citation: null, derivation: 'clinician', ...sig };
  return undefined;   // no derivation set → finding stays uncited_deterministic (unchanged behaviour)
}

// ── Injected ceilings table (shape of data/dose-limits.json) ──────────────────
export interface DoseLimit {
  molecule: string;            // canonical, lower-case
  aliases?: string[];
  max_mg_per_day: number;
  caution_mg_per_day?: number;
  caution_note?: string;
  note?: string;
  // Deterministic-Citations (dose-limits/1.1): provenance of the ceiling threshold, attached to the
  // emitted finding. 'external' carries a resolved corpus citation; 'llm' is internally-derived;
  // 'clinician' (dose-limits/1.2, PRD CDMSS-PHARMACY-ROUND1 §2) means a named clinician signed it.
  derivation?: 'external' | 'llm' | 'clinician';
  citation?: CorpusCitation | null;
  signed_by?: string;      // clinician who signed this ceiling, e.g. "Dr Khatija, Chief Clinical Pharmacologist, Even"
  signed_on?: string;      // ISO date, e.g. "2026-07-25"
  // Decision 5 — naproxen: a higher allowance on day one of an acute course.
  first_day_max_mg_per_day?: number;
  // Decision 6 — etoricoxib: a higher ceiling only under a named indication (gout).
  indication_conditional?: { indication: 'gout'; max_mg_per_day: number };
}
export interface DoseLimitsTable {
  version: string;
  default_sos_cap_per_day: number;
  limits: DoseLimit[];
}

// ── Regimen frequency parse ───────────────────────────────────────────────────
export interface FreqParse {
  scheduled: number;   // fixed doses/day (0 for pure SOS)
  sosCap: number;      // additional doses/day if every SOS dose is taken (0 if not SOS)
  isSos: boolean;
  assumed: boolean;    // SOS with no explicit cap → default cap assumed
  unknown: boolean;    // frequency could not be parsed at all → med excluded from aggregation
}

const SOS_RE = /\b(sos|s\/?o\/?s|prn|as\s+needed|as\s+required|if\s+needed|when\s+required|only\s+if)\b/i;
// spoken/abbreviated fixed frequencies → doses/day
const KEYWORD_FREQ: { re: RegExp; n: number }[] = [
  { re: /\bq\.?i\.?d\b|\bqds\b|\bfour\s+times\b|\b4\s+times\b/i, n: 4 },
  { re: /\bt\.?i\.?d\b|\btds\b|\bthr?ice\b|\bthree\s+times\b|\b3\s+times\b/i, n: 3 },
  { re: /\bb\.?i\.?d\b|\bbds?\b|\btwice\b|\btwo\s+times\b|\b2\s+times\b/i, n: 2 },
  { re: /\bo\.?d\b|\bonce\b|\bone\s+time\b|\b1\s+time\b|\bhs\b|\bbed\s*time\b|\bnocte\b|\bod\b/i, n: 1 },
];

/** Parse a max SOS cap from an SOS instruction, e.g. "sos max TID", "max 3", "SOS BD". */
function sosCapFrom(s: string): number | null {
  const m = s.match(/max(?:imum)?\s*(?:of\s*)?(\d+)/i);
  if (m) return Math.max(0, parseInt(m[1], 10));
  for (const k of KEYWORD_FREQ) if (k.re.test(s)) return k.n;
  return null;
}

/** Parse a frequency string into doses/day, distinguishing fixed schedule from an SOS ceiling. */
export function parseFrequency(raw: string | undefined, defaultSosCap: number): FreqParse {
  const s = (raw || '').trim();
  const none = (o: Partial<FreqParse>): FreqParse => ({ scheduled: 0, sosCap: 0, isSos: false, assumed: false, unknown: false, ...o });
  if (!s) return none({ unknown: true });
  const isSos = SOS_RE.test(s);

  // Dosing grid: "1-0-1", "1-1-1", "1-0-1-1", "0-0-1". Sum the slots (each slot = doses at that time).
  const grid = s.match(/(?<!\d)(\d+)\s*-\s*(\d+)\s*-\s*(\d+)(?:\s*-\s*(\d+))?(?!\d)/);
  if (grid) {
    const slots = [grid[1], grid[2], grid[3], grid[4]].filter((x) => x != null).map((x) => parseInt(x as string, 10));
    const sum = slots.reduce((a, b) => a + b, 0);
    if (isSos) return none({ isSos: true, sosCap: sum || sosCapFrom(s) || defaultSosCap, assumed: !sum });
    return none({ scheduled: sum });
  }

  if (isSos) {
    const cap = sosCapFrom(s);
    return none({ isSos: true, sosCap: cap ?? defaultSosCap, assumed: cap == null });
  }

  // "every N hours" → floor(24/N)
  const q = s.match(/(?:every|q)\s*(\d+)\s*(?:h|hr|hour)/i);
  if (q) { const h = parseInt(q[1], 10); if (h > 0) return none({ scheduled: Math.max(1, Math.floor(24 / h)) }); }

  for (const k of KEYWORD_FREQ) if (k.re.test(s)) return none({ scheduled: k.n });

  return none({ unknown: true });
}

// ── Units per administration (dosage field, e.g. "1 tablet", "2 caps") ────────
export function unitsPerDose(dosage: string | undefined): number {
  const s = (dosage || '').trim();
  if (!s) return 1;
  // A dosing grid mistakenly entered in the dosage field ("1-0-1") is not a unit count.
  if (/\d\s*-\s*\d\s*-\s*\d/.test(s)) return 1;
  // BUG-0.8-13: a VOLUME ("10ml", "2 tsp") is not a tablet count — never read it as units.
  if (/\d\s*mls?\b|\bcc\b|\btsp\b|teaspoons?|\bdrops?\b/i.test(s)) return 1;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  const n = m ? parseFloat(m[1]) : 1;
  return n > 0 && n <= 20 ? n : 1;   // guard against stray large numbers
}

// ── Strength token → mg ───────────────────────────────────────────────────────
/** Parse a single strength token (e.g. "325mg", "1 g", "60 MG", "500mcg") to milligrams; null if unparseable. */
export function strengthTokenToMg(tok: string): number | null {
  const m = (tok || '').match(/(\d+(?:\.\d+)?)\s*(mg|mcg|µg|ug|g|gm)?\b/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!isFinite(v)) return null;
  const unit = (m[2] || 'mg').toLowerCase();
  if (unit === 'g' || unit === 'gm') return v * 1000;
  if (unit === 'mcg' || unit === 'µg' || unit === 'ug') return v / 1000;
  return v;                              // mg (default)
}

// ── Molecule canonicalisation ─────────────────────────────────────────────────
function stripStrength(s: string): string {
  return s.replace(/\d+(?:\.\d+)?\s*(?:mg|mcg|µg|ug|g|gm|iu|%)\b/gi, ' ').replace(/\(.*?\)/g, ' ');
}
/** Map a generic-name fragment to a ceiling molecule if it names one, else the cleaned fragment. */
export function canonicalMolecule(fragment: string, limits: DoseLimit[]): string {
  const clean = stripStrength(fragment.toLowerCase()).replace(/[^a-z /]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const lim of limits) {
    const names = [lim.molecule, ...(lim.aliases || [])].map((x) => x.toLowerCase());
    for (const nm of names) {
      // word-ish containment so "chlorpheniramine maleate" ≠ paracetamol but "paracetamol/acetaminophen" matches
      const re = new RegExp(`(^|[ /])${nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([ /]|$)`);
      if (re.test(clean)) return lim.molecule;
    }
  }
  return clean.split('/')[0].trim();
}

// ── Per-med molecule breakdown ────────────────────────────────────────────────
export interface MedMolecule { molecule: string; perUnitMg: number | null }

/**
 * A liquid/suspension whose strength is a CONCENTRATION ("250mg/5ml") dosed by VOLUME ("5 ml").
 * The tablet model (per-unit strength × unit count) does not apply — computing it would badly
 * over-estimate (250 × 5 × N). These are also predominantly paediatric (weight-based dosing,
 * out of scope for adult ceilings), so v1 excludes them from aggregation rather than mis-flag.
 */
export function isVolumetric(m: OpdMed): boolean {
  const conc = /\/\s*\d*\s*ml\b|per\s*\d*\s*ml\b|mg\s*\/\s*ml/i;   // "250mg/5ml", "mg/ml", "per 5ml"
  // BUG-0.8-13: the old /\bml\b/ MISSED a volume written without a space ("10ml") — \b never fires
  // between a digit and "m" — and omitted tsp/cc, so a syrup dosed "10ml (2 tsp)" fell through to the
  // tablet model. Match ml adjacent to a digit + tsp/teaspoon/cc, AND detect a liquid dosage form.
  const volDose = /\d\s*mls?\b|\bmls?\b|\bcc\b|\bdrops?\b|\btsp\b|teaspoons?/i;
  const liquidForm = /syrup|suspension|solution|\bdrops?\b|elixir|linctus|\bliquid\b/i;
  const nameHay = `${m.brand || ''} ${m.generic || ''}`;
  return conc.test(m.strength || '') || conc.test(m.dose || '')
    || volDose.test(m.dose || '') || liquidForm.test(nameHay);
}

/** Split a med into its molecules with aligned per-unit strengths (combos → multiple rows). */
export function moleculesOf(m: OpdMed, limits: DoseLimit[]): MedMolecule[] {
  // Strip parenthetical strength lists BEFORE splitting on '+': the EMR sometimes writes the
  // composition into the generic name as "Dicyclomine+Paracetamol (20Mg+500Mg)" — the '+' inside
  // the parens would otherwise create a phantom molecule and misalign it against the strength field.
  const genSrc = (m.generic || m.resolvedGeneric || m.brand || '').replace(/\(.*?\)/g, ' ').trim();
  if (!genSrc) return [];
  const genParts = genSrc.split('+').map((x) => x.trim()).filter(Boolean);
  const strParts = (m.strength || m.dose || '').split('+').map((x) => x.trim()).filter(Boolean);
  const aligned = strParts.length === genParts.length;
  return genParts.map((g, i) => {
    let mg = aligned ? strengthTokenToMg(strParts[i]) : null;
    // fall back to a strength embedded in the generic fragment itself ("Chlorzoxazone 500 Mg")
    if (mg == null) { const em = g.match(/\d+(?:\.\d+)?\s*(?:mg|mcg|µg|ug|g|gm)\b/i); if (em) mg = strengthTokenToMg(em[0]); }
    // single-molecule line with strength only in the `strength`/`dose` field
    if (mg == null && genParts.length === 1 && strParts.length === 1) mg = strengthTokenToMg(strParts[0]);
    return { molecule: canonicalMolecule(g, limits), perUnitMg: mg };
  });
}

// ── Duration parse (single shared parser) ─────────────────────────────────────
// PRD CDMSS-PHARMACY-ROUND1 §3.1/§4: the ONE duration parser, reused (do NOT write a second one).
// It lives HERE in the pure core rather than in lib/opd-note-audit.ts because the day-one ceiling
// resolution below must call it and this file loads under `--experimental-strip-types` (type-only
// imports) — it cannot import the impure orchestrator. opd-note-audit.ts re-exports it verbatim, so
// the §3.1 `export parseDurationDays` surface (and its existing decongestant caller) is preserved.
// Regexes are UNCHANGED from the original definition — days/weeks/months plus d/wks/mos; `to continue`,
// `sos`, `when needed`, `3 more days`, empty → null.
export function parseDurationDays(s?: string): number | null {
  if (!s) return null;
  const str = s.toLowerCase();
  let m = str.match(/(\d+)\s*(?:days?|d)\b/); if (m) return Number(m[1]);
  m = str.match(/(\d+)\s*(?:weeks?|wks?|w)\b/); if (m) return Number(m[1]) * 7;
  m = str.match(/(\d+)\s*(?:months?|mos?)\b/); if (m) return Number(m[1]) * 30;
  return null;
}

// ── Aggregate + verdict ───────────────────────────────────────────────────────
export interface MoleculeLoad {
  molecule: string;
  scheduledMgPerDay: number;
  sosMaxMgPerDay: number;        // additional mg/day if every SOS dose is taken (on top of scheduled)
  products: string[];            // contributing brand/generic labels
  hasSos: boolean;
  assumedSos: boolean;
  incomplete: boolean;           // at least one contributing product had unknown freq or strength
}

/** Aggregate the total daily mg per molecule across every product on the prescription. */
export function aggregateDailyDose(meds: OpdMed[], table: DoseLimitsTable): Map<string, MoleculeLoad> {
  const acc = new Map<string, MoleculeLoad>();
  for (const m of meds) {
    const fp = parseFrequency(m.frequency, table.default_sos_cap_per_day);
    const u = unitsPerDose(m.dose);   // the EMR `dosage` field maps to OpdMed.dose ("1 tablet")
    const volumetric = isVolumetric(m);   // liquid/suspension by concentration — outside the tablet model
    const label = m.brand || m.generic || m.resolvedGeneric || 'medication';
    for (const mm of moleculesOf(m, table.limits)) {
      const cur = acc.get(mm.molecule) || { molecule: mm.molecule, scheduledMgPerDay: 0, sosMaxMgPerDay: 0, products: [], hasSos: false, assumedSos: false, incomplete: false };
      if (mm.perUnitMg == null || fp.unknown || volumetric) {
        cur.incomplete = true;
      } else {
        cur.scheduledMgPerDay += mm.perUnitMg * u * fp.scheduled;
        cur.sosMaxMgPerDay += mm.perUnitMg * u * fp.sosCap;
        if (fp.isSos) { cur.hasSos = true; if (fp.assumed) cur.assumedSos = true; }
      }
      if (!cur.products.includes(label)) cur.products.push(label);
      acc.set(mm.molecule, cur);
    }
  }
  return acc;
}

const round = (n: number) => Math.round(n);

function det(subject: string, verdict: OpdFinding['verdict'], confidence: number, rationale: string): OpdFinding {
  return { subject, verdict, confidence, domain: 'prescribing_safety', rationale, evidence: [], estimates: [], citation_ids: [], source: 'deterministic' };
}

/**
 * Resolve the applicable daily ceiling for a molecule (PRD CDMSS-PHARMACY-ROUND1 §4), in order:
 *  1. gout-conditional — `indication_conditional.indication === 'gout'` AND `ctx.isGout === true`
 *     (etoricoxib 120 mg only with a documented gout diagnosis; else the tighter default applies).
 *  2. first-day — `first_day_max_mg_per_day` set AND EVERY contributing product parses to exactly
 *     1 day (naproxen 1250 mg permitted on day one of an acute course).
 *  3. `max_mg_per_day` — the conservative default.
 * Fail-safe: `ctx` omitted → rule 1 is skipped (isGout undefined) and rule 2 depends only on the
 * meds' own durations, so a molecule with NEITHER new field resolves to rule 3 exactly as today.
 */
function resolveCeiling(lim: DoseLimit, molecule: string, meds: OpdMed[], limits: DoseLimit[], ctx?: { isGout?: boolean }): number {
  if (lim.indication_conditional?.indication === 'gout' && ctx?.isGout === true) {
    return lim.indication_conditional.max_mg_per_day;
  }
  if (lim.first_day_max_mg_per_day != null) {
    const contributing = meds.filter((m) => moleculesOf(m, limits).some((mm) => mm.molecule === molecule));
    if (contributing.length > 0 && contributing.every((m) => parseDurationDays(m.duration) === 1)) {
      return lim.first_day_max_mg_per_day;
    }
  }
  return lim.max_mg_per_day;
}

/**
 * Deterministic daily-dose findings. Flags a molecule when its aggregate across products exceeds
 * the ceiling. Fires ONLY for molecules present in >1 product OR whose single-product scheduled
 * total already exceeds the ceiling — so a single correctly-dosed drug never trips it. SOS-only
 * exceedance is a softer, lower-confidence advisory.
 *
 * `ctx` is OPTIONAL (PRD §4): omitting it reproduces today's behaviour byte-for-byte — the only
 * ceilings that vary are those carrying the new `indication_conditional` / `first_day_max_mg_per_day`
 * fields, and rule 2 reads only the meds' own durations.
 */
export function doseAggregationFindings(meds: OpdMed[], table: DoseLimitsTable, ctx?: { isGout?: boolean }): OpdFinding[] {
  const loads = aggregateDailyDose(meds, table);
  const byMol = new Map(table.limits.map((l) => [l.molecule, l]));
  const out: OpdFinding[] = [];

  // count products per molecule to decide whether stacking is in play
  for (const load of loads.values()) {
    const lim = byMol.get(load.molecule);
    if (!lim) continue;                                   // no ceiling for this molecule → never flag
    const nProducts = load.products.length;
    const sched = load.scheduledMgPerDay;
    const sosMax = sched + load.sosMaxMgPerDay;
    const ceiling = resolveCeiling(lim, load.molecule, meds, table.limits, ctx);
    const prods = load.products.join(' + ');

    const prov = doseProvenance(lim);   // corpus citation / llm mark for this molecule's ceiling
    if (sched > ceiling) {
      // Hard: the fixed daily schedule alone exceeds the ceiling.
      const conf = load.incomplete ? 0.6 : 0.85;
      const stack = nProducts > 1 ? ` combined across ${nProducts} products (${prods})` : ` (${prods})`;
      out.push({ ...det(
        `Daily dose exceeds ceiling: ${lim.molecule}`,
        'low-value', conf,
        `Scheduled ${lim.molecule} totals ~${round(sched)} mg/day${stack}, above the ${ceiling} mg/day adult ceiling.` +
        (lim.caution_mg_per_day && lim.caution_note ? ` ${lim.caution_note}` : '') +
        (lim.note ? ` ${lim.note}` : '') +
        (load.incomplete ? ' (One contributing product had an unclear strength or frequency — verify the total.)' : ''),
      ), ...(prov ? { provenance: prov } : {}) });
    } else if (load.hasSos && sosMax > ceiling && nProducts >= 1) {
      // Soft: only exceeds if every as-needed dose is taken on top of the schedule.
      out.push({ ...det(
        `Daily dose may exceed ceiling if all SOS taken: ${lim.molecule}`,
        'context-dependent', load.assumedSos ? 0.3 : 0.4,
        `${lim.molecule} could reach ~${round(sosMax)} mg/day if every as-needed dose is taken${nProducts > 1 ? ` across ${nProducts} products (${prods})` : ` (${prods})`}, above the ${ceiling} mg/day ceiling — as-needed is a ceiling, not a fixed dose, so this is advisory.` +
        (load.assumedSos ? ' (No explicit SOS cap documented; a default ceiling was assumed — specify a maximum frequency.)' : ''),
      ), ...(prov ? { provenance: prov } : {}) });
    } else if (nProducts > 1 && sched > 0) {
      // Informational: same molecule in multiple products but within the ceiling — worth awareness,
      // does not penalise (confidence 0, informational).
      out.push({ ...det(
        `Same molecule in ${nProducts} products (within ceiling): ${lim.molecule}`,
        'uncertain', 0,
        `${lim.molecule} appears in ${nProducts} co-prescribed products (${prods}), totalling ~${round(sched)} mg/day — within the ${ceiling} mg/day ceiling, but confirm the duplication is intended.`,
      ), informational: true });
    }
  }
  return out;
}
