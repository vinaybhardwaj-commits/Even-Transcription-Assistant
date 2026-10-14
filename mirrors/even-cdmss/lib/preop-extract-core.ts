/**
 * lib/preop-extract-core.ts — the model rail's PURE reading half (PRD v1.1-LOCKED §7 / D4;
 * Build Plan B5, repurposed by B8b). No DB, no fetch, no clock, NO MODEL: the calls are made by
 * lib/preop/suggest.ts, and everything that decides what a model is allowed to have said
 * lives here, where a table of cases can pin it.
 *
 * ⚠️ B8 CHANGED WHAT HAPPENS TO WHAT THIS FILE ACCEPTS. Its four gates are unchanged and
 * still run exactly as written — but an accepted reading is no longer an INPUT. It is a
 * SUGGESTION (lib/preop-suggest-core.ts), reconciled across three reads and shown on the
 * case page until a named human confirms it. The header below describes the gates; the
 * assertion it makes about scoring was true of B5 and is now the suggestion rail's job.
 *
 * THE INVARIANT THIS FILE DEFENDS. "A model may propose an INPUT (with provenance and
 * confidence) or write prose ABOUT a computed result. It may never contribute a point of
 * score." An extraction proposes a tri-state on ONE instrument input; the arithmetic that
 * turns inputs into a score never sees a model, and — B5's own addition — an extraction
 * may only ever fill an input the DETERMINISTIC pass left UNKNOWN
 * (see resolveInputs in preop-assemble-core.ts). It cannot overwrite a lab, a PAC field,
 * an ICD code, or the booking form's closed world. It can only speak where the record is
 * silent.
 *
 * FOUR GATES, in the order a proposal meets them:
 *
 *  1 · TARGET WHITELIST. A proposal naming anything outside EXTRACT_TARGETS is dropped.
 *      Three instrument inputs are deliberately NOT extractable — see EXTRACT_TARGETS.
 *  2 · SPAN VERIFICATION (the anti-fabrication gate, the ClinicalState B2 rail's own).
 *      Every proposal carries `rawText`, and that text must occur VERBATIM in the named
 *      source field. A span that does not is REJECTED, never silently kept.
 *  3 · THE CONFIDENCE FLOOR (PRD §7). Below it the observation is dropped by the
 *      assembler and the instrument widens to a range — the same §8 degradation machinery
 *      a missing input feeds. No new uncertainty concept.
 *  4 · THE STABILITY GATE (B5's anti-flap rule). An extraction is keyed on the FINGERPRINT
 *      OF ITS SOURCE TEXT. Unchanged text ⇒ the stored reading is reused verbatim and no
 *      model runs at all. If a re-extraction of unchanged text ever disagrees with the
 *      stored one, the STORED reading stands and the input is flagged `unstable` — the
 *      determinism boundary defending itself, in public, on the card.
 *
 * POLARITY: MARKED, NEVER REMOVED. A span that reads as a negation while carrying status
 * 'present' is flagged `polaritySuspect` and kept. This is the ClinicalState rail's ruling
 * and its reasoning is carried here unchanged: an earlier build DROPPED such findings and
 * measured 3 harmful drops out of 8, each in a red-flag case, because `absent`/`negative`
 * are adjectival heads of genuinely present signs in clinical English. A false mark costs
 * a line of noise; a false deletion cost a diagnosis. The marks are listed in the B7
 * validation pack, which is where a clinician — not a regex — rules on them.
 */

import {
  canonicalJson, fnv1a, EXTRACT_CONFIDENCE_FLOOR,
  type Observation, type PreopInputId,
} from './preop-assemble-core';

/** Bumped when the target set, the prompt contract, or the verification gates change. */
export const PREOP_EXTRACT_RULE_VERSION = 'preop-extract/1';

// ── the source fields (kickoff B5, priority order) ──────────────────────────────
//
// The text the DETERMINISTIC map cannot read. Every one of these is a `verbatim` field in
// PAC_MAP — which is exactly why they are here: lib/preop-pac-map-core.ts refuses to infer
// a clinical fact from prose (a test enforces it), so the prose it carries for display is
// the substrate this rail reads. Coverage figures measured 26 Aug over 95 reports.

