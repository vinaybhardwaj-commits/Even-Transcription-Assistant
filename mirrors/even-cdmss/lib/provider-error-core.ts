/**
 *   node --experimental-strip-types lib/provider-error-core.ts
 *
 * Provider-error observability (403-diagnosis kickoff, 30 Jul 2026) — PURE core.
 *
 * WHY: the only record of a Vertex failure was `String(e.message).slice(0, 200)` into a
 * console.warn nothing reads, followed by a silent Ollama fallback returning 200. Vertex's 403
 * body carries error.status, error.message and error.details[] — and the message is what
 * distinguishes an IAM denial from a quota denial from a disabled API. Truncating a diagnostic
 * to 200 characters was the defect; this core serialises the FULL error (generous 4000-char cap)
 * and counts provider calls in flight, so the load-correlation hypothesis (§3 of the kickoff)
 * becomes falsifiable: quota/rate limits are concurrency-sensitive, IAM denials are stateless.
 *
 * Observability only. No retry, no backoff, no routing — behaviour is unchanged everywhere.
 */

/** The diagnostic cap. 200 was the defect; do not replace it with a smaller number. */
export const PROVIDER_ERROR_CAP = 4000;

export interface SerializedProviderError {
  /** HTTP status from the SDK error (e.status on an OpenAI APIError), null if absent. */
  http_status: number | null;
  /** The body's error.status — e.g. PERMISSION_DENIED vs RESOURCE_EXHAUSTED. THE discriminator. */
  error_status: string | null;
  /** The body's error.code (numeric on Vertex), null if absent. */
  error_code: number | string | null;
  /** The FULL error message, capped at PROVIDER_ERROR_CAP — never 200. */
  message: string;
  /** error.details[] serialised verbatim (capped), null when the body carries none. */
  details: string | null;
}

const cap = (s: string): string => s.slice(0, PROVIDER_ERROR_CAP);

/**
 * Serialise a provider error without losing the body. Tolerates every shape seen in the wild:
 * an OpenAI-SDK APIError (`status` + `error` body), a Vertex REST body (`{ error: { code,
 * message, status, details } }`), a plain Error, or junk. Never throws.
 */
export function serializeProviderError(e: unknown): SerializedProviderError {
  const out: SerializedProviderError = { http_status: null, error_status: null, error_code: null, message: '', details: null };
  try {
    const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    // OpenAI APIError: .status is the HTTP status number.
    if (typeof o.status === 'number') out.http_status = o.status;
    // The body: APIError.error, or the object itself when a raw body was thrown. Vertex nests
    // { error: { code, message, status, details } }.
    let body = (o.error && typeof o.error === 'object' ? o.error : null) as Record<string, unknown> | null;
    if (body && body.error && typeof body.error === 'object') body = body.error as Record<string, unknown>;
    if (body) {
      if (typeof body.status === 'string') out.error_status = body.status;
      if (typeof body.code === 'number' || typeof body.code === 'string') out.error_code = body.code;
      if (Array.isArray(body.details) && body.details.length) {
        try { out.details = cap(JSON.stringify(body.details)); } catch { /* unserialisable — leave null */ }
      }
      // Prefer the body's own message — it is the IAM-vs-quota discriminator.
      if (typeof body.message === 'string' && body.message) out.message = cap(body.message);
    }
    if (!out.message) out.message = cap(String((o as { message?: unknown }).message ?? e ?? ''));
  } catch {
    try { out.message = cap(String(e)); } catch { out.message = 'unserialisable provider error'; }
  }
  return out;
}

// ── the 200-that-is-not-a-completion check (31 Jul 2026) ──────────────────────────────────────
//
// WHY: every guard built by the 403-diagnosis kickoff fires only on a THROWN exception. OpenRouter
// reports provider-side failures as HTTP 200 with an error object in the body, and the OpenAI SDK
// does not throw on a 200 — so an empty response entered no catch, emitted no provider_error, and
// returned a `result` whose content was undefined. The caller turned that into '' and reported
// "stage failed" while the trace showed a successful call. Measured 31 Jul: 1,523 of 3,963
// gemini-2.5-pro responses (38.4%) came back empty this way, and nothing captured a single body.
//
// This is the fourth instance of the same defect family — a value correct in one place and not
// read where it is used. The check below is what makes the class visible; it is NOT a remedy.

/** Finish reasons that describe a completion that actually finished. Anything else is a failure. */
export const USABLE_FINISH_REASONS: ReadonlySet<string> = new Set(['stop', 'tool_calls', 'function_call']);

export interface ProviderResponseDefect {
  /** Which rule fired. `no_choices` ⇒ the body had no choices[0] at all. */
  kind: 'no_choices' | 'empty_content' | 'finish_reason';
  finish_reason: string | null;
  /** OpenRouter passes the upstream's own reason through untranslated — the real diagnosis. */
  native_finish_reason: string | null;
  content_length: number;
  /** OpenRouter's `provider` field: WHICH Google endpoint served this (google-vertex / ai-studio). */
  served_by: string | null;
  /** The body's `error` object (top-level, then per-choice), serialised verbatim. */
  response_error: string | null;
  /** The FULL response body, capped. It is the entire diagnostic payload and nothing kept it. */
  body: string | null;
}

