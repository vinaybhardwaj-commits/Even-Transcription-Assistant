/**
 * lib/guardrails-r3-core.ts — the replacement guardrail suite's decision core (PURE).
 *
 * ── WHY A PURE CORE AND NOT A ROUTE FULL OF `if`s ───────────────────────────────────────────────
 * Its predecessor, `app/api/admin/telemetry-overhead/route.ts`, carried its whole guard chain
 * inline. Every one of its guards therefore had to be proven by spawning a child process with a
 * synthetic environment, because the only way to reach the decision was to make a request. That
 * worked, and those child-process cases are kept here too — but it made each guard expensive to
 * test and it meant the ORDER of the guards, which is the part that actually failed review, could
 * only be checked by observing which status came back.
 *
 * The decision is a pure function of an environment snapshot and a clock. Written that way, the
 * order is a value that can be asserted directly, every refusal is reachable without a process, and
 * the route becomes a thin caller that cannot silently reorder anything.
 *
 * ⚠️ ZERO OUTBOUND IMPORTS, AND THAT IS LOAD-BEARING. Nothing here imports from `lib/`. The suite
 * must be able to state its refusal on a branch where the telemetry modules it will eventually
 * measure DO NOT EXIST (see `MEASUREMENT_INTEGRATION` below), and an import of any of them would
 * make this file unloadable exactly when it most needs to answer.
 *
 * ⚠️ NOTHING IN THIS FILE EVER RETURNS, LOGS OR EMBEDS ANY PART OF A CONNECTION STRING. The
 * predecessor leaked a password through an error object twice before that rule was written down.
 * Every refusal below is ONE WORD from a closed set, and the endpoint comparison reports which
 * SIDE is wrong without naming either host.
 */

/**
 * THE ROUTE THIS CORE GUARDS. Named once so the route, the refusal tests and the evidence document
 * cannot drift on spelling.
 */
export const GUARDRAILS_R3_ROUTE = '/api/admin/telemetry-guardrails-r3';

/**
 * GUARD 2's DATE — the instrument's ABSOLUTE EXPIRY, `2026-09-15T00:00:00Z`.
 *
 * ⚠️ THIS IS THE ONLY MECHANISM THAT MAKES THE DELETION REAL. Nothing in CI enumerates routes, so a
 * deletion owed in a report is a promise and not a control. Its predecessor's constant did its job
 * — it expired on schedule and turned the branch red — and the deletion still did not follow for
 * sixteen hours. The lesson taken here is not "pick a later date": it is that the expiry must be
 * the second thing that happens, so that after this instant EVERY AUTHENTICATED REQUEST IS 410
 * whatever else is configured. See `evaluateGuardrailsR3Request`.
 */
export const EXPIRES_AT_UTC = Date.UTC(2026, 8, 15, 0, 0, 0);

/**
 * THE FREEZE DEADLINE, `2026-09-08T00:00:00Z` — one week before the expiry.
 *
 * The closing ledger's standing clock: *"If the qualifying SHA is not frozen by
 * 2026-09-08T00:00:00Z, it is deleted and disarmed and a newly dated authorization is requested —
 * it is not silently extended and the shortened remainder is not used."*
 *
 * ⚠️ MADE A MECHANISM RATHER THAN A PROMISE. Past this instant, an UNSET qualifying SHA refuses
 * with its own word instead of falling through to the ordinary "not qualified" refusal. The
 * difference matters to whoever reads the response: `not_qualified` means "freeze the SHA and set
 * it", and `freeze_deadline_passed` means "you may no longer do that — go back for a new
 * authorization". A single refusal word for both would invite exactly the silent extension the
 * ledger forbids.
 */
export const FREEZE_DEADLINE_UTC = Date.UTC(2026, 8, 8, 0, 0, 0);

/**
 * The only branch this route may serve from.
 *
 * ⚠️ THE REF GUARD IS NOT REDUNDANT WITH THE ENVIRONMENT LABEL, and it is not redundant with the
 * frozen-SHA guard either. A Preview build carries `VERCEL_ENV=preview` BAKED IN and can later be
 * PROMOTED to production — serving production traffic from a build whose own label still says
 * preview. The ref is what stops that, and it is the predecessor's reasoning kept verbatim because
 * the hazard has not changed.
 */
export const ONLY_REF = 'guardrails-r3';

