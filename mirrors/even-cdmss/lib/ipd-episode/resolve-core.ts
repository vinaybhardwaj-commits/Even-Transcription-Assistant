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
    case 'vitals':
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
  const wanted = terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
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
    case 'lab': return ['lab_order'];
    case 'drug': return ['order'];
    case 'procedure': return ['ot_note', 'order'];
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

/** A term matches when it appears in the haystack, whole-word where the term is a single word.
 *  Terms shorter than 3 characters are ignored — "iv" would match everything. */
export function termMatches(term: string, haystack: string): boolean {
  const t = norm(term).trim();
  if (t.length < 3) return false;
  const h = norm(haystack);
  if (!/\s/.test(t)) {
    return new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(h);
  }
  return h.includes(t);
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
  for (const e of events) {
    if (!types.includes(e.event_type)) continue;
    // THE FILTER THE OLD COMMENT ONLY DESCRIBED.
    if (fromDay != null && e.day_index < fromDay) continue;
    const hay = haystackFor(e);
    for (const term of matcher.terms) {
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
export function resolveEntry(entry: ResolvableEntry, events: readonly EpisodeEvent[]): ResolvedOutcome {
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

  // ITEM 3. The window opens on the day the expectation was FORMED. An event the checkpoint had
  // already seen cannot be what satisfies what it went on to expect.
  const fromDay = entry.dayIndex;

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
  if (!classIsRepresented(m.kind, events, fromDay)) {
    return {
      resolution: 'absent_class_missing',
      verdict: 'unassessable',
      severity: entry.proposedSeverity,
      statement: m.kind === 'vitals' || m.kind === 'imaging'
        ? `Expected: ${entry.item}. This pipeline cannot answer whether it happened: ${m.kind} data is absent from the mirror entirely.`
        : `Expected: ${entry.item}. This pipeline cannot answer whether it happened: no ${m.kind} record of any kind exists from day ${fromDay} onward, so "not done" and "not recorded that day" cannot be told apart.`,
      matchedEvent: null, matchedTerm: null,
      confound: m.kind === 'vitals' || m.kind === 'imaging'
        ? `no ${m.kind} data in this mirror`
        : `no ${m.kind} data recorded from day ${fromDay} onward`,
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

  return {
    resolution: 'absent_class_present',
    verdict: 'divergent',
    severity: entry.proposedSeverity,
    statement: `Expected: ${entry.item}. No matching ${m.kind} record exists from day ${fromDay} onward, and ${m.kind} data IS recorded in that window — so the absence is real.`,
    matchedEvent: null, matchedTerm: null, confound: null,
  };
}

/** Resolve every entry. Order is stable (the order the entries were generated in). */
export function resolveAll(
  entries: readonly ResolvableEntry[], events: readonly EpisodeEvent[],
): { entry: ResolvableEntry; outcome: ResolvedOutcome }[] {
  return entries.map((entry) => ({ entry, outcome: resolveEntry(entry, events) }));
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
