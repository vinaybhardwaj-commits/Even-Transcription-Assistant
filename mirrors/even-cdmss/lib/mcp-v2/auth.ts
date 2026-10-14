/**
 * lib/mcp-v2/auth.ts — the four keys and the timing-safe compare
 * (LAB-MCP-V2-PRD-v1.0 §3.1, decisions 4 and 5).
 *
 * Decision 4 keeps env-var secrets rather than a principals table: no token minting path,
 * no DB read on the auth hot path, V holds the keys. Decision 5 gives each SCOPE its own
 * key, so the key a caller holds IS its authority — there is no header a client can set
 * to claim a role, and therefore no header a compromised client can lie in.
 *
 * The compare is `timingSafeEqual` on equal-length buffers, matching v1's `labKeyMatches`
 * exactly. It is inherited rather than re-invented (kickoff grounding), including the
 * length pre-check, which leaks only length and is required because timingSafeEqual
 * throws on a length mismatch.
 *
 * ⚠️ V1 AND V2 KEYS ARE DISJOINT. LAB_API_KEY is not accepted here and none of these four
 * is accepted by v1 (§3.1). The two surfaces share no secret, so a v1 key that leaks
 * cannot reach v2's write tools.
 */
import { timingSafeEqual } from 'crypto';
import {
  IDENTIFYING_PRINCIPALS_ENV, KEY_ENV_BY_PRINCIPAL, NEVER_IDENTIFYING, PRINCIPALS,
  SCOPES_BY_PRINCIPAL, type DataScope, type Principal, type Scope,
} from '../lab-v2/contracts';
import { LabError } from '../lab-execution-context';

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return timingSafeEqual(ab, bb); } catch { return false; }
}

/** §3.1 — 503 unless at least one of the four is set. Dark by default. */
export function labV2KeysConfigured(): boolean {
  return PRINCIPALS.some((p) => !!process.env[KEY_ENV_BY_PRINCIPAL[p]]);
}

/**
 * Resolve a presented secret to its principal, or null.
 *
 * Every configured key is compared even after a match, so the work done is a function of
 * how many keys are SET, never of which one matched or of how early it appeared. An
 * empty env var for a principal is treated as unset, so a half-configured deployment
 * cannot be authenticated with the empty string.
 */
export function principalFor(presented: string | null | undefined): Principal | null {
  if (!presented) return null;
  let found: Principal | null = null;
  for (const p of PRINCIPALS) {
    const secret = process.env[KEY_ENV_BY_PRINCIPAL[p]];
    if (!secret) continue;
    if (safeEq(presented, secret) && !found) found = p;
  }
  return found;
}

export function scopesFor(principal: Principal): readonly Scope[] {
  return SCOPES_BY_PRINCIPAL[principal];
}

// ── §17.8 DECISION 105 — data_scope ──────────────────────────────────────────────────

/**
 * The principals allowed to send an identifying input, from `LAB_V2_IDENTIFYING_PRINCIPALS`.
 *
 * ⚠️ READ ON EVERY CALL, NOT CACHED AT MODULE LOAD. "Refuses `research` at load" is about the
 * moment the list is READ, and on Vercel a module's top-level code runs once per cold start
 * while the environment can change between deployments. Reading per call means a deployment that
 * adds `research` is refused by the very next request rather than by whichever instance happens
 * to restart, and it makes the function testable without module cache games.
 *
 * ⚠️ AND AN UNKNOWN NAME IS REFUSED TOO. A typo — `operater`, `ops` — would otherwise grant
 * nothing and look exactly like a correctly-empty list, so the deployment would silently not
 * work and nobody would know which of the two it was.
 *
 * @throws LabError CLASSIFICATION_REQUIRED when the list names `research`, or a name that is not
 *         a principal at all.
 */
export function identifyingPrincipals(env: Record<string, string | undefined> = process.env): readonly Principal[] {
  const raw = env[IDENTIFYING_PRINCIPALS_ENV];
  if (!raw || !raw.trim()) return [];
  const names = raw.split(',').map((n) => n.trim()).filter((n) => n.length > 0);
  const out: Principal[] = [];
  for (const name of names) {
    if ((NEVER_IDENTIFYING as readonly string[]).includes(name)) {
      throw new LabError('CLASSIFICATION_REQUIRED',
        `${IDENTIFYING_PRINCIPALS_ENV} names '${name}', which may never hold data_scope 'identifying': `
        + 'the research key exists to be handed to people who analyse de-identified data, and this '
        + 'platform\u2019s guarantee is that it cannot reach a person. Remove it from the list.');
    }
    if (!(PRINCIPALS as readonly string[]).includes(name)) {
      throw new LabError('CLASSIFICATION_REQUIRED',
        `${IDENTIFYING_PRINCIPALS_ENV} names '${name}', which is not a principal. `
        + `The four are ${PRINCIPALS.join(', ')}. A typo here grants nothing and looks exactly like an empty list.`);
    }
    if (!out.includes(name as Principal)) out.push(name as Principal);
  }
  return out;
}

/** §17.8 decision 105 — one principal's data scope. `identifying` only by being on the list. */
export function dataScopeFor(principal: Principal, env: Record<string, string | undefined> = process.env): DataScope {
  return identifyingPrincipals(env).includes(principal) ? 'identifying' : 'deidentified';
}

/**
 * The decision 105 gate, in one place so `service.ts` and `system_capabilities` cannot disagree.
 *
 * ⚠️ BOTH CONDITIONS, AND `production_read` IS THE ONE THAT IS NOT ABOUT THE LIST. A principal on
 * the list that could not already read production would be being granted something new by an env
 * variable, which is precisely the "header a client can set to claim a role" that decision 5 exists
 * to prevent. The list narrows an existing authority; it never widens one.
 */
export function mayUseIdentifyingInput(principal: Principal, env: Record<string, string | undefined> = process.env): boolean {
  return scopesFor(principal).includes('production_read') && dataScopeFor(principal, env) === 'identifying';
}
