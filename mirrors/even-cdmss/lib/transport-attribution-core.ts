/**
 * lib/transport-attribution-core.ts — dispatch evidence on a returned completion (PURE).
 * CDMSS-RERANK-TELEMETRY-CC-KICKOFF-11-AUG-2026 §4.4, Stage 0a step 2.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────────────────────────
 * The mechanism below was written on 10 Aug for the LVC judge (GUARD-FIX PRD v3.0 D-8) and lived
 * in lib/trace.ts, because only the TRACED transport needed it. The rerank judge is TRACELESS
 * (lib/rerank.ts:311 passes `undefined` as the trace id, and kickoff constraint 2 forbids changing
 * that), so its transport is `chatWithFallback` in lib/llm.ts — which attaches nothing, and is why
 * §5 of the throttle-rate findings could not say which caller was throttled.
 *
 * lib/trace.ts already imports from lib/llm.ts, so lib/llm.ts cannot import back from lib/trace.ts.
 * The primitive therefore moves DOWN into a module both can depend on. lib/trace.ts re-exports
 * every name it previously declared, so no existing consumer moves — including
 * lib/__tests__/lvc-judge-attribution.test.ts, which imports all four from '../trace' and is one of
 * the four files held uncommitted on main that this build must not touch.
 *
 * ── THE PROPERTY THAT MAKES THIS SAFE TO PUT ON THE PRODUCTION PATH ─────────────────────────────
 * The evidence is a NON-ENUMERABLE property on the object the provider SDK already returned. It is
 * invisible to `JSON.stringify`, to `Object.keys`, to spreads and to every existing consumer of a
 * completion; it allocates no new object; and `attach` never throws, even on a frozen or sealed
 * provider object. Attaching it cannot change a request, a provider choice, a retry, or a byte of
 * a response — which is exactly what §4.4 requires tests to prove before it may ship.
 */

/** The property name carrying dispatch evidence on a returned completion. Namespaced so it can
 *  never collide with an OpenAI/Bedrock/OpenRouter SDK field. */
export const TRANSPORT_ATTRIBUTION_FIELD = 'cdmss_transport_attribution';

/**
 * One provider attempt, in dispatch order. §4.3 requires the ORDERED attempt outcomes per rerank
 * batch — `429`, other HTTP, timeout, success or a declared transport error — and they are
 * distinguished here rather than collapsed, because a 429 and a socket reset call for different
 * remediation and the throttle-rate census could only see the ones that reached a console line.
 *
 * `success` is terminal for its tier. A tier that never reports one either fell through to the
 * next tier or ended the ladder.
 *
 * ⚠️ THE RUNTIME AUTHORITY IS THE ARRAY, NOT THE TYPE (v11 §4 item 1, review 22 item 3). The union
 * was hand-written and had no runtime form, so nothing could ask "is this one of the six?" — and an
 * attempt reaching the manifest from JSONB is an untyped value at runtime. `validateManifest` now
 * branches on this array in all three manifest locations. The six values and their order are
 * unchanged; the type is derived from the array so the two can never disagree.
 */
export const TRANSPORT_ATTEMPT_OUTCOMES = [
  'http_429', 'http_other', 'timeout', 'transport_error', 'bad_response', 'success',
] as const;

export type TransportAttemptOutcome = typeof TRANSPORT_ATTEMPT_OUTCOMES[number];

export interface TransportAttempt {
  /**
   * WHICH PROVIDER this attempt was made against.
   *
   * ⚠️ WIDENED (rerank telemetry on-path D14, 11 Aug 2026) from the two cloud tiers to include the
   * local model, and the field's meaning restated with it: it names the PROVIDER ATTEMPTED, not a
   * position on the cloud ladder. Ollama is not a ladder tier — it is the terminal substitution,
   * and before this change a local request left no attempt at all. That is precisely the hole the
   * 11 Aug census fell into: 21 local substitutions were counted from console lines, and the
   * attempt sequence that led to each of them recorded the cloud failures but never the local
   * call that actually produced the answer.
   */
  tier: 'vertex' | 'openrouter' | 'ollama';
  /** 1-based, in dispatch order within that provider. */
  attempt: number;
  outcome: TransportAttemptOutcome;
  /** HTTP status when the provider supplied one; null for timeouts and transport errors. */
  status: number | null;
}

