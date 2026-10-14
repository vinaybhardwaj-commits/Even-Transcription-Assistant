/**
 * lib/lab-v2/transport.ts — the model transport seam (LAB-MCP-V2-PRD-v1.0 §6.2, §14.1).
 *
 * One interface, two implementations. `liveTransport` is the real thing and goes through
 * `governedLabChat` in lib/trace.ts — never a provider SDK directly, both because
 * scripts/reasoning-governance-check.mjs hard-fails an ungoverned call site and because
 * attribution must come from the ONE existing mechanism.
 *
 * `fixtureTransport` is what the tests run on. It is not a convenience: §15 has to prove
 * that a mismatched served model is caught, that a transport error moves money to
 * `unknown`, and that a stored result survives an invalid attribution — none of which can
 * be provoked against a real provider on demand. The two named fixture models exist for
 * exactly those cases:
 *   · `fixture-fail`     — throws, with no usage. Drives the unknown-cost path.
 *   · `fixture-mismatch` — succeeds but reports a DIFFERENT served model. Drives §6.2.
 */
import { governedLabChat, readTransportAttribution } from '../trace';
import type { Provider } from './contracts';

export interface TransportRequest {
  provider: Provider;
  model: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * §6.2 / fix 26a — the token counts behind a call's cost, stored ON the served receipt.
 * `usage_missing` is a POSITIVE statement, not an absence: a provider that returned no usage is a
 * different fact from one we forgot to record, and only the first is acceptable.
 */
export interface ServedUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens?: number | null;
  usage_missing?: true;
}

export interface Served { provider: string; model: string | null; options: Record<string, unknown>; usage: ServedUsage }

export interface TransportResult {
  completion: unknown;
  /** What actually served the call, read off the transport receipt. Null = no receipt. */
  served: Served | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  text: string;
}

export type Transport = (req: TransportRequest) => Promise<TransportResult>;

/** Pull the usage block out of an OpenAI-shaped completion, tolerating its absence. */
function usageOf(completion: unknown): { input_tokens: number; output_tokens: number } | null {
  const u = (completion as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u) return null;
  const inTok = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const outTok = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  if (!Number.isFinite(inTok) || !Number.isFinite(outTok)) return null;
  return { input_tokens: inTok, output_tokens: outTok };
}

/**
 * Fix 26a — the usage block in the shape §17.2 names, read from the completion rather than from
 * the attribution receipt. `readTransportAttribution` carries dispatch evidence only
 * (`dispatched_provider`, `dispatched_model`, `cloud_response_received`); the token counts have
 * always been on the completion's own `usage`, which is why round 1 stored none.
 * Reasoning tokens live under `completion_tokens_details` on the OpenAI shape and sometimes at
 * the top level, so both are read.
 */
export function servedUsage(completion: unknown): ServedUsage {
  const u = (completion as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u) return { prompt_tokens: null, completion_tokens: null, usage_missing: true };
  const details = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const reasoning = details.reasoning_tokens ?? u.reasoning_tokens;
  const prompt = Number(u.prompt_tokens ?? u.input_tokens);
  const completion_tokens = Number(u.completion_tokens ?? u.output_tokens);
  const out: ServedUsage = {
    prompt_tokens: Number.isFinite(prompt) ? prompt : null,
    completion_tokens: Number.isFinite(completion_tokens) ? completion_tokens : null,
  };
  if (reasoning != null && Number.isFinite(Number(reasoning))) out.reasoning_tokens = Number(reasoning);
  if (out.prompt_tokens === null && out.completion_tokens === null) out.usage_missing = true;
  return out;
}

function textOf(completion: unknown): string {
  const c = completion as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = c?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

export const liveTransport: Transport = async (req) => {
  const completion = await governedLabChat(req.provider, req.model, req.params, req.timeoutMs, req.signal);
  const receipt = readTransportAttribution(completion);
  return {
    completion,
    // No receipt is a REAL state, not a failure (§6.2) — it becomes attribution 'unknown'
    // rather than being papered over with the requested values, which would make every
    // unattributed call look verified.
    served: receipt
      ? {
        provider: receipt.dispatched_provider,
        model: receipt.dispatched_model,
        options: { cloud_response_received: receipt.cloud_response_received },
        usage: servedUsage(completion),
      }
      : null,
    usage: usageOf(completion),
    text: textOf(completion),
  };
};

export interface FixtureOptions {
  /** Text the fixture returns for a normal model. */
  reply?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Deterministic in-process transport. No network, no clock dependence. */
export function fixtureTransport(opts: FixtureOptions = {}): Transport {
  const reply = opts.reply ?? '{"findings":[],"pdqi9":null}';
  const inputTokens = opts.inputTokens ?? 1000;
  const outputTokens = opts.outputTokens ?? 200;
  return async (req) => {
    if (req.signal?.aborted) throw new Error('aborted');
    if (req.model === 'fixture-fail') {
      // A transport error with NO usage — §6.3's unknown-cost path.
      throw new Error('fixture transport failure (no usage)');
    }
    const completion = { choices: [{ message: { content: reply } }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } };
    const servedModel = req.model === 'fixture-mismatch' ? 'some-other-model' : req.model;
    return {
      completion,
      served: { provider: req.provider, model: servedModel, options: {}, usage: servedUsage(completion) },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      text: reply,
    };
  };
}
