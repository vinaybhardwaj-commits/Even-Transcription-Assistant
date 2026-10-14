/**
 * lib/__tests__/telemetry-overhead-guard.test.ts — the five guards on the temporary measurement
 * route, each proven by execution (addendum v4 §3, §6, §10).
 *
 * ⚠️ EVERY CASE RUNS IN A CHILD PROCESS. Three of the five guards read `process.env` at request
 * time and one reads the clock, and a serverless request IS one process — so a case that mutated
 * `process.env` in the shared test process would prove less and could leak into its neighbours.
 * Each child gets its own environment, and guard 5's child gets its own `Date.now`.
 *
 * ⚠️ NO SOCKET IS OPENED, TO ANY HOST. The child installs `telemetry-db-stub`, which replaces
 * `globalThis.fetch` — the transport the Neon driver uses — before the route runs. So even the
 * all-guards-pass case, which proceeds into the DDL and a measurement cell, never leaves the
 * process. `DATABASE_URL` in these cases is a syntactically valid but entirely fictional endpoint.
 *
 * ⚠️ THE ROUTE THIS TESTS IS TEMPORARY AND IS OWED A DELETION (addendum v4 §12). When
 * `app/api/admin/telemetry-overhead/route.ts` goes, this file goes with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

/**
 * ⚠️ FIXTURES OF THE REAL FORM, INCLUDING THE POOLED VARIANT (addendum v6 fix 3).
 *
 * The previous fixtures were `ep-measure-branch-000001` and `ep-production-primary-999999`. Neither
 * carries `-pooler`, so no test ever saw a realistic pooled host — and that is exactly why the
 * endpoint guard's blindness to Neon's pooled suffix was invisible for two passes. A real Neon host
 * is `ep-<label>[-pooler].c-2.<region>.aws.neon.tech`, and a real connection string uses the POOLED
 * one, so the pooled form is the default here and the direct form is the variant.
 *
 * Same shape of error as the one-character username `u` in pass 5, which hid the password leak
 * because `u:` parses as a URL scheme. Twice running, an unrealistic fixture hid a real behaviour.
 * The username below is the real one for the same reason.
 */
const FAKE_ENDPOINT = 'ep-young-moon-aofuyr1u';
const OTHER_ENDPOINT = 'ep-super-union-aoys3lle';
const FAKE_PASSWORD = 's3cr3t-p%40ssword';
const DB_USER = 'neondb_owner';

/** `ep-<label>[-pooler].c-2.ap-southeast-1.aws.neon.tech` — the real host shape. */
const hostFor = (label: string, pooled = true) =>
  `${label}${pooled ? '-pooler' : ''}.c-2.ap-southeast-1.aws.neon.tech`;
const urlFor = (label: string, pooled = true) =>
  `postgresql://${DB_USER}:${FAKE_PASSWORD}@${hostFor(label, pooled)}/neondb?sslmode=require`;

/** The default: the BRANCH, on its POOLED host, which is what an operator actually pastes. */
const FAKE_DB_URL = urlFor(FAKE_ENDPOINT);

/**
 * The three ordinary paste mistakes that made the old 500 body leak the password (v5 fix 1).
 * Measured against the real driver: the first two put the WHOLE connection string into `neon()`'s
 * throw; the third throws a format template carrying no user data.
 */
const UNPARSEABLE = {
  'dropped scheme': `${DB_USER}:${FAKE_PASSWORD}@${hostFor(FAKE_ENDPOINT)}/neondb`,
  'wrapped in quotes': `"${FAKE_DB_URL}"`,
  'leading psql': `psql ${FAKE_DB_URL}`,
};

/** The parts of the connection string that must never appear in any response, in any case. */
const SECRETS = [
  FAKE_DB_URL, DB_USER, FAKE_PASSWORD, 's3cr3t-p@ssword',
  'ap-southeast-1.aws.neon.tech', 'neondb', FAKE_ENDPOINT,
];

const BASE_ENV = {
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'exp/rerank-telemetry',
  CDMSS_OVERHEAD_MEASURE: '1',
  CDMSS_OVERHEAD_DB_ENDPOINT: FAKE_ENDPOINT,
  CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT: OTHER_ENDPOINT,
  DATABASE_URL: FAKE_DB_URL,
};