export type CdmssTransportAttribution = {
  /** Which branch dispatched the request. 'vertex' is the direct Vertex Gemini branch — the
   *  trace's own provider label for it is 'gemini'; this field uses the PRD's name. */
  dispatched_provider: 'vertex' | 'openrouter' | 'ollama' | 'bedrock';
  /** The model slug the transport supplied to that provider (publisher prefix as sent). */
  dispatched_model: string | null;
  /** True when a cloud provider produced this result; false for the local model. */
  cloud_response_received: boolean;
  /**
   * ADDITIVE (rerank telemetry §4.3). The ordered attempt sequence that led to this result, when
   * the transport collected one. OPTIONAL on purpose: `tracedChat` attaches attribution without
   * it, and every existing reader (lib/lvc.ts's `resolveJudgeAttribution`) reads only
   * `dispatched_provider` / `dispatched_model`, so adding the field moves nothing.
   *
   * ABSENT means the transport did not collect attempts — NOT that there were none. §4.4 forbids
   * guessing, so an absent sequence stays absent rather than being reconstructed.
   */
  attempts?: TransportAttempt[];
};

/** Attach dispatch evidence to a completion and return the SAME object. Non-enumerable, so no
 *  existing consumer of the completion can observe it. Never throws. */
export function attachTransportAttribution<T>(result: T, attribution: CdmssTransportAttribution): T {
  if (!result || (typeof result !== 'object' && typeof result !== 'function')) return result;
  try {
    Object.defineProperty(result, TRANSPORT_ATTRIBUTION_FIELD, {
      value: attribution, enumerable: false, configurable: true, writable: true,
    });
  } catch { /* frozen/sealed provider object — evidence is best-effort, never a thrown call */ }
  return result;
}

/** Read dispatch evidence back off a completion. `undefined` means the transport left none —
 *  which is a real state (an untraced call, a stream wrapper), not a failure. */
export function readTransportAttribution(result: unknown): CdmssTransportAttribution | undefined {
  if (!result || (typeof result !== 'object' && typeof result !== 'function')) return undefined;
  const v = (result as Record<string, unknown>)[TRANSPORT_ATTRIBUTION_FIELD];
  return v && typeof v === 'object' ? (v as CdmssTransportAttribution) : undefined;
}

/**
 * Map one `RetryAttemptFailure` (lib/openrouter-retry.ts) onto a declared outcome. Kept pure and
 * here rather than inline at the call site so both ladder tiers classify identically — a 429 that
 * counted as `http_other` on one tier and `http_429` on the other would make the census
 * tier-dependent, which is the class of defect this telemetry exists to remove.
 */
export function classifyAttemptOutcome(kind: string, status: number | null): TransportAttemptOutcome {
  if (kind === 'timeout') return 'timeout';
  if (kind === 'transport') return 'transport_error';
  if (kind === 'bad_response') return 'bad_response';
  return status === 429 ? 'http_429' : 'http_other';
}

/** The SDK's timeout error, named once. Matched against BOTH `name` and `constructor.name`. */
const TIMEOUT_ERROR_NAME = 'APIConnectionTimeoutError';

