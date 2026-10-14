/**
 * app/api/admin/telemetry-guardrails-r3/route.ts — the REPLACEMENT guardrail instrument.
 *
 * ── WHAT THIS REPLACES, AND WHY ─────────────────────────────────────────────────────────────────
 * `app/api/admin/telemetry-overhead/route.ts` took the first three overhead guardrails from a
 * Vercel Preview against a non-production Neon branch. It carried a hard expiry as its own deletion
 * mechanism, that expiry passed on 2026-08-20, and the route then returned 410 on every
 * authenticated request and turned the branch red until Rep 42 authorised its deletion (`07452bb`).
 *
 * The expiry worked. The deletion did not follow. This instrument is built on the assumption that
 * the same will be true again, so every control here is a mechanism rather than an intention.
 *
 * ── THE GUARDS, IN THE ORDER THEY RUN ───────────────────────────────────────────────────────────
 *   1. admin          `requireAdmin` ALONE — no `isAdminUnlocked()` clause
 *   2. expiry         2026-09-15T00:00:00Z, 410 — SECOND, immediately after authentication
 *   3. preview        VERCEL_ENV === 'preview' AND VERCEL_GIT_COMMIT_REF === 'guardrails-r3'
 *   4. qualification  the FROZEN measurement SHA, compared EXACTLY
 *   5. armed          CDMSS_GUARDRAILS_R3_MEASURE === '1'
 *   6. db identity    NOT the forbidden endpoint, AND equal to the expected one
 *   7. integration    the measurement body must exist on this branch — see below
 *
 * Guards 2-7 are `evaluateGuardrailsR3Request` in `lib/guardrails-r3-core.ts`, which is PURE and
 * has zero outbound imports. Guard 1 is here because it needs the request. That split is the whole
 * design: the predecessor's guard ORDER could only be observed by making requests and reading
 * statuses, and its misordered expiry survived review twice. Here the order is a value the refusal
 * tests assert directly, and this file cannot reorder it because it only calls the chain once.
 *
 * ⚠️ WHY EXPIRY IS SECOND AND NOT LAST. The predecessor's report claimed "after the expiry every
 * request is 410 whatever else is configured" while its expiry ran fifth — so a request failing an
 * earlier guard got a 403 and never saw the 410. Second is the first position that makes the claim
 * true. It is the position, not the date, that makes a deletion deadline mean anything.
 *
 * ⚠️ THIS BUILD CANNOT MEASURE, BY CONSTRUCTION. Guardrails 1-3 measure telemetry writes, and the
 * telemetry modules do not exist on this branch — see `MEASUREMENT_INTEGRATION`. Guard 7 returns
 * **501 `not_integrated`**, so "no qualifying measurement is taken" is a property of the code and
 * not of anyone's restraint. Rep 41 permits design, fixtures, refusal tests and dry runs in
 * parallel with the proof programme; it permits no measurement, and this instrument enforces that
 * against its own operator.
 *
 * ⚠️ NOTHING HERE EVER LOGS, ECHOES OR RETURNS ANY PART OF `DATABASE_URL`, including inside an
 * error. The predecessor leaked a password through a driver's error object twice before that rule
 * was written down. The connection string is parsed by hand, never by `new URL` — which throws on
 * some real strings and retains the input on its error — and only ONE WORD is ever returned.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import {
  ENV, EXPIRES_AT_UTC, FREEZE_DEADLINE_UTC, MEASUREMENT_INTEGRATION,
  evaluateGuardrailsR3Request,
} from '@/lib/guardrails-r3-core';

export const runtime = 'nodejs';
export const maxDuration = 800;

/**
 * The Neon endpoint id out of `DATABASE_URL`, or null.
 *
 * ⚠️ PARSED BY HAND, AND NOTHING PARSED IS EVER RETURNED. Kept from the predecessor because the
 * reasoning is unchanged and it was fixed twice under review:
 *
 *  - `new URL` is not used. It throws on connection strings that the driver accepts, and its error
 *    object retains the input — which is how the 500 body leaked the password.
 *  - The `@` search is SCOPED TO THE AUTHORITY. Taking the last `@` in the whole string let a query
 *    parameter move the parsed host while the driver connected somewhere else entirely.
 *  - Any shape this does not recognise returns null, and guard 6 treats null as a REFUSAL rather
 *    than as a pass.
 */
