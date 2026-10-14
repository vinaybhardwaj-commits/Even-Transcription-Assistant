// Formulary-scoped, high-risk interaction engine (Khatija's idea, V's framing:
// "within our formulary" + "narrow to high-risk"). Rather than scrape millions of
// pairs, we tag each drug with the interaction-relevant properties it carries
// (anticoagulant, QT-prolonging, serotonergic, nephrotoxic, …) from its name +
// EHRC formulary class, then fire a small set of well-established MECHANISM rules
// over those tags. Deterministic, instant, and every alert is traceable to a rule.
//
// This is a clinical safety NET, not an exhaustive database — pharmacy/AMS should
// review the tag lists and rules below and extend them as testing surfaces gaps.

import type { DdiPair } from './rxlabelguard';
import type { DrugClass } from './ddi';

// ── canonical pair order (G-1 fix, 1 Aug 2026) ────────────────────────────────────────────────────
// A DdiPair's (drug_a, drug_b) used to carry the meds[] INPUT order, so the finding subject
// ("Interaction (major): A + B" vs "… B + A") — and with it finding_ref AND stable_ref, both hashed
// over the subject text — changed when the EMR reordered medication lines (metamorphic relation G-1,
// surfaced by the suite at f816f34). Canonicalise at CONSTRUCTION so every consumer inherits it:
// sort on the normalised lowercase name — THE one normalisation, shared with ddi.ts's pairKey()
// (this file is the leaf of the ddi→ddi-tags import edge, so the shared definition lives here).
// The ORIGINAL names are preserved; only their order changes. Nothing about which pairs fire,
// their severity, mechanism, recommendation or source is affected.
export const normDrugName = (s: string): string => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
/** The two names in canonical order, originals intact — spread into a DdiPair literal. */
export function orderPair(a: string, b: string): { drug_a: string; drug_b: string } {
  return normDrugName(a) <= normDrugName(b) ? { drug_a: a, drug_b: b } : { drug_a: b, drug_b: a };
}

export type Tag =
  | 'anticoagulant' | 'antiplatelet' | 'nsaid' | 'qt' | 'serotonergic'
  | 'nephrotoxic' | 'cns_depressant' | 'ace_arb' | 'k_sparing' | 'potassium'
  | 'aminoglycoside' | 'loop_diuretic' | 'statin' | 'macrolide' | 'azole'
  | 'sulfonylurea' | 'insulin' | 'methotrexate';

const has = (s: string, ...keys: string[]) => keys.some((k) => s.includes(k));

