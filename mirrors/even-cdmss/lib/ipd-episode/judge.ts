/**
 * lib/ipd-episode/judge.ts — the IMPURE half of the three Opus passes: A1 divergence, A2 fidelity,
 * B commentary. Every call goes through `governedChat` with `{ bedrock: model }` and no other
 * client (PRD §3.7).
 *
 * WHAT EACH PASS IS GIVEN IS DECIDED BEFORE IT GETS HERE. The caller hands A1 a list produced by
 * `diffPassEvents` (no discharge event) and A2 one produced by `fidelityPassEvents` (with it).
 * This file renders what it is given; it never reaches back for an event, which is why the
 * blinding cannot be broken by a change in here.
 */

import { callModel, type ModelCallBudget } from './model-call';
import { assertKnownBedrockModel } from '../bedrock-core';
import {
  buildCommentaryUser, buildDiffUser, buildFidelityUser, parseFindings, validateCommentary,
  capFindings,
  type Commentary, type EpisodeFinding, type ExpectationDigest, type ParseFailure,
} from './judge-core';
import {
  IPD_EPISODE_COMMENTARY_SYSTEM, IPD_EPISODE_DIFF_SYSTEM, IPD_EPISODE_FIDELITY_SYSTEM,
} from './prompts';
import type { EpisodeEvent } from './assemble-core';

/** `lib/bedrock-core.ts` BEDROCK_MODELS. Overridable by IPD_EPISODE_JUDGE_MODEL; an unlisted id is
 *  refused there. Opus does the diff, the fidelity check and the commentary. */
export const IPD_EPISODE_JUDGE_MODEL_DEFAULT = 'global.anthropic.claude-opus-4-6-v1';

export function judgeModel(env: Record<string, string | undefined>): string {
  const override = (env.IPD_EPISODE_JUDGE_MODEL ?? '').trim();
  return override || IPD_EPISODE_JUDGE_MODEL_DEFAULT;
}

/**
 * ⚠️ IT WAS ALREADY 0, and item 9's answer is that this was never the source of the spread. All
 * three Opus passes have passed `temperature: 0` since the first commit; the 96/100/80 variance
 * happened at temperature 0 on byte-identical checkpoints. Naming it as a constant and recording
 * it on the audit row does not make the pass reproducible — it makes the claim checkable, so the
 * next investigation starts from the row instead of from someone's memory of the code.
 *
 * A seed is not available: Bedrock Converse's inferenceConfig accepts maxTokens and temperature
 * and nothing else (lib/bedrock-core.ts toConverseInput, UNTOUCHED).
 */
export const JUDGE_TEMPERATURE = 0;

/**
 * ⚠️ EVERY CEILING RE-DERIVED (round 11 item 1). All four were set once and never revisited when
 * decision 33 added a matcher and a proposed_severity to every expectation and the diff prompt grew
 * to carry five expected courses. IPNO-416's diff pass produced 22,677 characters — roughly 5,700
 * tokens — and was still going when 8000 cut it off. The derivations are here so the next schema
 * change has something to update rather than a bare number to guess at.
 *
 * DIFF (A1) and FIDELITY (A2), 16000:
 *   one finding ≈ finding_id + 6 enum fields + statement (~40 words) + evidence_basis (1-3 rows)
 *              + citation_ids                                        ≈ 200-260 output tokens
 *   cap        = MAX_FINDINGS_PER_PASS (80 since decision 47; was 30)
 *   ⚠️ THE CAP NO LONGER SITS UNDER THIS CEILING, AND THAT IS THE POINT OF DECISION 47. 80 × 260
 *              ≈ 20,800 tokens, which is ABOVE 16000. The cap trims the PARSED list and cannot
 *              bound generation, so this is not an overrun — it means the ceiling, not the cap, is
 *              now what limits how many findings a pass can return: 16000 / 260 ≈ 61.
 *   measured   round 24 A1 dropped 18 findings on IP-1483, 10 on IPNO-486, 6 on IPNO-495 at a cap
 *              of 30 — the cap had begun deciding how much of an admission could be charged for.
 *              If a pass now comes back with finish_reason `length`, the ceiling is the binding
 *              constraint and THIS arithmetic is what needs redoing.
 *
 * COMMENTARY (B), 10000 — raised from 6000, which was the tightest of the four:
 *   narrative ~600 + outcome_context ~300                            ≈ 900 tokens
 *   findings_context: one note per finding, and an episode can carry 80 findings once the resolver
 *              contributes (IP-1286 ran 68-73)   80 × 60             ≈ 4,800 tokens
 *   worst case                                                       ≈ 5,700 tokens
 *   ceiling    = 10000                                               ≈ 1.75× headroom
 *   6000 left almost none, and B is the pass whose truncation is silent — a rejected commentary
 *   stores null and the episode still scores.
 */
