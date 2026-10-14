// Deterministic drug–drug interaction leg for the audit surface.
// Three layers, merged & severity-ranked:
//   1. CLASS rules  — pharmacodynamic duplications from the EHRC formulary classes
//      (e.g. two anticoagulants → bleeding). Catches the long tail the pairwise
//      list and FDA labels miss. THIS is what makes enoxaparin+rivaroxaban fire.
//   2. CURATED pairs — named high-risk pairs pharmacy/AMS owns.
//   3. RxLabelGuard  — FDA SPL for breadth.
// Auto-feeds audit parameter #12 (drug–drug interactions).

import { rxlgInteractions, type DdiPair } from './rxlabelguard';
// normDrugName is THE one pair normalisation (G-1 fix): pairKey() below and orderPair() both use
// it, so canonical ordering and dedupe keys can never disagree. It lives in ddi-tags.ts because
// that file is the leaf of the existing ddi→ddi-tags import edge (no cycle).
import { tagInteractions, orderPair, normDrugName as norm } from './ddi-tags';

// ---- 2. curated named pairs ----
interface Rule { a: string; b: string; severity: DdiPair['severity']; mechanism: string; recommendation: string }
export const CURATED_RULES: Rule[] = [
  { a: 'enoxaparin', b: 'ketorolac', severity: 'major', mechanism: 'Additive bleeding risk (LMWH + NSAID).', recommendation: 'Avoid; if unavoidable, monitor for bleeding.' },
  { a: 'enoxaparin', b: 'diclofenac', severity: 'major', mechanism: 'Additive bleeding risk (LMWH + NSAID).', recommendation: 'Avoid; monitor for bleeding.' },
  { a: 'enoxaparin', b: 'aspirin', severity: 'major', mechanism: 'Additive bleeding risk (anticoagulant + antiplatelet).', recommendation: 'Use only with explicit indication; monitor.' },
  { a: 'heparin', b: 'enoxaparin', severity: 'major', mechanism: 'Duplicate anticoagulation.', recommendation: 'Do not co-administer; choose one agent.' },
  { a: 'warfarin', b: 'ketorolac', severity: 'major', mechanism: 'Markedly increased bleeding risk.', recommendation: 'Avoid; monitor INR and for bleeding.' },
  { a: 'vancomycin', b: 'amikacin', severity: 'major', mechanism: 'Additive nephro- and ototoxicity.', recommendation: 'Monitor renal function and drug levels.' },
  { a: 'vancomycin', b: 'piperacillin', severity: 'moderate', mechanism: 'Increased risk of acute kidney injury.', recommendation: 'Monitor serum creatinine.' },
  { a: 'colist', b: 'amikacin', severity: 'major', mechanism: 'Additive nephrotoxicity.', recommendation: 'Avoid; monitor renal function closely.' },
  { a: 'colist', b: 'vancomycin', severity: 'major', mechanism: 'Additive nephrotoxicity.', recommendation: 'Monitor renal function closely.' },
  { a: 'linezolid', b: 'tramadol', severity: 'major', mechanism: 'Serotonin syndrome risk (MAO inhibition + serotonergic).', recommendation: 'Avoid combination.' },
  { a: 'linezolid', b: 'fentanyl', severity: 'moderate', mechanism: 'Possible serotonin syndrome.', recommendation: 'Monitor for serotonergic toxicity.' },
  { a: 'propofol', b: 'fentanyl', severity: 'moderate', mechanism: 'Additive respiratory depression and hypotension.', recommendation: 'Titrate carefully; monitor haemodynamics.' },
  { a: 'tramadol', b: 'ondansetron', severity: 'moderate', mechanism: 'Reduced analgesia + serotonergic load.', recommendation: 'Prefer an alternative antiemetic if possible.' },
  { a: 'ciprofloxacin', b: 'ondansetron', severity: 'moderate', mechanism: 'Additive QT prolongation.', recommendation: 'Avoid in patients at QT risk; consider ECG.' },
];

export function curatedInteractions(drugs: string[]): DdiPair[] {
  const out: DdiPair[] = [];
  for (let i = 0; i < drugs.length; i++) {
    for (let j = i + 1; j < drugs.length; j++) {
      const A = norm(drugs[i]); const B = norm(drugs[j]);
      const r = CURATED_RULES.find((ru) =>
        (A.includes(ru.a) && B.includes(ru.b)) || (A.includes(ru.b) && B.includes(ru.a)));
      if (r) out.push({ ...orderPair(drugs[i], drugs[j]), severity: r.severity, mechanism: r.mechanism, recommendation: r.recommendation, source: 'EHRC curated rule' });
    }
  }
  return out;
}