// Map a drug (generic name + formulary major/minor grouping) to its interaction tags.
export function tagsFor(name: string, major: string, minor: string): Set<Tag> {
  const n = (name || '').toLowerCase();
  const mj = (major || '').toLowerCase();
  const t = new Set<Tag>();

  if (mj.includes('anticoagulant') || has(n, 'warfarin', 'heparin', 'enoxaparin', 'dalteparin', 'fondaparinux', 'rivaroxaban', 'dabigatran', 'apixaban', 'edoxaban', 'acenocoumarol', 'nadroparin')) t.add('anticoagulant');
  if (mj.includes('antiplatelet') || has(n, 'aspirin', 'acetylsalicylic', 'clopidogrel', 'prasugrel', 'ticagrelor', 'dipyridamole', 'cilostazol')) t.add('antiplatelet');
  if (mj.includes('nsaid') || has(n, 'diclofenac', 'ibuprofen', 'ketorolac', 'aceclofenac', 'naproxen', 'etoricoxib', 'mefenamic', 'indomethacin', 'piroxicam', 'lornoxicam', 'meloxicam', 'etodolac', 'aspirin')) t.add('nsaid');
  if (has(n, 'amiodarone', 'sotalol', 'haloperidol', 'quetiapine', 'ondansetron', 'domperidone', 'azithromycin', 'clarithromycin', 'erythromycin', 'ciprofloxacin', 'levofloxacin', 'moxifloxacin', 'ofloxacin', 'gemifloxacin', 'norfloxacin', 'fluconazole', 'citalopram', 'escitalopram', 'hydroxychloroquine', 'chloroquine', 'prochlorperazine', 'levosulpiride')) t.add('qt');
  if (has(n, 'linezolid', 'tramadol', 'tapentadol', 'fentanyl', 'pethidine', 'methylene blue', 'sertraline', 'fluoxetine', 'escitalopram', 'citalopram', 'paroxetine', 'fluvoxamine', 'duloxetine', 'venlafaxine', 'amitriptyline', 'imipramine', 'nortriptyline', 'mirtazapine', 'ondansetron', 'metoclopramide', 'selegiline', 'rasagiline')) t.add('serotonergic');
  if (mj.includes('aminoglycoside') || has(n, 'amikacin', 'gentamicin', 'gentamycin', 'netilmic', 'tobramycin', 'streptomycin')) { t.add('aminoglycoside'); t.add('nephrotoxic'); }
  if (has(n, 'vancomycin', 'colistin', 'colistimethate', 'polymyxin', 'amphotericin', 'tacrolimus', 'cyclosporine', 'ciclosporin', 'cisplatin', 'foscarnet')) t.add('nephrotoxic');
  if (has(n, 'morphine', 'fentanyl', 'tramadol', 'tapentadol', 'buprenorphine', 'pentazocine', 'nalbuphine', 'codeine', 'pethidine', 'oxycodone', 'midazolam', 'diazepam', 'lorazepam', 'alprazolam', 'clonazepam', 'zolpidem', 'phenobarbit', 'propofol', 'thiopent', 'etomidate', 'dexmedetomidine', 'dexmeditomidine', 'ketamine', 'pregabalin', 'gabapentin', 'baclofen', 'tizanidine')) t.add('cns_depressant');
  if (has(n, 'ramipril', 'enalapril', 'lisinopril', 'perindopril', 'captopril', 'benazepril', 'losartan', 'telmisartan', 'olmesartan', 'valsartan', 'candesartan', 'irbesartan', 'azilsartan', 'sacubitril')) t.add('ace_arb');
  if (has(n, 'spironolactone', 'eplerenone', 'amiloride', 'triamterene')) t.add('k_sparing');
  if (has(n, 'potassium chloride', 'potassium citrate', 'potassium bicarbonate', 'kcl')) t.add('potassium');
  if (has(n, 'furosemide', 'frusemide', 'torsemide', 'torasemide', 'bumetanide')) t.add('loop_diuretic');
  if (has(n, 'atorvastatin', 'rosuvastatin', 'simvastatin', 'pravastatin', 'fluvastatin', 'lovastatin', 'pitavastatin')) t.add('statin');
  if (has(n, 'azithromycin', 'clarithromycin', 'erythromycin', 'roxithromycin')) t.add('macrolide');
  if (has(n, 'fluconazole', 'itraconazole', 'ketoconazole', 'voriconazole', 'posaconazole', 'isavuconazole')) t.add('azole');
  if (has(n, 'glimepiride', 'gliclazide', 'glipizide', 'glibenclamide', 'glyburide')) t.add('sulfonylurea');
  if (n.includes('insulin')) t.add('insulin');
  if (n.includes('methotrexate')) t.add('methotrexate');
  return t;
}

interface TagRule { a: Tag; b: Tag; severity: DdiPair['severity']; mechanism: string; rec: string }

