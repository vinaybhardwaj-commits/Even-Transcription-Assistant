/**
 * lib/lvc-value-core.ts — Value Analysis CORE (CW-VA).
 *
 * PURE, dependency-free (no db/llm). Importable by BOTH the server value pass
 * (lib/lvc-value.ts) and the client card/visual (appropriateness-client.tsx),
 * and unit-testable on its own. See CDMSS-CHOOSING-WISELY-LOW-VALUE-CARE-PRD-v1.2.md §14.
 *
 * Posture (V's choices): runs always; structured card + simple visual; labeled
 * LLM estimates ALLOWED but every figure is tagged and estimates are kept visibly
 * separate from evidence-cited facts. Advisory, non-directive — never gatekeeping.
 */

import { validateCitationIds } from './citations-core';

export type Level = 'low' | 'moderate' | 'high' | 'unclear';
export type NetValue = 'high-value' | 'context-dependent' | 'low-value' | 'uncertain';

export interface ValueDimension {
  level: Level;
  detail: string;
}

export interface ValueIntervention {
  intervention: string;
  net_value: NetValue;
  confidence: number; // 0..1
  summary: string;
  long_term_benefit: ValueDimension;
  harms_risks: ValueDimension;
  upfront_cost: ValueDimension;
  long_term_care: ValueDimension;
  alternatives: { name: string; note: string }[];
  what_would_change: string[];
  evidence: string[];     // grounded (corpus-supported) points — rendered as the "evidence" block
  estimates: string[];    // model estimates (incl. any figures) — rendered separately, clearly labeled
  citation_ids: number[]; // [n] of the surfaced Source[] that back this intervention's evidence
}

/** A grounded EHRC charge-master match (real local price, not an estimate). */
export interface TariffRef {
  kind?: 'package' | 'investigation';
  code: string;
  item: string;
  dept?: string;
  type?: string;
  general?: number;
  private?: number | null;
  suite?: number | null;
  opd?: number | null;        // investigations carry an outpatient price
  score?: number;
}

export interface ValueAnalysis {
  interventions: ValueIntervention[];
  disclaimer: string;
  /** EHRC package-tariff matches for the proposed order(s) — cited cost, set deterministically (not by the LLM). */
  tariffs?: TariffRef[];
}

export const VALUE_DISCLAIMER =
  'Reasoned value assessment, not a validated cost-effectiveness analysis. Cost and long-term-care figures are model-generated estimates, not validated. Advisory only — it does not replace clinical judgment or shared decision-making.';

const LEVELS = new Set<Level>(['low', 'moderate', 'high', 'unclear']);
const NET_VALUES = new Set<NetValue>(['high-value', 'context-dependent', 'low-value', 'uncertain']);