interface ChildResult {
  status: number;
  body: Record<string, unknown>;
  raw: string;
  /** ⚠️ EVERYTHING the child emitted. v5 §11 requires the leak check to search stdout and stderr
   *  too — the first version searched only the parsed RESULT line, so a driver message printed by a
   *  `console.error` would have passed unnoticed. */
  allOutput: string;
}

/** Run one request in a fresh process with the given environment. */
function runGuardChild(
  env: Record<string, string | undefined>,
  args: string[] = [],
  query = '',
): ChildResult {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...BASE_ENV, ...env })) {
    if (v !== undefined) childEnv[k] = String(v);
  }
  // An explicit `undefined` in `env` means UNSET, which is a distinct case from "set to empty".
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete childEnv[k];

  const childArgs = ['--import', 'tsx', SELF, '--guard-child', ...args];
  if (query) childArgs.push(`--query=${query}`);
  const r = spawnSync(process.execPath, childArgs, {
    encoding: 'utf8', env: childEnv as unknown as NodeJS.ProcessEnv,
  });
  const allOutput = `${r.stdout || ''}\n${r.stderr || ''}`;
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `child produced no RESULT line.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const parsed = JSON.parse(line.slice('RESULT '.length)) as { status: number; body: Record<string, unknown> };
  return { status: parsed.status, body: parsed.body, raw: line, allOutput };
}

// ── the child ──────────────────────────────────────────────────────────────────────────────────
async function runChild(): Promise<void> {
  const nowArg = process.argv.find((a) => a.startsWith('--now='));
  if (nowArg) {
    const fixed = Number(nowArg.slice('--now='.length));
    Date.now = () => fixed;                       // guard 5's clock, before the route is imported
  }
  const { installDbStub } = await import('./telemetry-db-stub.ts');
  installDbStub();                                // replaces globalThis.fetch — no socket, ever
  const { NextRequest } = await import('next/server');
  const { POST } = await import('../../app/api/admin/telemetry-overhead/route.ts');

  const q = process.argv.find((a) => a.startsWith('--query='));
  const url = `https://cdmss.invalid/api/admin/telemetry-overhead?${q ? q.slice('--query='.length) : 'cell=declare&max=8&n=2'}`;
  const res = await POST(new NextRequest(url, { method: 'POST' }));
  let body: unknown = null;
  try { body = await res.json(); } catch { body = { unparseable: true }; }
  process.stdout.write(`RESULT ${JSON.stringify({ status: res.status, body })}\n`);
}

