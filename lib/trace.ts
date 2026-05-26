import { randomUUID } from 'crypto';
import { sql } from './db';
import { llm } from './llm';

const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;

export async function startTrace(feature: string, input: unknown, userId: number = 1, meta?: unknown): Promise<string> {
  const traceId = randomUUID();
  try {
    await sqlFn(
      `INSERT INTO traces (trace_id, user_id, feature, input, status, meta) VALUES ($1, $2, $3, $4::jsonb, 'running', $5::jsonb)`,
      [traceId, userId, feature, JSON.stringify(input ?? null), meta ? JSON.stringify(meta) : null]
    );
  } catch {
    // Tracing must never break the actual request
  }
  return traceId;
}

export async function logEvent(
  traceId: string,
  kind: string,
  stage: string | null,
  payload: unknown,
  latencyMs?: number
): Promise<void> {
  try {
    await sqlFn(
      `INSERT INTO trace_events (trace_id, seq, kind, stage, payload, latency_ms)
       VALUES ($1, COALESCE((SELECT MAX(seq) + 1 FROM trace_events WHERE trace_id = $1), 1), $2, $3, $4::jsonb, $5)`,
      [traceId, kind, stage, JSON.stringify(payload ?? null), latencyMs ?? null]
    );
  } catch {}
}

export async function finishTrace(
  traceId: string,
  status: 'success' | 'error' | 'partial',
  errorMessage?: string
): Promise<void> {
  try {
    await sqlFn(
      `UPDATE traces SET finished_at = NOW(), status = $1, error_message = $2,
       total_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000 WHERE trace_id = $3`,
      [status, errorMessage ?? null, traceId]
    );
  } catch {}
}

// Wraps llm.chat.completions.create with automatic event logging.
// Logs: model, full prompt (messages), full response content, token usage, finish_reason, latency.
// Returns the original response so callers can use it normally.
// Use 'any' for params/return because the OpenAI SDK's overload-based types conflict with
// Ollama-specific extra fields (options, keep_alive) and our streaming/non-streaming union.
// Callers know their own use case and cast accordingly.
export async function tracedChat(
  traceId: string,
  label: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const t0 = Date.now();
  // Log the request before firing
  const requestPayload = {
    model: (params as { model?: string }).model,
    messages: (params as { messages?: unknown }).messages,
    temperature: (params as { temperature?: number }).temperature,
    max_tokens: (params as { max_tokens?: number }).max_tokens,
    stream: (params as { stream?: boolean }).stream ?? false,
    options: (params as Record<string, unknown>).options,
    keep_alive: (params as Record<string, unknown>).keep_alive,
  };
  await logEvent(traceId, 'llm_request', label, requestPayload);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  try {
    result = await llm.chat.completions.create(params);
  } catch (e) {
    await logEvent(traceId, 'llm_error', label, {
      model: requestPayload.model,
      error: String((e as Error).message),
      stack: (e as Error).stack?.slice(0, 2000),
    }, Date.now() - t0);
    throw e;
  }

  // For non-streaming responses, log the full content + usage
  if (!('controller' in result)) {
    const r = result as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: unknown };
    await logEvent(traceId, 'llm_response', label, {
      model: requestPayload.model,
      content: r.choices?.[0]?.message?.content ?? '',
      finish_reason: r.choices?.[0]?.finish_reason,
      usage: r.usage,
    }, Date.now() - t0);
  } else {
    // For streaming, the caller will collect tokens and should call logStreamComplete after
    await logEvent(traceId, 'llm_response_stream_started', label, {
      model: requestPayload.model,
    }, Date.now() - t0);
  }

  return result;
}

// Used by streaming endpoints to log the assembled response after consuming the stream.
export async function logStreamComplete(
  traceId: string,
  label: string,
  fullContent: string,
  startMs: number,
  meta?: Record<string, unknown>
): Promise<void> {
  await logEvent(traceId, 'llm_response_stream_complete', label, {
    content: fullContent,
    char_count: fullContent.length,
    ...(meta || {}),
  }, Date.now() - startMs);
}