export interface ExtractSourceField {
  /** the field id, also the PAC_MAP field id where one exists */
  id: string;
  /** how the card names the source of a span */
  label: string;
  /** measured fill rate, all reports / surgical cohort — carried so the prompt table and
   *  the coverage report cannot drift apart */
  fill: string;
}

export const EXTRACT_SOURCE_FIELDS: ExtractSourceField[] = [
  { id: 'pac_other_history', label: 'PAC · other medical history', fill: '63/95 · 40/52' },
  { id: 'pac_meds_note', label: 'PAC · medication note', fill: '8/95 · 2/52' },
  { id: 'pac_endo_note', label: 'PAC · endocrine note', fill: '10/95 · 7/52' },
  { id: 'pac_cvs_note', label: 'PAC · cardiovascular note', fill: '11/95 · 10/52' },
  { id: 'pac_examination', label: 'PAC · physical examination', fill: '42/95 · 19/52' },
  { id: 'pac_airway_note', label: 'PAC · airway note', fill: '13/95 · 9/52' },
  { id: 'opd_narrative', label: 'OPD · consult narrative', fill: 'ClinicalState-held, where present' },
];

export const EXTRACT_SOURCE_IDS: ReadonlySet<string> = new Set(EXTRACT_SOURCE_FIELDS.map((f) => f.id));

export const sourceFieldLabel = (id: string): string =>
  EXTRACT_SOURCE_FIELDS.find((f) => f.id === id)?.label ?? id;

// ── the targets ─────────────────────────────────────────────────────────────────

export interface ExtractTarget {
  id: PreopInputId;
  /** the factor-table label, so the prompt and the card name the same thing */
  label: string;
  /** what the instrument actually scores — the model is given this, not the label alone */
  definition: string;
}

/**
 * The extractable inputs: instrument inputs ONLY, and not even all of those.
 *
 * ⚠️ THREE INSTRUMENT INPUTS ARE DELIBERATELY ABSENT, and their absence is a D4 ruling,
 * not an oversight:
 *
 *   · `age` — a number on the record. A model reading it out of prose could only ever
 *     disagree with the record, and Charlson's age points would then rest on the model.
 *   · `high_risk_surgery` — RCRI's surgical class is a DETERMINISTIC classification of the
 *     procedure text (classifyProcedureRisk). Handing it to a model would move a scored
 *     factor from arithmetic to opinion for no coverage gain.
 *   · `creatinine_over_2` — a MEASURED threshold. A measurement belongs to a measurement:
 *     the Eka lab feed and the PAC investigations array both supply it deterministically,
 *     with units. "Creatinine was high" is not 2.0 mg/dL, and a rail that let it be one
 *     would collapse an RCRI range on a model's reading of an adjective.
 *
 * Everything remaining is a HISTORY fact — the kind of thing a clinician writes down in
 * prose and no structured field on this template captures.
 */
