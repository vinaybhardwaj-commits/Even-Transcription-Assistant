/**
 * lib/lab-override-core.ts — PURE decision core for the F11 provider-override gate (addendum A12).
 *
 * WHY THIS IS ITS OWN PURE MODULE. F11 lets a Lab caller change which model answers on FIVE
 * PRODUCTION CLINICIAN-FACING ROUTES (ask · ddx · appropriateness · doc-audit/analyze ·
 * pathway/skeleton). V took that decision against the orchestrator's recommendation, and the gate is
 * what makes it safe (A12, decision 15). A gate whose logic lives inline in five route handlers
 * cannot be exhaustively tested; this one is a single pure function over an explicit input record,
 * so every one of the six conditions — and their ORDER — is unit-testable without a server.
 *
 * THE CONTRACT, and it is absolute: `decideOverride` returns `null` for "no override". A null result
 * MUST leave the route byte-identical to today. It NEVER returns an error, and no caller may surface
 * a gate refusal into a clinical response — a refused override is silent, and production behaviour
 * simply happens.
 *
 * ZERO IMPORTS, like opd-finding-identity-core: the impure wrapper reads env, headers and cookies and
 * hands the facts in. That keeps the decision itself inspectable and strip-types testable.
 */

/** The env kill switch. ABSENT OR UNSET ⇒ OFF — flipping it disables every override with no deploy. */
export const OVERRIDE_ENV_FLAG = 'LAB_PROVIDER_OVERRIDE_ENABLED';
/** The lab-origin marker. A HEADER, deliberately: never a query param, never inferable from a
 *  browser, and not something a clinician's session can carry by accident. */
export const LAB_ORIGIN_HEADER = 'x-cdmss-lab-origin';
export const LAB_ORIGIN_VALUE = 'lab-mcp';
/**
 * The admin STANDING marker (7 Aug 2026). A second header, carrying the ADMIN_TOKEN value, by which
 * the Lab MCP's own self-request presents the admin credential it already holds in env.
 *
 * ⚠️ WHY THIS EXISTS. Condition 3 below requires admin auth on the same request, and it was
 * measurably unsatisfiable from the MCP: `selfPostNdjson` forwards no cookies, so `isAdminUnlocked`
 * read an empty jar and EVERY MCP override on /api/ask and /api/ddx was refused `not_admin` —
 * silently, because a refusal is never surfaced. Measured 7 Aug: a `bedrock:` probe and a `vertex:`
 * probe both ran the production default while their lab rows claimed the requested model.
 *
 * ⚠️ THIS FORWARDS STANDING, IT DOES NOT BYPASS THE CONDITION (V, 7 Aug). The gate below is
 * BYTE-IDENTICAL: it still demands `isAdmin === true`. What changed is only HOW the impure wrapper
 * may establish that fact — cookie session OR this header, both verified timing-safely against the
 * same ADMIN_TOKEN. A caller with neither is refused exactly as before.
 *
 * A HEADER, and deliberately not the cat_admin cookie: a cookie would confer general admin standing
 * on the whole request, unlocking every `isAdminUnlocked` check on the route. This is read by the
 * F11 gate and nothing else. Like LAB_ORIGIN_HEADER it is also unsettable by a same-site browser
 * form post.
 */
export const LAB_ADMIN_HEADER = 'x-cdmss-lab-admin';

/** Every refusal reason, in gate order. Logged, never returned to a clinical caller. */
export type OverrideRefusal =
  | 'no_model_requested'      // nothing asked for — the overwhelmingly common path
  | 'flag_off'                // 1
  | 'no_lab_marker'           // 2
  | 'not_admin'               // 3
  | 'clinician_session'       // 4
  | 'unknown_provider'        // 5
  | 'model_unreachable';      // 6

