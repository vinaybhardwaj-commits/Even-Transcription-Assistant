/**
 * lib/preop/suggest.ts — B8b's IMPURE half: read the document THREE times at temperature 0,
 * read back what actually served, hand the three reads to the pure reconciler.
 *
 * Provider posture unchanged from B5 (the ClinicalState rail's: governedChat with the Gemini
 * surface model and its Vertex→OpenRouter ladder, `noLocalFallback` so a cloud failure
 * throws rather than quietly becoming a local mini). What changed is the number of reads and
 * what is done with them.
 *
 * WHY THREE READS COST ALMOST NOTHING. The anti-flap rail keys the whole record on the
 * fingerprint of its SOURCE TEXT, so the reads happen once per content change — not once per
 * sweep, not once per tick. A PAC that landed last week and has not been edited since costs
 * one string comparison forever. B7 measured the single-read leg at 4.5–8 s with the
 * reasoning cap; three of them, on a document that has genuinely just changed, is ~20 s
 * against a 60 s per-episode ceiling.
 *
 * AND WHY THREE READS AT ALL. B7 measured 40% self-disagreement on identical text at
 * temperature 0. One read cannot see that; three can. A rail that knows it disagreed with
 * itself can say so on the card instead of picking a winner.
 */

import { governedChat, startTrace, finishTrace } from '../trace';
import { servedCallForAudit } from '../backfill-runs';
import { geminiModelFor, geminiUtilityModel, TEXT_MODEL } from '../llm';
import {
  buildExtractPrompt, extractionSourceFingerprint, hasExtractableText, parseExtractOutput,
  verifyExtraction, EXTRACT_SOURCE_FIELDS,
  type VerifyResult,
} from '../preop-extract-core';
import {
  parseExtractMode, reconcileReads, PREOP_SUGGEST_RULE_VERSION, SUGGEST_TARGETS,
  type PreopExtractMode, type PreopSuggestionRecord,
} from '../preop-suggest-core';
import type { ParsedPac } from '../preop-pac-map-core';

export const PREOP_SUGGEST_STAGE = 'preop_suggest';
/** One try per read, and a ceiling that leaves room for three inside the per-episode box. */
export const PREOP_SUGGEST_READ_BUDGET_MS = 45_000;
export const PREOP_SUGGEST_MAX_TRIES = 1;
/** THREE. Named rather than inlined, because the whole rail's meaning depends on it. */
export const PREOP_SUGGEST_READS = 3;
/** The per-episode ceiling the sweep checks before starting the leg. */
export const PREOP_SUGGEST_BUDGET_MS = PREOP_SUGGEST_READ_BUDGET_MS * PREOP_SUGGEST_READS;

/** See lib/preop-extract-core.ts — the same cap, and the same measured reason for it. */
export const PREOP_SUGGEST_THINKING_BUDGET = Number(process.env.PREOP_EXTRACT_THINKING) || 512;

/**
 * `PREOP_EXTRACT_MODE` — off (default) | suggest | score. Replaces the B5 boolean, which was
 * never set in any environment, so there is nothing to migrate. Anything unrecognised reads
 * as OFF: a clinical rail must never be switched on by a typo.
 */
export function preopExtractMode(): PreopExtractMode {
  return parseExtractMode(process.env.PREOP_EXTRACT_MODE);
}

export function preopSuggestModel(): string | undefined {
  return geminiModelFor('preop_extract') ?? geminiModelFor('ccb') ?? geminiUtilityModel();
}

/**
 * The verbatim PAC boxes the rail reads. B8a dropped `opd_narrative` on its own measurement
 * (0/855 and 1/855 across the cohort), so the list is the PAC's own prose and nothing else.
 */
export function preopSuggestFields(parsedPac: ParsedPac | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of EXTRACT_SOURCE_FIELDS) {
    if (f.id === 'opd_narrative') continue;
    const v = parsedPac?.fields?.[f.id]?.text;
    if (typeof v === 'string' && v.trim()) out[f.id] = v.trim();
  }
  return out;
}

export type SuggestCall = (prompt: { system: string; user: string }, read: number) => Promise<string>;