// Well-established high-risk interaction mechanisms. Pharmacy/AMS owns this list.
export const TAG_RULES: TagRule[] = [
  { a: 'anticoagulant', b: 'anticoagulant', severity: 'major', mechanism: 'Two anticoagulants — duplicate/additive anticoagulation, high bleeding risk.', rec: 'Avoid concurrent anticoagulants; use a single agent unless deliberately bridging with monitoring.' },
  { a: 'anticoagulant', b: 'antiplatelet', severity: 'major', mechanism: 'Anticoagulant + antiplatelet — additive bleeding risk.', rec: 'Co-prescribe only with a clear indication; monitor for bleeding.' },
  { a: 'anticoagulant', b: 'nsaid', severity: 'major', mechanism: 'Anticoagulant + NSAID — increased bleeding risk.', rec: 'Avoid; prefer paracetamol for analgesia.' },
  { a: 'antiplatelet', b: 'antiplatelet', severity: 'moderate', mechanism: 'Dual antiplatelet therapy — increased bleeding risk.', rec: 'Use only when dual antiplatelet therapy is indicated.' },
  { a: 'antiplatelet', b: 'nsaid', severity: 'moderate', mechanism: 'Antiplatelet + NSAID — increased GI bleeding risk.', rec: 'Avoid; add gastroprotection if unavoidable.' },
  { a: 'nsaid', b: 'nsaid', severity: 'moderate', mechanism: 'Two NSAIDs — additive GI and renal toxicity.', rec: 'Avoid concurrent NSAIDs.' },
  { a: 'qt', b: 'qt', severity: 'major', mechanism: 'Two QT-prolonging drugs — additive QT prolongation, risk of torsades de pointes.', rec: 'Avoid; if essential, monitor ECG and correct electrolytes (K, Mg).' },
  { a: 'serotonergic', b: 'serotonergic', severity: 'major', mechanism: 'Two serotonergic drugs — serotonin syndrome risk.', rec: 'Avoid combination; monitor for serotonergic toxicity.' },
  { a: 'nephrotoxic', b: 'nephrotoxic', severity: 'major', mechanism: 'Two nephrotoxic agents — additive nephrotoxicity.', rec: 'Monitor renal function and drug levels; avoid if possible.' },
  { a: 'cns_depressant', b: 'cns_depressant', severity: 'moderate', mechanism: 'Two CNS depressants — additive sedation and respiratory depression.', rec: 'Use lowest effective doses; monitor sedation and respiration.' },
  { a: 'ace_arb', b: 'k_sparing', severity: 'major', mechanism: 'ACE-I/ARB + potassium-sparing diuretic — hyperkalaemia risk.', rec: 'Monitor serum potassium and renal function.' },
  { a: 'ace_arb', b: 'potassium', severity: 'major', mechanism: 'ACE-I/ARB + potassium supplement — hyperkalaemia risk.', rec: 'Avoid routine potassium; monitor serum potassium.' },
  { a: 'aminoglycoside', b: 'loop_diuretic', severity: 'moderate', mechanism: 'Aminoglycoside + loop diuretic — additive oto- and nephrotoxicity.', rec: 'Monitor renal function, hearing, and drug levels.' },
  { a: 'statin', b: 'macrolide', severity: 'major', mechanism: 'Statin + macrolide — raised statin levels, rhabdomyolysis risk.', rec: 'Hold the statin during the macrolide course, or use azithromycin.' },
  { a: 'statin', b: 'azole', severity: 'major', mechanism: 'Statin + azole antifungal — raised statin levels, rhabdomyolysis risk.', rec: 'Hold or reduce the statin during azole therapy.' },
  { a: 'nsaid', b: 'ace_arb', severity: 'moderate', mechanism: 'NSAID + ACE-I/ARB — reduced renal perfusion, AKI risk (worse if also on a diuretic — “triple whammy”).', rec: 'Avoid the NSAID; monitor renal function.' },
  { a: 'methotrexate', b: 'nsaid', severity: 'major', mechanism: 'Methotrexate + NSAID — reduced methotrexate clearance, toxicity risk.', rec: 'Avoid NSAIDs with methotrexate.' },
  { a: 'sulfonylurea', b: 'sulfonylurea', severity: 'moderate', mechanism: 'Two sulfonylureas — additive hypoglycaemia.', rec: 'Avoid duplication; monitor blood glucose.' },
  { a: 'insulin', b: 'sulfonylurea', severity: 'moderate', mechanism: 'Insulin + sulfonylurea — additive hypoglycaemia risk.', rec: 'Monitor blood glucose closely.' },
];

