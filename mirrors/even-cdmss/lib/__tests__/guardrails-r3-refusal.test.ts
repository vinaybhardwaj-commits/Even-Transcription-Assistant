/**
 * lib/__tests__/guardrails-r3-refusal.test.ts — every guard on the replacement instrument, proven
 * by refusing.
 *
 * ⚠️ THE ORDER IS THE PROOF, NOT A DETAIL. The predecessor's five guards were correct individually
 * and WRONG IN SEQUENCE: its expiry ran fifth, so its report's central claim — "after the expiry
 * every request is 410 whatever else is configured" — was false for any request that failed an
 * earlier guard. Nobody caught it for two passes, because the only way to see the order was to make
 * a request and read a status. Here the order is asserted directly.
 *
 * ⚠️ THE PURE CASES ARE NOT A CONVENIENCE. Guards 2-7 are a pure function of an environment
 * snapshot and a clock, so every refusal is reachable without a process, a socket or a clock stub.
 * The CHILD-PROCESS cases below are kept for what only they can prove — that the ROUTE actually
 * calls the chain, in that order, after admin, and that no refusal echoes a connection string.
 *
 * ⚠️ NO SOCKET IS OPENED, TO ANY HOST. Every case refuses before any database work, and the
 * measurement body does not exist on this branch at all (guard 7). `DATABASE_URL` in these cases is
 * a syntactically valid but entirely fictional endpoint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  ENV, EXPIRES_AT_UTC, FREEZE_DEADLINE_UTC, GUARDRAILS_R3_REFUSALS, GUARDRAILS_R3_ROUTE,
  MEASUREMENT_INTEGRATION, ONLY_REF, REFUSAL_STATUS,
  evaluateGuardrailsR3Request, normaliseEndpointId, refusalsInOrder,
  type GuardrailsR3Env,
} from '../guardrails-r3-core';

const SELF = fileURLToPath(import.meta.url);
const ROUTE_FILE = 'app/api/admin/telemetry-guardrails-r3/route.ts';

/** Block and line comments removed, string literals left alone. Enough for the source pins below,
 *  and the reason it exists at all is recorded on R3.11. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * ⚠️ FIXTURES OF THE REAL FORM, INCLUDING THE POOLED VARIANT. The predecessor's fixtures carried no
 * `-pooler`, so no test ever saw a realistic pooled host — and that is exactly why the endpoint
 * guard's blindness to Neon's pooled suffix survived two passes. A real connection string uses the
 * POOLED host, so the pooled form is the default here and the direct form is the variant. The
 * username is the real one for the same reason: a one-character username once hid a password leak,
 * because `u:` parses as a URL scheme.
 */
const BRANCH_ENDPOINT = 'ep-young-moon-aofuyr1u';
const PROD_ENDPOINT = 'ep-super-union-aoys3lle';
const FAKE_PASSWORD = 's3cr3t-p%40ssword';
const DB_USER = 'neondb_owner';
const hostFor = (label: string, pooled = true) =>
  `${label}${pooled ? '-pooler' : ''}.c-2.ap-southeast-1.aws.neon.tech`;
const urlFor = (label: string, pooled = true) =>
  `postgresql://${DB_USER}:${FAKE_PASSWORD}@${hostFor(label, pooled)}/neondb?sslmode=require`;
const FAKE_DB_URL = urlFor(BRANCH_ENDPOINT);

/** Anything that must never appear in any response, in any case. */
const SECRETS = [
  FAKE_DB_URL, DB_USER, FAKE_PASSWORD, 's3cr3t-p@ssword',
  'ap-southeast-1.aws.neon.tech', 'neondb', BRANCH_ENDPOINT, PROD_ENDPOINT,
];

const SHA_FROZEN = '4989fcbbe57232b569000f673418338b8644eba6';
const SHA_OTHER = '125de9b4ac2a7657439f912bf32b2514efeb4f3e';
/** Inside the window and before the freeze deadline. */
const NOW_OK = Date.UTC(2026, 7, 25, 12, 0, 0);

const PASSING: GuardrailsR3Env = {
  vercelEnv: 'preview', gitRef: ONLY_REF, gitSha: SHA_FROZEN, qualifyingSha: SHA_FROZEN,
  armed: '1', expectedEndpoint: BRANCH_ENDPOINT, forbiddenEndpoint: PROD_ENDPOINT,
  actualEndpoint: BRANCH_ENDPOINT,
};
const decide = (e: Partial<GuardrailsR3Env>, now = NOW_OK) =>
  evaluateGuardrailsR3Request({ ...PASSING, ...e }, now);