export const EXTRACT_TARGETS: ExtractTarget[] = [
  { id: 'ischaemic_heart_disease', label: 'Ischaemic heart disease', definition: 'history of angina, myocardial infarction, positive stress test, coronary angioplasty/stent, or coronary bypass surgery' },
  { id: 'congestive_heart_failure', label: 'Congestive heart failure', definition: 'history of heart failure, pulmonary oedema, paroxysmal nocturnal dyspnoea, or documented reduced ejection fraction' },
  { id: 'cerebrovascular_disease', label: 'Cerebrovascular disease', definition: 'history of stroke or transient ischaemic attack' },
  { id: 'insulin_treated_diabetes', label: 'Insulin-treated diabetes', definition: 'diabetes treated WITH INSULIN. Diabetes on tablets/oral hypoglycaemics is NOT this factor; say absent only when the record states the diabetes is on oral treatment or diet alone' },
  { id: 'functional_status_dependent', label: 'Dependent functional status', definition: 'the patient is partially or totally dependent for activities of daily living — bed-bound, not ambulating, needs assistance to wash/dress/feed. "Ambulant", "independent", "active" is absent' },
  { id: 'diabetes_mellitus', label: 'Diabetes mellitus', definition: 'diabetes of any type or treatment' },
  { id: 'copd_or_pneumonia', label: 'COPD or current pneumonia', definition: 'chronic obstructive pulmonary disease, chronic bronchitis, emphysema, or pneumonia now' },
  { id: 'hypertension_on_medication', label: 'Hypertension on medication', definition: 'hypertension for which the patient takes antihypertensive medication' },
  { id: 'myocardial_infarction', label: 'Myocardial infarction', definition: 'a documented past myocardial infarction' },
  { id: 'peripheral_vascular_disease', label: 'Peripheral vascular disease', definition: 'claudication, peripheral arterial bypass/angioplasty, gangrene, or untreated aortic aneurysm' },
  { id: 'dementia', label: 'Dementia', definition: 'diagnosed dementia or chronic cognitive impairment' },
  { id: 'chronic_pulmonary_disease', label: 'Chronic pulmonary disease', definition: 'any chronic lung disease including asthma requiring regular treatment, COPD, or interstitial lung disease' },
  { id: 'connective_tissue_disease', label: 'Connective tissue disease', definition: 'rheumatoid arthritis, systemic lupus erythematosus, polymyositis, or mixed connective tissue disease' },
  { id: 'peptic_ulcer_disease', label: 'Peptic ulcer disease', definition: 'documented gastric or duodenal ulcer' },
  { id: 'mild_liver_disease', label: 'Mild liver disease', definition: 'chronic hepatitis or cirrhosis without portal hypertension' },
  { id: 'diabetes_uncomplicated', label: 'Diabetes, uncomplicated', definition: 'diabetes with no stated end-organ damage' },
  { id: 'hemiplegia', label: 'Hemiplegia', definition: 'hemiplegia, paraplegia or quadriplegia, from any cause' },
  { id: 'moderate_severe_renal_disease', label: 'Moderate or severe renal disease', definition: 'chronic kidney disease stage 3 or worse, dialysis, or transplant' },
  { id: 'diabetes_end_organ_damage', label: 'Diabetes with end-organ damage', definition: 'diabetes with retinopathy, nephropathy or neuropathy' },
  { id: 'any_tumour', label: 'Any tumour (within 5 years)', definition: 'a solid tumour diagnosed or treated within the last five years, not stated as metastatic' },
  { id: 'leukaemia', label: 'Leukaemia', definition: 'acute or chronic leukaemia of any lineage, including a past diagnosis under treatment' },
  { id: 'lymphoma', label: 'Lymphoma', definition: 'Hodgkin or non-Hodgkin lymphoma, or multiple myeloma, at any stage' },
  { id: 'moderate_severe_liver_disease', label: 'Moderate or severe liver disease', definition: 'cirrhosis with portal hypertension, variceal bleeding, ascites or encephalopathy' },
  { id: 'metastatic_solid_tumour', label: 'Metastatic solid tumour', definition: 'a solid tumour with stated metastases' },
  { id: 'aids', label: 'AIDS', definition: 'AIDS-defining illness. HIV infection alone, without an AIDS-defining illness, is NOT this category' },
];

export const EXTRACT_TARGET_IDS: ReadonlySet<string> = new Set(EXTRACT_TARGETS.map((t) => t.id));

export const targetLabel = (id: string): string =>
  EXTRACT_TARGETS.find((t) => t.id === id)?.label ?? id;

/** ⚠️ Inputs a model may NEVER propose. Pinned as a constant so a future edit to
 *  EXTRACT_TARGETS that adds one of them fails a test rather than a review. */
export const NEVER_EXTRACTABLE: ReadonlySet<PreopInputId> = new Set<PreopInputId>([
  'age', 'high_risk_surgery', 'creatinine_over_2',
]);

// ── the prompt ──────────────────────────────────────────────────────────────────