/**
 * Does this thrown value declare itself an SDK connection timeout?
 *
 * ⚠️ THE DEFECT THIS FIXES (addendum v12 §1, Saul's review 23 finding 1). The check was
 * `e.name === 'APIConnectionTimeoutError'`, and the installed `openai` package's error does not
 * carry that name. Executed against the package in this worktree, openai 4.104.0:
 *
 *     new APIConnectionTimeoutError({ message: 'timed out' })
 *       e.name              "Error"          ← inherited from Error.prototype; not an own property
 *       e.constructor.name  "APIConnectionTimeoutError"
 *       e.status            undefined
 *
 * So the check was never true for a real SDK timeout: every local timeout classified
 * `transport_error`, and because `terminalOutcomeFor` (lib/rerank.ts) lifts a batch to `timeout`
 * only when the last attempt's outcome is `timeout`, the batch outcome `timeout` was UNREACHABLE on
 * the local arm. The local arm is the substitution path under throttling — the instrument was blind
 * exactly where this programme was built to look.
 *
 * ⚠️ BOTH READS, NOT A REPLACEMENT. The declared `name` still wins where it is present: a future SDK
 * version that sets `name` properly, and any wrapper that re-declares it, must keep working.
 *
 * ⚠️ NO `instanceof`, AND NO IMPORT OF THE SDK (v12 §2 item 4). This file has ZERO outbound imports
 * and that is what made pass 1's new architecture edge cycle-free — `retrieval-telemetry-core`
 * imports this module, so an import here could create a cycle and would change the graph. The
 * constructor name is read defensively instead.
 *
 * ⚠️ AND NEITHER READ MAY THROW (v12 §2 item 3). This runs ON A FAILURE PATH: a classifier that
 * throws while classifying a failure destroys the failure it was called to record. `Object.create(null)`
 * has no `constructor`; a proxy or a defined getter can throw on property access; the input may not
 * be an object at all. Every read is guarded and every failure resolves to "not a timeout", which
 * degrades to the honest `transport_error` rather than to a fabricated one.
 */
function declaresConnectionTimeout(e: unknown): boolean {
  if (e === null || (typeof e !== 'object' && typeof e !== 'function')) return false;
  try {
    if ((e as { name?: unknown }).name === TIMEOUT_ERROR_NAME) return true;
  } catch { /* a throwing `name` getter is not a declaration */ }
  try {
    const ctor = (e as { constructor?: unknown }).constructor;
    if (typeof ctor === 'function' && (ctor as { name?: unknown }).name === TIMEOUT_ERROR_NAME) return true;
  } catch { /* absent or throwing constructor — see the null-prototype case */ }
  return false;
}

/**
 * Classify a THROWN local-model call, which never runs through `createWithRetry` and therefore has
 * no `RetryAttemptFailure` to classify. Reads only what the SDK error itself declares — a numeric
 * `status`, and the SDK's own timeout identity — and reports `transport_error` when it declares
 * neither. §4.4 forbids GUESSING from requested model, environment or timing; reading a field the
 * provider SDK set is the opposite of guessing, and an undeclared failure stays the honest "the
 * transport failed and did not say more" rather than being sharpened.
 *
 * Deliberately a SECOND function rather than a widening of `classifyAttemptOutcome`: that one maps
 * a declared `kind`, both ladder tiers reach it through the identical expression, and a source pin
 * counts those two call sites to prove a 429 cannot be classified tier-dependently. The 429 rule
 * itself is not duplicated — it is delegated below, so there is still exactly one copy of it.
 *
 * The 429 rule and the status handling below are UNCHANGED by v12 (§2 item 5).
 */