export const JUDGE_MAX_TOKENS = 16000;
export const COMMENTARY_MAX_TOKENS = 10000;

/** Every judge call goes through the shared helper, so truncation is handled once (item 2). */
async function callWithRetry(
  traceId: string | undefined, label: string, system: string, user: string, model: string, promptRef: string, maxTokens: number,
  deadlineAt: number | null = null,
): Promise<{ text: string; error: string | null; finishReason: string | null; truncated: boolean; attempts: number; budget: ModelCallBudget }> {
  const r = await callModel({
    traceId, label, system, user, model, promptRef, maxTokens, deadlineAt,
    // ROUND 14 ITEM 11. The three Opus passes are audit-class work and now say so; the checkpoint
    // pass keeps `utility`, which is the right shape for a 15-35 s Haiku call.
    callClass: 'audit',
    temperature: JUDGE_TEMPERATURE,
    truncationRetryInstruction:
      'YOUR PREVIOUS RESPONSE WAS CUT OFF because it was too long. Answer again with ONLY THE MOST '
      + 'CONSEQUENTIAL findings — at most 15 — most serious first. A shorter complete answer is '
      + 'worth far more than a longer truncated one, which is discarded entirely.',
  });
  return { text: r.text, error: r.error, finishReason: r.finishReason, truncated: r.truncated, attempts: r.attempts, budget: r.budget };
}

export interface PassResult {
  findings: EpisodeFinding[];
  /** The call ran out of room and the retry did not fix it — the episode must not be scored. */
  truncated: boolean;
  finishReason: string | null;
  /** Findings dropped by the per-pass cap (item 3). */
  findingsTruncated: number;
  /** Findings discarded after the repair pass had its chance. */
  unparseable: number;
  /** Findings kept ONLY because a coercion repaired one bad enum value. */
  repaired: number;
  /** What was discarded and why — persisted to raw_judge_error and traced. */
  failures: ParseFailure[];
  ok: boolean;
  error: string | null;
  /** ROUND 13 ITEM 1. What the wall-clock budget did on this pass — recorded either way. */
  budget: ModelCallBudget;
}

/** Pass A1 — divergence. Outcome-blind: `events` must already exclude the discharge event. */
export async function runDiffPass(a: {
  traceId: string | undefined;
  admissionContext: string;
  events: EpisodeEvent[];
  digest: ExpectationDigest;
  model: string;
  deadlineAt?: number | null;
}): Promise<PassResult & { promptChars: number }> {
  const user = buildDiffUser({ admissionContext: a.admissionContext, events: a.events, digest: a.digest });
  const promptChars = user.length;
  const { text, error, finishReason, truncated, budget } = await callWithRetry(a.traceId, 'ipd_episode_diff', IPD_EPISODE_DIFF_SYSTEM, user, a.model, 'prompts/IPD_EPISODE_DIFF_SYSTEM', JUDGE_MAX_TOKENS, a.deadlineAt ?? null);
  if (error) return { findings: [], unparseable: 0, repaired: 0, failures: [], ok: false, error, truncated, finishReason, findingsTruncated: 0, budget, promptChars };
  const parsed = parseFindings(text, { pass: 'divergence', idPrefix: 'a1' });
  // An empty findings list is a legitimate result — a concordant admission. Only a call or parse
  // FAILURE skips the episode (§8), so "no divergence found" must not look like a failure here.
  const usable = /\bfindings\b/.test(text);
  const capped = capFindings(parsed.findings);
  return {
    findings: capped.kept, unparseable: parsed.unparseable, repaired: parsed.repaired,
    failures: parsed.failures, ok: usable, error: usable ? null : 'the response carried no findings array',
    truncated, finishReason, findingsTruncated: capped.dropped, budget, promptChars,
  };
}

