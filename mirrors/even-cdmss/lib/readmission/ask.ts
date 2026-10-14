/**
 * lib/readmission/ask.ts — R4.3 "ask the agent", the IMPURE half (CDMSS-READMISSIONS-R4.3-PRD v1.0
 * R43-1..R43-8): the case MATERIAL assembled from STORED artefacts + the two bills the case page
 * already reads, and ONE Opus-4.6-on-Bedrock call whose answer is checked by code (askVerdict, the
 * same citation validator that guards narratives) before anything is returned. Called by
 * app/api/care/readmissions/ask/route.ts and by the dry-run script; never from a page render.
 *
 * THE FENCE: no re-audit, no regeneration, no db13 read beyond the case route's set. PHI (R43-8): no
 * identity is passed to the model — the material is de-identified by construction.
 *
 * R10-B (CDMSS-READMISSIONS-R10-RECORD-REACH PRD §4, R10-D5/D6/D9) MOVES THE FENCE — it does not
 * remove it. The agent may now reach the patient's OTHER records through one capped Converse tool
 * (`fetch_record`, ≤ RECORD_FETCH_MAX per question, plus a wall budget), and it still may not assert
 * anything it cannot cite: retrieved artefacts cite in a SECOND namespace (`X…`) that `askVerdict`
 * resolves against what the thread actually holds. Everything else is untouched — the same single
 * Opus-4.6-on-Bedrock target, no ladder, no fallback (F11), the same citation gate, and a file that
 * still writes nothing (the route stores both the turns and the retrieved artefacts).
 *
 * ⚠️ NO REACH ⇒ NO TOOL. A deployment (or a patient) with nothing reachable declares no toolConfig
 * and takes the R9 call path byte for byte. An agent that cannot reach the record must not be told
 * it can, and a fence that only sometimes exists is worse than one that never did.
 *
 * R9: the conversation is no longer ephemeral, and this file still writes NOTHING. It gained exactly
 * one field — `overlayRaw`, the model's un-gated report of what the care manager just stated. Gating
 * it (readmission-ask-core.gateOverlay) and storing it (readmission/ask-store) both happen in the
 * route. Keeping the model call free of storage is what lets the answer path stay identical to R4.3's:
 * one Opus call, one citation verdict, a fault is a withheld answer and never a throw.
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
  askVerdict, parseAskReply, parseAskOverlay, parseFetchRecordArgs, loopExhaustedCopy, renderRecordIndex,
  unknownRecordCopy,
  ASK_BUDGET_MS, ASK_MAX_TOKENS, ASK_MAX_TRIES, ASK_TEMPERATURE, ASK_TOOL_CALL_BUDGET_MS,
  ASK_TOOL_TOTAL_BUDGET_MS, FETCH_RECORD_INPUT_SCHEMA, FETCH_RECORD_TOOL_DESCRIPTION,
  FETCH_RECORD_TOOL_NAME, RECORD_FETCH_MAX, RECORD_HELD_IN_PROMPT_MAX,
  type AskMaterial, type AskTurn, type AskVerdict, type RetrievedArtefact,
} from '../readmission-ask-core';
import { toolCallsOf, type ChatCompletionLike, type ConverseContentBlock, type ConverseToolConfig } from '../bedrock';
import type { RecordReach } from './records';

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

/** R10-B — the ONE tool. Declared from the pure constants so the prompt's description of it and the
 *  schema the model is handed cannot drift apart. */
export const FETCH_RECORD_TOOL_CONFIG: ConverseToolConfig = {
  tools: [{
    toolSpec: {
      name: FETCH_RECORD_TOOL_NAME,
      description: FETCH_RECORD_TOOL_DESCRIPTION,
      inputSchema: { json: FETCH_RECORD_INPUT_SCHEMA },
    },
  }],
};

export interface AskAnswer {
  outcome: 'answered' | 'withheld';
  verdict: AskVerdict | null;
  reason?: string;
  answerable?: boolean;
  cost: { tokensIn: number; tokensOut: number; usd: number; model: string; provider: string } | null;
  traceId: string;
  latencyMs: number;
  /** R9 — the model's RAW overlay report, exactly as it sent it, gated by the caller and by nothing
   *  here. Present even when the answer was withheld: the two decisions are independent, and a care
   *  manager's stated judgement should not be lost because the agent miscited its reply. */
  overlayRaw?: unknown;
  /** Test / dry-run seam: the prompt as sent. */
  prompt?: { system: string; user: string };
  /** R10-B — what the tool loop actually did: the artefacts fetched THIS turn (already de-identified
   *  and already persisted by the caller), how many fetches were spent, and whether the cap or the
   *  wall stopped it. The route renders these as evidence chips and stores them. */
  retrieved?: RetrievedArtefact[];
  fetches?: number;
  loopExhausted?: boolean;
}