/** Environment variable names, declared once so a guard and its test cannot drift on spelling. */
export const ENV = {
  qualifyingSha: 'CDMSS_GUARDRAILS_R3_QUALIFYING_SHA',
  armed: 'CDMSS_GUARDRAILS_R3_MEASURE',
  expectedEndpoint: 'CDMSS_GUARDRAILS_R3_DB_ENDPOINT',
  forbiddenEndpoint: 'CDMSS_GUARDRAILS_R3_FORBIDDEN_ENDPOINT',
} as const;

/**
 * Every refusal this core can produce, in the order the guards run.
 *
 * ⚠️ A CLOSED SET, AND IT IS THE WHOLE VOCABULARY. A refusal that interpolated a value — a host, an
 * endpoint id, a SHA, a fragment of a connection string — would be a leak with a status code on it.
 * `refusalsInOrder()` below asserts this list IS the guard order, so a guard added out of sequence
 * cannot pass its own test.
 */
export const GUARDRAILS_R3_REFUSALS = [
  'unauthorized',            // 1. admin
  'expired',                 // 2. absolute expiry — SECOND, immediately after authentication
  'not_preview',             // 3. preview environment AND branch ref
  'freeze_deadline_passed',  // 4. qualification — the ledger's standing clock, as a mechanism
  'not_qualified',           // 4. qualification — no frozen SHA configured
  'sha_mismatch',            // 4. qualification — this build is not the frozen SHA
  'not_armed',               // 5. explicit arming
  'no_denylist',             // 6. database identity — an absent denylist is not a denylist
  'forbidden_endpoint',      // 6. database identity — this IS the forbidden one
  'endpoint_mismatch',       // 6. database identity — not the expected one
  'not_integrated',          // 7. the measurement body is not present on this branch
] as const;

export type GuardrailsR3Refusal = typeof GUARDRAILS_R3_REFUSALS[number];

/** The HTTP status each refusal carries. Only the expiry is a 410; it is a deadline, not a denial. */
export const REFUSAL_STATUS: Record<GuardrailsR3Refusal, number> = {
  unauthorized: 401,
  expired: 410,
  not_preview: 403,
  freeze_deadline_passed: 403,
  not_qualified: 403,
  sha_mismatch: 403,
  not_armed: 403,
  no_denylist: 403,
  forbidden_endpoint: 403,
  endpoint_mismatch: 403,
  // ⚠️ 501, NOT 403. The other ten mean "you may not". This one means "this build CANNOT" — the
  // measurement body does not exist here. Collapsing it into 403 would let a misconfiguration and a
  // structural absence read identically to an operator, and they call for opposite actions.
  not_integrated: 501,
};

/**
 * WHETHER THE MEASUREMENT BODY EXISTS ON THIS BRANCH.
 *
 * ⚠️ THIS IS `false` AND IT IS NOT A PLACEHOLDER. This suite is built on a clean worktree off
 * `main`, and `main` CARRIES NONE OF THE TELEMETRY MODULES the first three guardrails measure —
 * `retrieval-telemetry-core`, `retrieval-telemetry-store`, `retrieval-invocation-store`,
 * `retrieval-capture` and `retrieval-settlement` are all absent at `61b5463`; they live on the
 * telemetry branch. Guardrails 1-3 write and read telemetry rows, so there is nothing here for them
 * to write with.
 *
 * That is a fact about the branch, so it is stated as one. The alternative — vendoring type shims
 * so the body could be written now — was rejected: the shims would be duplicate definitions owed a
 * deletion at integration, and an owed deletion that nothing enforces is precisely how the
 * predecessor route outlived its own expiry.
 *
 * ⚠️ THE CONSEQUENCE IS THE POINT. While this is `false` the instrument is STRUCTURALLY INCAPABLE
 * of taking a qualifying measurement, on any environment, however configured — which is what makes
 * "design and dry runs only, no qualifying measurement" a property of the code rather than of the
 * operator's restraint. Flipping it is an integration-time act on a branch where the modules exist.
 */
export const MEASUREMENT_INTEGRATION = { present: false } as const;

/** The environment values the chain reads. A snapshot, so the decision is a pure function of it. */
export interface GuardrailsR3Env {
  vercelEnv?: string;
  gitRef?: string;
  gitSha?: string;
  qualifyingSha?: string;
  armed?: string;
  expectedEndpoint?: string;
  forbiddenEndpoint?: string;
  /** The endpoint id already PARSED out of the connection string by the caller. Never the string
   *  itself: this file must not be able to leak what it never receives. */
  actualEndpoint?: string | null;
}

