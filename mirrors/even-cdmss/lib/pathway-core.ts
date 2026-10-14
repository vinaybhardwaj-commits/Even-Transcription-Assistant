/**
 * lib/pathway-core.ts — Pathway & Decision CORE (PW.1).
 *
 * PURE, dependency-free (no db/llm). Importable by BOTH the server passes
 * (lib/pathway.ts) and the client renderer (components/PathwayTrace.tsx), and
 * unit-testable on its own with `node --experimental-strip-types`.
 * See CDMSS-PATHWAY-DECISION-PRD-v1.0.md.
 *
 * Two-stage design (V's choice — Flash skeleton → Pro enrich):
 *   1) SKELETON: classify the input's stage + produce an ordered care-path spine.
 *   2) ENRICH:   per-node detail / decision-criteria / grounded evidence vs labeled
 *                estimates / alternatives. Tariffs are injected DETERMINISTICALLY by
 *                the server (never the LLM), reusing TariffRef from lvc-value-core.
 *
 * Posture: advisory, NON-DIRECTIVE. A chip is a lens ("worth questioning"), never a
 * block or a denial-of-care. Diagnosis stays DDx's job — when uncertain we hand off.
 */

import type { TariffRef } from './lvc-value-core';
export type { TariffRef } from './lvc-value-core';