export const EXTRACT_SYSTEM = `You are a clinical information extractor working for a pre-operative risk calculator.
You are given named text fields copied verbatim from a pre-anaesthesia check (PAC) form and outpatient notes.
Your ONLY job is to say which of a fixed list of clinical history items the text asserts or denies.

RULES — a violation of any one makes the whole item worthless:
1. Never invent. Every item you return carries "rawText": a VERBATIM substring copied character-for-character out of ONE named field. If you cannot copy a substring that says it, do not return the item.
2. "field" names which field the rawText came from. It must be one of the field names given to you.
3. "input" must be one of the listed input ids, exactly as spelled. Nothing else exists.
4. "status": "present" when the text asserts the item; "absent" ONLY when the text explicitly denies or excludes it. Silence is NOT absence — leave it out entirely.
5. "confidence": 0.0-1.0, how certain you are that this text asserts this item. Be strict: a passing mention that could mean something else is below 0.8.
6. Do not diagnose, do not infer, do not combine facts across fields. "Diabetic on insulin" is insulin_treated_diabetes; "diabetic" alone is not.
7. Return at most one item per input id. If two fields say the same thing, pick the clearer span.

Return ONLY this JSON, no prose, no markdown fence:
{"inputs":[{"input":"<id>","status":"present|absent","field":"<field name>","rawText":"<verbatim substring>","confidence":0.0,"note":"<= 12 words or null"}]}`;

/**
 * The user message: the target table, then the source fields. Pure string building.
 *
 * B8b passes a NARROWED target list (SUGGEST_TARGETS). The three inputs B8a's drug
 * dictionary now owns deterministically are no longer asked about at all — asking a model
 * for a fact a table already has is how the rabeprazole reading happened.
 */
export function buildExtractPrompt(
  fields: Record<string, string>,
  targetList: readonly ExtractTarget[] = EXTRACT_TARGETS,
): { system: string; user: string } {
  const targets = targetList.map((t) => `- ${t.id} — ${t.label}: ${t.definition}`).join('\n');
  const named = Object.entries(fields)
    .filter(([k, v]) => EXTRACT_SOURCE_IDS.has(k) && typeof v === 'string' && v.trim())
    .map(([k, v]) => `### ${k}\n${v.trim()}`)
    .join('\n\n');
  return {
    system: EXTRACT_SYSTEM,
    user: `INPUT IDS you may use:\n${targets}\n\nSOURCE FIELDS:\n\n${named}`,
  };
}

// ── parsing + the four gates ────────────────────────────────────────────────────

export interface ExtractProposal {
  input: string;
  status: string;
  field: string;
  rawText: string;
  confidence: number;
  note: string | null;
}

export type ExtractRejectReason =
  | 'unknown_input' | 'never_extractable' | 'unknown_field' | 'bad_status'
  | 'span_not_found' | 'empty_span' | 'duplicate';

export interface ExtractRejection {
  input: string;
  field: string;
  rawText: string;
  reason: ExtractRejectReason;
}

export interface ExtractedInput {
  inputId: PreopInputId;
  status: 'present' | 'absent';
  field: string;
  /** the VERBATIM source span — the card shows it, the fingerprint does not (see below) */
  rawText: string;
  confidence: number;
  note: string | null;
  /** the span reads as a negation while the status says present — MARKED, never removed */
  polaritySuspect?: boolean;
}

/** Tolerant JSON reader — models fence, models preamble. Throws on genuinely unparseable. */
export function parseExtractOutput(raw: string): ExtractProposal[] {
  let t = String(raw ?? '').trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  const parsed = JSON.parse(t) as { inputs?: unknown };
  if (!Array.isArray(parsed.inputs)) return [];
  const out: ExtractProposal[] = [];
  for (const p of parsed.inputs) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    const conf = Number(o.confidence);
    out.push({
      input: String(o.input ?? '').trim(),
      status: String(o.status ?? '').trim().toLowerCase(),
      field: String(o.field ?? '').trim(),
      rawText: typeof o.rawText === 'string' ? o.rawText.trim() : '',
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
      note: typeof o.note === 'string' && o.note.trim() ? o.note.trim().slice(0, 120) : null,
    });
  }
  return out;
}

// Head-governed negation, carried verbatim from lib/clinical-state/extract.ts along with
// its exclusions ("non-" is not a negation; "r/o" means suspected, not excluded).
const POLARITY_HEAD_RE = /^(?:no|not|denies|denied|denying|without|absent|negative|free of|ruled out)\b/i;
const POLARITY_LEFT_RE = /\b(?:no|not|denies|denied|denying|without|absent|negative for|free of|ruled out)\s+(?:[a-z][a-z-]*\s+){0,2}$/i;

function negationGoverned(rawText: string, source: string, offset: number): boolean {
  if (POLARITY_HEAD_RE.test(rawText.trim())) return true;
  return POLARITY_LEFT_RE.test(source.slice(Math.max(0, offset - 40), offset));
}