// ---- 1. class-based pharmacodynamic rules ----
// Each drug carries its EHRC formulary class (major/minor grouping). These catch
// duplications the named list misses — most importantly dual anticoagulation.
export interface DrugClass {
  name: string; major: string; minor: string;
  /**
   * DETERMINISM-TRIO PRD v1.0 §2.2 (D-1/D-2, 8 Aug 2026) — this line carries aspirin at an
   * ANTIPLATELET total daily dose (≤ 100 mg/day, or unparseable), so it is not analgesic NSAID
   * therapy. OPTIONAL and ADDITIVE: every existing construction site omits it and is byte-identical.
   * Honoured in tagInteractions (lib/ddi-tags.ts), which drops the `nsaid` tag from such an item
   * AFTER tagsFor has run. The `antiplatelet` tag is never touched.
   */
  suppressNsaid?: boolean;
}
const isAnticoag = (c: DrugClass) => /anticoagulant/i.test(c.major) || /anticoagulant/i.test(c.minor);
const isAntiplatelet = (c: DrugClass) => /antiplatelet/i.test(c.major) || /antiplatelet/i.test(c.minor);
const isNSAID = (c: DrugClass) => /\bnsaid\b/i.test(c.major) || /\bnsaid\b/i.test(c.minor);

function mk(a: DrugClass, b: DrugClass, severity: DdiPair['severity'], mechanism: string, recommendation: string): DdiPair {
  return { ...orderPair(a.name, b.name), severity, mechanism, recommendation, source: 'EHRC class rule' };
}

export function classInteractions(items: DrugClass[]): DdiPair[] {
  const out: DdiPair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (norm(a.name) === norm(b.name)) continue;
      if (isAnticoag(a) && isAnticoag(b)) {
        out.push(mk(a, b, 'major', 'Two anticoagulants — duplicate/additive anticoagulation, high bleeding risk.', 'Avoid concurrent anticoagulants; use a single agent unless deliberately bridging with monitoring.'));
      } else if ((isAnticoag(a) && isAntiplatelet(b)) || (isAntiplatelet(a) && isAnticoag(b))) {
        out.push(mk(a, b, 'major', 'Anticoagulant + antiplatelet — additive bleeding risk.', 'Co-prescribe only with a clear indication; monitor for bleeding.'));
      } else if ((isAnticoag(a) && isNSAID(b)) || (isNSAID(a) && isAnticoag(b))) {
        out.push(mk(a, b, 'major', 'Anticoagulant + NSAID — increased bleeding risk.', 'Avoid; prefer paracetamol for analgesia.'));
      } else if (isAntiplatelet(a) && isAntiplatelet(b)) {
        out.push(mk(a, b, 'moderate', 'Dual antiplatelet therapy — increased bleeding risk.', 'Use only when dual antiplatelet therapy is indicated.'));
      } else if (isNSAID(a) && isNSAID(b)) {
        out.push(mk(a, b, 'moderate', 'Two NSAIDs — additive GI and renal toxicity.', 'Avoid concurrent NSAIDs.'));
      }
    }
  }
  return out;
}

// ---- merge & rank ----
const SEV_RANK: Record<string, number> = { contraindicated: 5, major: 4, moderate: 3, minor: 2, unknown: 1, none: 0 };
function pairKey(a: string, b: string): string {
  const x = norm(a), y = norm(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}
export function mergeRank(pairs: DdiPair[]): DdiPair[] {
  const byKey = new Map<string, DdiPair>();
  for (const p of pairs) {
    const k = pairKey(p.drug_a, p.drug_b);
    const prev = byKey.get(k);
    if (!prev || SEV_RANK[p.severity] > SEV_RANK[prev.severity]) byKey.set(k, p);
  }
  return [...byKey.values()].filter((p) => p.severity !== 'none').sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
}

// CAT /drugs path (names only; PubChem class-overlap lives in that route's LLM engine).
export async function deterministicInteractions(drugs: string[]): Promise<DdiPair[]> {
  const clean = drugs.map((d) => d.trim()).filter(Boolean);
  if (clean.length < 2) return [];
  const curated = curatedInteractions(clean);
  const rxlg = await rxlgInteractions(clean);
  return mergeRank([...curated, ...rxlg]);
}

// Audit-surface path: class rules + curated + RxLabelGuard. Class first so the
// conservative pharmacodynamic flag wins ties.
export async function auditInteractions(items: DrugClass[]): Promise<DdiPair[]> {
  const names = items.map((i) => i.name.trim()).filter(Boolean);
  if (names.length < 2) return [];
  const cls = tagInteractions(items);          // formulary-scoped high-risk mechanism rules
  const curated = curatedInteractions(names);  // named high-risk pairs
  const rxlg = await rxlgInteractions(names);   // FDA SPL long-tail
  return mergeRank([...cls, ...curated, ...rxlg]);
}