// NB: this mirrors lib/citations-core.validateCitationIds. It is inlined (not imported)
// ON PURPOSE: pathway-core has an in-repo `node --experimental-strip-types` test, and a
// runtime (value) cross-module import would need a `.ts` extension the Next build doesn't
// use. Type-only imports are erased so they're fine; a value import is not. Keep in sync.
function validateCitationIds(ids: unknown, max: number, cap = 8): number[] {
  if (!Array.isArray(ids) || max < 1) return [];
  const out: number[] = [];
  for (const x of ids) {
    const n = Math.round(Number(x));
    if (Number.isFinite(n) && n >= 1 && n <= max && !out.includes(n)) out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type StageKind = 'triage' | 'assessment' | 'diagnosis' | 'treatment' | 'disposition' | 'followup';
export type StageFlag =
  | 'essential'
  | 'routine'
  | 'high-value'
  | 'context-dependent'
  | 'low-value'
  | 'caution'
  | 'followup';

export type DetectedStage = 'presentation' | 'diagnosis' | 'order' | 'mixed';
export type Certainty = 'low' | 'moderate' | 'high';

export interface SkeletonStage {
  id: string;        // stable, server-assigned: 's1', 's2', …
  kind: StageKind;
  title: string;     // short label, e.g. "Decision: MRI lumbar spine?"
  action: string;    // one-line what-to-do
  flag: StageFlag;   // tentative chip
}

export interface PathwaySkeleton {
  detectedStage: DetectedStage;
  workingDiagnosis: string | null;
  diagnosisCertainty: Certainty;
  /** True when the diagnosis is not established → hand off to DDx rather than guess. */
  needsDdx: boolean;
  /** Anchoring / base-rate warning + the more likely syndrome, when the stated dx is weak. */
  anchorNote?: string | null;
  /** Prefilled scenario for the DDx deep-link (defaults to the raw scenario in the route). */
  ddxQuery?: string;
  summary: string;
  stages: SkeletonStage[];
}

export interface EnrichedNode {
  id: string;        // matches a SkeletonStage.id
  flag: StageFlag;   // may revise the skeleton's tentative chip
  detail: string;    // fuller what-to-do
  decisionCriteria: string | null;   // "branches if…" / "image only if…"
  /** Concrete orderable item at this node (e.g. "MRI lumbar spine") → deterministic tariff match. */
  order?: string;
  alternatives?: { name: string; note: string }[];
  evidence: string[];    // corpus-grounded points (the "evidence" block)
  estimates: string[];   // model estimates incl. any figures — kept separate, labeled
  citation_ids: number[]; // [n] of the surfaced Source[] that back this node's evidence
  /** EHRC charge-master matches for `order` — set DETERMINISTICALLY by the server, not the LLM. */
  tariffs?: TariffRef[];
}

export interface PathwayEnrichment {
  nodes: EnrichedNode[];
  disclaimer: string;
}

export const PATHWAY_DISCLAIMER =
  'Advisory care-path grounded in retrieved guidance — not a validated protocol. Evidence-cited steps are kept separate from model estimates (every figure is an estimate unless tied to an EHRC tariff). Decision support only: it does not replace clinical judgment and never blocks, cancels, or mandates an order.';

// ─────────────────────────────────────────────────────────────────────────────
// Normalisers
// ─────────────────────────────────────────────────────────────────────────────

const STAGE_KINDS = new Set<StageKind>(['triage', 'assessment', 'diagnosis', 'treatment', 'disposition', 'followup']);
const STAGE_FLAGS = new Set<StageFlag>(['essential', 'routine', 'high-value', 'context-dependent', 'low-value', 'caution', 'followup']);
const DETECTED = new Set<DetectedStage>(['presentation', 'diagnosis', 'order', 'mixed']);
const CERTAINTY = new Set<Certainty>(['low', 'moderate', 'high']);

/** Canonical clinical ordering of stage kinds (used to keep the spine in order). */
export const STAGE_ORDER: Record<StageKind, number> = {
  triage: 0, assessment: 1, diagnosis: 2, treatment: 3, disposition: 4, followup: 5,
};

export function normStageKind(v: unknown): StageKind {
  const s = String(v ?? '').toLowerCase().trim().replace(/[\s_-]+/g, '');
  if (s === 'triage' || s === 'stabilisation' || s === 'stabilization') return 'triage';
  if (s === 'assessment' || s === 'workup' || s === 'investigation' || s === 'investigations' || s === 'evaluation') return 'assessment';
  if (s === 'diagnosis' || s === 'dx' || s === 'riskstratification') return 'diagnosis';
  if (s === 'treatment' || s === 'management' || s === 'therapy' || s === 'tx') return 'treatment';
  if (s === 'disposition' || s === 'admit' || s === 'discharge' || s === 'referral') return 'disposition';
  if (s === 'followup' || s === 'follow' || s === 'monitoring' || s === 'safetynet') return 'followup';
  return STAGE_KINDS.has(s as StageKind) ? (s as StageKind) : 'assessment';
}

export function normStageFlag(v: unknown): StageFlag {
  const s = String(v ?? '').toLowerCase().trim().replace(/\s+/g, '-');
  if (s === 'question' || s === 'question-this' || s === 'lowvalue' || s === 'low_value') return 'low-value';
  if (s === 'highvalue' || s === 'high_value') return 'high-value';
  if (s === 'context' || s === 'context_dependent' || s === 'contextdependent') return 'context-dependent';
  if (s === 'warning' || s === 'warn') return 'caution';
  if (s === 'follow-up' || s === 'follow_up') return 'followup';
  return STAGE_FLAGS.has(s as StageFlag) ? (s as StageFlag) : 'routine';
}

function normDetected(v: unknown): DetectedStage {
  const s = String(v ?? '').toLowerCase().trim();
  return DETECTED.has(s as DetectedStage) ? (s as DetectedStage) : 'mixed';
}
function normCertainty(v: unknown): Certainty {
  const s = String(v ?? '').toLowerCase().trim();
  return CERTAINTY.has(s as Certainty) ? (s as Certainty) : 'moderate';
}
function asStr(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function asStrOrNull(v: unknown): string | null { const s = asStr(v); return s ? s : null; }
function asStrArray(v: unknown, cap = 8): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, cap);
}
function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').toLowerCase().trim();
  return s === 'true' || s === 'yes' || s === '1';
}

// ─────────────────────────────────────────────────────────────────────────────
// Tolerant JSON extraction (self-contained — no cross-module dep)
// ─────────────────────────────────────────────────────────────────────────────

