/**
 * lib/ipd-episode/resolve-core.ts — the DETERMINISTIC omission resolver (PRD decision 33,
 * V, 2026-09-02). Pure: no db, no model, no Next.
 *
 * ⚠️ WHY THIS FILE EXISTS. Three runs of IP-1286 scored 96, 100 and 80 on byte-identical
 * checkpoints, and across all three ZERO findings had an empty `evidence_basis` and ZERO rested on
 * a Tier C source — yet the judge returned 0, 12 and 11 `unassessable` verdicts, ten of them on
 * Tier A evidence. The model was not reporting that the mirror could not answer; it was declining
 * to commit. And the question it was declining on — did the expected thing happen — is not a
 * judgement at all. It is a lookup.
 *
 * DECISION 33: whether an expected action happened is a DATABASE QUESTION. Code decides it. The
 * model proposes what to expect, and its severity, while it is still blinded; this module answers
 * whether it happened. Nothing here can waver between runs, because nothing here asks an opinion.
 *
 * The four outcomes, and the one that is deliberately narrow:
 *
 *   PRESENT                 a matching event exists at or after the entry's by_day → concordant
 *   ABSENT, class present   the data class IS represented in this episode, so the absence is real
 *                           → divergent, at the severity proposed at generation time
 *   ABSENT, class missing   the class is not represented at all (no lab rows anywhere; vitals and
 *                           radiology are not in this mirror) → unassessable. THE ONLY PATH THAT
 *                           MAY PRODUCE unassessable.
 *   AMBIGUOUS               the class exists but cannot settle THIS question — a package bill can
 *                           hide a dispensed drug, a panel can hide an analyte → context_dependent
 *
 * Every finding records which path produced it, in `resolution`, together with the matcher that
 * resolved it. A validator can re-derive the whole omission set from the stored course and the
 * stored events without running a model.
 */

import type { EpisodeEvent } from './assemble-core';

// ── the matcher (emitted by the checkpoint model at generation time, item 1) ─────────────────

export const MATCHER_KINDS = ['lab', 'drug', 'imaging', 'procedure', 'note', 'vitals', 'other'] as const;
export type MatcherKind = (typeof MATCHER_KINDS)[number];

export interface ExpectationMatcher {
  kind: MatcherKind;
  /** Lower-cased search terms. A match on ANY term is a match. */
  terms: string[];
}

/** The `section` value `run.ts` gives an escalation trigger. Named here because the resolver's
 *  conditional gate keys on it, and a typo would silently reopen the hole it closes. */
export const ESCALATION_SECTION = 'escalation';

