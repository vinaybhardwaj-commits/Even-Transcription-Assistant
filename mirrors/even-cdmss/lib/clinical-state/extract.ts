// lib/clinical-state/extract.ts — two-stage extraction: free-text clinical input →
// ClinicalState. PURE: the LLM stage takes an injected chat function so this module
// never imports ./llm and stays unit-testable with a fake.
//
// Stage 1 (deterministic): demographics, vitals → instability, explicit negations
// ("No fever" → status:'absent'), temporal phrases, and a critical-concept checklist
// (a concept neither asserted nor negated → status:'unknown' + missingCriticalData —
// "fever not mentioned" is DIFFERENT from "no fever").
// Stage 2 (LLM, constrained): granular finding normalisation returning SOURCE SPANS;
// every rawText is verified to occur in the input — spans that don't are REJECTED,
// never silently kept (anti-fabrication at the schema boundary).

import {
  type ClinicalState, type ClinicalFinding, type Surface, type Temporality, type Instability,
  emptyClinicalState, mkFindingId,
} from './schema';
import { extractDemographics } from '../concordance-core';

export interface ExtractInput {
  surface: Surface;
  /** Named source fields, e.g. { complaint, history, exam, vitals }. Field name becomes provenance.sourceField. */
  fields: Record<string, string | undefined>;
  /** Structured demographics when the caller has them (beats text inference). */
  age?: number | string;
  sex?: string;
}

// Concepts a clinician always wants classified as stated / negated / not-mentioned.
// Small and deliberately conservative — the checklist is about the DIFFERENCE between
// "no fever" (absent) and silence (unknown), not about coverage.
export const CRITICAL_CONCEPTS: string[] = [
  'fever', 'chest pain', 'breathlessness', 'syncope', 'vomiting', 'weight loss', 'bleeding',
];

// Field names recognised as THE presenting complaint. A caller whose field name is not in this
// set gets no complaint finding and no error — exactly the silent mismatch that produced
// "positives: 0" on the Patient Summary rich baseline (31 Jul 2026: patient-summary.ts passed
// `presentingComplaint`, this file matched only `complaint`/`cc`). Exported so the accepted
// names are pinned by test; extend the set rather than renaming at a call site.
export const COMPLAINT_FIELD_NAMES: ReadonlySet<string> = new Set(['complaint', 'cc', 'presentingComplaint']);

const NEGATION_RE = /\b(?:no|denies|denied|without|not)\s+(?:any\s+)?([a-z][a-z -]{2,40}?)(?=\s*(?:[,.;:)]|$|\bor\b|\band\b))/gi;
const DURATION_RE = /\b(?:for|since|x|of)\s+(\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?))\b/i;
const ONSET_RE = /\b(\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?))\s+ago\b/i;
const COURSE_RE = /\b(worsening|improving|progressive|intermittent|constant|episodic|recurrent|sudden(?:-|\s)?onset)\b/i;

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function temporalityOf(text: string): Temporality | undefined {
  const t: Temporality = {};
  const d = text.match(DURATION_RE);
  if (d) t.duration = d[0].trim();
  const o = text.match(ONSET_RE);
  if (o) t.onset = o[0].trim();
  const c = text.match(COURSE_RE);
  if (c) t.course = c[1].toLowerCase();
  return t.duration || t.onset || t.course ? t : undefined;
}

function finding(
  concept: string, status: ClinicalFinding['status'], sourceField: string, rawText: string,
  method: ClinicalFinding['provenance']['extractionMethod'], confidence: number,
  extras?: Partial<Pick<ClinicalFinding, 'value' | 'unit' | 'temporality' | 'normalizedConcept'>>,
): ClinicalFinding {
  return {
    id: mkFindingId(concept, sourceField, status),
    concept,
    status,
    provenance: { sourceField, rawText, extractionMethod: method, confidence },
    ...extras,
  };
}

// ── Vitals → structured reads + instability (adult thresholds, deterministic) ──

interface VitalRead { name: string; value: number; rawText: string }