export type GuardrailsR3Decision =
  | { ok: true }
  | { ok: false; refused: GuardrailsR3Refusal; status: number; expiredAt?: string; note?: string };

/** Trim, treating an all-whitespace value as absent. A key of three spaces is not a key. */
const val = (v: string | undefined): string => (v ?? '').trim();

/**
 * A 40-character lowercase hex commit SHA, and nothing else.
 *
 * ⚠️ EXACT, WITH NO PREFIX MATCHING ANYWHERE. The obvious convenience — accepting the short SHA an
 * operator reads off a deployment page — is the whole hazard: a 7-character prefix identifies one
 * commit today and can identify two later, and "the qualifying SHA" would then name a set. The
 * frozen SHA is one object. `startsWith` is never used against it.
 */
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Neon's pooled hosts differ from the direct ones by a `-pooler` suffix on the endpoint id, and an
 * operator pastes whichever one the console showed them. Both env values and the parsed host go
 * through this, so the denylist catches BOTH forms of the production endpoint rather than whichever
 * one happened to be typed. Its predecessor shipped without this and the gap survived two passes.
 */
export function normaliseEndpointId(id: string): string {
  return id.trim().toLowerCase().replace(/-pooler$/, '');
}

/**
 * THE CHAIN. Returns the FIRST refusal, or `{ ok: true }`.
 *
 * ⚠️ AUTHENTICATION IS NOT HERE, AND ITS ABSENCE IS DELIBERATE. Guard 1 is `requireAdmin` at the
 * route, because it needs the request object. Everything after it is here. The route calls this
 * only AFTER admin has passed, and `refusalsInOrder()` plus the route's own source pin are what
 * hold the two halves in the stated order.
 */
export function evaluateGuardrailsR3Request(env: GuardrailsR3Env, now: number): GuardrailsR3Decision {
  const refuse = (refused: GuardrailsR3Refusal, extra?: Record<string, string>): GuardrailsR3Decision =>
    ({ ok: false, refused, status: REFUSAL_STATUS[refused], ...extra });

  // ── GUARD 2. ABSOLUTE EXPIRY. SECOND, IMMEDIATELY AFTER AUTHENTICATION. ───────────────────────
  // Its predecessor ran this FIFTH and claimed in its report that "after the expiry every request
  // is 410 whatever else is configured". That claim was false: a request failing an earlier guard
  // got a 403 and never saw the 410, so the deletion deadline did not mean what the report said.
  // Second is the first position where the claim is true, and it is true for every authenticated
  // request regardless of environment, ref, SHA, arming or database.
  if (now >= EXPIRES_AT_UTC) {
    return refuse('expired', {
      expiredAt: new Date(EXPIRES_AT_UTC).toISOString(),
      note: 'This measurement instrument is past its hard expiry and must be deleted and disarmed.',
    });
  }

  // ── GUARD 3. PREVIEW, ON THIS BRANCH ONLY. ────────────────────────────────────────────────────
  if (val(env.vercelEnv) !== 'preview' || val(env.gitRef) !== ONLY_REF) return refuse('not_preview');

  // ── GUARD 4. THE FROZEN QUALIFYING SHA. ───────────────────────────────────────────────────────
  // A qualifying measurement is a measurement OF A NAMED BUILD. Rep 41 admits one only after the
  // proof programme closes AND the measurement SHA is frozen, so the instrument refuses to measure
  // anything it cannot name.
  const qualifying = val(env.qualifyingSha);
  if (!qualifying) {
    // The ledger's standing clock, as a mechanism. Two different words because they call for two
    // different actions — see FREEZE_DEADLINE_UTC.
    return refuse(now >= FREEZE_DEADLINE_UTC ? 'freeze_deadline_passed' : 'not_qualified');
  }
  const actualSha = val(env.gitSha);
  // ⚠️ BOTH SIDES MUST BE FULL SHAs, AND THE COMPARISON IS EXACT. A malformed expectation refuses
  // rather than being repaired, and an absent build SHA refuses rather than being treated as a
  // wildcard. Every failure direction is "do not measure".
  if (!FULL_SHA.test(qualifying) || !FULL_SHA.test(actualSha) || qualifying !== actualSha) {
    return refuse('sha_mismatch');
  }

  // ── GUARD 5. EXPLICITLY ARMED. ────────────────────────────────────────────────────────────────
  if (val(env.armed) !== '1') return refuse('not_armed');

  // ── GUARD 6. DATABASE IDENTITY. THE ONE THAT MATTERS. ─────────────────────────────────────────
  // A Neon measurement branch is a copy-on-write clone: row counts and schema are IDENTICAL to
  // production, so no content check can tell them apart. The host is the only discriminator.
  //
  // ⚠️ A DENYLIST FIRST, BECAUSE AN ALLOWLIST OF TWO OPERATOR-SET VARIABLES CANNOT SAY WHICH SIDE
  // IS WRONG. The equality check compares two values the operator set and has no independent
  // knowledge of which endpoint is production. `forbiddenEndpoint` holds PRODUCTION's id and is
  // checked FIRST, so pointing the expected value at production still refuses. An ABSENT denylist
  // refuses too: a denylist that is not there is not a denylist.
  const forbidden = val(env.forbiddenEndpoint) ? normaliseEndpointId(val(env.forbiddenEndpoint)) : '';
  const expected = val(env.expectedEndpoint) ? normaliseEndpointId(val(env.expectedEndpoint)) : '';
  const actual = env.actualEndpoint ? normaliseEndpointId(env.actualEndpoint) : '';

  if (!forbidden) return refuse('no_denylist');
  if (actual && actual === forbidden) return refuse('forbidden_endpoint');
  if (!expected || !actual || expected !== actual) return refuse('endpoint_mismatch');

  // ── GUARD 7. THE MEASUREMENT BODY MUST EXIST. ─────────────────────────────────────────────────
  // See MEASUREMENT_INTEGRATION. On this branch it does not, and the instrument says so rather than
  // pretending a zero is a measurement.
  if (!MEASUREMENT_INTEGRATION.present) {
    return refuse('not_integrated', {
      note: 'Guardrails 1-3 measure telemetry writes; the telemetry modules are absent on this branch. '
        + 'No qualifying measurement can be taken from this build.',
    });
  }

  return { ok: true };
}