export const RESOLUTIONS = ['present', 'absent_class_present', 'absent_class_missing', 'ambiguous_confounded'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

// ── class availability ──────────────────────────────────────────────────────────────────────

/**
 * Is this data class represented in the episode at all?
 *
 * ⚠️ TWO CLASSES ARE NEVER REPRESENTED, AND THAT IS A FACT ABOUT THE MIRROR, NOT THIS EPISODE.
 * `vitals` has no table in the KX mirror at all (the Even-native `chart_*` layer holds observations
 * but its encounter namespace does not join — reference §2, overlap measured at zero). `imaging` is
 * effectively absent: `kx_radiology_reports` reaches 24 encounters by uhid and 1 by visit_id, and
 * `chart_radiology_report` has zero rows — the reference's own instruction is "treat radiology as
 * unavailable". An expectation of either therefore resolves `unassessable` on EVERY episode, which
 * is the honest answer: this pipeline cannot tell you whether a chest film was done.
 *
 * ⚠️ ROUND 14 ITEM 2 — THE WINDOW, NOT THE ADMISSION. `fromDay` scopes the question to the days the
 * expectation could have been satisfied in, and that changes the answer.
 *
 * On IPNO-416 four day-3 findings fired as real divergences on a day with ZERO progress notes,
 * because notes existed on days 0 to 2 and the class was therefore "represented". Admission-scoped
 * presence answers a question nobody asked: it says the hospital writes notes, not that it wrote
 * one on the day the expectation was about. Where the class is empty in the expectation's OWN
 * window, "it did not happen" and "nothing was recorded that day" are indistinguishable, and
 * `unassessable` is the only honest verdict.
 *
 * The day the class went silent is not lost with it — `discharge-day` documentation gaps become a
 * finding of their own in judge-core (`missingDischargeDayNote`), which is the signal that
 * day-scoping would otherwise swallow.
 */
export function classIsRepresented(
  kind: MatcherKind, events: readonly EpisodeEvent[], fromDay: number | null = null,
): boolean {
  if (fromDay != null) events = events.filter((e) => e.day_index >= fromDay);
  switch (kind) {
    case 'lab':
      return events.some((e) => e.event_type === 'lab_order');
    case 'drug':
      return events.some((e) => e.event_type === 'order' && detail(e, 'service_type') === 'Pharmacy');
    case 'procedure':
      return events.some((e) => e.event_type === 'ot_note')
        || events.some((e) => e.event_type === 'order' && detail(e, 'service_type') !== 'Pharmacy');
    case 'note':
      return events.some((e) => e.event_type === 'note' || e.event_type === 'initial_assessment'
        || e.event_type === 'handover');
    case 'imaging':
      // ITEM 4: radiology IS in this mirror — as billing lines, not as a radiology table.
      return events.some(isRadiologyOrder);
    case 'vitals':
      // Still absent by construction: no vitals table joins on encounter_id (§2 of the reference).
      return false;
    case 'other':
    default:
      // Not a class this engine can look up. It is never "absent" in the checkable sense.
      return false;
  }
}

// ── the confounds, enumerated (item 2) ──────────────────────────────────────────────────────
//
// These are the cases where the class EXISTS but a negative lookup does not mean the thing did not
// happen. They are written out here, in code, precisely so the model is not asked to weigh them.

/** A billing line that bundles its contents — a package, a kit, a bundled procedure charge. A drug
 *  dispensed inside one of these never appears under its own `ordered_item_name`. */
const PACKAGE_HINT = /\b(package|bundle|bundled|kit|combo|scheme|surgery charge|ot charge|procedure charge|day care)\b/i;

/**
 * ROUND 14 ITEM 6 — WHICH PANEL CONTAINS WHICH ANALYTE, rather than "a panel was ordered, so who
 * can say".
 *
 * The old rule found ANY panel-shaped lab order in the episode and blamed the absence on it. On
 * IPNO-416 that made r-1 (creatinine, urea) and r-4 (electrolytes) `context_dependent` against the
 * CBC panel — which contains none of those — while a KFT ordered on day 0 contains all of them.
 * Both should have been PRESENT. A confound attributed to a panel that cannot hold the analyte is
 * not a caveat, it is a wrong answer wearing a caveat's clothes.
 *
 * So a panel now RESOLVES an expectation when it demonstrably contains the analyte, and may only
 * be offered as a confound when it is a panel this table cannot enumerate. Anything else is a
 * plain absence.
 */
export const PANEL_CONTENTS: { match: RegExp; name: string; analytes: string[] }[] = [
  {
    match: /\b(kft|rft|renal function|kidney function|renal profile)\b/i,
    name: 'renal function test',
    analytes: ['creatinine', 'urea', 'bun', 'blood urea nitrogen', 'sodium', 'potassium', 'chloride',
      'electrolyte', 'electrolytes', 'uric acid', 'egfr'],
  },
  {
    match: /\b(lft|liver function|liver profile|hepatic panel)\b/i,
    name: 'liver function test',
    analytes: ['bilirubin', 'sgot', 'sgpt', 'ast', 'alt', 'alkaline phosphatase', 'alp', 'albumin',
      'total protein', 'ggt'],
  },
  {
    match: /\b(cbc|complete blood count|haemogram|hemogram|complete haemogram)\b/i,
    name: 'complete blood count',
    analytes: ['haemoglobin', 'hemoglobin', 'hb', 'wbc', 'tlc', 'total leucocyte', 'dlc', 'platelet',
      'rbc', 'haematocrit', 'hematocrit', 'pcv', 'mcv', 'neutrophil', 'lymphocyte'],
  },
  {
    match: /\b(electrolyte|electrolytes|serum electrolytes)\b/i,
    name: 'serum electrolytes',
    analytes: ['sodium', 'potassium', 'chloride', 'bicarbonate', 'na', 'k'],
  },
  {
    match: /\b(coagulation|coagulation profile|pt\/inr|prothrombin)\b/i,
    name: 'coagulation profile',
    analytes: ['pt', 'prothrombin time', 'inr', 'aptt', 'ptt', 'bleeding time', 'clotting time'],
  },
  {
    match: /\b(lipid profile|lipid panel)\b/i,
    name: 'lipid profile',
    analytes: ['cholesterol', 'triglyceride', 'hdl', 'ldl', 'vldl'],
  },
  {
    match: /\b(thyroid profile|thyroid function|tft)\b/i,
    name: 'thyroid function test',
    analytes: ['tsh', 't3', 't4', 'free t4', 'free t3'],
  },
  {
    match: /\b(abg|arterial blood gas|blood gas)\b/i,
    name: 'arterial blood gas',
    analytes: ['ph', 'pco2', 'po2', 'bicarbonate', 'hco3', 'lactate', 'base excess', 'oxygenation',
      'acid base', 'acidosis'],
  },
  {
    match: /\b(urine routine|urinalysis|urine r\/m|urine routine and microscopy)\b/i,
    name: 'urine routine examination',
    analytes: ['urine protein', 'proteinuria', 'urine albumin', 'pus cell', 'urine microscopy',
      'urine ph', 'urine sugar'],
  },
];

/** A panel-shaped order this table cannot enumerate: it may or may not hold the analyte. */
const UNENUMERATED_PANEL_HINT = /\b(profile|panel|screen|screening|series)\b/i;

export interface Confound { kind: MatcherKind; reason: string }

/**
 * Does something in this episode make a NEGATIVE lookup unsafe for this class? Returns the reason
 * when it does, so the stored finding can say WHY it is context_dependent rather than divergent.
 */
export function confoundFor(
  kind: MatcherKind, events: readonly EpisodeEvent[], terms: readonly string[] = [],
): Confound | null {
  if (kind === 'drug') {
    const pkg = events.find((e) => e.event_type === 'order'
      && PACKAGE_HINT.test(`${detail(e, 'service_item_name')} ${detail(e, 'ordered_item_name')} ${detail(e, 'department')}`));
    if (pkg) {
      return { kind, reason: `a bundled billing line (${detail(pkg, 'service_item_name') || detail(pkg, 'ordered_item_name') || 'package'}) can hide a dispensed drug` };
    }
  }
  if (kind === 'lab') {
    // ITEM 6. Only a panel this table CANNOT enumerate is a confound; one it can enumerate has
    // already answered the question in `panelContaining` — present if it holds the analyte, and
    // silent if it does not, because a panel that cannot hold it explains nothing about it.
    const panel = events.find((e) => e.event_type === 'lab_order'
      && UNENUMERATED_PANEL_HINT.test(detail(e, 'service_name'))
      && !PANEL_CONTENTS.some((p) => p.match.test(detail(e, 'service_name'))));
    if (panel) {
      return {
        kind,
        reason: `an unenumerated panel order (${detail(panel, 'service_name')}) may contain ${terms.length ? `"${terms[0]}"` : 'the analyte'} without naming it`,
      };
    }
  }
  if (kind === 'procedure') {
    // An OT note's procedure detail is free text; a step performed inside an operation is not
    // separately recorded anywhere.
    if (events.some((e) => e.event_type === 'ot_note')) {
      return { kind, reason: 'an operative step performed within a recorded procedure is not separately billed or noted' };
    }
  }
  return null;
}

/**
 * ITEM 6. The panel order that demonstrably CONTAINS one of these terms, if one was placed in the
 * window. Naming it is the whole point: "creatinine was covered by the renal function test ordered
 * on day 0" is an answer; "a panel was ordered" is not.
 */
export function panelContaining(
  terms: readonly string[], events: readonly EpisodeEvent[], fromDay: number | null,
): { event: EpisodeEvent; panel: string; term: string } | null {
  const wanted = expandTermsWithCatalogue(terms);
  if (!wanted.length) return null;
  for (const e of events) {
    if (e.event_type !== 'lab_order') continue;
    if (fromDay != null && e.day_index < fromDay) continue;
    const name = detail(e, 'service_name');
    for (const p of PANEL_CONTENTS) {
      if (!p.match.test(name)) continue;
      for (const term of wanted) {
        // Either direction: the expectation may name "creatinine" or "serum creatinine level".
        if (p.analytes.some((a) => term === a || term.includes(a) || a.includes(term))) {
          return { event: e, panel: p.name, term };
        }
      }
    }
  }
  return null;
}

/**
 * ROUND 21 ITEM 2 — THE HOSPITAL'S OWN CATALOGUE, BECAUSE MATCHER TERMS ARE NOT A RESOLUTION KEY.
 *
 * Two failures on IPNO-486 alone, both structural rather than unlucky:
 *
 *   · a matcher of "iv line / intravenous access / peripheral line" matches NOTHING in a catalogue
 *     whose actual entries are `VASOFIX 20G` (741 rows), `CANNULAE-.-20G-…BD-1's` (996), `IV SET`
 *     (853), `VENFLON`, `INFUSION SET`. The clinical concept and the billing string share no word.
 *   · the day-1 antiepileptic matcher listed "brevipil" and the day-2 matcher did not, so the SAME
 *     drug resolved present on one day and divergent on the next. The model's term list is a
 *     guess at what the catalogue calls a thing, and it varies between checkpoints of one episode.
 *
 * So terms are expanded against a table derived from db13's own item and service names before any
 * match is attempted. Every entry below was READ OUT OF THE CATALOGUE, with its row count, not
 * recalled: the antiepileptic block exists because the catalogue carries both
 * `LEVETIRACETAM-INJECTION-100MG-LEVIPIL 5ML INJ` and a bare `BREVIPIL 10MG INJ`, so brand and
 * generic each have to reach the other.
 *
 * Expansion is BIDIRECTIONAL and additive: a matcher naming the generic finds the brand, a matcher
 * naming the brand finds the generic, and nothing that matched before stops matching.
 */
export const CATALOGUE_SYNONYMS: readonly (readonly string[])[] = [
  // vascular access — the failing case, all counts from kx_billing_records
  ['iv line', 'iv access', 'intravenous access', 'peripheral line', 'peripheral cannula',
   'venous access', 'vasofix', 'cannula', 'cannulae', 'venflon', 'iv set', 'infusion set',
   'scalp vein', 'iv cannulazation', 'iv cannulation'],
  // antiepileptics — brand and generic both appear as bare strings in the catalogue
  ['brivaracetam', 'brevipil', 'brivasure'],
  ['levetiracetam', 'levipil'],
  ['valproate', 'sodium valproate', 'divalproex', 'encorate'],
  ['lacosamide', 'lacosam'],
  ['phenytoin', 'eptoin'],
  // imaging modalities — names live in `service_item_name` under service_type 'Radiology'
  ['x-ray', 'xray', 'x ray', 'radiograph', 'chest film'],
  ['ultrasound', 'usg', 'sonography', 'ultrasonography'],
  ['ct', 'cect', 'computed tomography', 'ct scan'],
  ['mri', 'magnetic resonance', 'mr imaging'],
  ['doppler', 'colour doppler', 'color doppler'],
  ['venogram', 'venography', 'mr venogram'],
  // neurophysiology — `EEG - Bedside` (27), `EEG` (3), `EEG - Routine` (1), all service_type Procedure
  ['eeg', 'electroencephalogram', 'electroencephalography'],
  ['ecg', 'ekg', 'electrocardiogram'],
  // common ward procedures whose billing string differs from the clinical phrase
  ['urinary catheter', 'foley', 'catheterisation', 'catheterization', 'foleys'],
  ['ryles tube', 'nasogastric', 'ng tube', 'rt insertion'],
  ['central line', 'cvc', 'central venous catheter', 'triple lumen'],
  ['blood transfusion', 'prbc', 'packed cell', 'packed red'],
  ['dialysis', 'haemodialysis', 'hemodialysis', 'hd', 'sledd'],
];

const SYNONYM_INDEX: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const group of CATALOGUE_SYNONYMS) {
    for (const term of group) {
      const key = term.toLowerCase();
      m.set(key, [...(m.get(key) ?? []), ...group.map((g) => g.toLowerCase()).filter((g) => g !== key)]);
    }
  }
  return m;
})();