async function geminiRead(traceId: string, prompt: { system: string; user: string }): Promise<string> {
  const r = await governedChat(traceId, PREOP_SUGGEST_STAGE, {
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }],
    temperature: 0,
    max_tokens: 1600,
    ...(preopSuggestModel() ? { google: { thinking_config: { thinking_budget: PREOP_SUGGEST_THINKING_BUDGET } } } : {}),
  }, {
    gemini: preopSuggestModel(),
    promptRef: 'preop-extract/EXTRACT_SYSTEM',
    timeoutMs: PREOP_SUGGEST_READ_BUDGET_MS,
    maxTries: PREOP_SUGGEST_MAX_TRIES,
    noLocalFallback: true,
  });
  return String(r?.choices?.[0]?.message?.content ?? '');
}

export interface SuggestOneResult {
  /** 'reused' means NO MODEL RAN — the stored record answered for unchanged source text */
  outcome: 'reused' | 'no_text' | 'fresh' | 'failed';
  record: PreopSuggestionRecord | null;
  changed: boolean;
  reads: number;
  latencyMs: number;
  error?: string;
}

/**
 * One episode's suggestions. The fingerprint is compared BEFORE anything is called, so the
 * common case — a PAC that landed last week — costs one string comparison and no tokens.
 *
 * A read that fails does not fail the episode: the surviving reads still reconcile, and the
 * record says how many there were. Two unanimous reads are a weaker signal than three and
 * the agreement field says so.
 */
export async function suggestOne(a: {
  episodeKey: string;
  fields: Record<string, string>;
  stored: PreopSuggestionRecord | null;
  now: Date;
  call?: SuggestCall;
}): Promise<SuggestOneResult> {
  const t0 = Date.now();
  const none = { record: a.stored, changed: false, reads: 0 };
  if (!hasExtractableText(a.fields)) return { outcome: 'no_text', ...none, latencyMs: 0 };

  const fp = extractionSourceFingerprint(a.fields);
  if (a.stored && a.stored.sourceFingerprint === fp && a.stored.version === PREOP_SUGGEST_RULE_VERSION) {
    return { outcome: 'reused', ...none, latencyMs: 0 };
  }

  const prompt = buildExtractPrompt(a.fields, SUGGEST_TARGETS);
  const verified: VerifyResult[] = [];
  const traceIds: string[] = [];
  const errors: string[] = [];
  let model: string | null = null;
  let provider: string | null = null;

  for (let i = 0; i < PREOP_SUGGEST_READS; i++) {
    const traceId = await startTrace('preop_suggest', { episodeKey: a.episodeKey, read: i + 1, fields: Object.keys(a.fields) });
    traceIds.push(traceId);
    try {
      const raw = await (a.call ? a.call(prompt, i + 1) : geminiRead(traceId, prompt));
      verified.push(verifyExtraction(parseExtractOutput(raw), a.fields));
      if (!a.call) {
        const served = await servedCallForAudit(traceId, PREOP_SUGGEST_STAGE);
        // The label is DERIVED, and the FIRST served label wins: if a later read came back
        // from something else, that is a fault to report, not a record to average.
        if (served.model && !model) { model = served.model; provider = served.provider; }
        else if (served.model && model && served.model !== model) {
          errors.push(`read ${i + 1} served by ${served.provider ?? '?'}:${served.model}, not ${model}`);
        }
      }
      await finishTrace(traceId, 'success');
    } catch (e) {
      errors.push(`read ${i + 1}: ${String((e as Error).message).slice(0, 200)}`);
      await finishTrace(traceId, 'error', String((e as Error).message).slice(0, 300));
    }
  }

  if (!verified.length) {
    return { outcome: 'failed', ...none, reads: 0, latencyMs: Date.now() - t0, error: errors.join(' | ').slice(0, 300) };
  }

  const { suggestions, dropped } = reconcileReads(verified);
  const record: PreopSuggestionRecord = {
    version: PREOP_SUGGEST_RULE_VERSION,
    sourceFingerprint: fp,
    generatedAt: a.now.toISOString(),
    model, provider, traceIds,
    readCount: verified.length,
    suggestions, dropped,
    fieldsSeen: Object.keys(a.fields).filter((k) => a.fields[k]?.trim()),
  };
  return {
    outcome: 'fresh', record, changed: true, reads: verified.length,
    latencyMs: Date.now() - t0,
    ...(errors.length ? { error: errors.join(' | ').slice(0, 300) } : {}),
  };
}