const refusalOf = (e: Partial<GuardrailsR3Env>, now = NOW_OK) => {
  const d = decide(e, now);
  return d.ok ? null : d.refused;
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE ORDER
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('R3.1 — the guards run in the committed order, derived by executing the chain', () => {
  // ⚠️ `refusalsInOrder()` DRIVES THE REAL CHAIN rather than restating a list, so this compares the
  // code's order against the declared one. A hand-written second copy would agree with the
  // declaration and could still disagree with the function — which is what the predecessor's
  // misordered expiry actually was.
  assert.deepEqual(refusalsInOrder(), [
    'expired',
    'not_preview',
    'freeze_deadline_passed',
    'not_qualified',
    'sha_mismatch',
    'not_armed',
    'no_denylist',
    'forbidden_endpoint',
    'endpoint_mismatch',
    'not_integrated',
  ]);
  // …and the declared vocabulary is exactly those plus the route-level admin refusal, so a guard
  // added to the chain without a word, or a word without a guard, is visible here.
  assert.deepEqual([...GUARDRAILS_R3_REFUSALS], ['unauthorized', ...refusalsInOrder()]);
});

test('R3.2 — THE EXPIRY IS SECOND: after it, EVERY authenticated request is 410 however configured', () => {
  const AFTER = EXPIRES_AT_UTC;                // the instant itself, not a millisecond later
  // Each of these fails a LATER guard too. Under the predecessor's ordering every one of them
  // returned 403 and the deadline meant nothing. All must be 410.
  const alsoBroken: Array<[string, Partial<GuardrailsR3Env>]> = [
    ['nothing else wrong', {}],
    ['not preview', { vercelEnv: 'production' }],
    ['wrong branch', { gitRef: 'main' }],
    ['no qualifying sha', { qualifyingSha: '' }],
    ['sha mismatch', { gitSha: SHA_OTHER }],
    ['not armed', { armed: '0' }],
    ['no denylist', { forbiddenEndpoint: '' }],
    ['pointed at production', { actualEndpoint: PROD_ENDPOINT }],
    ['everything wrong at once', {
      vercelEnv: 'production', gitRef: 'main', qualifyingSha: '', armed: '0',
      forbiddenEndpoint: '', actualEndpoint: PROD_ENDPOINT,
    }],
  ];
  for (const [label, env] of alsoBroken) {
    const d = decide(env, AFTER);
    assert.equal(d.ok, false, label);
    assert.equal(d.ok === false && d.refused, 'expired', `${label}: must be the EXPIRY, not a later guard`);
    assert.equal(d.ok === false && d.status, 410, `${label}: 410, not 403`);
  }
  // The expiry is INCLUSIVE of its instant, and one millisecond earlier is a different answer —
  // so the boundary is asserted rather than assumed.
  assert.notEqual(refusalOf({}, EXPIRES_AT_UTC - 1), 'expired');
  assert.equal(refusalOf({}, EXPIRES_AT_UTC), 'expired');
});

test('R3.3 — the expiry is 2026-09-15T00:00:00Z and the freeze deadline is 2026-09-08T00:00:00Z', () => {
  assert.equal(new Date(EXPIRES_AT_UTC).toISOString(), '2026-09-15T00:00:00.000Z');
  assert.equal(new Date(FREEZE_DEADLINE_UTC).toISOString(), '2026-09-08T00:00:00.000Z');
  // The ledger's clock: the freeze deadline is a week BEFORE the expiry, not after it. A deadline
  // that fell later would be unreachable and the instrument would look governed while it was not.
  assert.ok(FREEZE_DEADLINE_UTC < EXPIRES_AT_UTC);
  assert.equal((EXPIRES_AT_UTC - FREEZE_DEADLINE_UTC) / 86_400_000, 7);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. EACH GUARD REFUSES
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('R3.4 — guard 3, preview and branch: production, a promoted build, and any other ref refuse', () => {
  assert.equal(refusalOf({ vercelEnv: 'production' }), 'not_preview');
  assert.equal(refusalOf({ vercelEnv: '' }), 'not_preview');
  assert.equal(refusalOf({ vercelEnv: undefined }), 'not_preview');
  // THE PROMOTION HAZARD, which is why the ref guard is not redundant with the environment label:
  // a Preview build carries VERCEL_ENV=preview baked in and can be promoted to serve production.
  // The label alone still says 'preview'; the ref is what refuses.
  assert.equal(refusalOf({ gitRef: 'main' }), 'not_preview');
  assert.equal(refusalOf({ gitRef: 'exp/rerank-telemetry' }), 'not_preview');
  assert.equal(refusalOf({ gitRef: `${ONLY_REF}-2` }), 'not_preview');
  assert.equal(refusalOf({ gitRef: undefined }), 'not_preview');
});

test('R3.5 — guard 4, qualification: the frozen SHA is EXACT, and a prefix is never accepted', () => {
  // Absent expectation refuses, before the deadline, with the word that says "freeze it and set it".
  assert.equal(refusalOf({ qualifyingSha: '' }), 'not_qualified');
  assert.equal(refusalOf({ qualifyingSha: undefined }), 'not_qualified');
  assert.equal(refusalOf({ qualifyingSha: '   ' }), 'not_qualified', 'whitespace is not a SHA');

  // ⚠️ NO PREFIX MATCHING, IN EITHER DIRECTION. The convenient thing — accepting the short SHA an
  // operator reads off a deployment page — is the hazard: a 7-character prefix names one commit
  // today and can name two later, and "the qualifying SHA" would then be a set rather than an
  // object. Both a short expectation and a short build SHA refuse.
  assert.equal(refusalOf({ qualifyingSha: SHA_FROZEN.slice(0, 7) }), 'sha_mismatch');
  assert.equal(refusalOf({ gitSha: SHA_FROZEN.slice(0, 7) }), 'sha_mismatch');
  assert.equal(refusalOf({ qualifyingSha: SHA_FROZEN.slice(0, 39) }), 'sha_mismatch');
  assert.equal(refusalOf({ qualifyingSha: `${SHA_FROZEN}0` }), 'sha_mismatch');
  // A different commit refuses.
  assert.equal(refusalOf({ gitSha: SHA_OTHER }), 'sha_mismatch');
  // An ABSENT build SHA is not a wildcard.
  assert.equal(refusalOf({ gitSha: '' }), 'sha_mismatch');
  assert.equal(refusalOf({ gitSha: undefined }), 'sha_mismatch');
  // Case and shape are enforced: an uppercase or non-hex value is malformed, not repaired.
  assert.equal(refusalOf({ qualifyingSha: SHA_FROZEN.toUpperCase(), gitSha: SHA_FROZEN.toUpperCase() }), 'sha_mismatch');
  assert.equal(refusalOf({ qualifyingSha: 'z'.repeat(40), gitSha: 'z'.repeat(40) }), 'sha_mismatch');
  // The matching pair passes this guard and is stopped by a LATER one, proving the guard is not
  // simply always-refusing.
  assert.equal(refusalOf({}), 'not_integrated');
});

test('R3.6 — guard 4: past the FREEZE DEADLINE an unset SHA gets its own word, not the ordinary one', () => {
  // The ledger: "If the qualifying SHA is not frozen by 2026-09-08T00:00:00Z, it is deleted and
  // disarmed and a newly dated authorization is requested — it is not silently extended."
  // Two words because they call for two different actions, which is the whole mechanism.
  assert.equal(refusalOf({ qualifyingSha: '' }, FREEZE_DEADLINE_UTC - 1), 'not_qualified');
  assert.equal(refusalOf({ qualifyingSha: '' }, FREEZE_DEADLINE_UTC), 'freeze_deadline_passed');
  assert.equal(refusalOf({ qualifyingSha: '' }, FREEZE_DEADLINE_UTC + 86_400_000), 'freeze_deadline_passed');
  // …but a SHA already frozen BEFORE the deadline keeps working right up to the expiry. The freeze
  // deadline governs freezing, not measuring.
  assert.equal(refusalOf({}, FREEZE_DEADLINE_UTC + 1), 'not_integrated');
  assert.equal(refusalOf({}, EXPIRES_AT_UTC - 1), 'not_integrated');
});

test('R3.7 — guard 5, armed: anything but the exact string "1" refuses', () => {
  for (const v of ['0', '', 'true', 'yes', 'on', ' 1 x', undefined]) {
    assert.equal(refusalOf({ armed: v }), 'not_armed', `armed=${String(v)}`);
  }
  // A padded "1" is accepted, because the value is trimmed — and that is asserted rather than
  // left to chance, since an operator pasting into a Vercel field is the normal case.
  assert.equal(refusalOf({ armed: ' 1 ' }), 'not_integrated');
});

test('R3.8 — guard 6, database identity: the denylist is checked FIRST and its absence refuses', () => {
  // An ABSENT denylist refuses: a denylist that is not there is not a denylist.
  assert.equal(refusalOf({ forbiddenEndpoint: '' }), 'no_denylist');
  assert.equal(refusalOf({ forbiddenEndpoint: undefined }), 'no_denylist');

  // ⚠️ THE DENYLIST WINS OVER THE ALLOWLIST, AND THAT IS THE POINT. The equality check compares two
  // values the OPERATOR set and has no independent knowledge of which endpoint is production. If
  // someone points the expected value at production — the natural move when debugging late is to
  // change the variable you just added — this still refuses.
  assert.equal(
    refusalOf({ expectedEndpoint: PROD_ENDPOINT, actualEndpoint: PROD_ENDPOINT }),
    'forbidden_endpoint',
    'aiming the expectation at production must still refuse',
  );
  assert.equal(refusalOf({ actualEndpoint: PROD_ENDPOINT }), 'forbidden_endpoint');

  // Mismatch, absent expectation and an unparseable connection string all refuse. Every failure
  // direction is "do not run".
  assert.equal(refusalOf({ actualEndpoint: 'ep-third-party-000000' }), 'endpoint_mismatch');
  assert.equal(refusalOf({ expectedEndpoint: '' }), 'endpoint_mismatch');
  assert.equal(refusalOf({ actualEndpoint: null }), 'endpoint_mismatch');
});

test('R3.9 — guard 6: the POOLED and DIRECT forms are the same endpoint, on BOTH sides', () => {
  // The predecessor shipped blind to Neon's `-pooler` suffix and the gap survived two passes,
  // because no fixture carried a pooled host. Both directions are pinned here.
  assert.equal(normaliseEndpointId(`${BRANCH_ENDPOINT}-pooler`), BRANCH_ENDPOINT);
  assert.equal(normaliseEndpointId(BRANCH_ENDPOINT), BRANCH_ENDPOINT);
  assert.equal(normaliseEndpointId(`  ${BRANCH_ENDPOINT.toUpperCase()}-POOLER `), BRANCH_ENDPOINT);
  // An operator who sets either form gets identical behaviour…
  assert.equal(refusalOf({ expectedEndpoint: `${BRANCH_ENDPOINT}-pooler` }), 'not_integrated');
  assert.equal(refusalOf({ actualEndpoint: `${BRANCH_ENDPOINT}-pooler` }), 'not_integrated');
  // …and the DENYLIST catches BOTH forms of production, which is the half that actually protects.
  assert.equal(refusalOf({ actualEndpoint: `${PROD_ENDPOINT}-pooler` }), 'forbidden_endpoint');
  assert.equal(
    refusalOf({ forbiddenEndpoint: `${PROD_ENDPOINT}-pooler`, actualEndpoint: PROD_ENDPOINT }),
    'forbidden_endpoint',
  );
});

test('R3.10 — guard 7: a fully configured, fully authorised request STILL cannot measure', () => {
  // ⚠️ THIS IS THE ONE THAT MAKES "NO QUALIFYING MEASUREMENT" A PROPERTY OF THE CODE. Everything
  // else passes: preview, the right branch, the frozen SHA matching exactly, armed, the branch
  // database, inside the window. The instrument still refuses, because guardrails 1-3 measure
  // telemetry writes and the telemetry modules do not exist on this branch.
  assert.equal(MEASUREMENT_INTEGRATION.present, false);
  const d = decide({});
  assert.equal(d.ok, false);
  assert.equal(d.ok === false && d.refused, 'not_integrated');
  // 501, not 403: "this build CANNOT", not "you may not". They call for opposite actions and an
  // operator must be able to tell them apart.
  assert.equal(d.ok === false && d.status, 501);
  assert.equal(REFUSAL_STATUS.not_integrated, 501);
  assert.notEqual(REFUSAL_STATUS.not_integrated, REFUSAL_STATUS.not_armed);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE ROUTE ITSELF — what only a request can show
// ════════════════════════════════════════════════════════════════════════════════════════════════

const BASE_ENV: Record<string, string> = {
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: ONLY_REF,
  VERCEL_GIT_COMMIT_SHA: SHA_FROZEN,
  [ENV.qualifyingSha]: SHA_FROZEN,
  [ENV.armed]: '1',
  [ENV.expectedEndpoint]: BRANCH_ENDPOINT,
  [ENV.forbiddenEndpoint]: PROD_ENDPOINT,
  DATABASE_URL: FAKE_DB_URL,
};

interface ChildResult { status: number; body: Record<string, unknown>; allOutput: string }

/** One request, in a fresh process, with its own environment and clock. */
function runRouteChild(env: Record<string, string | undefined>, now?: number): ChildResult {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...BASE_ENV, ...env })) {
    if (v !== undefined) childEnv[k] = String(v);
  }
  // An explicit `undefined` means UNSET, which is a different case from "set to empty".
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];
  // ⚠️ THE TEST RUNNER'S OWN VARIABLES MUST NOT REACH THE CHILD. `NODE_TEST_CONTEXT` is what tells
  // a node process it is a test-runner child; inherited, it makes the child re-enter the runner and
  // re-execute this whole file under the V8 serialization protocol instead of running the request.
  // The symptom is a child that emits binary test events and no RESULT line, which reads like a
  // crash and is not one.
  for (const k of Object.keys(childEnv)) if (k.startsWith('NODE_TEST_')) delete childEnv[k];
  const args = ['--import', 'tsx', SELF, '--route-child'];
  if (now !== undefined) args.push(`--now=${now}`);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: childEnv as NodeJS.ProcessEnv });
  const allOutput = `${r.stdout || ''}\n${r.stderr || ''}`;
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `child produced no RESULT line.\nstdout:${r.stdout}\nstderr:${r.stderr}`);
  const parsed = JSON.parse(line.slice('RESULT '.length)) as { status: number; body: Record<string, unknown> };
  return { status: parsed.status, body: parsed.body, allOutput };
}