/** A matcher's terms, plus every catalogue synonym of each. Deduplicated, order-stable. */
export function expandTermsWithCatalogue(terms: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => { const k = t.toLowerCase().trim(); if (k && !seen.has(k)) { seen.add(k); out.push(k); } };
  for (const t of terms) {
    add(t);
    for (const syn of SYNONYM_INDEX.get(t.toLowerCase().trim()) ?? []) add(syn);
  }
  return out;
}

/**
 * The catalogue concepts a piece of item text mentions — the canonical (first) term of every
 * synonym group it hits. Used by the day-0 query builder (item 6) to turn a pharmacy line into a
 * clinical word: `BREVIPIL 10MG INJ` becomes `brivaracetam`, and a surgical stapler becomes
 * nothing at all, which is what keeps round 7 item 7's lesson intact.
 */
export function catalogueConceptsIn(text: string): string[] {
  const hay = String(text ?? '').toLowerCase();
  const out: string[] = [];
  for (const group of CATALOGUE_SYNONYMS) {
    if (group.some((t) => termMatches(t, hay))) {
      const canonical = group[0];
      if (!out.includes(canonical)) out.push(canonical);
    }
  }
  return out;
}

/**
 * ROUND 21 ITEM 3 — NEVER SCORE DIVERGENT OFF A PREMISE THIS PIPELINE CANNOT OBSERVE.
 *
 * `results_available` is false on EVERY lab order in this database and there is no vitals class at
 * all, so an expectation whose action is CONDITIONAL on a value — "correct the abnormality if low",
 * "titrate to a target", "repeat if deranged" — has an antecedent nothing here can evaluate. Scoring
 * its absence as a major omission asserts that a correction was needed, which is precisely the fact
 * the substrate withholds.
 *
 * This is the same argument as the escalation gate (round 17/18); it applies wherever the premise
 * is a number nobody recorded, not only in the escalation section.
 */
const VALUE_CONDITIONAL = /\b(if (it is |the |they are |there is |values? |levels? )?(low|high|abnormal|elevated|raised|deranged|reduced|persistent|worsening|positive|negative|below|above|<|>)|if (hypo|hyper)[a-z]+|as (clinically )?indicated by|based on (the )?(result|value|level)|titrat\w+ to|target (of )?[<>]?\s*\d|maintain\w* (\w+ )*(above|below|between)|correct(ion)? (of )?\w* ?if|(replace|supplement)\w* if|when (values?|levels?) )/i;

/**
 * ROUND 23 ITEM 7 — PAPER ARTEFACTS THIS ENGINE CANNOT SEE AT ALL.
 *
 * Informed consent, preoperative anaesthetic clearance, a signed checklist: real and important, and
 * outside every data class this pipeline reads. There is no table in which their presence or
 * absence is recorded, so calling one missing is not a finding, it is a guess about paperwork.
 *
 * ⚠️ AND A CONDITIONAL WHOSE ANTECEDENT WAS NEVER ESTABLISHED. IPNO-495 was penalised for the
 * absence of a treponemal confirmatory test with no evidence anywhere that the VDRL was ever
 * positive. "Confirm X if the screen is positive" is unscoreable when nothing says the screen was
 * positive — and results_available is false on every lab row, so nothing ever can.
 */
const PAPER_ARTEFACT = /\b(informed consent|consent form|written consent|pre[- ]?operative clearance|preop clearance|anaesthe(tic|sia) clearance|fitness (for|certificate)|surgical safety checklist|sign[- ]?off|counsell?ing documented)\b/i;

const UNESTABLISHED_ANTECEDENT = /\b(confirmator\w+|confirm\w* (test|assay)|if (the )?(screen|test|result)\w* (is |was )?(positive|reactive|abnormal)|follow[- ]?up (test|assay) if)\b/i;

export function premiseIsUnobservable(item: string): boolean {
  const t = String(item ?? '');
  return VALUE_CONDITIONAL.test(t) || PAPER_ARTEFACT.test(t) || UNESTABLISHED_ANTECEDENT.test(t);
}