/** Map a level to a 0–3 score for the simple bar visual. 'unclear' → 0 (renders as a hatched/empty bar). */
export function levelToScore(level: Level): number {
  switch (level) {
    case 'high': return 3;
    case 'moderate': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

function normLevel(v: unknown): Level {
  const s = String(v ?? '').toLowerCase().trim();
  return (LEVELS.has(s as Level) ? s : 'unclear') as Level;
}
function normNetValue(v: unknown): NetValue {
  const s = String(v ?? '').toLowerCase().trim().replace(/\s+/g, '-');
  return (NET_VALUES.has(s as NetValue) ? s : 'uncertain') as NetValue;
}
function asStr(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function asStrArray(v: unknown, cap = 8): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, cap);
}
function asDimension(v: unknown): ValueDimension {
  const o = (v && typeof v === 'object') ? v as Record<string, unknown> : {};
  return { level: normLevel(o.level), detail: asStr(o.detail) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────────────────────

export const VALUE_SYSTEM = `You are a clinical value-of-care analyst. Given a patient and one or more PROPOSED interventions (tests, treatments, procedures), produce a balanced, structured value assessment — the value case FOR and AGAINST doing it for THIS patient.

You are given NUMBERED EVIDENCE EXCERPTS [1], [2], … retrieved from a medical corpus. Ground clinical claims (benefit, harms, outcomes) in those excerpts and CITE them. Be specific to the patient's age, comorbidities, and severity.

Rules:
- Be balanced and NON-DIRECTIVE. This informs shared decision-making; it is NOT a recommendation to withhold care and must never read as a denial-of-care justification.
- Weigh PRE-TEST PROBABILITY for THIS patient, and guard against anchoring. If the proposed intervention is a test with low pre-test probability or low diagnostic yield here, or a low-specificity / low-utility test (e.g. the Widal test for typhoid), reflect that in net_value (lean low-value or context-dependent) and explain it in "summary". Do NOT anchor on an outside positive low-utility result — reason from the dominant clinical syndrome and base rates (e.g. a roommate cluster of acute watery diarrhoea favours common-source gastroenteritis over enteric fever).
- CITE your sources: for each intervention, put in "citation_ids" the numbers [n] of the excerpts that actually support your evidence. Every point you place in "evidence" must be supported by a cited excerpt. If an excerpt doesn't support a claim, do not cite it.
- Separate EVIDENCE-CITED facts (supported by the excerpts) from your own ESTIMATES. Put grounded points in "evidence" (with citations) and anything you are estimating, or asserting from general knowledge the excerpts don't cover, in "estimates". Every cost / long-term-care figure goes in "estimates", written as an estimate (e.g. "est. ~₹X (not validated)"). Never present an estimate as cited evidence.
- If the excerpts do not support a dimension, rate it "unclear" and say so — do NOT manufacture evidence.
- If an "EHRC TARIFF" is provided for the intervention, that is the AUTHORITATIVE local upfront cost. Set upfront_cost.detail to reference it as a real EHRC package price (not an estimate), and do NOT put an upfront-cost figure in "estimates".
- Rate each dimension low | moderate | high (or "unclear").
- "long_term_care" = ongoing needs/downstream care after the intervention. "what_would_change_this" = factors that would change the value calculus.

Return ONLY JSON, no prose:
{"interventions":[{"intervention":"<name>","net_value":"high-value|context-dependent|low-value|uncertain","confidence":0.0-1.0,"summary":"<one-line bottom line for this patient>","long_term_benefit":{"level":"low|moderate|high|unclear","detail":"..."},"harms_risks":{"level":"...","detail":"..."},"upfront_cost":{"level":"...","detail":"..."},"long_term_care":{"level":"...","detail":"..."},"alternatives":[{"name":"...","note":"..."}],"what_would_change_this":["..."],"evidence":["<corpus-supported point>"],"estimates":["<model estimate incl. any figures, marked est.>"],"citation_ids":[1,2]}]}`;

export function buildValueUser(
  ctx: { scenario: string; proposedActions?: string[]; patient?: { age?: number; sex?: string } },
  citedContext: string,
): string {
  const pt = ctx.patient
    ? `Patient: ${ctx.patient.age != null ? `${ctx.patient.age}y` : 'age unknown'}${ctx.patient.sex ? `, ${ctx.patient.sex}` : ''}\n`
    : '';
  const orders = ctx.proposedActions && ctx.proposedActions.length
    ? `Proposed intervention(s): ${ctx.proposedActions.join('; ')}\n`
    : 'Proposed intervention(s): (infer the main one from the scenario)\n';
  const ev = citedContext.trim()
    ? citedContext.trim()
    : '(no excerpts retrieved — rate dimensions "unclear" where you lack support, leave citation_ids empty, and put any clinical reasoning in estimates rather than evidence)';
  return `${pt}${orders}Clinical scenario:\n${ctx.scenario.trim()}\n\nNUMBERED EVIDENCE EXCERPTS:\n${ev}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser (tolerant of ```json fences / surrounding prose)
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

/** Parse the value-pass response. `sourceCount` clamps citation_ids to [1..n]. Returns null if nothing usable. */
export function parseValueResponse(text: string, sourceCount = 0): ValueAnalysis | null {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== 'object') return null;
  const rawList = (obj as Record<string, unknown>).interventions;
  if (!Array.isArray(rawList) || rawList.length === 0) return null;

  const interventions: ValueIntervention[] = [];
  for (const r of rawList.slice(0, 4)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const name = asStr(o.intervention);
    if (!name) continue;
    let confidence = Number(o.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));
    interventions.push({
      intervention: name,
      net_value: normNetValue(o.net_value),
      confidence,
      summary: asStr(o.summary),
      long_term_benefit: asDimension(o.long_term_benefit),
      harms_risks: asDimension(o.harms_risks),
      upfront_cost: asDimension(o.upfront_cost),
      long_term_care: asDimension(o.long_term_care),
      alternatives: Array.isArray(o.alternatives)
        ? (o.alternatives as unknown[]).map((a) => {
            const ao = (a && typeof a === 'object') ? a as Record<string, unknown> : {};
            return { name: asStr(ao.name), note: asStr(ao.note) };
          }).filter((a) => a.name).slice(0, 6)
        : [],
      what_would_change: asStrArray(o.what_would_change_this ?? o.what_would_change),
      evidence: asStrArray(o.evidence),
      estimates: asStrArray(o.estimates),
      citation_ids: validateCitationIds(o.citation_ids, sourceCount),
    });
  }
  if (interventions.length === 0) return null;
  return { interventions, disclaimer: VALUE_DISCLAIMER };
}

// ─────────────────────────────────────────────────────────────────────────────
// Citation self-critique + revise (mirrors the Ask surface's audit loop)
// ─────────────────────────────────────────────────────────────────────────────

export const VALUE_CRITIQUE_SYSTEM = `You are a clinical citation + accuracy auditor reviewing a value-of-care assessment produced by an AI tool. You are given the patient scenario, the NUMBERED evidence excerpts [1..n], and the draft assessment JSON.

Find problems: claims placed in "evidence" that are NOT actually supported by the cited excerpts; citation_ids that don't match the claim; figures or general-knowledge assertions mis-filed as evidence instead of estimates; missing important caveats/harms a physician would expect.

Output ONLY JSON:
{"unsupported_evidence":["..."],"wrong_or_missing_citations":["..."],"misfiled_estimates":["..."],"missing_caveats":["..."],"needs_revision":true|false,"severity":"none|minor|moderate|major"}

Empty arrays are fine. needs_revision=true if any array is non-empty.`;

export const VALUE_REVISE_SYSTEM = `You are revising your own value-of-care assessment based on a citation auditor's critique. You receive the scenario, the NUMBERED excerpts [1..n], your earlier draft JSON, and the critique JSON.

Rewrite the assessment to fix every issue: move unsupported claims out of "evidence" (into "estimates" if still worth saying, else drop), correct citation_ids so each intervention cites only excerpts that truly support it, add missing caveats. Keep the EXACT same JSON schema as the draft (interventions[] with the same fields incl. citation_ids). Output ONLY the corrected JSON, no prose.`;

export interface ValueCritique {
  unsupported_evidence: string[];
  wrong_or_missing_citations: string[];
  misfiled_estimates: string[];
  missing_caveats: string[];
  /** Anchoring / base-rate / low-pre-test-probability errors (optional; used by pathway + value). */
  anchoring: string[];
  needs_revision: boolean;
  severity: 'none' | 'minor' | 'moderate' | 'major';
}

export function buildCritiqueUser(scenario: string, citedContext: string, draftJson: string): string {
  return `Scenario:\n${scenario.trim()}\n\nNUMBERED EVIDENCE EXCERPTS:\n${citedContext.trim() || '(none)'}\n\nDraft assessment JSON to audit:\n${draftJson}\n\nOutput the JSON critique now.`;
}

export function buildReviseUser(scenario: string, citedContext: string, draftJson: string, critiqueJson: string): string {
  return `Scenario:\n${scenario.trim()}\n\nNUMBERED EVIDENCE EXCERPTS:\n${citedContext.trim() || '(none)'}\n\nEarlier draft JSON:\n${draftJson}\n\nAuditor critique JSON:\n${critiqueJson}\n\nOutput the corrected assessment JSON now.`;
}

export function parseCritique(text: string): ValueCritique {
  const obj = extractJsonObject(text);
  const o = (obj && typeof obj === 'object') ? obj as Record<string, unknown> : {};
  const arr = (v: unknown) => asStrArray(v, 10);
  const ue = arr(o.unsupported_evidence), wc = arr(o.wrong_or_missing_citations), me = arr(o.misfiled_estimates), mc = arr(o.missing_caveats), an = arr(o.anchoring);
  const total = ue.length + wc.length + me.length + mc.length + an.length;
  const sevRaw = String(o.severity ?? '').toLowerCase().trim();
  const severity = (['none', 'minor', 'moderate', 'major'].includes(sevRaw) ? sevRaw : (total > 0 ? 'minor' : 'none')) as ValueCritique['severity'];
  const needs = typeof o.needs_revision === 'boolean' ? o.needs_revision : (total > 0);
  return { unsupported_evidence: ue, wrong_or_missing_citations: wc, misfiled_estimates: me, missing_caveats: mc, anchoring: an, needs_revision: needs, severity };
}