async function runChild(): Promise<void> {
  const nowArg = process.argv.find((a) => a.startsWith('--now='));
  if (nowArg) {
    const fixed = Number(nowArg.slice('--now='.length));
    Date.now = () => fixed;                      // before the route is imported
  }
  const { NextRequest } = await import('next/server');
  const { POST } = await import(`../../${ROUTE_FILE}`);
  const res = await (POST as (r: unknown) => Promise<Response>)(
    new NextRequest(`https://cdmss.invalid${GUARDRAILS_R3_ROUTE}`, { method: 'POST' }));
  let body: unknown = null;
  try { body = await res.json(); } catch { body = { unparseable: true }; }
  process.stdout.write(`RESULT ${JSON.stringify({ status: res.status, body })}\n`);
}

if (process.argv.includes('--route-child')) {
  void runChild().catch((e) => {
    process.stdout.write(`RESULT ${JSON.stringify({ status: -1, body: { childThrew: String((e as Error).message) } })}\n`);
  });
} else {
  test('R3.11 — the ROUTE refuses on admin FIRST, and never consults the admin cookie', () => {
    const r = runRouteChild({ ADMIN_TOKEN: 'a-token-not-presented' });
    assert.equal(r.status, 401);
    // ⚠️ THE SOURCE CLAIM ALONGSIDE THE BEHAVIOUR, because no request can prove a branch that is
    // not there. The migration route admits an admin browser SESSION via the cookie; this route
    // must not, because that turns a credential into a session.
    // ⚠️ CHECKED ON CODE, NOT ON PROSE — and this test failed first on exactly that. The route's
    // own comment explains WHY it omits the migration route's `|| isAdminUnlocked()` clause, so it
    // NAMES the function, and a raw-text search read that explanation as the defect it warns
    // against. The predecessor recorded hitting this same trap and it still caught me. Comments are
    // stripped before the scan; the surviving text is what executes.
    const raw = readFileSync(ROUTE_FILE, 'utf8');
    const code = stripComments(raw);
    assert.equal(/isAdminUnlocked/.test(code), false, 'the route must not consult the admin cookie');
    assert.ok(/isAdminUnlocked/.test(raw), 'the comment explaining the omission is still there');
    assert.match(code, /const denied = requireAdmin\(req\);\n\s*if \(denied\) return denied;/);
    // …and admin runs BEFORE the chain: the call to requireAdmin precedes the call to the chain.
    assert.ok(code.indexOf('requireAdmin(req)') < code.indexOf('evaluateGuardrailsR3Request('),
      'authentication must precede the guard chain');
  });

  test('R3.12 — the ROUTE returns 410 after the expiry, on an otherwise perfect request', () => {
    const r = runRouteChild({}, EXPIRES_AT_UTC);
    assert.equal(r.status, 410);
    assert.equal(r.body.refused, 'expired');
    assert.equal(r.body.expired_at, '2026-09-15T00:00:00.000Z');
  });

  test('R3.13 — the ROUTE reaches guard 7 and refuses 501 when everything else is correct', () => {
    const r = runRouteChild({}, NOW_OK);
    assert.equal(r.status, 501, 'a fully configured request still cannot measure');
    assert.equal(r.body.refused, 'not_integrated');
    assert.equal(r.body.instrument, 'telemetry-guardrails-r3');
    assert.equal(r.body.expires_at, '2026-09-15T00:00:00.000Z');
    assert.equal(r.body.freeze_deadline, '2026-09-08T00:00:00.000Z');
  });

  test('R3.14 — the ROUTE parses the endpoint out of a REAL connection string, and refuses on a bad one', () => {
    // The pooled branch host is accepted and reaches guard 7…
    assert.equal(runRouteChild({ DATABASE_URL: urlFor(BRANCH_ENDPOINT) }, NOW_OK).body.refused, 'not_integrated');
    assert.equal(runRouteChild({ DATABASE_URL: urlFor(BRANCH_ENDPOINT, false) }, NOW_OK).body.refused, 'not_integrated');
    // …production is refused by the DENYLIST, in both forms…
    assert.equal(runRouteChild({ DATABASE_URL: urlFor(PROD_ENDPOINT) }, NOW_OK).body.refused, 'forbidden_endpoint');
    assert.equal(runRouteChild({ DATABASE_URL: urlFor(PROD_ENDPOINT, false) }, NOW_OK).body.refused, 'forbidden_endpoint');
    // ⚠️ AND THE `@` SEARCH IS SCOPED TO THE AUTHORITY. A query parameter carrying an `@` must not
    // move the parsed host while the driver connects somewhere else entirely — the exact defect
    // fixed in the predecessor under review.
    const smuggled = `${urlFor(BRANCH_ENDPOINT)}&opt=user@${hostFor(PROD_ENDPOINT)}`;
    assert.equal(runRouteChild({ DATABASE_URL: smuggled }, NOW_OK).body.refused, 'not_integrated');
    // The three ordinary paste mistakes all refuse rather than being repaired.
    for (const bad of [
      `${DB_USER}:${FAKE_PASSWORD}@${hostFor(BRANCH_ENDPOINT)}/neondb`,   // dropped scheme
      `"${FAKE_DB_URL}"`,                                                 // wrapped in quotes
      `psql ${FAKE_DB_URL}`,                                              // leading psql
    ]) {
      assert.equal(runRouteChild({ DATABASE_URL: bad }, NOW_OK).body.refused, 'endpoint_mismatch');
    }
  });

  test('R3.15 — NO RESPONSE, ON ANY PATH, CARRIES ANY PART OF THE CONNECTION STRING', () => {
    // ⚠️ STDOUT AND STDERR TOO, NOT JUST THE BODY. The predecessor's first version searched only
    // the parsed result, so a driver message printed by a console.error would have passed unnoticed.
    const cases: Array<[string, Record<string, string | undefined>, number | undefined]> = [
      ['expired', {}, EXPIRES_AT_UTC],
      ['not_preview', { VERCEL_ENV: 'production' }, NOW_OK],
      ['not_qualified', { [ENV.qualifyingSha]: undefined }, NOW_OK],
      ['sha_mismatch', { VERCEL_GIT_COMMIT_SHA: SHA_OTHER }, NOW_OK],
      ['not_armed', { [ENV.armed]: '0' }, NOW_OK],
      ['no_denylist', { [ENV.forbiddenEndpoint]: undefined }, NOW_OK],
      ['forbidden_endpoint', { DATABASE_URL: urlFor(PROD_ENDPOINT) }, NOW_OK],
      ['endpoint_mismatch', { DATABASE_URL: `"${FAKE_DB_URL}"` }, NOW_OK],
      ['not_integrated', {}, NOW_OK],
    ];
    for (const [label, env, now] of cases) {
      const r = runRouteChild(env, now);
      const hay = `${JSON.stringify(r.body)}\n${r.allOutput}`;
      for (const secret of SECRETS) {
        assert.equal(hay.includes(secret), false, `${label}: response or output leaked ${secret.slice(0, 24)}…`);
      }
    }
  });
}
