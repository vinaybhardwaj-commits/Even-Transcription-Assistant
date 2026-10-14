/**
 * lib/preop/narrative.ts — the narrative rail's IMPURE half (Build Plan B6): build the
 * fact list from the COMPUTED SNAPSHOT, make ONE Opus-4.6-on-Bedrock call, read back what
 * served, hand the reply to the pure validator. Every decision lives in
 * lib/preop-narrative-core.ts.
 *
 * CALLED FROM THE SWEEP ONLY, never from a page request — the page renders what the sweep
 * stored, exactly as the readmit case page does. That is not a performance choice: a page
 * that could generate prose on load would produce a different paragraph for two readers
 * looking at the same reading.
 *
 * WHEN IT RUNS: only when a snapshot version actually minted, i.e. when the live row's
 * fingerprint moved. A sweep over a board that has not changed makes zero calls, and a
 * narrative whose stored fingerprint no longer matches the row is simply not rendered
 * (narrativeRenderable) rather than being silently shown against a newer score.
 *
 * DEC-2, kept: `bedrock` outranks everything in tracedChat and has no ladder behind it, so
 * a Bedrock failure is terminal rather than a quiet downgrade — and the model that ANSWERED
 * is read back off the trace. If the answer came from anything other than the model we
 * asked for, NOTHING IS STORED. A disagreement is a refusal, never a correction.
 */

import { tracedChat, startTrace, finishTrace } from '../trace';
import { servedCallForAudit } from '../backfill-runs';
import { modelsAgree, TEXT_MODEL } from '../llm';
import {
  buildNarrativeFacts, buildNarrativePrompt, buildPreopNarrative, parseNarrativeOutput,
  PREOP_NARRATIVE_BUDGET_MS, PREOP_NARRATIVE_MAX_TRIES, PREOP_NARRATIVE_MODEL_ID,
  PREOP_NARRATIVE_PROVIDER,
  type PreopNarrative,
} from '../preop-narrative-core';
import type { PreopSnapshot } from '../preop-assemble-core';

export const PREOP_NARRATIVE_STAGE = 'preop_narrative';

/** PREOP_NARRATIVE_ENABLED (PRD §7). Ships OFF. */
export function preopNarrativeEnabled(): boolean {
  return process.env.PREOP_NARRATIVE_ENABLED === '1';
}

export type NarrativeCall = (prompt: { system: string; user: string }) => Promise<string>;

async function opusCall(traceId: string, prompt: { system: string; user: string }): Promise<string> {
  const r = await tracedChat(traceId, PREOP_NARRATIVE_STAGE, {
    model: TEXT_MODEL,                 // nominal — the bedrock target outranks it, no ladder
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0.2,
    max_tokens: 900,
  }, {
    bedrock: PREOP_NARRATIVE_MODEL_ID,
    timeoutMs: PREOP_NARRATIVE_BUDGET_MS,
    maxTries: PREOP_NARRATIVE_MAX_TRIES,
    noLocalFallback: true,
  });
  return String(r?.choices?.[0]?.message?.content ?? '');
}

export interface NarrateResult {
  ok: boolean;
  narrative: PreopNarrative | null;
  reason?: string;
  latencyMs: number;
  called: boolean;
}

/**
 * One episode's narrative. An INVALID narrative is still returned and still stored — the
 * R4-4 contract: kept for review, never rendered. What is NOT stored is a narrative from
 * the wrong model, or from no model at all.
 */
export async function narrateOne(a: {
  snapshot: PreopSnapshot;
  now: Date;
  /** test seam — production never passes it */
  call?: NarrativeCall;
}): Promise<NarrateResult> {
  const t0 = Date.now();
  const facts = buildNarrativeFacts(a.snapshot);
  const prompt = buildNarrativePrompt(facts);
  const traceId = await startTrace('preop_narrative', {
    episodeKey: a.snapshot.episodeKey, fingerprint: a.snapshot.fingerprint, facts: facts.length,
  });

  let raw: string;
  try {
    raw = await (a.call ? a.call(prompt) : opusCall(traceId, prompt));
  } catch (e) {
    await finishTrace(traceId, 'error', String((e as Error).message).slice(0, 300));
    return { ok: false, narrative: null, reason: `narrative leg failed: ${String((e as Error).message).slice(0, 300)}`, latencyMs: Date.now() - t0, called: true };
  }

  // What actually served — read back, never assumed. A disagreement stores nothing.
  const served = a.call
    ? { model: null, provider: null }
    : await servedCallForAudit(traceId, PREOP_NARRATIVE_STAGE);
  if (!a.call && served.model && !modelsAgree(served.model, PREOP_NARRATIVE_MODEL_ID)) {
    await finishTrace(traceId, 'partial', 'DEC-2 model disagreement');
    return {
      ok: false, narrative: null, called: true, latencyMs: Date.now() - t0,
      reason: `DEC-2: asked ${PREOP_NARRATIVE_MODEL_ID} but ${served.provider ?? '?'}:${served.model} answered — nothing stored`,
    };
  }

  const narrative = buildPreopNarrative({
    text: parseNarrativeOutput(raw),
    facts,
    snapshotFingerprint: a.snapshot.fingerprint,
    generatedAt: a.now.toISOString(),
    model: served.model, provider: served.provider ?? (a.call ? null : PREOP_NARRATIVE_PROVIDER),
    traceId,
  });
  await finishTrace(traceId, narrative.valid ? 'success' : 'partial', narrative.valid ? undefined : narrative.invalidReason);
  return { ok: true, narrative, latencyMs: Date.now() - t0, called: true };
}