function parseVitals(vitals: string): VitalRead[] {
  const out: VitalRead[] = [];
  const bp = vitals.match(/\b(?:bp\s*:?\s*)?(\d{2,3})\s*\/\s*(\d{2,3})\b/i);
  if (bp) {
    out.push({ name: 'systolic bp', value: parseInt(bp[1], 10), rawText: bp[0].trim() });
    out.push({ name: 'diastolic bp', value: parseInt(bp[2], 10), rawText: bp[0].trim() });
  }
  const hr = vitals.match(/\b(?:hr|pulse|heart rate)\s*:?\s*(\d{2,3})\b/i);
  if (hr) out.push({ name: 'heart rate', value: parseInt(hr[1], 10), rawText: hr[0].trim() });
  const spo2 = vitals.match(/\b(?:spo2|sats?|oxygen saturation)\s*:?\s*(\d{2,3})\s*%?/i);
  if (spo2) out.push({ name: 'spo2', value: parseInt(spo2[1], 10), rawText: spo2[0].trim() });
  const rr = vitals.match(/\b(?:rr|resp(?:iratory)? rate)\s*:?\s*(\d{1,2})\b/i);
  if (rr) out.push({ name: 'respiratory rate', value: parseInt(rr[1], 10), rawText: rr[0].trim() });
  const temp = vitals.match(/\b(?:temp(?:erature)?\s*:?\s*)(\d{2,3}(?:\.\d+)?)\s*(?:°?\s*[cf])?\b/i);
  if (temp) out.push({ name: 'temperature', value: parseFloat(temp[1]), rawText: temp[0].trim() });
  return out;
}

function instabilityReasons(reads: VitalRead[]): string[] {
  const reasons: string[] = [];
  for (const r of reads) {
    if (r.name === 'systolic bp' && r.value < 90) reasons.push(`SBP ${r.value} < 90`);
    if (r.name === 'heart rate' && (r.value > 130 || r.value < 40)) reasons.push(`HR ${r.value} outside 40-130`);
    if (r.name === 'spo2' && r.value < 92 && r.value > 40) reasons.push(`SpO2 ${r.value}% < 92%`);
    if (r.name === 'respiratory rate' && r.value > 28) reasons.push(`RR ${r.value} > 28`);
    if (r.name === 'temperature' && ((r.value > 30 && r.value < 32.5) || (r.value >= 40 && r.value < 45)))
      reasons.push(`temperature ${r.value} extreme`);
  }
  return reasons;
}

// ── Stage 1 — deterministic extraction ──

export function deterministicExtract(input: ExtractInput, opts?: { criticalConcepts?: string[] }): ClinicalState {
  const state = emptyClinicalState(input.surface);
  const fields = Object.entries(input.fields).filter((e): e is [string, string] => !!e[1] && !!e[1].trim());
  const allText = fields.map(([, v]) => v).join('\n');

  // Demographics: structured input wins; else infer from the text (concordance-core).
  const inferred = extractDemographics(allText);
  const ageNum = input.age != null && String(input.age).trim() !== '' ? Number(input.age) : NaN;
  const age = Number.isFinite(ageNum) && ageNum > 0 && ageNum < 130 ? Math.round(ageNum) : inferred.age;
  const sexRaw = input.sex && input.sex !== '?' ? String(input.sex) : null;
  const sex = sexRaw
    ? (/^f/i.test(sexRaw.trim()) ? 'F' as const : /^m/i.test(sexRaw.trim()) ? 'M' as const : inferred.sex)
    : inferred.sex;
  const ageBand = age == null ? null : `${Math.floor(age / 10) * 10}-${Math.floor(age / 10) * 10 + 9}`;
  state.demographics = { age: age ?? null, ageBand, sex: sex ?? null, sexRaw };

  const negatedConcepts = new Set<string>();

  for (const [name, text] of fields) {
    // Explicit negations → absent findings ("No fever, no chills" → two negatives).
    for (const m of text.matchAll(NEGATION_RE)) {
      const concept = m[1].trim().toLowerCase();
      if (!concept) continue;
      negatedConcepts.add(norm(concept));
      state.negatives.push(finding(concept, 'absent', name, m[0].trim(), 'deterministic', 0.9));
    }
    if (name === 'vitals') {
      const reads = parseVitals(text);
      for (const r of reads) {
        state.positives.push(finding(r.name, 'present', name, r.rawText, 'deterministic', 0.9, { value: String(r.value) }));
      }
      const reasons = instabilityReasons(reads);
      // Three-state instability (assembly only — parseVitals/instabilityReasons LOGIC unchanged):
      // itemise which instability-relevant channels parsed, as display labels. BP is assessed
      // iff a 'systolic bp' read parsed (diastolic has no threshold, not a separate channel).
      const CHANNELS: ReadonlyArray<readonly [string, string]> = [
        ['systolic bp', 'BP'], ['heart rate', 'HR'], ['spo2', 'SpO₂'], ['respiratory rate', 'RR'], ['temperature', 'T'],
      ];
      const present = new Set(reads.map((r) => r.name));
      const assessedInputs = CHANNELS.filter(([n]) => present.has(n)).map(([, label]) => label);
      const missingInputs = CHANNELS.filter(([n]) => !present.has(n)).map(([, label]) => label);
      const assessment: Instability['assessment'] =
        reasons.length ? 'unstable' : assessedInputs.length ? 'no_instability_detected' : 'not_assessable';
      state.instability = { unstable: assessment === 'unstable', reasons, assessment, assessedInputs, missingInputs };
    }
  }

  // The presenting complaint is a finding in its own right, with its temporal phrase.
  const complaintField = fields.find(([name]) => COMPLAINT_FIELD_NAMES.has(name));
  if (complaintField) {
    const [name, text] = complaintField;
    state.positives.push(finding(text.trim(), 'present', name, text.trim(), 'deterministic', 0.95, {
      temporality: temporalityOf(text),
    }));
  }

  // Critical-concept checklist: silence is 'unknown', not 'absent'.
  const normAll = norm(allText);
  for (const concept of opts?.criticalConcepts ?? CRITICAL_CONCEPTS) {
    const n = norm(concept);
    if (normAll.includes(n)) continue;                 // asserted or negated in text — already handled
    if (negatedConcepts.has(n)) continue;
    state.unknowns.push(finding(concept, 'unknown', 'checklist', '(not mentioned)', 'deterministic', 1));
    state.missingCriticalData.push(concept);
  }

  return state;
}