function neonEndpointId(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // ⚠️ THE SCHEME IS ANCHORED AT THE START, NOT MERELY PRESENT. Found by the refusal tests: with a
  // bare `indexOf('://')`, a value wrapped in quotes (`"postgresql://…"`) or pasted with its
  // command (`psql postgresql://…`) parsed CLEANLY and the guard reported a matching endpoint —
  // for a string the driver could never connect with. That is not a production-safety hole, since
  // the denylist still refuses, but a guard that "recognises" a string nothing can use is reporting
  // on something that will not happen. Anything not starting with a real scheme is unparseable.
  const m = /^(postgres|postgresql):\/\//.exec(s);
  if (!m) return null;
  const afterScheme = s.slice(m[0].length);
  // The authority ends at the first '/', '?' or '#'. Everything after it is out of scope.
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd < 0 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const at = authority.lastIndexOf('@');
  const hostPort = at < 0 ? authority : authority.slice(at + 1);
  const host = hostPort.split(':')[0];
  if (!host) return null;
  const label = host.split('.')[0];
  // A Neon endpoint id is `ep-<words>-<id>`, optionally `-pooler`. Anything else is not one.
  return /^ep-[a-z0-9-]+$/i.test(label) ? label : null;
}

export async function POST(req: NextRequest) {
  // ── GUARD 1. ADMIN, AND ONLY ADMIN. ───────────────────────────────────────────────────────────
  // Deliberately NOT the migration route's `|| isAdminUnlocked()`: that turns a credential into a
  // browser session. Kept as the predecessor had it, for the reason the predecessor gave.
  const denied = requireAdmin(req);
  if (denied) return denied;

  // ── GUARDS 2-7, IN ONE CALL. ──────────────────────────────────────────────────────────────────
  // The chain is pure and lives in lib/. This route cannot reorder it, skip one, or add a seventh
  // in the middle, because it does not contain them.
  const decision = evaluateGuardrailsR3Request({
    vercelEnv: process.env.VERCEL_ENV,
    gitRef: process.env.VERCEL_GIT_COMMIT_REF,
    gitSha: process.env.VERCEL_GIT_COMMIT_SHA,
    qualifyingSha: process.env[ENV.qualifyingSha],
    armed: process.env[ENV.armed],
    expectedEndpoint: process.env[ENV.expectedEndpoint],
    forbiddenEndpoint: process.env[ENV.forbiddenEndpoint],
    // Parsed HERE and passed as a bare label. The core never receives the connection string, so it
    // cannot leak what it was never given.
    actualEndpoint: neonEndpointId(process.env.DATABASE_URL),
  }, Date.now());

  if (!decision.ok) {
    const { refused, status, expiredAt, note } = decision;
    return NextResponse.json({
      ok: false, refused,
      ...(expiredAt ? { expired_at: expiredAt } : {}),
      ...(note ? { note } : {}),
      // Provenance an operator can act on WITHOUT naming a host, a SHA or a connection string.
      instrument: 'telemetry-guardrails-r3',
      expires_at: new Date(EXPIRES_AT_UTC).toISOString(),
      freeze_deadline: new Date(FREEZE_DEADLINE_UTC).toISOString(),
    }, { status });
  }

  // ══ ALL SEVEN GUARDS PASSED. ══════════════════════════════════════════════════════════════════
  // ⚠️ UNREACHABLE ON THIS BRANCH, and that is asserted rather than assumed: guard 7 refuses while
  // `MEASUREMENT_INTEGRATION.present` is false, and it is false here. This block exists so the
  // integration point is a named place in the file rather than a paragraph in a report.
  //
  // AT INTEGRATION, on a branch where the telemetry modules exist, guardrails 1-3 are taken here:
  //   1. start-write latency     — `declareRetrievals`, the durable start, round-tripped
  //   2. terminal-write latency  — `writeRetrievalTerminal`
  //   3. manifest size           — `buildRetrievalPayload`, in UTF-16 units AND UTF-8 bytes
  // over the synthetic, text-free fixtures and seeds in `lib/guardrails-r3-fixtures.ts`, reported
  // through `summariseSamples` with p95/p99 WITHHELD below their minimum n.
  //
  // Guardrail 4 (retrieval wall time) is `scripts/guardrails-r3/paired-runner.mjs` and guardrail 5
  // (audit completion rate) is `scripts/guardrails-r3/synthetic-audit-runner.mjs`. Neither needs
  // this route, neither needs a deployment, and both run locally today.
  return NextResponse.json({
    ok: false, refused: 'not_integrated', instrument: 'telemetry-guardrails-r3',
    note: 'unreachable: guard 7 refuses while the measurement body is absent',
  }, { status: 501 });
}