/**
 * ROUND 21 ITEM 4 — IMAGING IS AUDITABLE NOW.
 *
 * `classIsRepresented('imaging')` returned false unconditionally, so nine imaging expectations on
 * IPNO-486 resolved `absent_class_missing` on an episode carrying four MRIs, a brain venogram, a
 * whole-spine survey and a chest X-ray on day 0. It protected the score by accident and made the
 * whole class unauditable.
 *
 * Radiology IS in this mirror, in the billing table: `service_type = 'Radiology'` (3,180 rows,
 * `department = 'Diagnostic- Radiology'` 3,191). ⚠️ Its `ordered_item_name` is EMPTY — the modality
 * lives in `service_item_name` ("X-Ray Chest Pa", "CT BRAIN PLAIN", "MRI Brain Plain With
 * Contrast", "Ultrasound Abdomen & Pelvis"), which `haystackFor` already reads.
 *
 * Matching an imaging expectation therefore looks at RADIOLOGY ORDERS ONLY, never at every order —
 * otherwise "chest x-ray" could be satisfied by a pharmacy line mentioning a chest drain.
 */
const RADIOLOGY_SERVICE = /radiolog|imaging/i;

export function isRadiologyOrder(e: EpisodeEvent): boolean {
  if (e.event_type !== 'order') return false;
  return RADIOLOGY_SERVICE.test(`${detail(e, 'service_type')} ${detail(e, 'department')}`);
}

// ── matching ────────────────────────────────────────────────────────────────────────────────

const detail = (e: EpisodeEvent, key: string): string => {
  const v = (e.detail as Record<string, unknown>)?.[key];
  return v == null ? '' : String(v);
};

/** The text a matcher is tested against, per event kind. Deliberately narrow: an event's whole
 *  JSON would match almost anything, which would turn every expectation into a false PRESENT. */
export function haystackFor(e: EpisodeEvent): string {
  switch (e.event_type) {
    case 'lab_order':
      return `${detail(e, 'service_name')} ${detail(e, 'sub_department')}`;
    case 'order':
      return `${detail(e, 'ordered_item_name')} ${detail(e, 'service_item_name')} ${detail(e, 'service_type')} ${detail(e, 'department')}`;
    case 'ot_note':
      return expandClinicalShorthand(`${detail(e, 'surgery_name')} ${e.summary}`);
    case 'note':
    case 'initial_assessment':
    case 'handover':
      // ITEM 5: a note is where shorthand lives, and where a false negative costs the most.
      return expandClinicalShorthand(e.summary);
    default:
      return e.summary;
  }
}

/** Which event types a matcher kind may match against — so a `drug` expectation cannot be
 *  satisfied by the word appearing in a progress note. */
export function eventTypesFor(kind: MatcherKind): readonly EpisodeEvent['event_type'][] {
  switch (kind) {
    // ITEM 4: GRBS was ordered on nine days of IPNO-495 as Procedure and Pathology BILLING lines
    // while "grbs" sat in the matcher terms, and glucose monitoring was called absent three times.
    // A lab is ordered before it is resulted, and in this mirror the order is often a billing row.
    case 'lab': return ['lab_order', 'order'];
    case 'drug': return ['order'];
    case 'procedure': return ['ot_note', 'order'];
    case 'imaging': return ['order'];
    case 'note': return ['note', 'initial_assessment', 'handover'];
    default: return [];
  }
}

/**
 * ROUND 14 ITEM 5 — CLINICAL SHORTHAND, EXPANDED BEFORE ANY NEGATIVE IS ASSERTED.
 *
 * "P/A- SOFT NONTENDER" IS an abdominal examination. The resolver could not see that, so an
 * expectation phrased "abdominal examination documented" resolved absent against a note that
 * plainly contained one — a false omission, which is worse than a missed one: it is the audit
 * inventing a failure.
 *
 * EVERY EXPANSION BELOW WAS READ OFF THE REAL NOTES, not recalled. The IPNO-416 course was grepped
 * for slash-shorthand and each token resolved from its own context:
 *
 *   "C/S/B Dr <name>: 1) Bilateral acute pyelonephritis…"   → Case Seen By  (a review header)
 *   "o/e pallor+ BP-110/70 … S/E- CVS-S1S2+ RS-B/L NVBS+ CNS-NAD P/A- SOFT NONTENDER"
 *   "S/P B/L DJ stenting - POD 0"                            → status post, bilateral, post-op day
 *   "I/O-2433/2505"                                          → intake/output
 *
 * V named P/A, O/E, S/E, C/S/B, POD and K/C/O. The rest of this table is what the same notes
 * actually contained beside them, listed in the report.
 *
 * ⚠️ EXPANSION IS ADDITIVE AND WHOLE-TOKEN ONLY. The shorthand is APPENDED to the haystack, never
 * substituted, so nothing that matched before stops matching; and the token must stand alone, so
 * "hd" inside "childhood" cannot become "dialysis".
 */
export const CLINICAL_SHORTHAND: Record<string, string> = {
  // examination headers — the ones that turn a negative into a false omission
  'p/a': 'per abdomen abdominal examination abdomen',
  'o/e': 'on examination examination examined',
  's/e': 'systemic examination examination',
  'l/e': 'local examination examination',
  'p/r': 'per rectum rectal examination',
  'p/v': 'per vaginum vaginal examination',
  'c/s/b': 'case seen by review reviewed ward round',
  'c/c/c': 'conscious coherent cooperative',
  // system headers
  'r/s': 'respiratory system respiratory chest',
  'cvs': 'cardiovascular system cardiac heart',
  'cns': 'central nervous system neurological',
  'p/s': 'peripheral smear',
  // status and history
  'k/c/o': 'known case of history known',
  's/p': 'status post',
  'h/o': 'history of history',
  'pod': 'post operative day postoperative',
  'b/l': 'bilateral',
  'd/w': 'discussed with discussion',
  'r/v': 'review reviewed',
  // findings and measures that an expectation is likely to name
  'nad': 'no abnormality detected normal',
  'nvbs': 'normal vesicular breath sounds air entry',
  'i/o': 'intake output fluid balance urine output',
  'u/o': 'urine output',
  'spo2': 'oxygen saturation saturation',
  'grbs': 'random blood sugar glucose capillary blood glucose',
  'rbs': 'random blood sugar glucose',
  'fbs': 'fasting blood sugar glucose',
  'hd': 'haemodialysis hemodialysis dialysis',
  'mhd': 'maintenance haemodialysis dialysis',
  'ot': 'operation theatre surgery',
  'inj': 'injection',
  'tab': 'tablet',
};

/**
 * Append the expansion of every shorthand token present in the text. Deterministic and additive.
 */