export interface OverrideFacts {
  /** The requested model string, e.g. 'openrouter:google/gemini-2.5-flash'. Absent ⇒ no override. */
  requestedModel?: string | null;
  /** process.env[OVERRIDE_ENV_FLAG] — passed in, not read here. */
  envFlag?: string | null;
  /** The value of the lab-origin header on THIS request. */
  labOriginHeader?: string | null;
  /** Result of the EXISTING admin guard. Never re-implemented here. */
  isAdmin: boolean;
  /** True when a clinician/care session is present on the same request. */
  isClinicianSession: boolean;
  /** Provider resolution, done by lib/lab-provider-core (the ONE resolver). */
  resolved?: { ok: true; provider: string; model: string; paid: boolean } | { ok: false } | null;
  /** Reachability probe result for the resolved model. Undefined ⇒ not probed ⇒ treated as
   *  unreachable, because an unprobed model must not reach a clinical route. */
  reachable?: boolean;
  /** Who is asking — recorded on an honoured override. */
  caller?: string | null;
}

export type OverrideDecision =
  | { override: true; provider: string; model: string; paid: boolean; caller: string }
  | { override: false; refusal: OverrideRefusal };

/**
 * The gate. Six conditions, evaluated IN THE ORDER A12 specifies, because the order is itself the
 * safety property: the kill switch is checked before anything else, and the clinician-session check
 * (4) comes AFTER admin (3) so that a clinician who also holds an admin cookie is still refused.
 * Fail-closed at every step.
 *
 * Pure. Never throws. Never returns an error — only "override" or "don't".
 */
export function decideOverride(f: OverrideFacts): OverrideDecision {
  const requested = String(f?.requestedModel ?? '').trim();
  // The common path: nothing was asked for. Byte-identical production behaviour, no gate evaluated.
  if (!requested) return { override: false, refusal: 'no_model_requested' };

  // 1 — kill switch. Absent/unset/anything-but-'1' ⇒ OFF.
  if (String(f.envFlag ?? '') !== '1') return { override: false, refusal: 'flag_off' };

  // 2 — explicit lab-origin marker. A browser cannot set this on a same-site form post, and it is
  //     not a query param, so it cannot be pasted into a URL.
  if (String(f.labOriginHeader ?? '') !== LAB_ORIGIN_VALUE) return { override: false, refusal: 'no_lab_marker' };

  // 3 — admin auth on the SAME request, via the existing guard.
  if (f.isAdmin !== true) return { override: false, refusal: 'not_admin' };

  // 4 — a clinician session refuses the override even when 1-3 pass. Fail closed toward production:
  //     if a real clinician is somehow on this request, they get the production model, full stop.
  if (f.isClinicianSession === true) return { override: false, refusal: 'clinician_session' };

  // 5 — the provider string must parse to a known prefix. Unknown ⇒ production default, never a guess.
  const r = f.resolved;
  if (!r || r.ok !== true) return { override: false, refusal: 'unknown_provider' };

  // 6 — the resolved model must be reachable. UNPROBED COUNTS AS UNREACHABLE: an override that has
  //     not been shown to work must not be the thing a clinical route depends on.
  if (f.reachable !== true) return { override: false, refusal: 'model_unreachable' };

  return { override: true, provider: r.provider, model: r.model, paid: r.paid, caller: String(f.caller ?? 'lab-mcp') };
}

/** Structured audit line for an HONOURED override — route · provider · resolved model · caller (A12).
 *  The RESOLVED model is recorded, never the requested string. */
export function overrideAuditLine(route: string, d: Extract<OverrideDecision, { override: true }>): string {
  return `[lab-override] route=${route} provider=${d.provider} model=${d.model} paid=${d.paid} caller=${d.caller}`;
}

/** Refusals are logged at debug level only and NEVER surfaced to the caller. `no_model_requested` is
 *  not worth a line — it is the normal path for every real clinical request. */
export function shouldLogRefusal(refusal: OverrideRefusal): boolean {
  return refusal !== 'no_model_requested';
}