/** True for a streaming result — it has no choices yet and must never be judged by this check. */
function isStream(x: unknown): boolean {
  return Boolean(x && typeof x === 'object'
    && ('controller' in (x as object) || Symbol.asyncIterator in (x as object)));
}

function firstDefined(...xs: unknown[]): string | null {
  for (const x of xs) if (x != null && x !== '') return String(x);
  return null;
}

/**
 * §2.1 — validate the response instead of assuming it. Returns null when the response is a usable
 * completion (the overwhelmingly common case, byte-identical behaviour), or the defect otherwise.
 *
 * PURE and TOTAL: any shape yields a verdict, so the check can never be the thing that fails.
 *
 * A NULL/absent finish_reason with content present is deliberately NOT a defect — content is the
 * real signal, and some providers omit the field. A finish_reason that is PRESENT and not in
 * USABLE_FINISH_REASONS is a defect even with content, because that content is truncated
 * ('length') or filtered ('content_filter', 'error') and downstream JSON parsing will fail on it
 * anyway — silently, which is the behaviour this exists to end.
 */
export function classifyProviderResponse(result: unknown): ProviderResponseDefect | null {
  if (isStream(result)) return null;
  const o = (result && typeof result === 'object' ? result : {}) as {
    choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown;
                      native_finish_reason?: unknown; error?: unknown }>;
    provider?: unknown;
    error?: unknown;
  };
  const c0 = Array.isArray(o.choices) ? o.choices[0] : undefined;
  const finish = c0?.finish_reason == null ? null : String(c0.finish_reason).toLowerCase();
  const content = typeof c0?.message?.content === 'string' ? c0.message.content : '';
  const base = {
    finish_reason: finish,
    native_finish_reason: c0?.native_finish_reason == null ? null : String(c0.native_finish_reason),
    content_length: content.length,
    served_by: o.provider == null ? null : String(o.provider),
    response_error: (() => {
      const e = o.error ?? c0?.error;
      if (e == null) return null;
      try { return cap(typeof e === 'string' ? e : JSON.stringify(e)); } catch { return cap(String(e)); }
    })(),
    body: (() => { try { return cap(JSON.stringify(result)); } catch { return cap(String(result)); } })(),
  };
  if (!c0) return { kind: 'no_choices', ...base };
  // A tool-call response legitimately carries no content.
  const hasToolCalls = Array.isArray(c0.message?.tool_calls) && (c0.message!.tool_calls as unknown[]).length > 0;
  if (!content && !hasToolCalls) return { kind: 'empty_content', ...base };
  if (finish !== null && !USABLE_FINISH_REASONS.has(finish)) return { kind: 'finish_reason', ...base };
  return null;
}

/**
 * IS THIS DEFECT WORTH ANOTHER ATTEMPT? (7 Aug 2026, measured on a live Bedrock critique leg.)
 *
 * ⚠️ WHAT THIS COSTS WHEN IT IS WRONG. A Bedrock `critique` call returned HTTP 200 with
 * `finish_reason=length` — it had written ~2,900 characters and hit the leg's `max_tokens`. The
 * shared loop treated that like any other bad 200 and retried it twice more, on the same prompt
 * with the same cap, and got the same truncation both times: 54 seconds of a single run spent
 * re-proving a deterministic outcome.
 *
 * THE RULE: a defect that says THE CALL COMPLETED is not retryable; a defect that says WE GOT
 * NOTHING BACK is.
 *   · `no_choices` / `empty_content` — the measured OpenRouter class (1,523 of 3,963 responses on
 *     31 Jul). The provider hiccuped and returned a husk; another attempt genuinely may succeed.
 *   · `finish_reason` — the model ran and stopped for a reason we cannot use: `length` (the caller's
 *     cap was too small) or `content_filter` (the input was refused). Both are functions of the
 *     REQUEST, not of the moment. Identical input reproduces them.
 *
 * A truncated leg is a SIZING bug and it must surface as one, immediately, instead of hiding
 * behind three attempts' worth of latency. The retry loop cannot fix it: the cap belongs to the
 * call site, and silently re-issuing a caller's request with different generation parameters would
 * mean the answer that came back was not produced under the settings the call site asked for.
 */
export function isRetryableDefect(d: ProviderResponseDefect | null | undefined): boolean {
  if (!d) return false;
  return d.kind !== 'finish_reason';
}

/** The failure message. NORMATIVE — like emptyContentErrorMessage on the eval path, this string IS
 *  the instrumentation for any caller that only ever sees `(e as Error).message`. */