/**
 * ONE question → ONE Opus call → CODE DECIDES. Never throws: a model fault is a withheld answer.
 * `call` is a test seam (production never passes it).
 *
 * R10-B adds an OPTIONAL `reach`. Absent, or offering nothing, and every line below is R9's exactly:
 * one call, `{ bedrock: NARRATIVE_MODEL_ID, timeoutMs: ASK_BUDGET_MS, maxTries: ASK_MAX_TRIES }`, no
 * toolConfig on the wire. Present, and the same single Opus target answers a CAPPED tool loop —
 * ≤ RECORD_FETCH_MAX fetches, a wall budget, and F11 unchanged: no ladder, no fallback, an unserved
 * call is a WITHHELD answer and never a degraded one.
 */
export async function answerCaseQuestion(a: {
  dedupKey: string; material: AskMaterial; history: readonly AskTurn[]; question: string;
  /** R10-B: the patient's other records. Omitted ⇒ the R9 path, byte for byte. */
  reach?: RecordReach | null;
  /** R10-B: artefacts already pulled into this thread — citable without being re-fetched (R10-D7). */
  held?: readonly RetrievedArtefact[];
  call?: (prompt: { system: string; user: string }) => Promise<string>;
}): Promise<AskAnswer> {
  const t0 = Date.now();
  const ledgerIds = a.material.ledger.map((i) => i.id);
  const held = [...(a.held ?? [])];
  const indexText = a.reach && a.reach.index.entries.length ? renderRecordIndex(a.reach.index) : '';
  const canFetch = indexText !== '';
  // Only the most recent RECORD_HELD_IN_PROMPT_MAX are re-shown in full; the rest stay CITABLE (see
  // `recordIds` below) and their absence from the prompt is stated rather than hidden.
  const shown = held.slice(-RECORD_HELD_IN_PROMPT_MAX);
  const prompt = buildAskPrompt(a.material, a.history, a.question, canFetch || held.length
    ? {
      index: indexText,
      retrieved: shown.map((r) => ({ id: r.id, label: r.label, date: r.date, text: r.text })),
      olderNotShown: held.length - shown.length,
    }
    : undefined);
  const traceId = a.call ? 'test-trace' : await startTrace(ASK_STAGE, { dedupKey: a.dedupKey, model: `bedrock:${NARRATIVE_MODEL_ID}`, turns: a.history.length });
  const fetched: RetrievedArtefact[] = [];
  let fetches = 0;
  let loopExhausted = false;
  let text = '';
  try {
    if (a.call) text = await a.call(prompt);
    else if (!canFetch) {
      const res = await tracedChat(traceId, ASK_STAGE, {
        model: TEXT_MODEL,   // nominal — the bedrock target outranks it and has no ladder
        messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
        temperature: ASK_TEMPERATURE,
        max_tokens: ASK_MAX_TOKENS,
      }, { bedrock: NARRATIVE_MODEL_ID, timeoutMs: ASK_BUDGET_MS, maxTries: ASK_MAX_TRIES });
      text = String(res?.choices?.[0]?.message?.content ?? '');
    } else {
      // ══ THE CAPPED TOOL LOOP (R10-D5) ═════════════════════════════════════════════════════════
      //
      // Converse's own turn-taking: the assistant's `toolUse` block is echoed back verbatim (its
      // toolUseId is what the answer is keyed on, so a text round-trip would lose it) and answered
      // with a `toolResult`. Every exit is an ANSWER, never an error:
      //   · the model stops asking            → its text is the answer;
      //   · the fetch cap is reached          → the last call is made with NO tools, so it must
      //                                         answer from what it holds, and the tool channel has
      //                                         already told it how many it read (acceptance #5);
      //   · the wall budget is reached        → the same forced final call;
      //   · an id is not in the index         → an honest refusal in the tool channel, and the model
      //                                         corrects itself inside the same turn.
      const turns: Array<{ role: 'user' | 'assistant'; content?: string; contentBlocks?: ConverseContentBlock[] }> = [
        { role: 'user', content: prompt.user },
      ];
      for (let round = 0; round <= RECORD_FETCH_MAX; round += 1) {
        const spent = Date.now() - t0;
        // Tools are offered only while there is BOTH a fetch left and time to use one.
        const offerTools = fetches < RECORD_FETCH_MAX && spent + ASK_TOOL_CALL_BUDGET_MS <= ASK_TOOL_TOTAL_BUDGET_MS;
        if (!offerTools && round > 0) loopExhausted = true;
        const res = (await tracedChat(traceId, ASK_STAGE, {
          model: TEXT_MODEL,   // nominal — the bedrock target outranks it and has no ladder
          messages: [{ role: 'system', content: prompt.system }, ...turns],
          temperature: ASK_TEMPERATURE,
          max_tokens: ASK_MAX_TOKENS,
          ...(offerTools ? { toolConfig: FETCH_RECORD_TOOL_CONFIG } : {}),
        }, { bedrock: NARRATIVE_MODEL_ID, timeoutMs: ASK_TOOL_CALL_BUDGET_MS, maxTries: ASK_MAX_TRIES })) as ChatCompletionLike;
        const calls = toolCallsOf(res);
        text = String(res?.choices?.[0]?.message?.content ?? '');
        if (!calls.length || !offerTools) break;   // it answered, or it may no longer ask
        // Echo the assistant's own tool turn, then answer every toolUse it raised.
        turns.push({ role: 'assistant', contentBlocks: res.converseContent ?? [] });
        const results: ConverseContentBlock[] = [];
        for (const c of calls) {
          if (fetches >= RECORD_FETCH_MAX) {
            loopExhausted = true;
            results.push({ toolResult: { toolUseId: c.id, content: [{ text: loopExhaustedCopy(fetches) }], status: 'success' } });
            continue;
          }
          const id = parseFetchRecordArgs(c.function?.arguments ?? null);
          if (!id) {
            results.push({ toolResult: { toolUseId: c.id, content: [{ text: unknownRecordCopy(String(c.function?.arguments ?? 'the id you sent')) }], status: 'error' } });
            continue;
          }
          fetches += 1;
          const r = await a.reach!.fetch(id);
          if (r.ok && r.artefact) {
            fetched.push(r.artefact);
            results.push({ toolResult: { toolUseId: c.id, content: [{ text: `[${r.artefact.id}] ${r.artefact.label}${r.artefact.date ? `, ${r.artefact.date}` : ''}\n${r.artefact.text}` }], status: 'success' } });
          } else {
            results.push({ toolResult: { toolUseId: c.id, content: [{ text: r.message }], status: 'error' } });
          }
        }
        turns.push({ role: 'user', contentBlocks: results });
      }
    }
  } catch (e) {
    if (!a.call) await finishTrace(traceId, 'error', String((e as Error).message).slice(0, 300)).catch(() => {});
    return { outcome: 'withheld', verdict: null, reason: 'model_unavailable', cost: null, traceId, latencyMs: Date.now() - t0, retrieved: fetched, fetches, loopExhausted, ...(a.call ? { prompt } : {}) };
  }
  let cost: AskAnswer['cost'] = null;
  if (!a.call) {
    const served = await servedCallForAudit(traceId, ASK_STAGE);
    if (served.model && !modelsAgree(served.model, NARRATIVE_MODEL_ID)) {
      await finishTrace(traceId, 'error', 'DEC-2 model disagreement').catch(() => {});
      return { outcome: 'withheld', verdict: null, reason: 'model_disagreement', cost: null, traceId, latencyMs: Date.now() - t0, retrieved: fetched, fetches, loopExhausted };
    }
    const usage = await usageForTrace(traceId, ASK_STAGE);
    cost = { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, usd: Number(costUsd(served.model ?? NARRATIVE_MODEL_ID, usage.tokensIn, usage.tokensOut, false, PRICING).toFixed(4)), model: served.model ?? NARRATIVE_MODEL_ID, provider: served.provider ?? NARRATIVE_PROVIDER };
  }
  const parsed = parseAskReply(text);
  const overlayRaw = parseAskOverlay(text);
  // R10-D6 — the SECOND namespace resolves against what this thread actually holds: artefacts
  // already persisted (`held`) plus the ones fetched in this very turn. An `X` id the model did not
  // fetch resolves to nothing and the answer is withheld, exactly like an invented ledger id.
  const recordIds = [...held.map((r) => r.id), ...fetched.map((r) => r.id)];
  const verdict = askVerdict(parsed, ledgerIds, recordIds);
  if (!a.call) await finishTrace(traceId, verdict.ok ? 'success' : 'partial', verdict.ok ? undefined : `answer withheld: ${verdict.reason}`).catch(() => {});
  const tail = { retrieved: fetched, fetches, loopExhausted };
  if (!verdict.ok) return { outcome: 'withheld', verdict, reason: verdict.reason ?? 'unresolved', cost, traceId, latencyMs: Date.now() - t0, overlayRaw, ...tail, ...(a.call ? { prompt } : {}) };
  return { outcome: 'answered', verdict, answerable: parsed?.answerable !== false, cost, traceId, latencyMs: Date.now() - t0, overlayRaw, ...tail, ...(a.call ? { prompt } : {}) };
}