// ── Stage 2 — constrained LLM normalisation with span verification ──

/** Injected chat function — (system, user) → model text. Wire tracedChat/llm outside. */
export type ChatFn = (system: string, user: string) => Promise<string>;

export const NORMALISE_SYSTEM = `You are a clinical information extractor. You receive a clinical presentation as named fields. Return findings as JSON — ONLY findings stated in the text, each with the EXACT source substring it came from.

RULES:
1. Never invent a finding. Every finding carries "rawText": a VERBATIM substring copied from one field.
2. "field" = which named field the rawText came from.
3. status: "present" (asserted), "absent" (explicitly negated), "historical" (past/resolved history), "resolved".
4. Do NOT diagnose; extract findings only. Do not include vital-sign numbers (handled elsewhere).
5. Optional: "value"+"unit" for a measured finding; "duration"/"onset"/"course" as stated.

Return ONLY: {"findings":[{"concept":"…","status":"present|absent|historical|resolved","field":"history","rawText":"<verbatim substring>","value":null,"unit":null,"duration":null,"onset":null,"course":null}]}`;

export interface LlmNormaliseResult {
  accepted: ClinicalFinding[];
  /** Findings whose rawText was NOT found verbatim in the named field — rejected, surfaced for the trace. */
  rejected: Array<{ concept: string; rawText: string; field: string }>;
  /** Accepted findings carrying `polaritySuspect` — MARKED, never removed. Distinct from
   *  `rejected`: that is "the model invented text" and those findings are gone; this is "the span
   *  reads as a negation" and those findings are present in `accepted`. Never merge the two. */
  polarityMarked: Array<{ concept: string; rawText: string; field: string }>;
}

// ── Polarity marker (31 Jul 2026) ─────────────────────────────────────────────────────────────
//
// Span verification proves PROVENANCE, not POLARITY: a negated span copied faithfully and
// labelled 'present' passes it cleanly (observed live: "No obvious regional wall motion
// abnormalities" / "no PAH" as status:'present'). And the deterministic pass cannot be relied on
// to contradict it — NEGATION_RE caps the captured concept at 41 chars, so long negations produce
// no competing 'absent' finding and the stages disagree in silence.
//
// ⚠️ THIS MARKS, IT DOES NOT FILTER — AND THE HISTORY IS THE REASON. An earlier build used this
// exact detection to REJECT the finding. Measured over the ddx-case-bank/1.0 and
// right-care-check-gold/2.0 banks, 8 drops across 6 cases: 5 correct, but 3 HARMFUL and all 3 in
// red-flag cases whose cannot-miss diagnosis depended on the dropped sign — `absent distal pulses`
// (D18, acute limb ischaemia), `absent bowel sounds` (D19, perforated viscus), `not using
// contraception` (D16, ruptured ectopic). `absent` and `negative` are adjectival heads of
// genuinely PRESENT abnormal signs in clinical English, not negation operators like `no`/`denies`,
// and no cue list can separate the two without understanding the concept.
//
// So the detection is unchanged and the CONSEQUENCE is inverted. A false mark costs a line of
// noise; a false deletion cost a diagnosis. Flipping is likewise still out: flipping
// "regional wall motion abnormalities"→absent would be right, but flipping "normal wall
// motion"→absent asserts the opposite of the record.
//
// HEAD-GOVERNED only: a cue at the start of the span, or immediately to its left in the source
// field (the cue often sits just outside rawText). A cue elsewhere in the span — "pain not
// relieved by antacids" — modifies a qualifier, not the head concept, and must not fire.
// Deliberately excluded: "non" (a "non-productive cough" is a present finding) and "r/o"
// ("r/o MI" means suspected, not excluded).
const POLARITY_HEAD_RE = /^(?:no|not|denies|denied|denying|without|absent|negative|free of|ruled out)\b/i;
const POLARITY_LEFT_RE = /\b(?:no|not|denies|denied|denying|without|absent|negative for|free of|ruled out)\s+(?:[a-z][a-z-]*\s+){0,2}$/i;