if (process.argv.includes('--guard-child')) {
  void runChild().catch((e) => {
    process.stdout.write(`RESULT ${JSON.stringify({ status: -1, body: { childThrew: String((e as Error).message) } })}\n`);
  });
} else {
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The five guards
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  test('GUARD 1 — admin: a set ADMIN_TOKEN with nothing presented is refused, and isAdminUnlocked is NOT consulted', () => {
    const r = runGuardChild({ ADMIN_TOKEN: 'a-token-not-presented' });
    assert.equal(r.status, 401);
    // ⚠️ THE SOURCE CLAIM ALONGSIDE THE BEHAVIOUR. The migration route admits an admin browser
    // session via the admin cookie; this route must not, because that turns a credential into a
    // session. Asserted as an absence, since no request can prove a branch that is not there.
    //
    // ⚠️ AND IT IS CHECKED ON CODE, NOT ON PROSE. The route's own comment explains WHY it omits
    // that clause, so it names the function — and a raw-text search read that explanation as the
    // defect it warns against. Found by running it. This is the third time in this workstream a
    // text-level check has had to decide whether comments are in scope: the import scanner in pass
    // 1, the call-form pin in pass 2, and this.
    const code = readRouteCode();
    assert.equal(/isAdminUnlocked/.test(code), false, 'the route must not consult the admin cookie');
    assert.match(code, /const denied = requireAdmin\(req\);\n\s*if \(denied\) return denied;/);
  });

  test('GUARD 3 — preview: VERCEL_ENV=production is refused even with everything else correct', () => {
    const r = runGuardChild({ VERCEL_ENV: 'production' });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'not_preview');
  });

  test('GUARD 3 — preview: VERCEL_ENV=preview on a DIFFERENT branch is refused', () => {
    // The clause that matters: a Preview build carries VERCEL_ENV=preview baked in and can later be
    // PROMOTED to production, which would serve production traffic from a build the environment
    // label alone would admit.
    const r = runGuardChild({ VERCEL_GIT_COMMIT_REF: 'main' });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'not_preview');
  });

  test('GUARD 4 — arming: an unset CDMSS_OVERHEAD_MEASURE is refused', () => {
    const r = runGuardChild({ CDMSS_OVERHEAD_MEASURE: undefined });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'not_armed');
  });

  test('GUARD 5 — THE ONE THAT MATTERS: a production endpoint id is refused', () => {
    // Pointed at a different database with every other guard satisfied. The branch is a
    // copy-on-write clone, so row counts and schema are identical and no CONTENT check could tell
    // these apart — the host is the only discriminator.
    const r = runGuardChild({ CDMSS_OVERHEAD_DB_ENDPOINT: OTHER_ENDPOINT });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'endpoint_mismatch');
    assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'refused'], 'and nothing else is returned');
  });

  test('GUARD 5 — an UNSET expectation refuses, it does not pass', () => {
    // The failure direction is always "do not run". An absent expectation is the shape a
    // half-configured preview has, and it must not be the shape that opens the route.
    const r = runGuardChild({ CDMSS_OVERHEAD_DB_ENDPOINT: undefined });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'endpoint_mismatch');
  });

  test('GUARD 5 — an unparseable DATABASE_URL refuses', () => {
    const r = runGuardChild({ DATABASE_URL: 'not-a-connection-string' });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'endpoint_mismatch');
  });

  test('GUARD 5 — a password containing @ cannot shift the parsed host', () => {
    // The parse takes the substring after the LAST `@`, so an embedded `@` in the credentials
    // cannot make some other label look like the endpoint.
    const tricky = `postgresql://u:p@${OTHER_ENDPOINT}.example.com@${FAKE_ENDPOINT}.ap-southeast-1.aws.neon.tech/neondb`;
    const r = runGuardChild({ DATABASE_URL: tricky });
    assert.equal(r.status, 200, 'the real host is the one after the last @, so this is the branch');
    assert.equal(r.body.ok, true);
  });

  test('GUARD 2 — expiry: past the hard UTC date every request is 410', () => {
    // Guard 2 is the ONLY enforcement that this route is deleted: nothing in CI enumerates routes,
    // and a note in a report is not a mechanism.
    const past = Date.UTC(2026, 7, 20, 0, 0, 1);      // one second after the expiry
    const r = runGuardChild({}, [`--now=${past}`]);
    assert.equal(r.status, 410);
    assert.equal(r.body.refused, 'expired');
  });

  test('GUARD 2 — before the expiry the route still runs', () => {
    const before = Date.UTC(2026, 7, 19, 23, 59, 59);
    const r = runGuardChild({}, [`--now=${before}`]);
    assert.equal(r.status, 200, 'not vacuous: the expiry check discriminates rather than always refusing');
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // All five pass, and nothing leaks
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  test('ALL FIVE PASS — the route runs, writes route=script, and reports the first sample separately', () => {
    const r = runGuardChild({});
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.route_written_as, 'script', '§7: the closed InvocationRoute union cannot name this route');
    assert.equal((r.body.cell as string), 'declare');
    assert.deepEqual(r.body.shape, { batch_size: 8 }, 'fix 7: the true shape, not an echoed max/conc');
    const first = r.body.first_statement_in_process as { n: number; ms: number | null };
    assert.equal(first.n, 1, 'the first sample is n=1 and never enters a percentile column');
    assert.ok(typeof first.ms === 'number');
    const dist = r.body.distribution_excluding_first as Record<string, number>;
    assert.equal(dist.n, 1, 'n=2 requested, one consumed as the first sample');
    assert.ok(String(r.body.label).includes('SYNTHETIC'), 'every response labels itself synthetic');
  });

  test('FIX 2 + FIX 1 — a REAL 500, driven by an unparseable URL that still satisfies guard 5', () => {
    // ⚠️ THE OLD CASE HERE NEVER RAN. It was keyed on `CDMSS_OVERHEAD_FORCE_DB_ERROR`, which nothing
    // in the repository reads, so it silently duplicated the all-pass case and the 500 shape had
    // never been exercised at all. This drives the real defect instead of simulating it: a
    // `DATABASE_URL` with the scheme dropped parses to the expected endpoint, passes every guard,
    // and then makes `neon()` throw inside the route.
    const r = runGuardChild({ DATABASE_URL: UNPARSEABLE['dropped scheme'] });
    assert.equal(r.status, 500, 'the 500 path is reachable and is now exercised');
    assert.equal(r.body.ok, false);
    // Nothing derived from the caught error: a fixed sentence plus the constructor name.
    assert.match(String(r.body.error), /deliberately not returned/);
    assert.equal(typeof r.body.error_class, 'string');
    assert.ok(String(r.body.error_class).length < 40, 'error_class is a class name, not a message');
    for (const secret of SECRETS) {
      assert.equal(r.allOutput.includes(secret), false, `the 500 path leaked "${secret.slice(0, 24)}…"`);
    }
  });

  test('v5 FIX 1 — two of the three leaking shapes are refused BEFORE the driver ever sees them', () => {
    // ⚠️ ALL THREE shapes leak with a realistic username (v6 fix 4) — `u:` parses as a URL scheme,
    // which is the only reason the dropped-scheme case ever looked safe. What differs is REFUSAL:
    // v5 fix 3's authority-scoped parse refuses these two at guard 5, so their leak path is closed
    // twice over — once by never returning the error, once by never reaching it. The third shape
    // does reach the 500, and the case above proves that body carries nothing.
    for (const shape of ['wrapped in quotes', 'leading psql'] as const) {
      const r = runGuardChild({ DATABASE_URL: UNPARSEABLE[shape] });
      assert.equal(r.status, 403, `${shape} must refuse at guard 5`);
      assert.equal(r.body.refused, 'endpoint_mismatch');
      for (const secret of SECRETS) {
        assert.equal(r.allOutput.includes(secret), false, `${shape} leaked "${secret.slice(0, 24)}…"`);
      }
    }
  });

  test('FIX 3 — a query parameter cannot move the parsed host away from the one the driver uses', () => {
    // The bypass: guard 5 parsed the last `@` in the WHOLE string, so a `?x=@allowed-host` suffix
    // made it read the allowed endpoint while the driver connected to the one in the authority.
    const bypass = `postgresql://u:pw@${OTHER_ENDPOINT}.ap-southeast-1.aws.neon.tech/db?x=@${FAKE_ENDPOINT}.ap-southeast-1.aws.neon.tech`;
    const r = runGuardChild({ DATABASE_URL: bypass });
    assert.equal(r.status, 403, 'the authority is what is parsed, so this is the FORBIDDEN endpoint');
    assert.equal(r.body.refused, 'forbidden_endpoint', 'and the denylist catches it first');
  });

  test('FIX 4 — the denylist refuses production even when the expected value also names it', () => {
    // The failure this closes: guard 5 compares two variables V sets and has no independent
    // knowledge of which endpoint is production. Debugging a refusal late, the natural move is to
    // change the variable you just added — which would have opened the route onto production.
    const r = runGuardChild({
      DATABASE_URL: urlFor(OTHER_ENDPOINT),   // production, POOLED host
      CDMSS_OVERHEAD_DB_ENDPOINT: OTHER_ENDPOINT,
      CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT: OTHER_ENDPOINT,
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'forbidden_endpoint', 'the denylist is checked BEFORE the equality');
    assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'refused'], 'and nothing else is returned');
  });

  test('FIX 4 — an ABSENT denylist refuses: a denylist that is not there is not a denylist', () => {
    const r = runGuardChild({ CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT: undefined });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'no_denylist');
  });

  test('FIX 5 — p95 and p99 are withheld below their floors, never a maximum in disguise', () => {
    // At n=50 one sample is consumed as first-statement-in-process, 49 remain, and nearest-rank p99
    // over 49 samples returns index 48 — the maximum. The route must say so rather than print it.
    // The addendum's attack, exactly: n=50 leaves 49 samples, and nearest-rank p99 over 49 returns
    // index 48 — the maximum. p95's floor is 40, so at 49 it is legitimately reported.
    const r = runGuardChild({}, [], 'cell=activerun&n=50');
    assert.equal(r.status, 200);
    const d = r.body.distribution_excluding_first as Record<string, unknown>;
    assert.equal(d.n, 49);
    assert.equal(d.p99, null, 'p99 is withheld at n=49 — it would be the maximum');
    assert.match(String(d.p99_withheld), /needs n >= 200/);
    assert.equal(typeof d.p95, 'number', 'p95 IS reported at n=49: its floor is 40');
    assert.ok(typeof d.median === 'number' && typeof d.max === 'number', 'min/median/max still reported');

    // …and below p95's own floor it is withheld too, so the floor is real at both levels.
    const low = runGuardChild({}, [], 'cell=activerun&n=11');
    const dl = low.body.distribution_excluding_first as Record<string, unknown>;
    assert.equal(dl.n, 10);
    assert.equal(dl.p95, null, 'p95 withheld at n=10');
    assert.match(String(dl.p95_withheld), /needs n >= 40/);
  });

  test('FIX 5 — and p95 IS emitted once its floor is met, so the floor is not a blanket refusal', () => {
    const r = runGuardChild({}, [], 'cell=activerun&n=41');
    const d = r.body.distribution_excluding_first as Record<string, unknown>;
    assert.equal(d.n, 40);
    assert.equal(typeof d.p95, 'number', 'p95 appears at exactly the floor');
    assert.equal(d.p95_withheld, null);
    assert.equal(d.p99, null, 'p99 still withheld — its floor is higher');
  });

  test('FIX 6 — the invocation insert has its own cell', () => {
    // 34 of 35 statements had a cell; `startInvocation` was called untimed inside `declare`, so any
    // batch-level total built from the cells was short by exactly this statement.
    const r = runGuardChild({}, [], 'cell=start_invocation&n=3');
    assert.equal(r.status, 200);
    assert.equal(r.body.cell, 'start_invocation');
    assert.equal((r.body.distribution_excluding_first as Record<string, number>).n, 2);
    // …and `declare` now says plainly that it is two statements, not three.
    const d = runGuardChild({}, [], 'cell=declare&max=8&n=2');
    assert.match(String(d.body.batch_total_note), /TWO statements/);
    assert.match(String(d.body.batch_total_note), /start_invocation/);
  });

  test('FIX 7 — the shape is true per cell, and conc is gone', () => {
    const batch = runGuardChild({}, [], 'cell=declare&max=8&n=2');
    assert.deepEqual(batch.body.shape, { batch_size: 8 }, 'the batch cell carries the real batch size');
    const perNote = runGuardChild({}, [], 'cell=terminal_primary&max=8&n=2');
    assert.deepEqual(perNote.body.shape, { batch_size: 1 }, 'a per-note cell is size 1 whatever max says');
    assert.match(String(perNote.body.shape_note), /PER-NOTE/);
    assert.match(String(batch.body.concurrency), /NOT EXERCISED/);
    // The parameter is not merely ignored — it is absent from the source.
    assert.equal(/shapeConc|params\.get\('conc'\)/.test(readRouteCode()), false, 'conc is removed, not just unused');
  });

  test('FIX 8 — the real-audit arm refuses rather than silently becoming the null arm', () => {
    // The stub answers no `opd_note_audits` rows, which is exactly the condition: the id would be
    // null while `audit_mode` still read "real", and two runs differing only in that string would be
    // read as the foreign-key comparison when they were the same measurement twice.
    const r = runGuardChild({}, [], 'cell=settle_primary&n=2&audit=real');
    assert.equal(r.status, 409);
    assert.equal(r.body.refused, 'no_audit_id');
    // The null arm is still explicitly available, because that one is honest about what it is.
    const nullArm = runGuardChild({}, [], 'cell=settle_primary&n=2&audit=null');
    assert.equal(nullArm.status, 200);
    assert.equal(nullArm.body.audit_mode, 'null');
    // And a cell that never binds audit_id is not refused by a missing audit row.
    const declare = runGuardChild({}, [], 'cell=declare&n=2&audit=real');
    assert.equal(declare.status, 200);
    assert.match(String(declare.body.audit_mode), /n\/a/);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // v6 — THE POOLER SUFFIX. Neon exposes `ep-x` and `ep-x-pooler` for the SAME compute, and a real
  // connection string uses the pooled host. Without normalisation the measurement cannot run at all
  // and the denylist cannot see production.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  test('v6 FIX 1 — the branch POOLED host passes against the bare expected id', () => {
    // THE CASE THAT BLOCKED THE MEASUREMENT. Before normalisation this parsed to
    // `ep-young-moon-aofuyr1u-pooler`, never equalled the bare expected id, and every request
    // returned endpoint_mismatch.
    const r = runGuardChild({ DATABASE_URL: urlFor(FAKE_ENDPOINT, true), CDMSS_OVERHEAD_DB_ENDPOINT: FAKE_ENDPOINT });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  test('v6 FIX 1 — the branch DIRECT host passes against the bare expected id', () => {
    const r = runGuardChild({ DATABASE_URL: urlFor(FAKE_ENDPOINT, false), CDMSS_OVERHEAD_DB_ENDPOINT: FAKE_ENDPOINT });
    assert.equal(r.status, 200);
  });

  test('v6 FIX 1 — the branch POOLED host passes against a POOLED expected id', () => {
    // Either form may be set for either variable: both sides go through the same normalisation.
    const r = runGuardChild({
      DATABASE_URL: urlFor(FAKE_ENDPOINT, true),
      CDMSS_OVERHEAD_DB_ENDPOINT: `${FAKE_ENDPOINT}-pooler`,
    });
    assert.equal(r.status, 200);
  });

  test('v6 FIX 2 — production on its POOLED host refuses forbidden_endpoint, NOT endpoint_mismatch', () => {
    // ⚠️ THE ONE THAT MATTERS. Before normalisation this fell through to `endpoint_mismatch`: the
    // request still refused, so nothing was exposed, but the guard that exists specifically to catch
    // production did not catch it — and had both variables been set to production values it would
    // have run. Proven with a POOLED host, by execution, not by inspection.
    const r = runGuardChild({ DATABASE_URL: urlFor(OTHER_ENDPOINT, true) });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'forbidden_endpoint');
  });

  test('v6 FIX 2 — production on its DIRECT host also refuses forbidden_endpoint', () => {
    const r = runGuardChild({ DATABASE_URL: urlFor(OTHER_ENDPOINT, false) });
    assert.equal(r.status, 403);
    assert.equal(r.body.refused, 'forbidden_endpoint');
  });

  test('v6 — `pooler` in the MIDDLE of a label is part of the id and is never truncated', () => {
    const MIDDLE = 'ep-pooler-test-000001';
    // It matches itself…
    const ok = runGuardChild({ DATABASE_URL: urlFor(MIDDLE, false), CDMSS_OVERHEAD_DB_ENDPOINT: MIDDLE });
    assert.equal(ok.status, 200, 'a label merely containing "pooler" is unchanged');
    // …and it is emphatically NOT collapsed to `ep`, which is what an over-eager strip would do.
    const collapsed = runGuardChild({ DATABASE_URL: urlFor(MIDDLE, false), CDMSS_OVERHEAD_DB_ENDPOINT: 'ep' });
    assert.equal(collapsed.status, 403);
    assert.equal(collapsed.body.refused, 'endpoint_mismatch');
  });

  test('v6 — a doubled `-pooler-pooler` strips exactly ONE, and that is the stated rule', () => {
    // Neon never emits this. Stripping repeatedly would be inventing a rule the platform does not
    // have, so exactly ONE trailing occurrence comes off — and it comes off BOTH SIDES, because the
    // env values go through the same normalisation. The stated rule is therefore: the two forms must
    // correspond after one strip each.
    //
    // ⚠️ MY FIRST VERSION OF THIS CASE ASSERTED THE WRONG PAIRING and failed. I expected a doubled
    // host to match a single `-pooler` expectation, forgetting that the expectation is normalised
    // too. The route was right; the test was wrong. Recorded because the symmetry is the whole
    // point of normalising in the code rather than in the variables.
    const DOUBLED = `${FAKE_ENDPOINT}-pooler-pooler`;
    const host = `${DOUBLED}.c-2.ap-southeast-1.aws.neon.tech`;
    const url = `postgresql://${DB_USER}:${FAKE_PASSWORD}@${host}/neondb`;
    // Doubled host, doubled expectation: one strip each, both land on `ep-…-pooler`.
    const same = runGuardChild({ DATABASE_URL: url, CDMSS_OVERHEAD_DB_ENDPOINT: DOUBLED });
    assert.equal(same.status, 200, 'one strip on each side, so the doubled forms correspond');
    // A single `-pooler` expectation normalises to the bare id and does NOT match.
    const single = runGuardChild({ DATABASE_URL: url, CDMSS_OVERHEAD_DB_ENDPOINT: `${FAKE_ENDPOINT}-pooler` });
    assert.equal(single.status, 403);
    assert.equal(single.body.refused, 'endpoint_mismatch');
    // …and neither does the bare id: the strip is not applied repeatedly.
    const bare = runGuardChild({ DATABASE_URL: url, CDMSS_OVERHEAD_DB_ENDPOINT: FAKE_ENDPOINT });
    assert.equal(bare.status, 403);
    assert.equal(bare.body.refused, 'endpoint_mismatch');
  });

  test('v6 — normalisation cannot make two DIFFERENT endpoints compare equal', () => {
    // The only identity the strip creates is `ep-x` ≡ `ep-x-pooler`, which is one compute with two
    // hostnames. Two genuinely different endpoints stay different in every combination of forms.
    for (const [dbPooled, expPooled] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      const r = runGuardChild({
        DATABASE_URL: urlFor(FAKE_ENDPOINT, dbPooled),
        CDMSS_OVERHEAD_DB_ENDPOINT: expPooled ? `${OTHER_ENDPOINT}-pooler` : OTHER_ENDPOINT,
        CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT: 'ep-unrelated-denylist-000000',
      });
      assert.equal(r.status, 403, `db pooled=${dbPooled}, expected pooled=${expPooled}`);
      assert.equal(r.body.refused, 'endpoint_mismatch', 'different endpoints never collapse together');
    }
  });

  test('NO OUTPUT ANYWHERE CARRIES A DATABASE_URL SUBSTRING — every response shape, stdout and stderr', () => {
    // ⚠️ EIGHT RESPONSE SHAPES, ALL EXERCISED. Part XI said "eight response shapes" when it meant
    // eight test cases covering five; 401, 400 and 500 were unexercised. All three are here now, and
    // the search covers the child's whole output rather than only the parsed RESULT line.
    const cases: Array<[string, ChildResult]> = [
      ['401 admin', runGuardChild({ ADMIN_TOKEN: 'not-presented' })],
      ['410 expired', runGuardChild({}, [`--now=${Date.UTC(2026, 7, 21)}`])],
      ['403 not_preview', runGuardChild({ VERCEL_ENV: 'production' })],
      ['403 not_armed', runGuardChild({ CDMSS_OVERHEAD_MEASURE: undefined })],
      ['403 no_denylist', runGuardChild({ CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT: undefined })],
      ['403 forbidden_endpoint', runGuardChild({ DATABASE_URL: urlFor(OTHER_ENDPOINT) })],
      ['403 endpoint_mismatch', runGuardChild({ CDMSS_OVERHEAD_DB_ENDPOINT: 'ep-something-else-000002' })],
      ['409 no_audit_id', runGuardChild({}, [], 'cell=settle_primary&n=2&audit=real')],
      ['400 unknown cell', runGuardChild({}, [], 'cell=nonsense&n=2')],
      ['500 driver throw', runGuardChild({ DATABASE_URL: UNPARSEABLE['dropped scheme'] })],
      ['200 all pass', runGuardChild({})],
    ];
    const seen = new Set<number>();
    for (const [name, r] of cases) {
      seen.add(r.status);
      for (const secret of SECRETS) {
        assert.equal(
          r.allOutput.includes(secret), false,
          `${name} leaked "${secret.slice(0, 24)}…" — no output may carry any part of the connection string`,
        );
      }
    }
    assert.deepEqual([...seen].sort((a, b) => a - b), [200, 400, 401, 403, 409, 410, 500],
      'every status the route can return is exercised by this check');
  });

  test('the route is POST-only, and carries its own expiry and deletion notice in source', () => {
    const src = readRouteSource();
    assert.match(src, /export async function POST\(/);
    assert.equal(/export async function GET\(/.test(src), false, 'no GET: this is not a browsable endpoint');
    assert.match(src, /const EXPIRES_AT_UTC = Date\.UTC\(2026, 7, 20, 0, 0, 0\);/, 'the hard expiry is 2026-08-20 UTC');
    assert.match(src, /OWED A DELETION/i, 'the file says plainly that it is temporary');
    assert.match(src, /export const maxDuration = 800;/);
    assert.match(src, /export const runtime = 'nodejs';/);
  });
}

function readRouteSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs').readFileSync('app/api/admin/telemetry-overhead/route.ts', 'utf8');
}

/** The route's source with every comment removed — for claims about what the CODE does. */
function readRouteCode(): string {
  return readRouteSource()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}
