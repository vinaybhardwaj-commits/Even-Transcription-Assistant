/**
 * ⚠️ RETIRED SURFACE — DO NOT DELETE. The mechanics here are LIVE.
 *
 * Care Conversation Briefs was retired as a care-manager product on 30 Jul 2026 — non-use, not
 * malfunction. The nav card is gone and the batch cron is paused, so this code is now invisible,
 * unused-looking and untraced: exactly the profile a tech-debt sweep deletes. It must not be.
 *
 * These mechanics are the best working example of ClinicalState, MemberState and the longitudinal
 * spine in the system, and they are RE-EXPOSED as a microservice behind /api/v1/patient-summary,
 * which feeds the physician's pre-encounter Patient Summary in Pulse (the OPD HIS). Deleting or
 * "cleaning up" anything here breaks that API.
 *
 * See: CDMSS-CCB-REPURPOSE-PRD-v0.1-30-JUL-2026 and the Patient Summary API kickoff (30 Jul 2026),
 * and the entry in CDMSS-OPEN-ISSUE-REGISTER-23-JUL-2026.md.
 *
 * ⚠️ HAZARD — CCB_ENABLED IS NOT A CCB FLAG. It gates ALL EIGHT /care pages: /care, /care/briefs,
 * /care/m/[uid], /care/[uid], /care/triage, /care/review, /care/lvc, /care/concepts. Setting it to
 * 0 does NOT disable CCB — it 404s the entire care-manager surface and takes down OPD Audit
 * Triage, LVC adjudication, Concept Coder and Review Mode with it. The flag keeps its name by
 * decision; this warning is the mitigation.
 */
/**
 * lib/ccb-brief-core.ts — Care Conversation Brief: brief generator CORE (pure).
 *
 * PURE, dependency-free (node --experimental-strip-types friendly). The envelope types,
 * the prompt builders, the JSON parsers, the de-identified episode-text composer, the
 * retrieval-query builder, the GROUNDING math, and — most importantly — the deterministic
 * COMMERCIAL WALL (`pitchGate`). The wired `ccb-brief.ts` does the I/O (multimodal read,
 * retrieve, LLM) and calls these.
 *
 * Two-layer contract (PRD D1, §12): a CLINICAL engine (advisory, cite-or-label) sits beside
 * a CLEARLY-LABELLED COMMERCIAL layer. The pitch may fire ONLY when the clinical engine
 * produced a corpus-CITED surgical/specialist-indication finding — `pitchGate` enforces this
 * deterministically (not by trusting the model), and it is the ethics tripwire (unit-pinned).
 */

import type { Source } from './citations-core';
import type { EpisodeBundle, ReportDoc } from './ccb-fetch-core';
// §2.1/§2.2 — the empty-extract detector and the unreadable marker. Both pure; doc-transport-core
// is itself dependency-free, so this core stays --experimental-strip-types loadable.
import { isEmptyExtract, saysUnreadable } from './doc-transport-core';

export const CCB_ENGINE_VERSION = 'care-brief/0.1';
export const CCB_DISCLAIMER =
  'Advisory, non-diagnostic decision support for a care-management conversation. Not a diagnosis and not a clinician performance assessment. Clinical claims are grounded in the CDMSS corpus where cited, otherwise labelled general reasoning.';

// ── Types ──────────────────────────────────────────────────────────────────────

export type Grounding = 'corpus_cited' | 'general_reasoning' | 'deterministic_rule';
export type FindingKind = 'synthesis' | 'speciality' | 'diagnosis' | 'treatment_line' | 'surgical_indication' | 'caution';

export interface ClinicalFinding {
  id: string;
  kind: FindingKind;
  claim: string;
  grounding: Grounding;
  citation_ids: number[];
  confidence: number;
}

export interface LowValueFlag { item: string; verdict: string; citation_ids: number[] }