export function extractJsonObject(text: string): unknown {
  let t = (text || '').trim();
  if (!t) return null;
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage ordering + id assignment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keep the LLM's intra-kind order but enforce the canonical kind ordering, then
 * stamp stable sequential ids (s1, s2, …). Stable sort: ties (same kind) preserve
 * the order the model returned. Caps the spine length defensively.
 */
export function orderAndIdStages(raw: { kind: StageKind; title: string; action: string; flag: StageFlag }[], cap = 8): SkeletonStage[] {
  const withIdx = raw.slice(0, cap).map((s, i) => ({ s, i }));
  withIdx.sort((a, b) => {
    const d = STAGE_ORDER[a.s.kind] - STAGE_ORDER[b.s.kind];
    return d !== 0 ? d : a.i - b.i;
  });
  return withIdx.map(({ s }, n) => ({ id: `s${n + 1}`, kind: s.kind, title: s.title, action: s.action, flag: s.flag }));
}

// ─────────────────────────────────────────────────────────────────────────────
// SKELETON pass (Flash) — prompt + parse
// ─────────────────────────────────────────────────────────────────────────────

export const SKELETON_SYSTEM = `You are a clinical pathway planner. Given a patient scenario (which may be an undifferentiated presentation, a working/confirmed diagnosis, or a specific proposed order), do TWO things FAST.

FIRST — reason from the SYNDROME, not the label. Guard against anchoring bias:
- Identify the dominant clinical syndrome from the PRESENTATION itself (symptoms, timeframe, epidemiology) BEFORE accepting any diagnosis that is merely stated or implied.
- Weigh PRE-TEST PROBABILITY and base rates. Example: a household/roommate cluster of acute watery diarrhoea over a couple of days favours a common-source viral or food-borne gastroenteritis over an uncommon systemic diagnosis.
- Treat OUTSIDE lab results — especially low-specificity / low-utility tests (e.g. the Widal test for typhoid) — with explicit skepticism. A single positive low-utility test does NOT establish a diagnosis and must NOT anchor the pathway.
- If the dominant syndrome conflicts with a stated/implied diagnosis, or the diagnosis rests mainly on a low-utility test, REFRAME the working diagnosis to the syndrome, set diagnosis_certainty "low", set needs_ddx true, and name the anchoring risk + the more likely syndrome in "anchor_note".

1) Classify the input:
   - "detected_stage": "presentation" (undifferentiated symptoms) | "diagnosis" (a diagnosis is established or strongly supported by the presentation) | "order" (a specific test/treatment is proposed) | "mixed".
   - "working_diagnosis": the single diagnosis (or syndrome, if you reframed) you are tracing management for, or null if genuinely undifferentiated.
   - "diagnosis_certainty": "low" | "moderate" | "high". Be honest — a diagnosis resting on one low-utility test, or contradicted by the dominant syndrome, is "low".
   - "needs_ddx": true whenever the diagnosis is NOT established — undifferentiated presentation, low certainty, OR anchored on a weak/low-utility result. You are a MANAGEMENT pathway tool — when the diagnosis is unclear, set needs_ddx true and DO NOT invent a differential; the user is handed off to the differential-diagnosis tool.
   - "anchor_note": one line naming the anchoring / base-rate risk and the more likely syndrome, or null if there is no anchoring concern.

2) Produce the recommended care-path as an ORDERED list of 3–7 stages spanning the relevant part of: triage → assessment → diagnosis → treatment → disposition → followup. Each stage:
   - "kind": one of triage | assessment | diagnosis | treatment | disposition | followup
   - "title": a short label (≤ 8 words)
   - "action": one line — what to do at this step
   - "flag": a value/appropriateness lens for this step — essential | routine | high-value | context-dependent | low-value | caution | followup. Use "low-value" for a step that is commonly done but low-value / worth questioning for this patient — INCLUDING a confirmatory test with low pre-test probability or low diagnostic yield (do NOT flag such a test "high-value"). "essential" for must-not-miss safety steps; "high-value" for high-benefit low-harm steps.

Be concise — this is the fast skeleton; detail comes later. Advisory and NON-DIRECTIVE: never phrase a step as blocking or denying care.

Return ONLY JSON, no prose:
{"detected_stage":"…","working_diagnosis":"… or null","diagnosis_certainty":"low|moderate|high","needs_ddx":true|false,"anchor_note":"… or null","summary":"<one-line path summary>","stages":[{"kind":"…","title":"…","action":"…","flag":"…"}]}`;

// Slice 2 (Right Care × ClinicalState): `clinicalStateText` is the pre-composed PATIENT
// PICTURE block. OPTIONAL and additive — omitted/empty → byte-identical to the ungrounded
// Slice-1 prompt (unit-asserted).
export function buildSkeletonUser(ctx: { scenario: string; proposedActions?: string[]; patient?: { age?: number; sex?: string }; clinicalStateText?: string }): string {
  const pt = ctx.patient && (ctx.patient.age != null || ctx.patient.sex)
    ? `Patient: ${ctx.patient.age != null ? `${ctx.patient.age}y` : 'age unknown'}${ctx.patient.sex ? `, ${ctx.patient.sex}` : ''}\n`
    : '';
  const orders = ctx.proposedActions && ctx.proposedActions.length
    ? `Proposed order(s): ${ctx.proposedActions.join('; ')}\n`
    : '';
  const picture = ctx.clinicalStateText && ctx.clinicalStateText.trim() ? `\n\n${ctx.clinicalStateText.trim()}` : '';
  return `${pt}${orders}Clinical scenario:\n${ctx.scenario.trim()}${picture}`;
}

export function parseSkeleton(text: string): PathwaySkeleton | null {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const rawStages = Array.isArray(o.stages) ? o.stages : [];
  const cleaned = rawStages
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const so = r as Record<string, unknown>;
      const title = asStr(so.title);
      const action = asStr(so.action);
      if (!title && !action) return null;
      return { kind: normStageKind(so.kind), title: title || action, action, flag: normStageFlag(so.flag) };
    })
    .filter((x): x is { kind: StageKind; title: string; action: string; flag: StageFlag } => !!x);

  if (cleaned.length === 0) return null;

  const workingDiagnosis = asStrOrNull(o.working_diagnosis ?? o.workingDiagnosis);
  const certainty = normCertainty(o.diagnosis_certainty ?? o.diagnosisCertainty);
  const detectedStage = normDetected(o.detected_stage ?? o.detectedStage);
  const anchorNote = asStrOrNull(o.anchor_note ?? o.anchorNote);
  // Respect the model, but force a DDx hand-off whenever the diagnosis is NOT established:
  // any low-certainty dx (incl. one anchored on a low-utility lab), an undifferentiated
  // presentation, or an explicit anchoring warning. This de-anchors confirm-the-label pathways.
  const needsDdx = asBool(o.needs_ddx ?? o.needsDdx)
    || certainty === 'low'
    || !!anchorNote
    || (detectedStage === 'presentation' && !workingDiagnosis);

  return {
    detectedStage,
    workingDiagnosis,
    diagnosisCertainty: certainty,
    needsDdx,
    anchorNote,
    ddxQuery: asStr(o.ddx_query ?? o.ddxQuery) || undefined,
    summary: asStr(o.summary),
    stages: orderAndIdStages(cleaned),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ENRICH pass (Pro) — prompt + parse
// ─────────────────────────────────────────────────────────────────────────────

export const ENRICH_SYSTEM = `You are a clinical pathway analyst. You are given a patient scenario, NUMBERED EVIDENCE EXCERPTS [1], [2], … retrieved from a medical corpus, and a fixed ordered list of care-path STAGES (each with an id). Enrich EACH stage by its id. Do NOT add, remove, reorder, or rename stages — only enrich the ones given.

For each stage return:
- "id": the SAME id you were given (required — omit a stage by omitting its object).
- "flag": value/appropriateness lens (you may revise the tentative one) — essential | routine | high-value | context-dependent | low-value | caution | followup.
- "detail": 1–3 sentences — what to do and why, specific to THIS patient (age, comorbidity, severity).
- "decision_criteria": the branch/decision rule, if any — e.g. "image only if red flags or >6 wks despite conservative care"; null if the step is unconditional.
- "order": the single concrete orderable item at this step (a test/procedure/drug name, e.g. "MRI lumbar spine") if the step is an order, else omit. Keep it short and generic so it can be matched to a tariff.
- "alternatives": optional [{ "name": "...", "note": "..." }].
- "evidence": points SUPPORTED BY THE EXCERPTS (grounded). If the excerpts don't support a claim, do not put it here.
- "estimates": anything you are estimating, or asserting from general knowledge the excerpts don't cover (figures, rough probabilities) — every figure written as an estimate, e.g. "est. ~₹X (not validated)". NEVER present an estimate as evidence.
- "citation_ids": the numbers [n] of the excerpts that actually support THIS node's evidence. Cite only excerpts that genuinely apply; leave empty if none do.

Rules:
- Balanced and NON-DIRECTIVE — this informs decision-making; it is NOT a denial-of-care justification and must never read as blocking an order.
- Weigh PRE-TEST PROBABILITY. If a step orders a confirmatory/diagnostic test whose pre-test probability or diagnostic yield is LOW for THIS presentation — or a test of poor specificity (e.g. the Widal test) — flag it "low-value" or "caution" (NOT "high-value") and say why in "detail". Do not let an outside low-utility result anchor the plan; reason from the dominant syndrome.
- Separate EVIDENCE (from excerpts, with citation_ids) from ESTIMATES (your own). Do not invent citations or cite excerpts that don't support the claim.
- Do NOT output cost figures in "estimates" for an "order" — the system attaches the real EHRC tariff deterministically.

Return ONLY JSON, no prose:
{"nodes":[{"id":"s1","flag":"…","detail":"…","decision_criteria":"… or null","order":"… (optional)","alternatives":[{"name":"…","note":"…"}],"evidence":["…"],"estimates":["…"],"citation_ids":[1,2]}]}`;

// Slice 2: same optional PATIENT PICTURE contract as buildSkeletonUser — both pathway
// passes see the picture when grounding is on; neither prompt changes when it is off.
export function buildEnrichUser(
  ctx: { scenario: string; proposedActions?: string[]; patient?: { age?: number; sex?: string }; workingDiagnosis?: string | null; clinicalStateText?: string },
  stages: SkeletonStage[],
  citedContext: string,
): string {
  const pt = ctx.patient && (ctx.patient.age != null || ctx.patient.sex)
    ? `Patient: ${ctx.patient.age != null ? `${ctx.patient.age}y` : 'age unknown'}${ctx.patient.sex ? `, ${ctx.patient.sex}` : ''}\n`
    : '';
  const dx = ctx.workingDiagnosis ? `Working diagnosis: ${ctx.workingDiagnosis}\n` : '';
  const orders = ctx.proposedActions && ctx.proposedActions.length ? `Proposed order(s): ${ctx.proposedActions.join('; ')}\n` : '';
  const picture = ctx.clinicalStateText && ctx.clinicalStateText.trim() ? `\n\n${ctx.clinicalStateText.trim()}` : '';
  const stageList = stages.map((s) => `- ${s.id} [${s.kind}] ${s.title}: ${s.action}`).join('\n');
  const ev = citedContext.trim()
    ? citedContext.trim()
    : '(no excerpts retrieved — rate conservatively; leave citation_ids empty; put unsupported clinical reasoning in estimates, not evidence)';
  return `${pt}${dx}${orders}Clinical scenario:\n${ctx.scenario.trim()}${picture}\n\nSTAGES TO ENRICH (keep these ids, do not change the set):\n${stageList}\n\nNUMBERED EVIDENCE EXCERPTS:\n${ev}`;
}

export function parseEnrichment(text: string, validIds?: string[], sourceCount = 0): PathwayEnrichment | null {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== 'object') return null;
  const rawNodes = (obj as Record<string, unknown>).nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) return null;
  const allow = validIds && validIds.length ? new Set(validIds) : null;

  const nodes: EnrichedNode[] = [];
  const seen = new Set<string>();
  for (const r of rawNodes) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const id = asStr(o.id);
    if (!id || seen.has(id)) continue;
    if (allow && !allow.has(id)) continue;
    seen.add(id);
    const alternatives = Array.isArray(o.alternatives)
      ? (o.alternatives as unknown[]).map((a) => {
          const ao = (a && typeof a === 'object') ? (a as Record<string, unknown>) : {};
          return { name: asStr(ao.name), note: asStr(ao.note) };
        }).filter((a) => a.name).slice(0, 6)
      : undefined;
    nodes.push({
      id,
      flag: normStageFlag(o.flag),
      detail: asStr(o.detail),
      decisionCriteria: asStrOrNull(o.decision_criteria ?? o.decisionCriteria),
      order: asStr(o.order) || undefined,
      alternatives: alternatives && alternatives.length ? alternatives : undefined,
      evidence: asStrArray(o.evidence),
      estimates: asStrArray(o.estimates),
      citation_ids: validateCitationIds(o.citation_ids, sourceCount),
    });
  }
  if (nodes.length === 0) return null;
  return { nodes, disclaimer: PATHWAY_DISCLAIMER };
}