/**
 * The refusal words in the order their guards run.
 *
 * ⚠️ DERIVED BY EXECUTION, NOT WRITTEN DOWN TWICE. Each entry is produced by driving the real chain
 * with the environment that reaches exactly that guard, so the returned order IS the code's order.
 * A hand-maintained list would agree with `GUARDRAILS_R3_REFUSALS` and disagree with the function —
 * which is the failure the predecessor's misordered expiry actually was.
 */
export function refusalsInOrder(): GuardrailsR3Refusal[] {
  const BEFORE = Date.UTC(2026, 7, 25, 0, 0, 0);   // inside the window, before the freeze deadline
  const AFTER_FREEZE = Date.UTC(2026, 8, 10, 0, 0, 0);
  const AFTER_EXPIRY = EXPIRES_AT_UTC + 1;
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  const ok: GuardrailsR3Env = {
    vercelEnv: 'preview', gitRef: ONLY_REF, gitSha: SHA_A, qualifyingSha: SHA_A,
    armed: '1', expectedEndpoint: 'ep-branch', forbiddenEndpoint: 'ep-production',
    actualEndpoint: 'ep-branch',
  };
  const at = (e: Partial<GuardrailsR3Env>, now = BEFORE): GuardrailsR3Refusal => {
    const d = evaluateGuardrailsR3Request({ ...ok, ...e }, now);
    return d.ok ? ('not_integrated' as GuardrailsR3Refusal) : d.refused;
  };
  return [
    at({}, AFTER_EXPIRY),                       // expired
    at({ vercelEnv: 'production' }),            // not_preview
    at({ qualifyingSha: '' }, AFTER_FREEZE),    // freeze_deadline_passed
    at({ qualifyingSha: '' }),                  // not_qualified
    at({ gitSha: SHA_B }),                      // sha_mismatch
    at({ armed: '0' }),                         // not_armed
    at({ forbiddenEndpoint: '' }),              // no_denylist
    at({ actualEndpoint: 'ep-production' }),    // forbidden_endpoint
    at({ actualEndpoint: 'ep-other' }),         // endpoint_mismatch
    at({}),                                     // not_integrated
  ];
}