/** Pass A2 — fidelity. Reads the discharge summary; writes `documentation` findings only. */
export async function runFidelityPass(a: {
  traceId: string | undefined;
  admissionContext: string;
  events: EpisodeEvent[];
  extractedCase: unknown;
  extractionVersion: string | null;
  model: string;
  deadlineAt?: number | null;
}): Promise<PassResult> {
  const user = buildFidelityUser({
    admissionContext: a.admissionContext, events: a.events,
    extractedCase: a.extractedCase, extractionVersion: a.extractionVersion,
  });
  const { text, error, finishReason, truncated, budget } = await callWithRetry(a.traceId, 'ipd_episode_fidelity', IPD_EPISODE_FIDELITY_SYSTEM, user, a.model, 'prompts/IPD_EPISODE_FIDELITY_SYSTEM', JUDGE_MAX_TOKENS, a.deadlineAt ?? null);
  if (error) return { findings: [], unparseable: 0, repaired: 0, failures: [], ok: false, error, truncated, finishReason, findingsTruncated: 0, budget };
  const parsed = parseFindings(text, { pass: 'fidelity', idPrefix: 'a2' });
  const usable = /\bfindings\b/.test(text);
  const capped = capFindings(parsed.findings);
  return {
    findings: capped.kept, unparseable: parsed.unparseable, repaired: parsed.repaired,
    failures: parsed.failures, ok: usable, error: usable ? null : 'the response carried no findings array',
    truncated, finishReason, findingsTruncated: capped.dropped, budget,
  };
}

/**
 * Pass B — commentary. The only outcome-aware pass, and the only one whose output is thrown away
 * whole when it misbehaves: a score field or an unknown finding_id costs one retry and then null
 * (§8). A failed commentary never fails the episode — the audit row is written with
 * `commentary = null`, which the UI renders as an honest absence.
 */
export async function runCommentaryPass(a: {
  traceId: string | undefined;
  admissionContext: string;
  events: EpisodeEvent[];
  findings: EpisodeFinding[];
  outcomeLine: string;
  expectedCourses: string[];
  model: string;
  deadlineAt?: number | null;
}): Promise<{ commentary: Commentary | null; error: string | null }> {
  const user = buildCommentaryUser({
    admissionContext: a.admissionContext, events: a.events, findings: a.findings,
    outcomeLine: a.outcomeLine, expectedCourses: a.expectedCourses,
  });
  const knownIds = a.findings.map((f) => f.finding_id);

  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, error } = await callWithRetry(a.traceId, `ipd_episode_commentary${attempt ? '_retry' : ''}`, IPD_EPISODE_COMMENTARY_SYSTEM, user, a.model, 'prompts/IPD_EPISODE_COMMENTARY_SYSTEM', COMMENTARY_MAX_TOKENS, a.deadlineAt ?? null);
    if (error) { lastError = error; continue; }
    const v = validateCommentary(text, knownIds);
    if (v.ok) return { commentary: v.commentary, error: null };
    lastError = v.reason;
  }
  return { commentary: null, error: lastError };
}

export { assertKnownBedrockModel };