export interface CommercialLayer {
  priority: 'high' | 'med' | 'low';
  push_harder: boolean;
  pitch_allowed: boolean;
  gated_on: string[];        // ids of the cited surgical_indication findings that justify the pitch
  script: string | null;
}

export interface RetrievalManifest {
  ran: boolean; queries: string[]; chunks_considered: number; reranked: boolean;
}
export interface GroundingSummary {
  findings: number; corpus_cited: number; general_reasoning: number; rule: number;
  citation_coverage_pct: number; distinct_sources: number;
}

export interface CcbEnvelope {
  trace_id: string | null;
  engine_version: string;
  generated_at: string;
  member_ref: { uhid: string | null; individual_uid: string };  // join-back only; never to the model
  episode: { date: string; coverage: 'rich' | 'order_only'; artifact_count: number };
  retrieval: RetrievalManifest;
  grounding_summary: GroundingSummary;
  clinical: ClinicalFinding[];
  low_value_flags: LowValueFlag[];
  commercial: CommercialLayer;
  sources: Source[];
  disclaimer: string;
}

/** De-identified read of one result PDF (no name/uhid — STATUS/clinical content only). */
export interface ExtractedReport {
  kind: ReportDoc['kind'];
  studyOrPanel: string | null;
  impression: string | null;
  keyFindings: string[];
  abnormalValues: string[];
}

// ── Prompts ─────────────────────────────────────────────────────────────────────

// §2.1 (30 Jul): the old instruction ended "If unreadable, return empty fields." That turned a
// FAILURE into DATA — measured on a real scanned report: HTTP 200, finish_reason stop, a
// well-formed JSON object with every field empty, reproduced 3/3 byte-identically. Downstream,
// a total extraction loss was indistinguishable from a genuinely unremarkable report. The model
// must now say so explicitly. The prompt is only advisory, so parseExtractedReport ALSO refuses
// an all-empty extract — the model can lie, the caller cannot.
export const EXTRACT_SYSTEM =
  'You read a single clinical result document (lab/radiology/health-checkup) and return a DE-IDENTIFIED structured summary. ' +
  'NEVER output patient name, UHID, MRN, phone, address, or any identifier. Output ONLY clinical content. ' +
  'Return strict JSON: {"studyOrPanel": string|null, "impression": string|null, "keyFindings": string[], "abnormalValues": string[]}. ' +
  'abnormalValues = out-of-range results with the value + flag (e.g. "Hb 9.1 g/dL (low)"). ' +
  'If you CANNOT READ the document — it is blank, a scan you cannot decipher, corrupt, or carries no clinical content — ' +
  'return exactly {"unreadable": true} and NOTHING else. Never return empty fields to signal an unreadable document: ' +
  'an empty summary means "this report is unremarkable", which is a different and dangerous claim.';

export function buildExtractUser(kind: ReportDoc['kind']): string {
  return `This is a ${kind} report. Summarise its clinical content as instructed. Output JSON only.`;
}

export const CLINICAL_SYSTEM =
  'You are a clinical decision-support engine producing an ADVISORY, NON-DIAGNOSTIC brief for a NON-CLINICAL care manager, ' +
  'from one outpatient episode (prescription + tests done + any result findings). For EACH finding either cite [n] from the ' +
  'provided numbered sources, or explicitly label it general reasoning — never assert un-sourced evidence. ' +
  'Cover, where supported: an episode synthesis, the speciality to work it up with, potential diagnoses (as possibilities), ' +
  'alternative treatment lines, any low-value caution, and — ONLY if genuinely indicated — a surgical/specialist-indication finding. ' +
  'A surgical_indication finding MUST be corpus_cited (carry citation_ids); if you cannot cite it, do not emit it as surgical_indication. ' +
  'CRITICAL: emit a surgical_indication ONLY when THIS patient\'s documented findings specifically meet the criteria for a named ' +
  'procedure or specialist operation — state it assertively and specifically (name the procedure/operation AND the member finding ' +
  'that indicates it). Do NOT emit generic, educational, population-level, or conditional statements as surgical_indication ' +
  '(e.g. "surgery should be considered if…", "typically reserved for patients with…", "for patients with X, surgery should be considered", ' +
  '"is the mainstay of treatment for…", "may be necessary in cases of…"). If the indication is only conditional or general, ' +
  'use kind "caution" or "speciality" instead — never "surgical_indication". ' +
  'Output strict JSON: {"findings":[{"id":string,"kind":"synthesis|speciality|diagnosis|treatment_line|surgical_indication|caution",' +
  '"claim":string,"grounding":"corpus_cited|general_reasoning|deterministic_rule","citation_ids":number[],"confidence":number}]}.';