/** True when the span reads as a negation while carrying status 'present'. */
function negationGoverned(rawText: string, sourceField: string, offset: number): boolean {
  if (POLARITY_HEAD_RE.test(rawText.trim())) return true;
  const left = sourceField.slice(Math.max(0, offset - 40), offset);
  return POLARITY_LEFT_RE.test(left);
}

function parseLooseJson(s: string): unknown {
  let t = (s || '').trim();
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

const STATUSES = new Set(['present', 'absent', 'historical', 'resolved']);

/** Run the constrained LLM pass and verify every span. Pure given `chat`; throws only on
 *  chat/JSON failure — the caller decides fail-open policy. */
export async function normalizeWithLlm(input: ExtractInput, chat: ChatFn): Promise<LlmNormaliseResult> {
  const fields = Object.entries(input.fields).filter((e): e is [string, string] => !!e[1] && !!e[1].trim());
  const user = fields.map(([k, v]) => `${k}: ${v}`).join('\n');
  const raw = await chat(NORMALISE_SYSTEM, user);
  const parsed = parseLooseJson(raw) as { findings?: unknown };
  const accepted: ClinicalFinding[] = [];
  const rejected: LlmNormaliseResult['rejected'] = [];
  const polarityMarked: LlmNormaliseResult['polarityMarked'] = [];
  if (!Array.isArray(parsed.findings)) return { accepted, rejected, polarityMarked };

  const byField = new Map(fields);
  for (const f of parsed.findings) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const concept = typeof o.concept === 'string' ? o.concept.trim() : '';
    const rawText = typeof o.rawText === 'string' ? o.rawText.trim() : '';
    const fieldName = typeof o.field === 'string' ? o.field.trim() : '';
    if (!concept || !rawText || !fieldName) continue;
    const statusRaw = String(o.status ?? '').toLowerCase();
    const status = (STATUSES.has(statusRaw) ? statusRaw : 'present') as ClinicalFinding['status'];

    // SPAN VERIFICATION — the anti-fabrication gate. rawText must occur in the named field.
    const src = byField.get(fieldName) ?? '';
    const offset = src.indexOf(rawText);
    if (offset < 0) { rejected.push({ concept, rawText, field: fieldName }); continue; }

    // POLARITY MARKER — annotate, never remove. 'present' only; absent/historical/resolved already
    // carry the negation in their status. The finding is accepted in full either way.
    const polaritySuspect = status === 'present' && negationGoverned(rawText, src, offset);
    if (polaritySuspect) polarityMarked.push({ concept, rawText, field: fieldName });

    const t: Temporality = {};
    if (typeof o.duration === 'string' && o.duration) t.duration = o.duration;
    if (typeof o.onset === 'string' && o.onset) t.onset = o.onset;
    if (typeof o.course === 'string' && o.course) t.course = o.course;
    accepted.push({
      id: mkFindingId(concept, fieldName, status),
      concept,
      status,
      value: typeof o.value === 'string' && o.value ? o.value : undefined,
      unit: typeof o.unit === 'string' && o.unit ? o.unit : undefined,
      temporality: t.duration || t.onset || t.course ? t : undefined,
      provenance: {
        sourceField: fieldName, rawText, startOffset: offset, endOffset: offset + rawText.length,
        extractionMethod: 'llm', confidence: 0.7,
      },
      ...(polaritySuspect ? { polaritySuspect: true as const } : {}),
    });
  }
  return { accepted, rejected, polarityMarked };
}

/** Merge LLM findings into a stage-1 state: positives/negatives grow; a checklist 'unknown'
 *  is resolved (removed) when the LLM asserted or negated that concept. */
export function mergeLlmFindings(state: ClinicalState, llm: LlmNormaliseResult): ClinicalState {
  const resolved = new Set(llm.accepted.map((f) => norm(f.concept)));
  const seen = new Set([...state.positives, ...state.negatives].map((f) => `${norm(f.concept)}|${f.status}`));
  const next: ClinicalState = {
    ...state,
    positives: [...state.positives],
    negatives: [...state.negatives],
    unknowns: state.unknowns.filter((u) => !resolved.has(norm(u.concept))),
  };
  next.missingCriticalData = state.missingCriticalData.filter((c) => !resolved.has(norm(c)));
  for (const f of llm.accepted) {
    const key = `${norm(f.concept)}|${f.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (f.status === 'absent') next.negatives.push(f);
    else next.positives.push(f);
  }
  return next;
}