export function classifyLocalAttempt(err: unknown): { outcome: TransportAttemptOutcome; status: number | null } {
  const e = (err ?? {}) as { status?: unknown };
  let status: number | null = null;
  try {
    status = typeof e.status === 'number' ? e.status : null;
  } catch { /* a throwing `status` getter leaves the status undeclared, which is not a guess */ }
  const kind = declaresConnectionTimeout(err) ? 'timeout' : status === null ? 'transport' : 'http';
  return { outcome: classifyAttemptOutcome(kind, status), status };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// FAILURE ATTRIBUTION (rerank telemetry on-path D14) — evidence on a THROWN error
// ────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * ⚠️ WHY A SECOND, SEPARATE MECHANISM AND NOT A NULLABLE `dispatched_provider`.
 *
 * `CdmssTransportAttribution` answers "which provider served this completion". When every route
 * fails there IS no completion, and PRD §4.4 is explicit that the record must then say so rather
 * than naming the last provider attempted. Widening the success type to carry a null provider
 * would put that "nobody served" state into a shape whose existing readers — `resolveJudgeAttribution`
 * in lib/lvc.ts — already branch on `dispatched_provider` being present. A separate type on a
 * separate property cannot reach those readers at all, which is what keeps §4.4 condition 4
 * (existing callers behaviourally compatible) true by construction rather than by test.
 *
 * This is the difference the PRD calls out twice and forbids merging: `unattributed` means a
 * completion may have arrived and we cannot say who served it. This type is the OTHER fact — the
 * proof that no completion arrived at all, which is what licenses `not_served`.
 */
export const TRANSPORT_FAILURE_ATTRIBUTION_FIELD = 'cdmss_transport_failure_attribution';

/**
 * The terminal phases a failed dispatch can end in. STABLE NAMES, never a message and never an
 * interpolated value — the same discipline `error_class` carries in the failure table. A phase
 * names WHERE the ladder ended, so a census can separate "the caller forbade a local answer" from
 * "a bad 200 was refused laundering" from "the local model itself failed".
 */
export const TRANSPORT_TERMINAL_PHASES = [
  'cloud_ladder_exhausted_no_local_fallback',
  'openrouter_bad_response_not_laundered',
  'cloud_ladder_exhausted_local_substitution',
  'intended_local_failed',
  'local_substitution_failed',
] as const;

export type CdmssTransportFailureAttribution = {
  /** Always `failed`. Present so a reader that holds both shapes can discriminate on one field. */
  outcome: 'failed';
  /** No provider served. Typed as the literal `null` so it cannot be filled in later by accident. */
  servedProvider: null;
  /** Ditto. §10: a requested model is never reported as a served model, and here none was served. */
  servedModel: null;
  /** The ordered ladder history that led to this failure. `null` means the transport collected
   *  none — NOT that there were none. An absent sequence stays absent (§4.4: no reconstruction). */
  attempts: TransportAttempt[] | null;
  /** One of TRANSPORT_TERMINAL_PHASES. Typed `string` so a new phase needs no type surgery. */
  terminalPhase: string;
};

/**
 * Attach failure evidence to a THROWN error and return the SAME object, so `throw attach(e, …)`
 * and `attach(e, …); throw e;` are both identity-preserving and neither changes which error is
 * thrown or when. IMMUTABLE, unlike the success attribution: an error object travels up through
 * catch blocks that may re-inspect it, and a record of what failed must not be silently rewritten
 * by a later frame. Never throws — a frozen or exotic error is left exactly as it was.
 */
export function attachTransportFailureAttribution<T>(error: T, attribution: CdmssTransportFailureAttribution): T {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
  try {
    Object.defineProperty(error, TRANSPORT_FAILURE_ATTRIBUTION_FIELD, {
      value: attribution, enumerable: false, configurable: false, writable: false,
    });
  } catch { /* frozen/sealed/already-attributed error — evidence is best-effort, never a thrown call */ }
  return error;
}

/**
 * The one local attempt a `chatWithFallback` invocation can make. `attempt: 1` is correct BY
 * CONSTRUCTION, not by convention: the intended-local arm returns before the ladder exists and the
 * substitution arm runs only after the ladder is over, so the two are mutually exclusive and the
 * local model is called at most once per invocation.
 *
 * `status: 200` on a success mirrors what both cloud tiers already record — the SDK surfaces no
 * status on a success, and inventing a different placeholder here would make the local row the odd
 * one out in every census that groups by status.
 */
export function localAttemptSuccess(): TransportAttempt {
  return { tier: 'ollama', attempt: 1, outcome: 'success', status: 200 };
}

/** Read failure evidence back off a thrown error. `undefined` means the transport left none. */
export function readTransportFailureAttribution(error: unknown): CdmssTransportFailureAttribution | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
  const v = (error as Record<string, unknown>)[TRANSPORT_FAILURE_ATTRIBUTION_FIELD];
  return v && typeof v === 'object' ? (v as CdmssTransportFailureAttribution) : undefined;
}
