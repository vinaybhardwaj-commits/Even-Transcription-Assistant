/**
 * app/api/admin/telemetry-overhead/route.ts — the real-database overhead measurement (addendum v4).
 *
 * ⚠️ THIS ROUTE IS TEMPORARY AND IS OWED A DELETION. It exists to take one measurement that a
 * stubbed harness cannot take, from a Vercel Preview against a NON-PRODUCTION Neon branch. Guard 2
 * below is a hard expiry, and it is the ONLY enforcement that this file goes away: nothing in CI
 * enumerates routes, so a note in a report is not a mechanism. After the expiry every AUTHENTICATED
 * request is 410, whatever else is configured — which is true only because the expiry runs second.
 *
 * ⚠️ WHY IT EXISTS AT ALL. PRD v2.1 line 267 requires numeric overhead guardrails before a canary;
 * kickoff D18 line 1032 forbids deploying to measure and confines measurement to a local or test
 * database. Both cannot hold, because D18's method excludes the term that decides the acceptance
 * criterion — the Mumbai-to-Singapore round trip. Amendment 1, signed by V before this pass, lifts
 * D18's prohibition FOR PREVIEW ONLY and leaves the prohibition on the production database standing
 * without exception. Guard 5 is that prohibition's mechanism rather than its promise.
 *
 * ⚠️ THE FIVE GUARDS RUN IN THIS ORDER AND ALL FIVE MUST PASS. Each is proven by a child-process
 * case in `lib/__tests__/telemetry-overhead-guard.test.ts`; a guard that exists only in source is
 * not a guard.
 *
 *   1. admin           `requireAdmin` ALONE — no `isAdminUnlocked()` clause
 *   2. expiry          hard UTC date, 410 after it
 *   3. preview         VERCEL_ENV === 'preview' AND VERCEL_GIT_COMMIT_REF === 'exp/rerank-telemetry'
 *   4. armed           CDMSS_OVERHEAD_MEASURE === '1'
 *   5. database identity   NOT the forbidden endpoint, AND equal to CDMSS_OVERHEAD_DB_ENDPOINT
 *
 * ⚠️ EXPIRY RUNS SECOND, NOT FIFTH (addendum v5 §9.1). Running it last made "after the expiry every
 * request is 410" false: anything failing an earlier guard got a 403 instead, so the deadline did
 * not mean what the report said it meant. Second is the first position where it can.
 *
 * ⚠️ NOTHING HERE EVER LOGS, ECHOES OR RETURNS ANY PART OF `DATABASE_URL`, including inside an
 * error. Guard 5 compares one label and reports one word.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { sql } from '@/lib/db';
import { retrievalTelemetryDdl, RETRIEVAL_ROLE_NOT_NULL_SQL, type TelemetryRequestContext, type OperationalTelemetry, type RetrievalRole } from '@/lib/retrieval-telemetry-core';
import { declareRetrievals, writeRetrievalTerminal, type LifecycleHandle } from '@/lib/retrieval-telemetry-store';
import { startInvocation } from '@/lib/retrieval-invocation-store';
import { settleRetrievalTelemetry } from '@/lib/retrieval-settlement';
import { createTelemetryCapture, buildRetrievalPayload } from '@/lib/retrieval-capture';
import { activeRun } from '@/lib/backfill-runs';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 800;

/**
 * GUARD 2's DATE. UTC midnight, 20 August 2026 — the last day addendum v4 §3 permits.
 * Section 12 requires this route deleted before `exp/rerank-telemetry` merges anywhere; this
 * constant is what makes that true even if the deletion is forgotten.
 */
const EXPIRES_AT_UTC = Date.UTC(2026, 7, 20, 0, 0, 0);

/** The only branch this route may serve from. A Preview build carries VERCEL_ENV=preview baked in
 *  and can later be PROMOTED to production, which would serve production traffic from a build that
 *  the environment label alone would admit. The ref is what stops that. */
const ONLY_REF = 'exp/rerank-telemetry';