// Deterministic-Citations (PRD §5.6, V-signed-off 22 Jul): the corpus source that verified each
// class-rule MECHANISM (Stage 1 retrieve-and-verify; VERIFY_SYSTEM/Gemini Pro; 19/19 supported).
// Keyed by the exact TAG_RULES mechanism string. SEVERITY is deliberately NOT cited (V3 — Stockley's/
// Lexicomp/Micromedex grade differently; asserting one as ours is misattribution). A DDI finding
// whose mechanism is NOT in this map (e.g. a curated pair) carries derivation 'llm', not a citation.
import type { CorpusCitation } from './provenance-tier-core';
export const DDI_MECHANISM_CITATIONS: Record<string, CorpusCitation> = {
  'Two anticoagulants — duplicate/additive anticoagulation, high bleeding risk.': { source: 'uptodate', book: 'UpToDate', chapter: 'Anticoagulant drug interactions', section: 'Content', page_start: null, page_end: null },
  'Anticoagulant + antiplatelet — additive bleeding risk.': { source: 'statpearls', book: 'StatPearls', chapter: 'Antiplatelet Medications', section: 'Adverse Effects', page_start: null, page_end: null },
  'Anticoagulant + NSAID — increased bleeding risk.': { source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'anticoagulant', section: 'Drug Interactions', page_start: null, page_end: null },
  'Dual antiplatelet therapy — increased bleeding risk.': { source: 'pubmed', book: 'Lit-J-Stroke', chapter: null, section: null, page_start: null, page_end: null },
  'Antiplatelet + NSAID — increased GI bleeding risk.': { source: 'pubmed', book: 'Lit-Stroke-Vasc-Neurol', chapter: null, section: null, page_start: null, page_end: null },
  'Two NSAIDs — additive GI and renal toxicity.': { source: 'pubmed', book: 'Lit-BMJ-Open', chapter: null, section: null, page_start: null, page_end: null },
  'Two QT-prolonging drugs — additive QT prolongation, risk of torsades de pointes.': { source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'qt-prolonging', section: 'Warnings', page_start: null, page_end: null },
  'Two serotonergic drugs — serotonin syndrome risk.': { source: 'statpearls', book: 'StatPearls', chapter: 'Serotonin Syndrome', section: 'Etiology', page_start: null, page_end: null },
  'Two nephrotoxic agents — additive nephrotoxicity.': { source: 'pubmed', book: 'Lit-Kidney-Int-Rep', chapter: null, section: null, page_start: null, page_end: null },
  'Two CNS depressants — additive sedation and respiratory depression.': { source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'cns-depressant', section: 'Warnings', page_start: null, page_end: null },
  'ACE-I/ARB + potassium-sparing diuretic — hyperkalaemia risk.': { source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'ace-inhibitor', section: 'Drug Interactions', page_start: null, page_end: null },
  'ACE-I/ARB + potassium supplement — hyperkalaemia risk.': { source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'ace-inhibitor', section: 'Drug Interactions', page_start: null, page_end: null },
  'Aminoglycoside + loop diuretic — additive oto- and nephrotoxicity.': { source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'aminoglycoside', section: 'Warnings', page_start: null, page_end: null },
  'Statin + macrolide — raised statin levels, rhabdomyolysis risk.': { source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'statin', section: 'Drug Interactions', page_start: null, page_end: null },
  'Statin + azole antifungal — raised statin levels, rhabdomyolysis risk.': { source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'statin', section: 'Drug Interactions', page_start: null, page_end: null },
  'NSAID + ACE-I/ARB — reduced renal perfusion, AKI risk (worse if also on a diuretic — “triple whammy”).': { source: 'pubmed', book: 'Lit-BMJ', chapter: null, section: null, page_start: null, page_end: null },
  'Methotrexate + NSAID — reduced methotrexate clearance, toxicity risk.': { source: 'openfda', book: 'OpenFDA-Drug-Labels', chapter: 'methotrexate', section: 'Drug Interactions', page_start: null, page_end: null },
  'Two sulfonylureas — additive hypoglycaemia.': { source: 'statpearls', book: 'StatPearls', chapter: 'Sulfonylureas', section: 'Adverse Effects', page_start: null, page_end: null },
  'Insulin + sulfonylurea — additive hypoglycaemia risk.': { source: 'pubmed', book: 'Lit-Diabetes-Care', chapter: null, section: null, page_start: null, page_end: null },
};

const SEV: Record<string, number> = { contraindicated: 5, major: 4, moderate: 3, minor: 2, unknown: 1, none: 0 };

// One DdiPair per interacting drug pair, carrying the highest-severity mechanism.
export function tagInteractions(items: DrugClass[]): DdiPair[] {
  // ── suppressNsaid (DETERMINISM-TRIO PRD v1.0 §2.2 step 3, D-1/D-2, 8 Aug 2026) ──────────────
  // tagsFor adds `nsaid` to aspirin BY NAME (L45) at any dose, so aspirin 75 mg — an antiplatelet,
  // not analgesic therapy — fired `nsaid × ace_arb` beside an ARB and lowered live scores
  // (metamorphic relation D-7). The DOSE is not knowable here: this file sees a name and a
  // formulary class, never a strength or a frequency. The caller that CAN compute it
  // (ddiFindings → aspirinMaxDailyMg, lib/opd-note-audit.ts) marks the item, and the tag is
  // removed here, AFTER tagsFor has run — so tagsFor's signature and body are untouched and every
  // route into the tag (the name list AND `mj.includes('nsaid')`) is covered by the one deletion.
  // `antiplatelet` is never removed: low-dose aspirin still fires DAPT and anticoagulant pairs.
  const tagged = items.map((i) => {
    const tags = tagsFor(i.name, i.major, i.minor);
    if (i.suppressNsaid) tags.delete('nsaid');
    return { name: i.name, tags };
  });
  const out: DdiPair[] = [];
  for (let i = 0; i < tagged.length; i++) {
    for (let j = i + 1; j < tagged.length; j++) {
      const A = tagged[i], B = tagged[j];
      if (A.name.toLowerCase() === B.name.toLowerCase()) continue;
      let best: DdiPair | null = null;
      for (const r of TAG_RULES) {
        const hit = (A.tags.has(r.a) && B.tags.has(r.b)) || (A.tags.has(r.b) && B.tags.has(r.a));
        if (!hit) continue;
        if (!best || SEV[r.severity] > SEV[best.severity]) {
          best = { ...orderPair(A.name, B.name), severity: r.severity, mechanism: r.mechanism, recommendation: r.rec, source: 'EHRC class rule' };
        }
      }
      if (best) out.push(best);
    }
  }
  return out;
}
