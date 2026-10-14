/**
 * lib/lab-override.ts — IMPURE wrapper around the F11 provider-override gate (addendum A12).
 *
 * The DECISION lives in lib/lab-override-core.ts (pure, zero imports, 13 tests). This module only
 * gathers the facts that decision needs — env, header, admin cookie, clinician cookie, provider
 * resolution, reachability — and hands them over. Splitting it this way is what makes a gate
 * guarding five clinician-facing routes exhaustively testable without a server.
 *
 * ⚠️ THE CONTRACT: `resolveLabOverride` returns `null` for "no override", and a null result MUST
 * leave the calling route byte-identical to today. It never throws — every failure path inside it is
 * caught and degrades to null, because a gate fault must produce production behaviour, never an
 * error in a clinical response.
 */
import type { NextRequest } from 'next/server';
import { isAdminUnlocked, adminTokenMatches } from './admin-cookie';
import { isCareUnlocked } from './care-cookie';
import { geminiConfigured, openrouterConfigured, bedrockConfigured, MINI_MODEL } from './llm';
import { resolveProvider } from './lab-provider-core';
import {
  decideOverride, overrideAuditLine, shouldLogRefusal,
  OVERRIDE_ENV_FLAG, LAB_ORIGIN_HEADER, LAB_ADMIN_HEADER,
  type OverrideDecision,
} from './lab-override-core';

export type HonouredOverride = Extract<OverrideDecision, { override: true }>;

/**
 * CONDITION 6 — reachability. This is a CONFIGURATION probe, and the naming is deliberate: it
 * verifies the provider is actually wired up in this deployment (credentials present), NOT that the
 * remote endpoint is live right now.
 *
 * WHY NOT A LIVENESS PING. A network round-trip here sits on the request path of a route that also
 * serves clinicians. The failure it would catch — provider up at probe time, down 200ms later — is
 * not eliminated by probing anyway, while the latency and the new failure mode are certain. A
 * misconfigured provider is the realistic failure and this catches it deterministically.
 *
 * If the call later fails at generation time, the governed layer's existing fallback handles it the
 * same way it handles any provider error today. Reported as a deviation, not smuggled in.
 */
export function probeReachable(provider: string): boolean {
  try {
    if (provider === 'ollama') return !!MINI_MODEL;          // the local default path
    if (provider === 'vertex') return geminiConfigured();
    if (provider === 'openrouter') return openrouterConfigured();
    // BEDROCK (Bedrock S1, 7 Aug 2026) — NOW A REAL GATE. It reads the OIDC-federation vars the
    // transport actually uses: GCP_SA_KEY (the one secret, already present for Vertex) plus
    // BEDROCK_REGION, BEDROCK_ROLE_ARN and BEDROCK_OIDC_AUDIENCE. All four or nothing — a chain
    // missing any link cannot be addressed, and a provider that resolves but cannot be reached
    // must refuse with a typed reason rather than run somewhere else.
    //
    // ⚠️ THERE IS NO `BEDROCK_API_KEY`, AND THERE NEVER WILL BE. The stub this replaces gated on
    // one; the whole point of the OIDC chain is that no AWS secret exists anywhere. If you find
    // that name in an env list, it is dead configuration — delete it, do not set it.
    //
    // ⚠️ BEDROCK_REGION deliberately, NOT AWS_REGION — Vercel's runtime sets AWS_REGION itself, so
    // gating on it would read as half-configured on every deploy. (Kept verbatim from the stub: it
    // is still the trap, and the AWS SDK now genuinely reads AWS_REGION as a default.)
    //
    // ROLLBACK: unset any one of the three BEDROCK_* vars and this goes false again — reachability
    // refused, zero behaviour change anywhere else.
    if (provider === 'bedrock') return bedrockConfigured();
    return false;
  } catch { return false; }
}

/**
 * CONDITION 3, established from a HEADER rather than a cookie session (7 Aug 2026).
 *
 * The Lab MCP runs server-side and already holds ADMIN_TOKEN in env; what it could not do was
 * present it, because `selfPostNdjson` sends no cookies and `isAdminUnlocked` reads only the jar.
 * This accepts the token on LAB_ADMIN_HEADER, compared timing-safely against the same env value by
 * the same `safeEq` the cookie path uses (`adminTokenMatches`).
 *
 * ⚠️ WHAT IT IS NOT. It is not a bypass and not a session: it establishes the SAME `isAdmin` fact
 * the cookie establishes, for the same gate, and it unlocks nothing else anywhere in the app. With
 * ADMIN_TOKEN unset it is false for every input, so an unconfigured deployment stays refusing.
 * Never logged, never returned, never written to a row or a trace — the audit line records route,
 * provider, model and caller, and none of those is the credential.
 */