/**
 * The Neon endpoint id out of `DATABASE_URL`, or null.
 *
 * ⚠️ PARSED BY HAND, NOT BY `new URL`, AND NOTHING IS EVER RETURNED FROM IT. A connection string
 * carries credentials; `new URL` throws on some of them and its error object retains the input.
 * That decision stands. Any shape this does not recognise returns null, which guard 5 treats as a
 * refusal rather than as a pass.
 *
 * ⚠️ THE `@` SEARCH IS SCOPED TO THE AUTHORITY, AND THE FIRST VERSION WAS NOT (addendum v5 fix 3).
 * Taking the last `@` in the WHOLE string let a query parameter move the parsed host while the
 * driver connected somewhere else entirely:
 *
 *     postgresql://u:pw@ep-production-999999.…/db?x=@ep-measure-000001.…
 *     parsed by the old code  ep-measure-000001    ← allowed
 *     connected by the driver ep-production-999999 ← the thing guard 5 exists to prevent
 *
 * So the authority is cut off FIRST — at the first `/`, `?` or `#` after the scheme — and only then
 * is the last `@` taken within it. A password containing `@` still cannot shift the host, because
 * within the authority the last `@` is still the delimiter.
 */
function neonEndpointId(raw: string | undefined): string | null {
  if (!raw) return null;
  const afterScheme = raw.replace(/^[a-z+]+:\/\//i, '');
  const authority = afterScheme.split(/[/?#]/)[0] ?? '';   // ← v5 fix 3: cut BEFORE looking for '@'
  const at = authority.lastIndexOf('@');
  const host = (at >= 0 ? authority.slice(at + 1) : authority).split(':')[0] ?? '';
  const label = host.split('.')[0] ?? '';
  return /^ep-[a-z0-9-]+$/i.test(label) ? normaliseEndpointId(label) : null;
}

/**
 * Strip ONE trailing `-pooler`, case-insensitively (addendum v6 fix 1).
 *
 * ⚠️ WITHOUT THIS THE MEASUREMENT CANNOT RUN, AND THE DENYLIST DOES NOT FIRE ON PRODUCTION.
 * Neon exposes `ep-x` and `ep-x-pooler` for the SAME compute, and a real connection string uses the
 * pooled host. Measured on the actual endpoints before this was written:
 *
 *     branch pooled URL parses to  ep-young-moon-aofuyr1u-pooler
 *     CDMSS_OVERHEAD_DB_ENDPOINT   ep-young-moon-aofuyr1u        → endpoint_mismatch, every request
 *     prod pooled URL parses to    ep-super-union-aoys3lle-pooler
 *     CDMSS_OVERHEAD_FORBIDDEN_…   ep-super-union-aoys3lle       → forbidden_endpoint does NOT fire
 *
 * The second is the one that matters: the request still refused, at `endpoint_mismatch`, so nothing
 * was exposed — but the guard that exists specifically to catch production did not catch it.
 *
 * ⚠️ NORMALISED IN THE CODE, NOT IN THE VARIABLES. Telling the operator to set the `-pooler` form
 * instead would leave the denylist blind to the DIRECT host, which is the worse of the two failures.
 * Normalising here makes the denylist catch both forms of the production endpoint, and lets either
 * form be set for either variable.
 *
 * ⚠️ ONE TRAILING OCCURRENCE ONLY, AND NEVER INTO A DEGENERATE ID.
 *   · `ep-x-pooler`            → `ep-x`          the real case
 *   · `ep-pooler-test-000001`  → unchanged       `pooler` in the MIDDLE is part of the id
 *   · `ep-x-pooler-pooler`     → `ep-x-pooler`   one occurrence, deliberately: Neon never emits this,
 *                                                and stripping repeatedly would be inventing a rule
 *   · `ep-pooler`              → unchanged       the remainder would not be a valid id, so the
 *                                                suffix is treated as the id itself rather than
 *                                                collapsing it to a bare `ep`
 */
function normaliseEndpointId(value: string): string {
  const stripped = value.replace(/-pooler$/i, '');
  return /^ep-[a-z0-9-]+$/i.test(stripped) ? stripped : value;
}

// ── statistics ─────────────────────────────────────────────────────────────────────────────────
/**
 * ⚠️ A PERCENTILE THAT IS SILENTLY THE MAXIMUM IS WORSE THAN NO PERCENTILE (addendum v5 fix 5).
 * Nearest-rank p99 at n = 49 returns index 48 — the largest sample. `p99 === max` for every n up to
 * 99, and `p95 === max` for every n up to 10, and the first version printed all three side by side
 * with no floor and no warning. Addendum v4 §4 warned about exactly this: "a p99 printed from an n
 * that cannot support it is a maximum wearing a percentile's name."
 *
 * So each percentile has a minimum sample count. Below it the value is `null` and a sibling field
 * names the floor that was not met, which is a fact the reader can act on rather than a number they
 * cannot tell from `max`.
 */
const P95_MIN_N = 40;
const P99_MIN_N = 200;

/** Nearest-rank percentile on an already-sorted ascending array. */
function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
function summarise(samples: number[]) {
  const s = samples.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const p95ok = s.length >= P95_MIN_N;
  const p99ok = s.length >= P99_MIN_N;
  return {
    n: s.length,
    min: s[0] ?? null,
    median: s.length ? (s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) : null,
    p95: p95ok ? pct(s, 95) : null,
    p95_withheld: p95ok ? null : `needs n >= ${P95_MIN_N}, have ${s.length} — a p95 here would be the maximum`,
    p99: p99ok ? pct(s, 99) : null,
    p99_withheld: p99ok ? null : `needs n >= ${P99_MIN_N}, have ${s.length} — a p99 here would be the maximum`,
    max: s[s.length - 1] ?? null,
  };
}

const ctxFor = (): TelemetryRequestContext => ({
  // §7: `/api/admin/telemetry-overhead` is not a member of the closed `InvocationRoute` union and
  // adding one is forbidden by §6. `script` is an existing member, it is honest about what this is,
  // and it keeps every synthetic row separable from real traffic by one predicate.
  invocationId: randomUUID(), route: 'script', routeClass: 'manual',
  deploymentSha: process.env.VERCEL_GIT_COMMIT_SHA || null, vercelRequestId: null,
  startedAt: new Date().toISOString(), routingFlags: {},
});

const operationalFor = (ctx: TelemetryRequestContext, role: RetrievalRole): OperationalTelemetry => ({
  route: 'script', route_class: 'manual', retrieval_role: role,
  invocation_id: ctx.invocationId, trace_id: null, deployment_sha: ctx.deploymentSha,
  started_at: ctx.startedAt, completed_at: new Date().toISOString(), routing_flags: {},
  active_backfill_run_id: null, active_backfill_target: null, active_backfill_state: null,
  active_lab_experiment_id: null,
});

const payloadFor = (role: RetrievalRole) =>
  buildRetrievalPayload(createTelemetryCapture(role), {
    hmacKey: process.env.CDMSS_TELEMETRY_HMAC_KEY ?? null,
    scorerContext: role === 'primary' ? '' : null,
  });

export async function POST(req: NextRequest) {
  // ── GUARD 1. ADMIN, AND ONLY ADMIN. ───────────────────────────────────────────────────────────
  // Deliberately NOT the migration route's `|| isAdminUnlocked()`: that turns a credential into a
  // browser session. `lib/admin-gate.ts` returns null when ADMIN_TOKEN is unset, so this guard is
  // open by default — it is the weakest of the five and nothing here is load-bearing on it.
  const denied = requireAdmin(req);
  if (denied) return denied;

  // ── GUARD 2. HARD EXPIRY. MOVED HERE FROM FIFTH (addendum v5 §9.1). ───────────────────────────
  // Part XI claimed "after 2026-08-20 every request is 410 whatever else is configured". With this
  // check running fifth that was FALSE: a request failing guards 3, 4 or 5 got a 403 after the
  // expiry and never saw a 410. Running it second makes the claim true for every authenticated
  // request, which is what the deletion deadline is supposed to mean.
  if (Date.now() >= EXPIRES_AT_UTC) {
    return NextResponse.json({
      ok: false, refused: 'expired',
      expired_at: new Date(EXPIRES_AT_UTC).toISOString(),
      note: 'This measurement route is past its hard expiry and must be deleted (addendum v4 §12).',
    }, { status: 410 });
  }

  // ── GUARD 3. PREVIEW, ON THIS BRANCH ONLY. ────────────────────────────────────────────────────
  if (process.env.VERCEL_ENV !== 'preview' || process.env.VERCEL_GIT_COMMIT_REF !== ONLY_REF) {
    return NextResponse.json({ ok: false, refused: 'not_preview' }, { status: 403 });
  }

  // ── GUARD 4. EXPLICITLY ARMED. ────────────────────────────────────────────────────────────────
  if (process.env.CDMSS_OVERHEAD_MEASURE !== '1') {
    return NextResponse.json({ ok: false, refused: 'not_armed' }, { status: 403 });
  }

  // ── GUARD 5. DATABASE IDENTITY. THE ONE THAT MATTERS. ─────────────────────────────────────────
  // The branch is a copy-on-write clone, so row counts and schema are identical to production and
  // NO CONTENT CHECK CAN TELL THEM APART. The host is the only discriminator. Every failure
  // direction is "do not run": an absent expectation refuses, an unparseable URL refuses, a
  // mismatch refuses.
  //
  // ⚠️ AND A DENYLIST, BECAUSE AN ALLOWLIST OF TWO OPERATOR-SET VARIABLES CANNOT TELL WHICH SIDE IS
  // WRONG (addendum v5 fix 4). The equality check compares two values V sets and has no independent
  // knowledge of which endpoint is production. If `DATABASE_URL` is ever not scoped to Preview it
  // refuses with one word that deliberately says nothing about which side is at fault — and the
  // natural move, debugging late, is to change the variable you just added rather than the one that
  // was already there. That single paste would have opened this route onto production.
  //
  // `CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT` holds the PRODUCTION endpoint id and is checked FIRST, so
  // setting the expected value to production's id still refuses. An ABSENT denylist refuses too: a
  // denylist that is not there is not a denylist.
  // ⚠️ BOTH ENV VALUES GO THROUGH THE SAME NORMALISATION AS THE PARSED HOST (v6 fix 1), so an
  // operator who sets either the bare or the `-pooler` form gets identical behaviour, and the
  // denylist catches BOTH forms of the production endpoint rather than whichever one was typed.
  const rawForbidden = (process.env.CDMSS_OVERHEAD_FORBIDDEN_ENDPOINT || '').trim();
  const rawExpected = (process.env.CDMSS_OVERHEAD_DB_ENDPOINT || '').trim();
  const forbiddenEndpoint = rawForbidden ? normaliseEndpointId(rawForbidden) : '';
  const expectedEndpoint = rawExpected ? normaliseEndpointId(rawExpected) : '';
  const actualEndpoint = neonEndpointId(process.env.DATABASE_URL);

  if (!forbiddenEndpoint) {
    return NextResponse.json({ ok: false, refused: 'no_denylist' }, { status: 403 });
  }
  if (actualEndpoint && actualEndpoint === forbiddenEndpoint) {
    // A distinct word, so the operator learns WHICH side is wrong without the route naming a host.
    return NextResponse.json({ ok: false, refused: 'forbidden_endpoint' }, { status: 403 });
  }
  if (!expectedEndpoint || !actualEndpoint || expectedEndpoint !== actualEndpoint) {
    // One word. No endpoint id, no host, no fragment of the connection string, in either direction.
    return NextResponse.json({ ok: false, refused: 'endpoint_mismatch' }, { status: 403 });
  }

  // ══ ALL FIVE GUARDS PASSED. Everything below runs against the branch and nothing else. ═════════
  const params = req.nextUrl.searchParams;
  const cell = (params.get('cell') || 'declare').trim();
  const shapeMax = Math.max(1, Math.min(100, parseInt(params.get('max') || '8', 10) || 8));
  const n = Math.max(1, Math.min(2000, parseInt(params.get('n') || '50', 10) || 50));
  const auditMode = params.get('audit') === 'null' ? 'null' : 'real';

  // ⚠️ `conc` IS GONE (addendum v5 fix 7). It was accepted, echoed into every response as
  // provenance, and never ran anything concurrently in any cell. A parameter that appears in the
  // output and does nothing is a false label on a measurement, so it is removed rather than
  // implemented: implementing it would introduce contention, which is a different experiment from
  // the one D18 asks for. Concurrency is therefore NOT exercised anywhere in this route, and the
  // response says so in one field instead of implying otherwise in every one.

  /** Which cells are per-BATCH. For the rest the batch is size 1 whatever `max` says (fix 7). */
  const isBatchCell = cell === 'declare';

  const steps: Record<string, string> = {};
  try {
    // ── THE ROUTE CREATES ITS OWN TABLES. ───────────────────────────────────────────────────────
    // The branch was cloned from `main`, and `main` has none of the three telemetry tables — so
    // there is nothing to write to until this runs. It is done HERE, after guard 5, and never by a
    // human aiming the migration route at a preview: that endpoint is aimed by hand and the failure
    // mode is aiming it at production.
    //
    // ⚠️ TWO DELIBERATE DEVIATIONS FROM THE MIGRATION ROUTE'S STOP RULE, AND THEIR REASONS.
    //
    // 1. That route returns 409 when the table exists WITH ROWS, because it would otherwise replace
    //    a CHECK constraint underneath legacy rows. Here, a second invocation ALWAYS finds rows —
    //    its own, from the previous cell — and §4 requires one cell per invocation, so a literal 409
    //    would make the matrix unreachable after the first call. Instead the decision is taken on
    //    EXISTENCE alone: absent ⇒ create, present ⇒ skip the DDL entirely. That is strictly safer
    //    than the migration route, because on the present branch no constraint is touched at all.
    //
    // 2. THE EMPTINESS COUNT IS GONE, AND NOT BECAUSE IT WAS INCONVENIENT.
    //    `lib/__tests__/telemetry-non-exposure.test.ts` fails on any `FROM <telemetry table>` in a
    //    file outside its ALLOWED set, and that test file is NOT on addendum v4 §6's contract, so it
    //    cannot be extended here. The two ways to keep the count were to edit that allow-list, which
    //    §6 forbids, or to build the table name dynamically so the source-text scan cannot see it —
    //    which is evading a privacy control by obfuscation, and is worse than not having the number.
    //    So the route reads NOTHING from the three telemetry tables. `to_regclass` asks the catalog
    //    whether a relation exists and reads no row of it. §5's row-count verification is owed and
    //    is flagged in Part XI rather than smuggled.
    const reg = (await sql`SELECT to_regclass('public.opd_audit_retrieval_telemetry') IS NOT NULL AS present`) as Array<{ present: boolean }>;
    if (!reg[0]?.present) {
      for (const stmt of retrievalTelemetryDdl()) { await sql(stmt.sql, []); }
      await sql(RETRIEVAL_ROLE_NOT_NULL_SQL, []);
      steps.schema = 'created';
    } else {
      steps.schema = 'already present — DDL skipped, no constraint touched';
    }

    // ── A REAL `opd_note_audits` ID, BECAUSE `audit_id` REFERENCES IT. ──────────────────────────
    // Production always settles with a real one, so the UPDATE carries an index probe into the
    // largest table in the schema. Passing null omits that probe and reads systematically low with
    // nothing in the output to show it. The branch is a clone, so real ids exist on it.
    let realAuditId: string | null = null;
    try {
      const a = (await sql`SELECT id FROM opd_note_audits ORDER BY id DESC LIMIT 1`) as Array<{ id: string }>;
      realAuditId = a[0]?.id != null ? String(a[0].id) : null;
    } catch { realAuditId = null; }
    // ⚠️ THE REAL ARM REFUSES RATHER THAN SILENTLY BECOMING THE NULL ARM (addendum v5 fix 8).
    // The first version left `realAuditId` null when the SELECT found nothing, passed null to
    // settlement, and still reported `audit_mode: "real"` at the top level. Two runs differing only
    // in that string would then be read as the foreign-key comparison when they were the same
    // measurement twice — and the whole point of this arm is the index probe into the largest table
    // in the schema. If there is no id to probe with, there is no measurement to take.
    //
    // Scoped to the cells that CONSUME the id. Only the settlement boundary binds `audit_id`, so a
    // `declare` or `activerun` run on a branch with no audits is not measuring anything false and is
    // not refused; a `settle_*` run on the real arm is, because that is the one where the missing id
    // silently changes what was measured.
    const usesAuditId = cell.startsWith('settle');
    if (usesAuditId && auditMode === 'real' && !realAuditId) {
      return NextResponse.json({
        ok: false,
        refused: 'no_audit_id',
        detail: 'audit=real needs a real opd_note_audits row to carry the foreign-key probe, and the '
          + 'branch returned none. Refusing rather than measuring the null arm under the real label. '
          + 'Use ?audit=null explicitly if the null arm is what you want.',
      }, { status: 409 });
    }
    const auditId = auditMode === 'null' ? null : realAuditId;
    steps.audit_id = !usesAuditId
      ? 'not used by this cell — only the settlement boundary binds audit_id'
      : auditMode === 'null'
        ? 'null (FK probe deliberately omitted — comparison arm)'
        : 'a real opd_note_audits row on the BRANCH';

    const samples: number[] = [];
    const mark = async (fn: () => Promise<unknown>) => {
      const t0 = performance.now();
      await fn();
      samples.push(performance.now() - t0);
    };

    // ── THE CELLS. One boundary at one batch shape, per invocation (§4). ────────────────────────
    for (let i = 0; i < n; i++) {
      const ctx = ctxFor();
      if (cell === 'start_invocation') {
        // ⚠️ STATEMENT 1 NOW HAS A CELL (addendum v5 fix 6). The topology is 3 + 4N; boundary 1
        // times `declareRetrievals`, which is statements 2 and 3. `startInvocation` — the
        // `INSERT INTO opd_retrieval_invocations` — was called untimed inside the `declare` cell, so
        // 34 of 35 statements had a cell and any batch-level total built from the cells was short by
        // exactly this one. It is measured here on its own.
        await mark(() => startInvocation(ctx));
      } else if (cell === 'declare') {
        // BOUNDARY 1 — declaration insert PLUS the invocation counter update. PER BATCH, not per
        // note: build report §8 shows both are batch-level, which is what makes the per-note serial
        // chain three statements and not five.
        //
        // ⚠️ THIS CELL IS TWO STATEMENTS, NOT THREE. `startInvocation` below is untimed — the
        // counter UPDATE needs a row to hit — and it has its own cell, `start_invocation`. The batch
        // total is therefore `start_invocation` + `declare`, and the response says so rather than
        // leaving a reader to assume this figure covers the whole batch.
        await startInvocation(ctx);                       // untimed: measured by its own cell
        const runs = Array.from({ length: shapeMax }, () => ({
          role: 'primary' as const, runId: randomUUID(), uid: null, engineVersion: null,
        }));
        await mark(() => declareRetrievals(ctx, runs, 'will_persist'));
      } else if (cell.startsWith('terminal') || cell.startsWith('settle')) {
        const role: RetrievalRole = cell.endsWith('normative') ? 'normative_channel' : 'primary';
        await startInvocation(ctx);
        const runId = randomUUID();
        const handle = await declareRetrievals(ctx, [{ role, runId, uid: null, engineVersion: null }], 'will_persist');
        if (cell.startsWith('terminal')) {
          // BOUNDARY 2 — the terminal update, per role, per note.
          await mark(() => writeRetrievalTerminal(handle, role, {
            payload: payloadFor(role), operational: operationalFor(ctx, role), traceId: null,
            completedAt: new Date().toISOString(),
          }));
        } else {
          // BOUNDARY 3 — the settlement read PLUS update, per role, per note.
          const settled: LifecycleHandle = await writeRetrievalTerminal(handle, role, {
            payload: payloadFor(role), operational: operationalFor(ctx, role), traceId: null,
            completedAt: new Date().toISOString(),
          });
          await mark(() => settleRetrievalTelemetry(settled, {
            outcome: 'persisted_clean', auditId, settledAt: new Date().toISOString(),
          }));
        }
      } else if (cell === 'activerun') {
        // BOUNDARY 4 — activeRun('opd'). The FIRST call in a process also runs ensureRunsTable's
        // CREATE TABLE and two CREATE INDEX; every later call is one SELECT. `ensured` is module
        // state with no reset, so that split is per process and not per iteration.
        await mark(() => activeRun('opd'));
      } else {
        return NextResponse.json({
          ok: false, error: 'unknown cell',
          cells: ['start_invocation', 'declare', 'terminal_primary', 'terminal_normative',
            'settle_primary', 'settle_normative', 'activerun'],
        }, { status: 400 });
      }
    }

    // ── THE FIRST SAMPLE IS NOT A PERCENTILE. ───────────────────────────────────────────────────
    // One request is one process, so the first statement absorbs TLS setup and, if the branch
    // compute has scaled to zero, a resume of hundreds of milliseconds. It is reported on its own
    // with n = 1 and is NOT called cold — cold cannot be forced in-process, because `ensured` in
    // `lib/backfill-runs.ts` is module state with no reset and no export.
    const [firstSample, ...rest] = samples;

    return NextResponse.json({
      ok: true,
      label: 'SYNTHETIC-AGAINST-A-BRANCH. Not a production measurement. No threshold is proposed.',
      cell,
      // ⚠️ THE TRUE SHAPE, PER CELL (addendum v5 fix 7). The first version echoed `max` into every
      // response, including the four per-note cells, which run exactly ONE declared run per
      // iteration whatever `max` says — so Part XI recorded `terminal_primary` and `settle_primary`
      // at shape 8/8 when the batch was size 1. The latency was unaffected; the provenance label was
      // false, which is worse in a report V reads to set guardrails.
      shape: isBatchCell ? { batch_size: shapeMax } : { batch_size: 1 },
      shape_note: isBatchCell
        ? 'batch_size is the number of runs the declaration insert carries in one statement'
        : 'a PER-NOTE boundary: the batch is size 1 by construction and `max` does not apply to it',
      concurrency: 'NOT EXERCISED anywhere in this route — every cell is measured serially',
      batch_total_note: cell === 'declare'
        ? 'this cell is TWO statements (declaration insert + counter update). The batch total is this '
          + 'cell PLUS the `start_invocation` cell, which times the third batch-level statement.'
        : undefined,
      audit_mode: cell.startsWith('settle') ? auditMode : 'n/a — this cell does not bind audit_id',
      first_statement_in_process: { n: 1, ms: firstSample ?? null },
      distribution_excluding_first: summarise(rest),
      route_written_as: 'script',
      row_count_verification: 'NOT PERFORMED BY THIS ROUTE — see Part XI. Reading the three telemetry '
        + 'tables from here would either need the non-exposure allow-list extended, which addendum v4 §6 '
        + 'forbids, or the table name built dynamically to evade that scan, which is worse. Owed.',
      steps,
      raw_samples_ms: samples,
      raw_samples_note: 'Save this response body as the archive; nothing is written to disk from a serverless function.',
    });
  } catch (e) {
    // ⚠️ NOTHING DERIVED FROM THE CAUGHT ERROR REACHES THIS BODY. NOT SLICED, NOT SANITISED, NOT
    // INCLUDED (addendum v5 fix 1, severity highest).
    //
    // The first version returned `message.slice(0, 200)`, and that leaks the database password.
    // When `DATABASE_URL` fails `new URL` but still satisfies guard 5's hand parse, `neon()` puts
    // the ENTIRE connection string into its throw. Measured against the real driver, with the real
    // username, ALL THREE ordinary paste mistakes do it:
    //
    //   a dropped `postgresql://`       →  'Connection string: neondb_owner:PASSWORD@ep-….neon.tech/db'
    //   value still wrapped in quotes   →  'Connection string: "postgresql://neondb_owner:PASSWORD@ep-….neon.tech/db"'
    //   a leading `psql `               →  'Connection string: psql postgresql://neondb_owner:PASSWORD@ep-….neon.tech/db'
    //
    // ⚠️ AN EARLIER VERSION OF THIS COMMENT SAID THE DROPPED-SCHEME CASE DOES NOT LEAK. IT WAS
    // WRONG, AND THE REASON IS WORTH KEEPING (addendum v6 fix 4). That reading came from probing
    // with the one-character username `u`, and `u:` IS A VALID URL SCHEME — `new URL('u:…')` parses
    // successfully with `protocol === 'u:'`, so the driver never reaches the "not a valid URL"
    // branch and emits a generic format template instead. `new URL('neondb_owner:…')` throws,
    // because an underscore cannot appear in a scheme, and THAT is the path that echoes the raw
    // string. The real user is `neondb_owner`. One unrealistic character in a fixture hid the
    // highest-severity finding in the file.
    //
    // 200 characters is more than enough for user, password and host. `lib/admin-gate.ts` returns
    // null when ADMIN_TOKEN is unset, so this route may be open, which makes it a disclosure to
    // anyone who can reach the URL.
    //
    // `name` is the constructor name — 'Error', 'NeonDbError' — and never carries operator input. It
    // is the only thing taken from `e`, and the guard test asserts the whole body against every
    // substring of the connection string, in both the response and the child's stdout and stderr.
    return NextResponse.json({
      ok: false,
      steps,
      error: 'measurement failed — see the deployment logs. The error is deliberately not returned: '
        + 'a driver error on this path can contain the whole DATABASE_URL, password included.',
      error_class: (e as Error).name,
    }, { status: 500 });
  }
}