export interface VerifyResult {
  accepted: ExtractedInput[];
  rejected: ExtractRejection[];
  polarityMarked: Array<{ input: string; field: string; rawText: string }>;
}

/**
 * Gates 1 and 2. Order matters and is asserted by test: an unknown input is rejected
 * BEFORE its span is looked for, so a hallucinated id never reads a field it invented.
 */
export function verifyExtraction(proposals: ExtractProposal[], fields: Record<string, string>): VerifyResult {
  const accepted: ExtractedInput[] = [];
  const rejected: ExtractRejection[] = [];
  const polarityMarked: VerifyResult['polarityMarked'] = [];
  const seen = new Set<string>();

  for (const p of proposals) {
    const rej = (reason: ExtractRejectReason) => rejected.push({ input: p.input, field: p.field, rawText: p.rawText, reason });
    if (NEVER_EXTRACTABLE.has(p.input as PreopInputId)) { rej('never_extractable'); continue; }
    if (!EXTRACT_TARGET_IDS.has(p.input)) { rej('unknown_input'); continue; }
    if (p.status !== 'present' && p.status !== 'absent') { rej('bad_status'); continue; }
    if (!p.rawText) { rej('empty_span'); continue; }
    const src = fields[p.field];
    if (!EXTRACT_SOURCE_IDS.has(p.field) || typeof src !== 'string' || !src) { rej('unknown_field'); continue; }
    const offset = src.indexOf(p.rawText);
    if (offset < 0) { rej('span_not_found'); continue; }
    if (seen.has(p.input)) { rej('duplicate'); continue; }
    seen.add(p.input);

    const polaritySuspect = p.status === 'present' && negationGoverned(p.rawText, src, offset);
    if (polaritySuspect) polarityMarked.push({ input: p.input, field: p.field, rawText: p.rawText });
    accepted.push({
      inputId: p.input as PreopInputId,
      status: p.status,
      field: p.field,
      rawText: p.rawText,
      confidence: p.confidence,
      note: p.note,
      ...(polaritySuspect ? { polaritySuspect: true as const } : {}),
    });
  }
  // Stable order, so two extractions of the same text produce byte-identical records.
  accepted.sort((a, b) => a.inputId.localeCompare(b.inputId));
  return { accepted, rejected, polarityMarked };
}

// ── the stored record + gate 4 (anti-flap) ──────────────────────────────────────

export interface PreopExtraction {
  version: string;
  /** fnv1a over the SOURCE TEXT. Unchanged fingerprint ⇒ no model runs at all. */
  sourceFingerprint: string;
  extractedAt: string;
  /** DERIVED from the call, never typed (house rule). null when no call was made. */
  model: string | null;
  provider: string | null;
  traceId: string | null;
  inputs: ExtractedInput[];
  rejected: ExtractRejection[];
  polarityMarked: Array<{ input: string; field: string; rawText: string }>;
  /**
   * Input ids where a re-extraction of UNCHANGED source text disagreed with the stored
   * reading. The STORED reading stands (that is what stops the flap); this list is the
   * public record that the rail is not reproducible on that input.
   */
  unstable: PreopInputId[];
  /** how many times unchanged text has been re-read — should stay 0 in steady state */
  reextractions: number;
  /** the fields actually sent, for the validation pack's coverage arithmetic */
  fieldsSeen: string[];
}

/**
 * The anti-flap key. Only the TEXT enters it — not the episode, not the clock, not the
 * model. Two episodes with byte-identical PAC prose would legitimately share a reading.
 */
export function extractionSourceFingerprint(fields: Record<string, string>): string {
  const material: Record<string, string> = {};
  for (const f of EXTRACT_SOURCE_FIELDS) {
    const v = fields[f.id];
    if (typeof v === 'string' && v.trim()) material[f.id] = v.trim();
  }
  return fnv1a(canonicalJson(material));
}

/** True when there is nothing for a model to read — the rail skips the episode entirely. */
export function hasExtractableText(fields: Record<string, string>): boolean {
  return EXTRACT_SOURCE_FIELDS.some((f) => typeof fields[f.id] === 'string' && fields[f.id].trim().length > 0);
}