export function labAdminStanding(req: { headers: { get(name: string): string | null } }): boolean {
  try {
    return adminTokenMatches(req.headers.get(LAB_ADMIN_HEADER) || '');
  } catch { return false; }
}

/** Injection seam for the two cookie readers (repo idiom — mirrors WithTraceDeps). Production
 *  passes nothing and gets the real guards; tests drive all six conditions without a server, which
 *  is what this module's whole split exists to make possible. */
export interface LabOverrideDeps {
  isAdmin?: () => Promise<boolean>;
  isClinician?: () => Promise<boolean>;
}

/**
 * Gather the six facts and decide. `route` is used only for the audit line.
 *
 * Returns the honoured override, or null. NEVER throws.
 */
export async function resolveLabOverride(
  req: NextRequest,
  requestedModel: unknown,
  route: string,
  deps: LabOverrideDeps = {},
): Promise<HonouredOverride | null> {
  try {
    const requested = requestedModel == null ? '' : String(requestedModel).trim();
    // Short-circuit before touching cookies/env: the overwhelmingly common path is "no override",
    // and it must cost nothing and depend on nothing.
    if (!requested) return null;

    // Cookie reads are independently fail-safe: an unreadable cookie must not open the gate, so
    // isAdmin degrades to false and isClinicianSession degrades to TRUE (the refusing value).
    //
    // ⚠️ TWO WAYS TO BE ADMIN, ONE STANDARD OF PROOF. The header is checked FIRST because it is
    // cheap and because it is the only one the MCP can satisfy; the cookie session is unchanged and
    // still serves the browser. Both compare against ADMIN_TOKEN with timingSafeEqual; neither can
    // succeed when it is unset. Whichever answers, decideOverride sees one boolean and all six
    // conditions below are byte-identical to before this existed.
    const isAdmin = labAdminStanding(req) || await (deps.isAdmin ?? isAdminUnlocked)().catch(() => false);
    const isClinicianSession = await (deps.isClinician ?? isCareUnlocked)().catch(() => true);

    const r = resolveProvider(requested, MINI_MODEL);
    const resolved = r.ok ? { ok: true as const, provider: r.provider, model: r.model, paid: r.paid } : { ok: false as const };
    const reachable = r.ok ? probeReachable(r.provider) : false;

    const decision = decideOverride({
      requestedModel: requested,
      envFlag: process.env[OVERRIDE_ENV_FLAG] ?? null,
      labOriginHeader: req.headers.get(LAB_ORIGIN_HEADER),
      isAdmin,
      isClinicianSession,
      resolved,
      reachable,
      caller: req.headers.get('x-cdmss-lab-caller') || 'lab-mcp',
    });

    if (decision.override) {
      // A12: every honoured override logs route · provider · RESOLVED model · caller.
      console.info(overrideAuditLine(route, decision));
      return decision;
    }
    if (shouldLogRefusal(decision.refusal)) {
      // Refusals are observable to operators but NEVER surfaced to the caller.
      console.info(`[lab-override] route=${route} REFUSED reason=${decision.refusal}`);
    }
    return null;
  } catch (e) {
    // A fault in the gate itself must produce production behaviour, not an error.
    console.warn('[lab-override] gate error — falling through to production default', String((e as Error).message).slice(0, 160));
    return null;
  }
}

/**
 * Map an honoured override onto the governedChat routing opts a route already passes.
 *
 * ADDITIVE BY CONSTRUCTION: with no override this returns `{}`, so a call site written as
 * `{ gemini: G, ...labRoutingOpts(ovr) }` is byte-identical to `{ gemini: G }` — same single key,
 * same value. That is what the per-route byte-identity test asserts.
 *
 * An openrouter, bedrock or ollama override must also CLEAR `gemini`, or the governed layer would
 * still see a Gemini model and prefer it.
 */
export function labRoutingOpts(ovr: HonouredOverride | null): { gemini?: string | undefined; openrouter?: string; bedrock?: string } {
  if (!ovr) return {};
  if (ovr.provider === 'vertex') return { gemini: ovr.model };
  if (ovr.provider === 'openrouter') return { gemini: undefined, openrouter: ovr.model };
  // BEDROCK (S1, 7 Aug 2026). Clearing `gemini` is not belt-and-braces here, it is the whole
  // mechanism: tracedChat gives an explicit bedrock target precedence over both cloud tiers, and
  // leaving a Gemini model beside it would make the record ambiguous about what was asked for.
  if (ovr.provider === 'bedrock') return { gemini: undefined, bedrock: ovr.model };
  return { gemini: undefined };   // ollama — force the local mini
}