export function expandClinicalShorthand(text: string): string {
  const t = (text || '').toLowerCase();
  const extra: string[] = [];
  for (const [token, expansion] of Object.entries(CLINICAL_SHORTHAND)) {
    const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9/])${esc}([^a-z0-9/]|$)`).test(t)) extra.push(expansion);
  }
  return extra.length ? `${text} ${extra.join(' ')}` : text;
}

/**
 * ── THE CANONICAL SUBJECT VOCABULARY (round 14 items 4 and 7) ────────────────────────────────
 *
 * It lives HERE, beside the clinical-shorthand layer, because both answer the same question — how
 * this engine normalises clinical language — and because BOTH of its callers can reach it from
 * here: judge-core groups expectations by subject, and checkpoint-core judges whether a retrieved
 * passage is on topic. Keeping one vocabulary is the whole lesson of this round: item 4 and the
 * round-13 digest were one defect in two places, and item 7 turned out to be a third.
 */
const PURPOSE_CLAUSE = /\b(to (assess|evaluate|guide|monitor|detect|exclude|rule out|confirm|check|determine|track|follow)|for (assessment|evaluation|monitoring|surveillance)|in order to)\b.*$/i;

const SUBJECT_STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'or', 'with', 'without', 'per', 'as', 'at', 'by', 'on', 'in',
  'is', 'be', 'should', 'must', 'may', 'if', 'any', 'all', 'both', 'each', 'this', 'that',
  'repeat', 'repeated', 'serial', 'daily', 'hourly', 'routine', 'regular', 'ongoing', 'continue',
  'continued', 'consider', 'indicated', 'required', 'needed', 'appropriate', 'adequate', 'new',
  'further', 'additional', 'follow', 'up', 'documented', 'documentation', 'document', 'record',
  'recorded', 'obtain', 'obtained', 'perform', 'performed', 'check', 'checked', 'ensure', 'review',
  'reviewed', 'assessment', 'assessed', 'level', 'levels', 'status', 'test', 'tests', 'study',
  'studies', 'value', 'values', 'result', 'results', 'patient', 'patients', 'within', 'hours',
  'hour', 'day', 'days', 'post', 'pre', 'including', 'include', 'includes', 'such',
]);

/**
 * Words that mean the same subject. Small and deliberate — not a medical ontology.
 *
 * ⚠️ EVERY CANONICAL VALUE IS ALSO A KEY, and that is enforced below rather than typed out. The
 * first version of this map omitted `stent: 'stent'`, so the word "stent" itself was not
 * recognised as a concept and the three stent-monitoring expectations fell back to their full word
 * sets — the exact failure the map exists to fix, reintroduced by a gap a reader cannot see.
 */
const SUBJECT_SYNONYM_SEED: Record<string, string> = {
  kft: 'renalfunction', rft: 'renalfunction', renal: 'renalfunction', kidney: 'renalfunction',
  creatinine: 'renalfunction', urea: 'renalfunction', bun: 'renalfunction',
  lft: 'liverfunction', liver: 'liverfunction', hepatic: 'liverfunction',
  cbc: 'bloodcount', haemogram: 'bloodcount', hemogram: 'bloodcount', haemoglobin: 'bloodcount',
  hemoglobin: 'bloodcount', hb: 'bloodcount', platelet: 'bloodcount', platelets: 'bloodcount',
  // Electrolytes fold into renal function DELIBERATELY: they are reported in the same panel
  // (see PANEL_CONTENTS' renal function test), ordered together, and monitored for the same
  // reason. Keeping them apart split "serum creatinine and electrolytes" from "renal function
  // test (creatinine, urea, electrolytes)" — the two round-13 wordings the digest could not merge.
  electrolyte: 'renalfunction', electrolytes: 'renalfunction', sodium: 'renalfunction',
  potassium: 'renalfunction', na: 'renalfunction', chloride: 'renalfunction',
  hyperkalemia: 'renalfunction', hyperkalaemia: 'renalfunction',
  dj: 'stent', stents: 'stent', stenting: 'stent', ureteric: 'stent', ureteral: 'stent',
  abg: 'bloodgas', gas: 'bloodgas', gases: 'bloodgas',
  antibiotic: 'antibiotics', antimicrobial: 'antibiotics', abx: 'antibiotics',
  dialysis: 'dialysis', haemodialysis: 'dialysis', hemodialysis: 'dialysis', hd: 'dialysis',
  culture: 'culture', cultures: 'culture', sensitivity: 'culture',
  urine: 'urine', urinary: 'urine', urinalysis: 'urine',
  vte: 'vte', thromboprophylaxis: 'vte', prophylaxis: 'vte', enoxaparin: 'vte', heparin: 'vte',
  glucose: 'glycaemia', sugar: 'glycaemia', glycaemic: 'glycaemia', glycemic: 'glycaemia',
  bp: 'bloodpressure', pressure: 'bloodpressure',
  output: 'urineoutput', fluid: 'fluidbalance', balance: 'fluidbalance', euvolemia: 'fluidbalance',
  pain: 'pain', analgesia: 'pain', analgesic: 'pain',
  nutrition: 'nutrition', diet: 'nutrition', feeding: 'nutrition',
  // ROUND 14 ITEM 7 uses this same vocabulary to judge whether a retrieved passage is on topic,
  // so the DIAGNOSIS words a corpus title uses belong here beside the investigation words. The
  // query said "renal" and "CKD" while the titles said "kidney" and "nephrology", and a raw-word
  // overlap test called eight on-topic nephrology sources off topic for it.
  ckd: 'renalfunction', esrd: 'renalfunction', uremia: 'renalfunction', uraemia: 'renalfunction',
  nephropathy: 'renalfunction', nephrology: 'renalfunction', aki: 'renalfunction',
  diabetes: 'diabetes', diabetic: 'diabetes', dm: 'diabetes', hyperglycaemia: 'diabetes',
  hypertension: 'hypertension', hypertensive: 'hypertension', htn: 'hypertension',
  sepsis: 'sepsis', septic: 'sepsis', urosepsis: 'sepsis', septicaemia: 'sepsis',
  uti: 'urinaryinfection', pyelonephritis: 'urinaryinfection', cystitis: 'urinaryinfection',
  bacteriuria: 'urinaryinfection',
  pancreatitis: 'pancreatitis', pancreatic: 'pancreatitis',
  hepatitis: 'hepatitis', hbsag: 'hepatitis',
  hydroureteronephrosis: 'stent', ureterolithiasis: 'stent', ureteroscopy: 'stent',
  urs: 'stent', hydronephrosis: 'stent',
  anaemia: 'anaemia', anemia: 'anaemia', transfusion: 'anaemia',
};

/** The seed plus an identity entry for every canonical value it names. */
const SUBJECT_SYNONYMS: Record<string, string> = (() => {
  const m: Record<string, string> = { ...SUBJECT_SYNONYM_SEED };
  for (const v of Object.values(SUBJECT_SYNONYM_SEED)) m[v] = v;
  return m;
})();

/** The canonical concepts themselves — what `subjectWords` may return as a concept. */
export const SUBJECT_CONCEPTS: ReadonlySet<string> = new Set(Object.values(SUBJECT_SYNONYM_SEED));

/**
 * The canonical subject of a piece of expectation text: the CONCEPTS it is about, and nothing else.
 *
 * ⚠️ THE SET OF ALL SURVIVING WORDS IS THE WRONG KEY, and measuring it on IPNO-416 proved it —
 * grouping by full word-set produced 70 classes from 79 entries, WORSE than the 68 the term list
 * gave. Exact set equality is as brittle as an exact term list; it just fails on different words.
 * The three stent-monitoring expectations differed only in which symptoms each day happened to
 * list, and that was enough to keep them apart:
 *
 *   "Stent patency and complications (flank pain, fever, sepsis signs)"
 *   "Stent-related symptoms (dysuria, urgency, frequency, gross hematuria) and signs of migration"
 *   "Stent function and complications (flank pain, hematuria, fever, signs of obstruction)"
 *
 * All three are about ONE thing: the stent. So only words that canonicalise to a known concept
 * count toward the key; the incidental vocabulary around them is dropped. Text with no recognised
 * concept falls back to its own normalised words and can then only group with text like itself —
 * conservative, and the same fallback round 12 chose for a matcher-less entry.
 *
 * AND FOR AN ESCALATION TRIGGER, THE SUBJECT IS THE TRIGGER. Entries reach here as
 * "trigger → action"; the action is the response, not the thing being expected, and including it
 * splits two identical triggers that name different escalation routes.
 */
export function subjectWords(text: string): string[] {
  const trigger = String(text || '').split('→')[0];
  const cut = trigger.replace(/\([^)]*\)/g, ' ').replace(PURPOSE_CLAUSE, ' ');
  const concepts = new Set<string>();
  const plain = new Set<string>();
  for (const raw of cut.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || raw.length < 2) continue;
    if (SUBJECT_STOPWORDS.has(raw)) continue;
    if (/^\d+$/.test(raw)) continue;
    const singular = raw.endsWith('s') && raw.length > 3 ? raw.slice(0, -1) : raw;
    const canonical = SUBJECT_SYNONYMS[raw] ?? SUBJECT_SYNONYMS[singular];
    if (canonical) concepts.add(canonical); else plain.add(singular);
  }
  return concepts.size ? [...concepts].sort() : [...plain].sort();
}

/** The subject key an expectation groups on: its item text and its matcher terms, canonicalised. */

const norm = (s: string) => s.toLowerCase();

/**
 * ROUND 23 ITEM 3 — TOKEN-SET MATCHING, BECAUSE A SUBSTRING TEST IS NOT A CLINICAL ONE.
 *
 * `h.includes(t)` required the haystack to contain the term's exact words in the term's exact
 * order. Real catalogue strings do not oblige: "chest x-ray" never matched `X-RAY CHEST PA VIEW`,
 * and "ct angiogram" never matched `CT Peripheral angiogram`, because the words are the same and
 * the order is not.
 *
 * A multi-word term now matches when EVERY one of its tokens appears somewhere in the haystack,
 * each on a word boundary and each after synonym folding. Order is irrelevant; extra words in the
 * haystack are irrelevant; a missing token still fails, so "chest x-ray" does not match a plain
 * "x-ray knee".
 *
 * Single-word terms keep the strict whole-word rule they had — that half was never the problem —
 * and the 3-character floor stays, because "iv" would match everything.
 */
const TOKEN_SYNONYMS: Record<string, string> = (() => {
  const groups: readonly (readonly string[])[] = [
    ['angiogram', 'angiography', 'angio', 'cta', 'angiographic'],
    ['doppler', 'duplex'],
    ['ultrasound', 'usg', 'sonography', 'ultrasonography', 'sonogram'],
    ['xray', 'x-ray', 'radiograph', 'radiography'],
    ['ct', 'cect', 'tomography'],
    ['mri', 'mr'],
    ['echo', 'echocardiogram', 'echocardiography'],
    ['ecg', 'ekg', 'electrocardiogram'],
    ['eeg', 'electroencephalogram', 'electroencephalography'],
    ['culture', 'c/s', 'sensitivity'],
    ['glucose', 'grbs', 'rbs', 'sugar', 'glycaemia', 'glycemia'],
    ['creatinine', 'creat'],
    ['haemoglobin', 'hemoglobin', 'hb'],
    ['electrolytes', 'electrolyte'],
    ['abdomen', 'abdominal'],
    ['chest', 'thorax', 'thoracic'],
    ['brain', 'head', 'cranial'],
    ['spine', 'spinal', 'vertebral'],
    ['renal', 'kidney'],
  ];
  const m: Record<string, string> = {};
  for (const g of groups) for (const t of g) m[t] = g[0];
  return m;
})();

/**
 * ⚠️ LIGHT STEMMING, ADDED AFTER MEASURING. Token-set matching lost "dj stent" against
 * `Cystoscopy Urs With Dj Stenting Unilateral` — the words are the same and the inflection is not.
 * Only `-ing`, `-es` and `-s` are folded, and only when at least four characters remain, so
 * "stenting" reaches "stent" while short clinical tokens are left alone.
 *
 * Both the term and the haystack are folded, so the rule is symmetric and neither side has to
 * guess which form the other used.
 */
const stem = (w: string): string => {
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
};

const tokensOf = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const raw of norm(text).split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    const folded = TOKEN_SYNONYMS[raw] ?? TOKEN_SYNONYMS[stem(raw)] ?? stem(raw);
    out.add(folded);
  }
  return out;
};

export function termMatches(term: string, haystack: string): boolean {
  const t = norm(term).trim();
  if (t.length < 3) return false;
  const h = norm(haystack);
  if (!/\s/.test(t)) {
    const folded = TOKEN_SYNONYMS[t];
    const hay = tokensOf(h);
    if (folded && hay.has(folded)) return true;
    return new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(h);
  }
  // multi-word: every token must be present, in any order
  const want = tokensOf(t);
  if (!want.size) return false;
  const have = tokensOf(h);
  for (const w of want) if (!have.has(w)) return false;
  return true;
}

export interface MatchHit { event: EpisodeEvent; term: string }

/**
 * ROUND 14 ITEM 3 — AN EXPECTATION IS SATISFIED FROM THE DAY IT WAS FORMED, NOT BEFORE IT.
 *
 * ⚠️ THE OLD CODE SEARCHED THE WHOLE ADMISSION, and not by intent — the day test was written as an
 * `if` with an EMPTY BODY and a comment where the filter should have been, so `byDay` reached the
 * function and did nothing. Every "present" statement on IPNO-416 therefore read "day 0": r-32
 * (repeat CBC, expected day 2) and r-47 (KFT, expected day 3) were both marked satisfied by the
 * day-0 order, although correct later orders existed and could have been cited instead.
 *
 * A "repeat" expectation answered by the order that PROMPTED it is a silent false negative — the
 * audit reporting that a thing was done, using as proof the very thing whose repetition was being
 * asked for. It hides precisely the failure this engine exists to find.
 *
 * `fromDay` is the day the expectation was FORMED — the checkpoint's own day, not `by_day`. A
 * checkpoint at day 2 saw everything before day 2 when it wrote its expectations, so an event it
 * had already seen cannot be what satisfies them. `by_day` remains a statement about lateness, and
 * lateness is a `timing` question for the judge, not an eligibility test here.
 */
export function findMatch(
  matcher: ExpectationMatcher, fromDay: number | null, events: readonly EpisodeEvent[],
): MatchHit | null {
  const types = eventTypesFor(matcher.kind);
  if (!types.length) return null;
  // ITEM 2: the model's term list is a guess at what the catalogue calls a thing. Expand it.
  const terms = expandTermsWithCatalogue(matcher.terms);
  for (const e of events) {
    if (!types.includes(e.event_type)) continue;
    // ITEM 4: an imaging expectation is answered by RADIOLOGY orders, never by any order at all.
    if (matcher.kind === 'imaging' && !isRadiologyOrder(e)) continue;
    if (fromDay != null && e.day_index < fromDay) continue;
    const hay = haystackFor(e);
    for (const term of terms) {
      if (termMatches(term, hay)) return { event: e, term };
    }
  }
  return null;
}

// ── the resolver ────────────────────────────────────────────────────────────────────────────

export interface ResolvableEntry {
  /** `<checkpoint-id>/<section>/<n>` — the same ref the diff pass would have used. */
  ref: string;
  checkpointId: string;
  dayIndex: number;
  section: string;
  item: string;
  rationale: string;
  byDay: number | null;
  citationIds: number[];
  matcher: ExpectationMatcher | null;
  proposedSeverity: 'minor' | 'moderate' | 'major';
  /** DECISION 42: 'once' resolves across the whole episode, 'repeat' from this entry's day. */
  recurrence?: 'once' | 'repeat';
}

export interface ResolvedOutcome {
  resolution: Resolution;
  verdict: 'concordant' | 'divergent' | 'unassessable' | 'context_dependent';
  severity: 'minor' | 'moderate' | 'major';
  statement: string;
  matchedEvent: EpisodeEvent | null;
  matchedTerm: string | null;
  confound: string | null;
}

/**
 * Resolve ONE expected entry against the assembled event list. Total and deterministic: the same
 * entry and the same events give the same answer, every time, with no model in the loop.
 *
 * An entry with no matcher resolves `ambiguous_confounded` — the model failed to say what would
 * count as satisfying it, so code cannot check it and will not guess. That is a defect in the
 * generation, and it is recorded as one rather than scored as an omission.
 */
export function resolveEntry(
  entry: ResolvableEntry, events: readonly EpisodeEvent[], terminalDay: number | null = null,
): ResolvedOutcome {
  // ⚠️ ROUND 20 ITEM 1 / DECISION 41 — THE TERMINAL DAY IS UNASSESSABLE.
  //
  // Round 14 scoped class presence to the expectation's own window, which correctly turned the days
  // AFTER a death into `unassessable`. It missed the day OF the death, because the class is still
  // represented in that window: the patient was alive for part of it, notes and orders exist, so a
  // day-5 expectation on a patient who died on day 5 resolved `absent_class_present` — divergent.
  //
  // IPNO-573 is the measured case: three MAJOR findings on day 5, the day the patient died,
  // including "hourly neurological assessment (GCS, pupil reactivity, motor response)". Twenty-four
  // of its sixty-eight penalty points came from care a dead patient did not receive. IPNO-560,
  // recorded `Admitted Dead`, carried six majors of the same kind — empiric antibiotics, IV fluids,
  // glycaemic control — and banded `moderate` because of them.
  //
  // An expectation formed ON the day of death cannot be judged: nothing in this pipeline knows what
  // hour the patient died, so "it was not done" and "there was no longer a patient to do it to" are
  // indistinguishable. That is what `unassessable` means, and `absent_class_missing` is the
  // resolution that carries it — the same one §4.2a exempts from the postcondition.
  //
  // `terminalDay` is null on every episode whose discharge_type this engine does not recognise as
  // death, so an unknown value audits normally (see `dischargeIndicatesDeath`).
  if (terminalDay != null && entry.dayIndex >= terminalDay) {
    return {
      resolution: 'absent_class_missing',
      verdict: 'unassessable',
      severity: entry.proposedSeverity,
      statement: `Expected: ${entry.item}. This expectation was formed on or after the day the patient died (day ${terminalDay}), so this engine cannot judge it: nothing here records the hour of death, and "not done" cannot be told apart from "there was no longer a patient to do it to".`,
      matchedEvent: null, matchedTerm: null,
      confound: `the expectation's window opens on or after the day of death (day ${terminalDay})`,
    };
  }

  // ⚠️ ROUND 17 ITEM 1 — AN ESCALATION TRIGGER IS A CONDITIONAL, AND CODE CANNOT EVALUATE ITS
  // ANTECEDENT. THIS GATE WAS PROMPT-ONLY UNTIL NOW.
  //
  // "If SBP < 90, start noradrenaline" is not an expectation that something happened. It is an
  // expectation that something happened IF something else did. Whether the trigger fired is a
  // question about vitals and bedside observation, and this mirror carries neither — so the
  // resolver cannot tell "the action was omitted" from "the condition never arose".
  //
  // Until this branch, nothing enforced that. `run.ts` pushes every trigger into the resolver with
  // the MODEL'S OWN matcher, and the pipeline only behaved because `prompts.ts` suggests
  // `{"kind": "other"}` in the escalation slot of its schema example. A model returning
  // `{kind: 'drug', terms: ['noradrenaline']}` — a perfectly reasonable reading of the field —
  // would have had the trigger resolved as a drug lookup: no noradrenaline order, pharmacy data
  // present, therefore `absent_class_present`, therefore DIVERGENT. A patient who never became
  // hypotensive would be marked as having been denied a vasopressor.
  //
  // This file's own posture is that a prompt is an instruction and only code is a guarantee, and
  // this was the last hard constraint on the engine resting on the other side of that line.
  //
  // `absent_class_missing` is the resolution because it is the one that means "this pipeline cannot
  // answer" — and §4.2a exempts it from the `unassessable` postcondition for exactly that reason.
  if (entry.section === ESCALATION_SECTION) {
    return {
      resolution: 'absent_class_missing',
      verdict: 'unassessable',
      severity: entry.proposedSeverity,
      statement: `Expected on condition: ${entry.item}. This is a conditional, and this engine cannot check one: whether the trigger fired is a question about vitals and clinical observation, which this mirror does not carry. No conclusion is drawn about whether the action was needed or taken.`,
      matchedEvent: null, matchedTerm: null,
      confound: 'an escalation trigger is conditional and its antecedent cannot be evaluated from this mirror',
    };
  }

  // ⚠️ ROUND 21 ITEM 3 — AN EXPECTATION CONDITIONAL ON A VALUE NOBODY RECORDED.
  //
  // `results_available` is false on every lab order in this database and there is no vitals class,
  // so "correct the abnormality if low" has an antecedent this pipeline cannot evaluate. Calling
  // its absence a major omission asserts that a correction was needed — the exact fact the
  // substrate withholds. Same argument as the escalation gate, applied wherever the premise is a
  // number nobody wrote down.
  if (premiseIsUnobservable(entry.item)) {
    return {
      resolution: 'absent_class_missing',
      verdict: 'unassessable',
      severity: entry.proposedSeverity,
      statement: `Expected: ${entry.item}. This engine cannot judge it: the action is conditional on a value — a lab result or a vital sign — and this pipeline carries neither (every lab order here has results_available = false, and there is no vitals class at all). Whether the condition was met is unknown, so whether the action was owed is unknown.`,
      matchedEvent: null, matchedTerm: null,
      confound: 'the expectation is conditional on a lab value or vital sign, which this mirror does not carry',
    };
  }

  const m = entry.matcher;
  if (!m || !m.terms.length) {
    return {
      resolution: 'ambiguous_confounded',
      verdict: 'context_dependent',
      severity: entry.proposedSeverity,
      statement: `Expected: ${entry.item}. This engine cannot check it — the expectation carried no machine-checkable matcher, so its presence or absence was never established.`,
      matchedEvent: null, matchedTerm: null,
      confound: 'no matcher was emitted for this expectation',
    };
  }

  // ⚠️ DECISION 42 — THE WINDOW IS THE EXPECTATION'S OWN DECLARATION, NOT THE RESOLVER'S GUESS.
  //
  // Round 14 item 3 floored every search at the entry's own day, so "repeat CBC on day 2" could not
  // be answered by the day-0 order — right, and it broke the EEG. Round 21 item 1 removed the floor
  // so "EEG if not yet completed" found the day-0 EEG — right, and it re-opened the CBC. Two rounds
  // arguing over one window because the resolver was guessing at something only the expectation
  // knows: is an EARLIER occurrence enough, or is a NEW one required?
  //
  // The checkpoint now says, while still blinded. `once` searches the whole episode to date;
  // `repeat` searches from its own day. An absent or unrecognised value defaults to `repeat`, the
  // conservative direction — a wrong finding is visible and arguable, a silently satisfied
  // expectation is neither.
  const fromDay = (entry.recurrence ?? 'repeat') === 'once' ? null : entry.dayIndex;

  // ⚠️ CLASS PRESENCE STAYS DAY-SCOPED (round 14 item 2), and the two are NOT the same question.
  // MATCHING asks "did this ever happen in this admission" — the whole episode is the right search.
  // CLASS PRESENCE asks "could this even have been observed in the window the expectation was
  // about" — and there the day still matters: four day-3 findings once fired on a day with zero
  // notes because notes existed on days 0-2. Widening this one too would put those back.
  const classFromDay = entry.dayIndex;

  const hit = findMatch(m, fromDay, events);
  if (hit) {
    return {
      resolution: 'present',
      verdict: 'concordant',
      severity: entry.proposedSeverity,
      statement: `Expected: ${entry.item}. The record shows it: ${hit.event.event_type} on day ${hit.event.day_index} matching "${hit.term}".`,
      matchedEvent: hit.event, matchedTerm: hit.term, confound: null,
    };
  }

  // ITEM 6. Before calling a lab absent, ask whether a panel ORDERED IN THE WINDOW contains it.
  // A named containment is an answer; the old blanket "a panel was ordered" was not.
  if (m.kind === 'lab') {
    const viaPanel = panelContaining(m.terms, events, fromDay);
    if (viaPanel) {
      return {
        resolution: 'present',
        verdict: 'concordant',
        severity: entry.proposedSeverity,
        statement: `Expected: ${entry.item}. The record shows it: a ${viaPanel.panel} ordered on day ${viaPanel.event.day_index} includes "${viaPanel.term}".`,
        matchedEvent: viaPanel.event, matchedTerm: viaPanel.term, confound: null,
      };
    }
  }

  // ITEM 2. Day-scoped, not admission-scoped: was this class recorded AT ALL in the window the
  // expectation could have been met in?
  if (!classIsRepresented(m.kind, events, classFromDay)) {
    return {
      resolution: 'absent_class_missing',
      verdict: 'unassessable',
      severity: entry.proposedSeverity,
      statement: m.kind === 'vitals' || m.kind === 'imaging'
        ? `Expected: ${entry.item}. This pipeline cannot answer whether it happened: ${m.kind} data is absent from the mirror entirely.`
        : `Expected: ${entry.item}. This pipeline cannot answer whether it happened: no ${m.kind} record of any kind exists from day ${classFromDay} onward, so "not done" and "not recorded that day" cannot be told apart.`,
      matchedEvent: null, matchedTerm: null,
      confound: m.kind === 'vitals' || m.kind === 'imaging'
        ? `no ${m.kind} data in this mirror`
        : `no ${m.kind} data recorded from day ${classFromDay} onward`,
    };
  }

  const confound = confoundFor(m.kind, events, m.terms);
  if (confound) {
    return {
      resolution: 'ambiguous_confounded',
      verdict: 'context_dependent',
      severity: entry.proposedSeverity,
      statement: `Expected: ${entry.item}. No matching ${m.kind} record was found, but ${confound.reason}, so the absence cannot be read as the action not happening.`,
      matchedEvent: null, matchedTerm: null,
      confound: confound.reason,
    };
  }

  // ⚠️ DECISION 44 (V, 2026-09-04) — THE ENGINE MAY NOT ASSERT A NEGATIVE IT HAS NOT VERIFIED.
  //
  // On IPNO-495, 22 of 29 divergent findings had an EMPTY evidence_basis and a null matched_term,
  // and between them they carried 141 of the episode's 167 penalty points — 84% of the score
  // resting on assertions the engine had not checked, most of them contradicted by the episode's
  // own event list. The statement said "no matching record exists anywhere in this admission",
  // which is a claim about the record; what the resolver actually knows is narrower and duller:
  // its matcher did not fire.
  //
  // So an unmatched expectation with nothing to point at is `context_dependent`, and it says what
  // it did rather than what it concluded. The finding survives — a reader can still act on it —
  // but it no longer carries a divergent verdict's weight or its certainty.
  return {
    resolution: 'absent_class_present',
    verdict: 'context_dependent',
    severity: entry.proposedSeverity,
    statement: `Expected: ${entry.item}. Not detected by matcher: no ${m.kind} record matched the terms this expectation was given, though ${m.kind} data IS recorded from day ${classFromDay} onward. The matcher may be wrong about what the record calls this, so the absence is not asserted.`,
    matchedEvent: null, matchedTerm: null, confound: 'unmatched by the expectation’s own terms; the absence is not verified',
  };
}

/** Resolve every entry. Order is stable (the order the entries were generated in). */
export function resolveAll(
  entries: readonly ResolvableEntry[], events: readonly EpisodeEvent[],
  terminalDay: number | null = null,
): { entry: ResolvableEntry; outcome: ResolvedOutcome }[] {
  return entries.map((entry) => ({ entry, outcome: resolveEntry(entry, events, terminalDay) }));
}

/** Counts by resolution, for the audit row and for the report. */
export function resolutionCounts(
  resolved: readonly { outcome: ResolvedOutcome }[],
): Record<Resolution, number> {
  const out: Record<Resolution, number> = {
    present: 0, absent_class_present: 0, absent_class_missing: 0, ambiguous_confounded: 0,
  };
  for (const r of resolved) out[r.outcome.resolution]++;
  return out;
}