export function buildExtraction(a: {
  fields: Record<string, string>;
  verified: VerifyResult;
  extractedAt: string;
  model: string | null;
  provider: string | null;
  traceId: string | null;
}): PreopExtraction {
  return {
    version: PREOP_EXTRACT_RULE_VERSION,
    sourceFingerprint: extractionSourceFingerprint(a.fields),
    extractedAt: a.extractedAt,
    model: a.model,
    provider: a.provider,
    traceId: a.traceId,
    inputs: a.verified.accepted,
    rejected: a.verified.rejected,
    polarityMarked: a.verified.polarityMarked,
    unstable: [],
    reextractions: 0,
    fieldsSeen: EXTRACT_SOURCE_FIELDS.map((f) => f.id).filter((id) => !!a.fields[id]?.trim()),
  };
}

export type ReconcileOutcome = 'first' | 'resource_changed' | 'stable' | 'unstable';

export interface ReconcileResult {
  record: PreopExtraction;
  outcome: ReconcileOutcome;
  /** ids that moved on unchanged text — the newly unstable ones only */
  moved: PreopInputId[];
  /** true when the record differs from the stored one and must be written */
  changed: boolean;
}

/**
 * GATE 4. Given the stored extraction and a fresh one, decide what stands.
 *
 *   no stored record            -> the fresh one, 'first'
 *   source text changed         -> the fresh one, 'resource_changed' (a real ripening)
 *   text unchanged, same reads  -> the STORED one, 'stable', nothing written
 *   text unchanged, reads moved -> the STORED one with `unstable` grown, 'unstable'
 *
 * The last line is the whole point: a model that answers differently on identical input
 * does NOT get to move a clinical score. It gets to be reported.
 */
export function reconcileExtraction(stored: PreopExtraction | null, fresh: PreopExtraction): ReconcileResult {
  if (!stored) return { record: fresh, outcome: 'first', moved: [], changed: true };
  if (stored.sourceFingerprint !== fresh.sourceFingerprint) {
    return { record: fresh, outcome: 'resource_changed', moved: [], changed: true };
  }
  const key = (list: ExtractedInput[]) => new Map(list.map((i) => [i.inputId, i.status]));
  const a = key(stored.inputs);
  const b = key(fresh.inputs);
  const moved: PreopInputId[] = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(id) !== b.get(id)) moved.push(id);
  }
  moved.sort();
  const reextractions = stored.reextractions + 1;
  if (!moved.length) {
    return { record: { ...stored, reextractions }, outcome: 'stable', moved: [], changed: true };
  }
  const unstable = [...new Set([...stored.unstable, ...moved])].sort();
  return { record: { ...stored, unstable, reextractions }, outcome: 'unstable', moved, changed: true };
}

// ── the record -> observations ──────────────────────────────────────────────────

/**
 * Turn a stored extraction into observations the assembler can resolve.
 *
 * `detail` — which IS inside the snapshot fingerprint — is a STABLE label built from the
 * target and the field. The verbatim span rides in `sourceSpan`, which is NOT in the
 * fingerprint, so a model that re-words its quotation without changing its answer mints
 * no version. What the reader sees is the span; what the timeline records is the answer.
 */
export function extractionObservations(rec: PreopExtraction | null): Observation[] {
  if (!rec) return [];
  const by = rec.model ? `${rec.provider ?? 'unknown'}:${rec.model}` : null;
  return rec.inputs.map((i) => ({
    inputId: i.inputId,
    status: i.status,
    detail: `${targetLabel(i.inputId)} — read from ${sourceFieldLabel(i.field)}`,
    value: null,
    source: 'EXTRACTED' as const,
    provenanceRef: i.field,
    observedAt: rec.extractedAt,
    confidence: i.confidence,
    extractedBy: by,
    sourceSpan: i.rawText,
    unstable: rec.unstable.includes(i.inputId),
    polaritySuspect: i.polaritySuspect === true,
  }));
}

/** How many accepted inputs would actually clear the floor. Reported, never assumed. */
export function aboveFloor(rec: PreopExtraction | null, floor: number = EXTRACT_CONFIDENCE_FLOOR): number {
  return (rec?.inputs ?? []).filter((i) => i.confidence >= floor).length;
}
