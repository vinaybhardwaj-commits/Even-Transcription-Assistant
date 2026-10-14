/**
 * lib/ml-label-trial/client.ts — the one model call the trial makes, via OpenRouter (a provider
 * already approved for audit content — ruling §4 PHI boundary; this is not a new exposure class).
 *
 * D7 — the model is a RUNTIME PARAMETER; there is no default here or anywhere in the metric path.
 * `label_source` is built from the id the PROVIDER RETURNS, never from the request: a silent
 * server-side alias re-route would otherwise stamp labels with a model that never produced them.
 *
 * D12 — temperature is pinned to 0 and the response records whether the provider echoed it. That
 * is NOT a determinism claim: this programme has measured that temperature 0 does not deliver
 * reproducibility. D6's two passes are what actually test it.
 *
 * Deliberately NOT openRouterGenerate: that seam carries the eval audit's pinned thinking budgets,
 * retry semantics and envelope instrumentation. This is a closed single-turn classification call
 * with strict parsing one layer up; sharing the seam would entangle two instruments.
 */
import { TRIAL_PROMPT_VERSION } from './core';

export interface TrialCallResult {
  raw: string;                    // the model's text, handed to parseLabelResponse upstream
  labelSource: string;            // model:<resolved-id>@<prompt-version>  (D7)
  resolvedModel: string;          // from the RESPONSE; 'unresolved' if the provider omits it
  temperatureHonoured: boolean | null;   // null = provider silent on it
  usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null;
  error?: string;                 // transport/HTTP failure — the caller records, never retries into coercion
}

export async function trialLabelCall(
  model: string, system: string, user: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TrialCallResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { raw: '', labelSource: 'unresolved', resolvedModel: 'unresolved', temperatureHonoured: null, usage: null, error: 'OPENROUTER_API_KEY is not set' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    let res: Response;
    try {
      res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0,
          max_tokens: 400,
          usage: { include: true },
        }),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { raw: '', labelSource: 'unresolved', resolvedModel: 'unresolved', temperatureHonoured: null, usage: null, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const j = (await res.json().catch(() => null)) as {
      model?: unknown;
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    } | null;
    if (!j) return { raw: '', labelSource: 'unresolved', resolvedModel: 'unresolved', temperatureHonoured: null, usage: null, error: 'empty/unparseable response body' };
    const raw = j.choices?.[0]?.message?.content ?? '';
    // D7 — the id from the RESPONSE, never assumed from the request.
    const resolvedModel = typeof j.model === 'string' && j.model ? j.model : 'unresolved';
    return {
      raw: String(raw),
      labelSource: `model:${resolvedModel}@${TRIAL_PROMPT_VERSION}`,
      resolvedModel,
      // OpenRouter does not echo the effective temperature; recording that honestly (D12).
      temperatureHonoured: null,
      usage: j?.usage ?? null,
    };
  } catch (e) {
    return { raw: '', labelSource: 'unresolved', resolvedModel: 'unresolved', temperatureHonoured: null, usage: null, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