export function buildClinicalUser(episodeText: string, citedContext: string): string {
  return `EPISODE (de-identified):\n${episodeText}\n\nNUMBERED SOURCES:\n${citedContext || '(none retrieved)'}\n\nReturn the findings JSON only.`;
}

export const COMMERCIAL_SYSTEM =
  'You write a short, factual second-opinion talking script for a NON-CLINICAL care manager, given ONLY corpus-cited ' +
  'surgical/specialist-indication findings. Do NOT introduce any clinical claim beyond those findings. The script offers an ' +
  'Even specialist consult / second opinion; it is an outreach aid, not medical advice. ' +
  'Output strict JSON: {"priority":"high|med|low","push_harder":boolean,"script":string}.';

export function buildCommercialUser(citedFindings: ClinicalFinding[]): string {
  const lines = citedFindings.map((f) => `- ${f.claim}`).join('\n');
  return `CITED INDICATION FINDINGS:\n${lines}\n\nReturn the commercial JSON only.`;
}

// ── JSON helpers + parsers ────────────────────────────────────────────────────

/** Pull the first balanced JSON object from a possibly fenced LLM string. */
export function extractJson(raw: string): unknown | null {
  if (!raw) return null;
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch { return null; }
}

const GROUNDINGS = new Set<Grounding>(['corpus_cited', 'general_reasoning', 'deterministic_rule']);
const KINDS = new Set<FindingKind>(['synthesis', 'speciality', 'diagnosis', 'treatment_line', 'surgical_indication', 'caution']);