export function providerResponseErrorMessage(d: ProviderResponseDefect, provider: string, model: string | null): string {
  const v = (x: unknown) => (x == null || x === '' ? 'null' : String(x));
  return `${provider} returned HTTP 200 that is NOT a completion (${d.kind}) — treated as a failure, not as an empty answer.
model=${v(model)} finish_reason=${v(d.finish_reason)} native_finish_reason=${v(d.native_finish_reason)} served_by=${v(d.served_by)} content_length=${d.content_length}
error=${v(d.response_error)}`;
}

/** An error raised by the response check rather than by the transport. Marked so a provider path's
 *  own catch can tell it apart and NOT route it into the local-model fallback (§2.3). */
export class ProviderResponseError extends Error {
  readonly defect: ProviderResponseDefect;
  readonly isProviderResponseError = true as const;
  constructor(d: ProviderResponseDefect, provider: string, model: string | null) {
    super(providerResponseErrorMessage(d, provider, model));
    this.name = 'ProviderResponseError';
    this.defect = d;
  }
}

export function isProviderResponseError(e: unknown): e is ProviderResponseError {
  return Boolean(e && typeof e === 'object' && (e as { isProviderResponseError?: unknown }).isProviderResponseError === true);
}

/**
 * §2.2 — the provider_error payload for a bad-response failure. Same event, same shape and the same
 * 4000-char cap as the thrown-error path, PLUS the four fields that only exist on a 200: the defect
 * kind, the finish reasons, which endpoint served it, and the body itself.
 */
export function providerResponsePayload(
  i: Omit<ProviderErrorPayloadInput, 'error'> & { defect: ProviderResponseDefect },
): Record<string, unknown> {
  const { defect, ...rest } = i;
  return {
    ...providerErrorPayload({ ...rest, error: new Error(providerResponseErrorMessage(defect, rest.provider, rest.intendedModel)) }),
    failure_class: 'bad_response_200',
    defect: defect.kind,
    finish_reason: defect.finish_reason,
    native_finish_reason: defect.native_finish_reason,
    content_length: defect.content_length,
    served_by: defect.served_by,
    response_error: defect.response_error,
    response_body: defect.body,
  };
}

// ── in-flight accounting ──────────────────────────────────────────────────────────────────────
//
// Module-scope, per-process — exactly the scope the hypothesis needs: `inFlightAtError` is the
// number of PROVIDER calls (gemini/openrouter; local Ollama is not a provider) in flight in this
// process when an error lands. A per-minute quota is sensitive to simultaneous in-flight calls;
// an IAM denial is not. Without this field the §3 hypothesis stays unfalsifiable.

const inFlight: Record<string, number> = Object.create(null);

export function beginProviderCall(provider: string): void {
  inFlight[provider] = (inFlight[provider] || 0) + 1;
}

/** Floor at 0 — an unmatched end must never produce a negative count. */
export function endProviderCall(provider: string): void {
  inFlight[provider] = Math.max(0, (inFlight[provider] || 0) - 1);
}

export function providerCallsInFlight(): { total: number; by: Record<string, number> } {
  const by: Record<string, number> = {};
  let total = 0;
  for (const k of Object.keys(inFlight)) {
    if (inFlight[k] > 0) { by[k] = inFlight[k]; total += inFlight[k]; }
  }
  return { total, by };
}

// ── the provider_error event payload ──────────────────────────────────────────────────────────

export interface ProviderErrorPayloadInput {
  provider: 'gemini' | 'openrouter' | 'bedrock';
  label: string | null;
  /** Feature when known; null under tracedChat — the traces row carries it (join on trace_id). */
  feature: string | null;
  fellBackTo: string;
  intendedModel: string | null;
  fallbackModel: string | null;
  /** Resolved region (gemini + bedrock; null for openrouter). */
  region: string | null;
  /** SA identity in use — client_email ONLY, never key material (gemini + bedrock). */
  saIdentity: string | null;
  /**
   * The assumed AWS role (bedrock only, 7 Aug 2026). The SECOND identity in the OIDC chain: an IAM
   * trust-policy denial names the role, a missing model grant names the role, a bad audience names
   * the SA — and without both fields on the record they read identically. Omitted ⇒ the key is
   * ABSENT from the payload, so every gemini/openrouter payload stays byte-identical.
   */
  roleArn?: string | null;
  error: unknown;
  inFlightAtError: { total: number; by: Record<string, number> };
}

/** One row per provider failure — everything §4.1/§4.2 of the kickoff names, in one object. */
export function providerErrorPayload(i: ProviderErrorPayloadInput): Record<string, unknown> {
  return {
    provider: i.provider,
    label: i.label,
    feature: i.feature,
    fellBackTo: i.fellBackTo,
    intended_model: i.intendedModel,
    fallback_model: i.fallbackModel,
    region: i.region,
    sa_identity: i.saIdentity,
    ...(i.roleArn ? { role_arn: i.roleArn } : {}),
    inFlightAtError: i.inFlightAtError.total,
    in_flight_by_provider: i.inFlightAtError.by,
    ...serializeProviderError(i.error),
  };
}
