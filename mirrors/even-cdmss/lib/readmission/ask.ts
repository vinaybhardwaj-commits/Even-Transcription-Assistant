/**
 * lib/readmission/ask.ts — R4.3 "ask the agent", the IMPURE half (CDMSS-READMISSIONS-R4.3-PRD v1.0
 * R43-1..R43-8): the case MATERIAL assembled from STORED artefacts + the two bills the case page
 * already reads, and ONE Opus-4.6-on-Bedrock call whose answer is checked by code (askVerdict, the
 * same citation validator that guards narratives) before anything is returned. Called by
 * app/api/care/readmissions/ask/route.ts and by the dry-run script; never from a page render.
 *
 * THE FENCE: no re-audit, no regeneration, no write to the finding, no db13 read beyond the case
 * route's set. The conversation is ephemeral (the caller passes ≤ 6 capped turns back in). PHI
 * (R43-8): no identity is passed to the model — the material is de-identified by construction.
 */
import { startTrace, finishTrace, tracedChat } from '../trace';
import { modelsAgree, TEXT_MODEL } from '../llm';
import { servedCallForAudit, usageForTrace } from '../backfill-runs';
import { PRICING } from '../llm-cost';
import { costUsd } from '../llm-cost-core';
import { buildAskPrompt } from '../readmission-prompts';
import type { StayBillBreakdown } from './db13';
import type { toFinding } from './surface-row';
import { chipText, coverageChips, judgementLabel, justificationCell, returnStayBill, type FindingBlob } from '../readmission-surface-core';
import { renderableNarrative, NARRATIVE_MODEL_ID, NARRATIVE_PROVIDER, type CaseArtefacts } from '../readmission-narrative-core';
import {
  askVerdict, parseAskReply, ASK_BUDGET_MS, ASK_MAX_TOKENS, ASK_MAX_TRIES, ASK_TEMPERATURE,
  type AskMaterial, type AskTurn, type AskVerdict,
} from '../readmission-ask-core';

export const ASK_STAGE = 'readmit_ask';

/** The material the model may see — from the pinned row's STORED artefacts + the two bills. Pure. */
export function askMaterialFrom(row: ReturnType<typeof toFinding>, blob: (FindingBlob & CaseArtefacts) | null, indexBill: StayBillBreakdown | null, readmitBill: StayBillBreakdown | null): AskMaterial {
  const narrative = renderableNarrative(blob?.caseNarrative ?? null);
  return {
    ledger: (blob?.evidenceLedger?.items ?? [])
      .filter((i): i is typeof i & { id: string } => typeof i.id === 'string' && i.id !== '')
      .map((i) => ({ id: i.id, source: String(i.source ?? 'unknown'), side: i.side ?? null, at: i.at ?? null, weight: String(i.weight ?? 'unweighted'), text: String(i.text ?? '') })),
    account: narrative?.text ?? null,
    judgements: {
      planned: row.planned ?? blob?.planned?.verdict ?? null,
      sameCondition: row.sameCondition ?? blob?.sameCondition?.verdict ?? null,
      justification: justificationCell(row),
      preventableInjury: judgementLabel(row.preventableInjury),
      negligence: judgementLabel(row.negligence),
      findingClass: row.findingClass, lane: row.lane, gapDays: row.gapDays,
    },
    coverage: coverageChips(row).map((c) => ({ label: c.label, state: chipText(c) === c.label ? c.state : chipText(c) })),
    bills: { index: indexBill, readmit: readmitBill, returnCell: returnStayBill(row) },
    refusals: (blob?.refusalRecord ?? []).filter((r) => r.found === false).map((r) => ({ lookedFor: r.lookedFor ?? 'unknown', ...(r.note ? { note: r.note } : {}) })),
  };
}

export interface AskAnswer {
  outcome: 'answered' | 'withheld';
  verdict: AskVerdict | null;
  reason?: string;
  answerable?: boolean;
  cost: { tokensIn: number; tokensOut: number; usd: number; model: string; provider: string } | null;
  traceId: string;
  latencyMs: number;
  /** Test / dry-run seam: the prompt as sent. */
  prompt?: { system: string; user: string };
}

/**
 * ONE question → ONE Opus call → CODE DECIDES. Never throws: a model fault is a withheld answer.
 * `call` is a test seam (production never passes it).
 */
export async function answerCaseQuestion(a: {
  dedupKey: string; material: AskMaterial; history: readonly AskTurn[]; question: string;
  call?: (prompt: { system: string; user: string }) => Promise<string>;
}): Promise<AskAnswer> {
  const t0 = Date.now();
  const ledgerIds = a.material.ledger.map((i) => i.id);
  const prompt = buildAskPrompt(a.material, a.history, a.question);
  const traceId = a.call ? 'test-trace' : await startTrace(ASK_STAGE, { dedupKey: a.dedupKey, model: `bedrock:${NARRATIVE_MODEL_ID}`, turns: a.history.length });
  let text = '';
  try {
    if (a.call) text = await a.call(prompt);
    else {
      const res = await tracedChat(traceId, ASK_STAGE, {
        model: TEXT_MODEL,   // nominal — the bedrock target outranks it and has no ladder
        messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        temperature: ASK_TEMPERATURE,
        max_tokens: ASK_MAX_TOKENS,
      }, { bedrock: NARRATIVE_MODEL_ID, timeoutMs: ASK_BUDGET_MS, maxTries: ASK_MAX_TRIES });
      text = String(res?.choices?.[0]?.message?.content ?? '');
    }
  } catch (e) {
    if (!a.call) await finishTrace(traceId, 'error', String((e as Error).message).slice(0, 300)).catch(() => {});
    return { outcome: 'withheld', verdict: null, reason: 'model_unavailable', cost: null, traceId, latencyMs: Date.now() - t0, ...(a.call ? { prompt } : {}) };
  }
  let cost: AskAnswer['cost'] = null;
  if (!a.call) {
    const served = await servedCallForAudit(traceId, ASK_STAGE);
    if (served.model && !modelsAgree(served.model, NARRATIVE_MODEL_ID)) {
      await finishTrace(traceId, 'error', 'DEC-2 model disagreement').catch(() => {});
      return { outcome: 'withheld', verdict: null, reason: 'model_disagreement', cost: null, traceId, latencyMs: Date.now() - t0 };
    }
    const usage = await usageForTrace(traceId, ASK_STAGE);
    cost = { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, usd: Number(costUsd(served.model ?? NARRATIVE_MODEL_ID, usage.tokensIn, usage.tokensOut, false, PRICING).toFixed(4)), model: served.model ?? NARRATIVE_MODEL_ID, provider: served.provider ?? NARRATIVE_PROVIDER };
  }
  const parsed = parseAskReply(text);
  const verdict = askVerdict(parsed, ledgerIds);
  if (!a.call) await finishTrace(traceId, verdict.ok ? 'success' : 'partial', verdict.ok ? undefined : `answer withheld: ${verdict.reason}`).catch(() => {});
  if (!verdict.ok) return { outcome: 'withheld', verdict, reason: verdict.reason ?? 'unresolved', cost, traceId, latencyMs: Date.now() - t0, ...(a.call ? { prompt } : {}) };
  return { outcome: 'answered', verdict, answerable: parsed?.answerable !== false, cost, traceId, latencyMs: Date.now() - t0, ...(a.call ? { prompt } : {}) };
}