function validCiteIds(ids: unknown, max: number, cap = 8): number[] {
  if (!Array.isArray(ids) || max < 1) return [];
  const out: number[] = [];
  for (const x of ids) {
    const n = Math.round(Number(x));
    if (Number.isFinite(n) && n >= 1 && n <= max && !out.includes(n)) out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

function clamp01(n: unknown): number { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5; }

/** Normalise one finding + ENFORCE the cite-or-label invariant: a finding may only claim
 *  `corpus_cited` if it actually carries citation_ids (else it's downgraded to general_reasoning).
 *  This is what makes the commercial wall trustworthy. */
export function normalizeFinding(f: Record<string, unknown>, maxCite: number, i: number): ClinicalFinding | null {
  const claim = String(f.claim ?? '').trim();
  if (!claim) return null;
  const kind = KINDS.has(f.kind as FindingKind) ? (f.kind as FindingKind) : 'synthesis';
  const citation_ids = validCiteIds(f.citation_ids, maxCite);
  let grounding: Grounding = GROUNDINGS.has(f.grounding as Grounding) ? (f.grounding as Grounding) : 'general_reasoning';
  if (grounding === 'corpus_cited' && citation_ids.length === 0) grounding = 'general_reasoning';
  const id = String(f.id ?? '').trim() || `f${i + 1}`;
  return { id, kind, claim, grounding, citation_ids, confidence: clamp01(f.confidence) };
}

export function parseClinical(raw: string, maxCite: number): ClinicalFinding[] {
  const j = extractJson(raw) as { findings?: unknown } | null;
  const arr = Array.isArray(j?.findings) ? (j!.findings as Record<string, unknown>[]) : [];
  const seen = new Set<string>();
  const out: ClinicalFinding[] = [];
  arr.forEach((f, i) => {
    const nf = normalizeFinding(f, maxCite, i);
    if (nf && !seen.has(nf.id)) { seen.add(nf.id); out.push(nf); }
  });
  return out;
}

export function parseCommercial(raw: string): { priority: CommercialLayer['priority']; push_harder: boolean; script: string | null } | null {
  const j = extractJson(raw) as Record<string, unknown> | null;
  if (!j) return null;
  const priority = j.priority === 'high' || j.priority === 'med' || j.priority === 'low' ? j.priority : 'med';
  const script = String(j.script ?? '').trim() || null;
  return { priority, push_harder: Boolean(j.push_harder), script };
}

export function parseExtractedReport(raw: string, kind: ReportDoc['kind']): ExtractedReport | null {
  const j = extractJson(raw) as Record<string, unknown> | null;
  if (!j) return null;
  // §2.1 — the model's explicit marker.
  if (saysUnreadable(j)) return null;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const out: ExtractedReport = {
    kind,
    studyOrPanel: (String(j.studyOrPanel ?? '').trim() || null),
    impression: (String(j.impression ?? '').trim() || null),
    keyFindings: arr(j.keyFindings),
    abnormalValues: arr(j.abnormalValues),
  };
  // §2.1 belt-and-braces — the CALLER-SIDE detector. The prompt above is advisory and the model
  // may still return empties (that is exactly what was measured). An extract with no clinical
  // content whatsoever is a FAILED READ, not an unremarkable report: return null so the caller
  // skips the document rather than publishing silence as a finding. `kind` is not content — it
  // is stamped from the argument, so it never keeps an all-empty extract alive.
  if (isEmptyExtract(out)) return null;
  return out;
}

// ── De-identified episode text + retrieval query ──────────────────────────────

function medNames(meds: unknown): string[] {
  if (!Array.isArray(meds)) return [];
  return meds.map((m) => {
    if (m && typeof m === 'object') {
      const o = m as Record<string, unknown>;
      return String(o.resolvedGeneric || o.generic || o.brand || o.name || '').trim();
    }
    return String(m ?? '').trim();
  }).filter(Boolean);
}

/** Compose the de-identified episode text fed to the clinical pass. No identifiers. */
export function composeEpisodeText(bundle: EpisodeBundle, reports: ExtractedReport[]): string {
  const p = bundle.prescription;
  const lines: string[] = [];
  if (p.presentingComplaint) lines.push(`Presenting complaint / history: ${p.presentingComplaint}`);
  if (p.diagnoses.length) lines.push(`Diagnoses: ${p.diagnoses.join('; ')}`);
  if (p.dxCodes.length) lines.push(`Diagnosis (ICD): ${p.dxCodes.join(', ')}`);
  if (p.impressionCodes.length) lines.push(`Impression (ICD): ${p.impressionCodes.join(', ')}`);
  const meds = medNames(p.meds);
  if (meds.length) lines.push(`Medications: ${meds.join(', ')}`);
  if (p.investigations.length) lines.push(`Investigations ordered on the note: ${p.investigations.join(', ')}`);
  if (p.planOfManagement) lines.push(`Plan: ${p.planOfManagement}`);
  if (p.specialistReferral.length) lines.push(`Specialist referral on the note: ${p.specialistReferral.join(', ')}`);
  if (bundle.orders.length) {
    const done = bundle.orders.map((o) => o.serviceName).filter(Boolean) as string[];
    if (done.length) lines.push(`Tests done this episode: ${Array.from(new Set(done)).join(', ')}`);
  }
  for (const r of reports) {
    const bits = [r.studyOrPanel, r.impression, r.abnormalValues.join('; '), r.keyFindings.join('; ')].filter(Boolean);
    if (bits.length) lines.push(`Result (${r.kind}): ${bits.join(' — ')}`);
  }
  if (bundle.coverage === 'order_only') lines.push('(No result documents available — order-level only.)');
  return lines.join('\n');
}

/** Build the corpus retrieval query from the episode's clinical content. */
export function retrievalQuery(bundle: EpisodeBundle, reports: ExtractedReport[]): string {
  const p = bundle.prescription;
  return [
    p.presentingComplaint || '',
    ...p.diagnoses, ...p.dxCodes, ...p.impressionCodes,
    ...p.investigations.slice(0, 8),
    ...bundle.orders.map((o) => o.serviceName || '').slice(0, 8),
    ...reports.map((r) => r.impression || r.studyOrPanel || '').filter(Boolean),
    'outpatient appropriateness specialist referral surgical indication management guideline',
  ].filter(Boolean).join('. ');
}

// ── The commercial WALL (deterministic; the ethics tripwire) ───────────────────

/** Minimum confidence a surgical_indication finding must carry to open the pitch. Env-tunable
 *  so the floor can be adjusted without a code change. */
export const PITCH_MIN_CONFIDENCE = (() => {
  const v = Number(process.env.CCB_PITCH_MIN_CONF);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.7;
})();

// Lexical markers that make a "surgical_indication" a GENERIC / CONDITIONAL / POPULATION-level
// (educational textbook) statement rather than a member-specific present indication. These are the
// dominant false-positive pattern behind the pre-calibration ~80% pitch rate ("surgery should be
// considered if…", "typically reserved for patients with…", "is the mainstay of treatment for…").
const GENERIC_INDICATION_PATTERNS: RegExp[] = [
  /\bif\b/i,                                                     // any conditional
  /\bshould\s+(be\s+considered|the\b)/i,                         // "should be considered", "should the TMT show…"
  /\bmay\s+(be\s+(considered|necessary|required|indicated|warranted)|necessitate|require|warrant)\b/i,
  /\b(can|might|could|would)\s+be\s+considered\b/i,
  /\bcan\s+be\s+an?\s+indication\b/i,
  /\b(in|for)\s+cases?\s+(of|where|involving|that)\b/i,
  /\bfor\s+(patients?|children|women|men|adults?|people|individuals?|those)\b/i,   // population framing
  /\bpatients?\s+(with|who)\b.*\b(should|may|can|are\s+candidates)\b/i,
  /\b(is|are)\s+(often|usually|frequently|commonly|typically|generally)\s+(needed|required|reserved|considered|indicated|recommended|performed|warranted)\b/i,
  /\bis\s+reserved\s+for\b/i,
  /\bis\s+(a|an|the)\s+(definitive|potential|primary|key|common|first[-\s]line|gold[-\s]standard|appropriate|reasonable|mainstay|treatment\s+option|option|emergent|indication)\b/i,
  /\bis\s+the\s+most\s+common\b/i,
  /\brepresents?\s+a\b/i,
  /\bis\s+(defined|considered)\s+(as|an?|to\s+be)\b/i,
  /\bwhen\s+\w+\s+is\s+suspected\b/i,                            // "when asthma is suspected…"
  /\bwhen\s+conservative\b/i,
];

/** A surgical_indication is member-specific (pitch-worthy) only if it is assertive and NOT phrased
 *  as a generic/conditional/population-level textbook statement. Pure + deterministic. */
export function isSpecificSurgicalIndication(claim: string): boolean {
  const c = (claim || '').trim();
  if (c.length < 12) return false;
  return !GENERIC_INDICATION_PATTERNS.some((re) => re.test(c));
}

export interface PitchGateOpts {
  /** confidence floor for the indication finding (default PITCH_MIN_CONFIDENCE). */
  minConfidence?: number;
  /** require the indication to read as member-specific, not generic/conditional (default true). */
  requireSpecific?: boolean;
}

/** The pitch may fire ONLY on a corpus-CITED surgical/specialist-indication finding that is
 *  member-specific (not a generic/conditional textbook statement) and clears the confidence floor.
 *  The `requireSpecific`/`minConfidence` knobs let the calibration backtest reproduce the OLD gate. */
export function pitchGate(clinical: ClinicalFinding[], opts: PitchGateOpts = {}): { allowed: boolean; gatedOn: string[] } {
  const minConf = opts.minConfidence ?? PITCH_MIN_CONFIDENCE;
  const requireSpecific = opts.requireSpecific ?? true;
  const cited = clinical.filter((f) =>
    f.kind === 'surgical_indication' &&
    f.grounding === 'corpus_cited' &&
    f.citation_ids.length > 0 &&
    f.confidence >= minConf &&
    (!requireSpecific || isSpecificSurgicalIndication(f.claim)),
  );
  return { allowed: cited.length > 0, gatedOn: cited.map((f) => f.id) };
}

/** Deterministic fallback priority when no pitch is allowed (referral present ⇒ med). */
export function defaultPriority(bundle: EpisodeBundle): CommercialLayer['priority'] {
  return bundle.prescription.specialistReferral.length > 0 ? 'med' : 'low';
}

// ── Grounding math + envelope assembly ────────────────────────────────────────

export function groundingSummary(clinical: ClinicalFinding[]): GroundingSummary {
  const cited = clinical.filter((f) => f.grounding === 'corpus_cited').length;
  const reasoning = clinical.filter((f) => f.grounding === 'general_reasoning').length;
  const rule = clinical.filter((f) => f.grounding === 'deterministic_rule').length;
  const distinct = new Set<number>();
  for (const f of clinical) for (const n of f.citation_ids) distinct.add(n);
  return {
    findings: clinical.length,
    corpus_cited: cited, general_reasoning: reasoning, rule,
    citation_coverage_pct: clinical.length ? Math.round((cited / clinical.length) * 100) : 0,
    distinct_sources: distinct.size,
  };
}

export interface AssembleParams {
  traceId: string | null;
  bundle: EpisodeBundle;
  clinical: ClinicalFinding[];
  commercial: CommercialLayer;
  lowValueFlags: LowValueFlag[];
  sources: Source[];
  retrieval: RetrievalManifest;
  artifactCount: number;
  now?: Date;
}

export function assembleEnvelope(p: AssembleParams): CcbEnvelope {
  return {
    trace_id: p.traceId,
    engine_version: CCB_ENGINE_VERSION,
    generated_at: (p.now ?? new Date()).toISOString(),
    member_ref: { uhid: p.bundle.keys.kxUhid, individual_uid: p.bundle.keys.individualUid },
    episode: { date: p.bundle.keys.noteDate, coverage: p.bundle.coverage, artifact_count: p.artifactCount },
    retrieval: p.retrieval,
    grounding_summary: groundingSummary(p.clinical),
    clinical: p.clinical,
    low_value_flags: p.lowValueFlags,
    commercial: p.commercial,
    sources: p.sources,
    disclaimer: CCB_DISCLAIMER,
  };
}

/** Build the commercial layer from the wall result + (optional) generated pitch. */
export function buildCommercial(
  bundle: EpisodeBundle,
  gate: { allowed: boolean; gatedOn: string[] },
  generated: { priority: CommercialLayer['priority']; push_harder: boolean; script: string | null } | null,
): CommercialLayer {
  if (!gate.allowed) {
    return { priority: defaultPriority(bundle), push_harder: false, pitch_allowed: false, gated_on: [], script: null };
  }
  return {
    priority: generated?.priority ?? 'high',
    push_harder: generated?.push_harder ?? true,
    pitch_allowed: true,
    gated_on: gate.gatedOn,
    script: generated?.script ?? null,
  };
}