/** Merge a skeleton spine with enrichment nodes by id (client + server share this). */
export interface MergedStage extends SkeletonStage {
  enriched: boolean;
  detail?: string;
  decisionCriteria?: string | null;
  order?: string;
  alternatives?: { name: string; note: string }[];
  evidence?: string[];
  estimates?: string[];
  citation_ids?: number[];
  tariffs?: TariffRef[];
}

export function mergeStages(stages: SkeletonStage[], enrichment: PathwayEnrichment | null): MergedStage[] {
  const byId = new Map<string, EnrichedNode>();
  for (const n of enrichment?.nodes ?? []) byId.set(n.id, n);
  return stages.map((s) => {
    const e = byId.get(s.id);
    if (!e) return { ...s, enriched: false };
    return {
      ...s,
      flag: e.flag || s.flag,
      enriched: true,
      detail: e.detail,
      decisionCriteria: e.decisionCriteria,
      order: e.order,
      alternatives: e.alternatives,
      evidence: e.evidence,
      estimates: e.estimates,
      citation_ids: e.citation_ids,
      tariffs: e.tariffs,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Citation self-critique + revise (mirrors the Ask surface / value mode)
// ─────────────────────────────────────────────────────────────────────────────

export const ENRICH_CRITIQUE_SYSTEM = `You are a clinical citation + accuracy auditor reviewing an enriched care-path produced by an AI tool. You are given the scenario, the NUMBERED evidence excerpts [1..n], and the draft enrichment JSON (nodes[]).

Find problems: node "evidence" points NOT actually supported by their citation_ids; citation_ids that don't match the claim; figures/general-knowledge assertions mis-filed as evidence instead of estimates; clinically important caveats/red-flags a physician would expect that are missing; AND anchoring / base-rate errors — the path anchors on a stated or implied diagnosis the presentation does not support, or rewards a low-yield / low-specificity confirmatory test against a low pre-test probability (flag these under "anchoring").

Output ONLY JSON:
{"unsupported_evidence":["…"],"wrong_or_missing_citations":["…"],"misfiled_estimates":["…"],"missing_caveats":["…"],"anchoring":["…"],"needs_revision":true|false,"severity":"none|minor|moderate|major"}

Empty arrays are fine. needs_revision=true if any array is non-empty.`;

export const ENRICH_REVISE_SYSTEM = `You are revising your own enriched care-path based on a citation auditor's critique. You receive the scenario, the NUMBERED excerpts [1..n], your earlier draft JSON (nodes[]), and the critique JSON.

Rewrite to fix every issue: move unsupported claims out of "evidence" (into "estimates" if still worth saying, else drop), correct each node's citation_ids so it cites only excerpts that truly support it, add missing caveats. If the auditor flagged ANCHORING / base-rate problems, DOWNGRADE the flag of the anchored or low-yield step (e.g. high-value → low-value or caution) and rewrite its "detail" to reflect the dominant syndrome and the low pre-test probability. Keep the EXACT same JSON schema and the SAME node ids as the draft. Output ONLY the corrected JSON, no prose.`;

export function buildEnrichCritiqueUser(scenario: string, citedContext: string, draftJson: string): string {
  return `Scenario:\n${scenario.trim()}\n\nNUMBERED EVIDENCE EXCERPTS:\n${citedContext.trim() || '(none)'}\n\nDraft enrichment JSON to audit:\n${draftJson}\n\nOutput the JSON critique now.`;
}

export function buildEnrichReviseUser(scenario: string, citedContext: string, draftJson: string, critiqueJson: string): string {
  return `Scenario:\n${scenario.trim()}\n\nNUMBERED EVIDENCE EXCERPTS:\n${citedContext.trim() || '(none)'}\n\nEarlier draft JSON:\n${draftJson}\n\nAuditor critique JSON:\n${critiqueJson}\n\nOutput the corrected enrichment JSON now.`;
}
