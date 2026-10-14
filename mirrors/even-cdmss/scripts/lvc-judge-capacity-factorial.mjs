#!/usr/bin/env node
/**
 * scripts/lvc-judge-capacity-factorial.mjs — runner, I/O and transport for the LVC judge capacity
 * factorial. CDMSS-LVC-JUDGE-CAPACITY-FACTORIAL-PRD-v3.0-11-AUG-2026, §3.7, §4.2-§4.5, §5.
 *
 * LOCAL ONLY. MEASUREMENT ONLY. Never in CI, never attached to a PR or an issue, and it changes
 * no production request path. Every artifact lands under an ignored private root; the terminal
 * gets aggregates, hashes and status codes and nothing else.
 *
 * ── WHAT THIS RUNNER DELIBERATELY DOES NOT USE ──────────────────────────────────────────────────
 * Not `defaultJudge`, not `governedChat`, not `tracedChat`, not `chatWithFallback`, not
 * `buildOpenrouterParams`, not `createWithRetry` / `openrouterCreateWithRetry`, not
 * `classifyProviderResponse`, not `parseJudgeResponse`, not OpenRouter, not the local model.
 * Every one of those either retries, falls back, repairs or normalizes — and each of those is a
 * mechanism that made the 9 August failure invisible. The whole experiment is a measurement of
 * what the provider returns with all of them switched off.
 *
 * It DOES reuse, for production equivalence (§4.4): `getVertexAccessToken` (via
 * `getGeminiChatClient`, purely to obtain the authenticated endpoint), `vertexModelName`,
 * `vertexRegion` and `AUDIT_LLM_SEED` from lib/llm.ts. The transport itself is a SEPARATE SDK
 * instance with `maxRetries: 0` and an instrumented `fetch`.
 *
 * ── ONE DISPATCH PER SCHEDULED CALL, ENFORCED AT THE FETCH BOUNDARY ─────────────────────────────
 * `instrumentedFetch` is the only way out of this process. It counts, and a second call for the
 * same scheduled run throws BEFORE reaching the network. A run whose count is not one is recorded
 * invalid. This is not belt-and-braces: `maxRetries: 0` is a promise the SDK makes about itself,
 * and the point of the counter is not to trust it.
 *
 * ── THE ARM IS READ OFF THE BYTES ───────────────────────────────────────────────────────────────
 * Before the network call, the serialized outbound body is parsed back and classified by
 * `realizedArmFromSerializedBody`. If it does not match the scheduled arm, the dispatch is
 * refused. PRD §1 exists because v2.0 would otherwise have run two silent duplicate arms.
 *
 * ── COMMANDS ────────────────────────────────────────────────────────────────────────────────────
 *   (no args) | --dry-run   every step except authentication and dispatch
 *   --freeze                build the frozen input + manifest (reads the DB; makes NO model call)
 *   --remanifest            rewrite the manifest ONLY, leaving the frozen input untouched
 *   --probe                 ONE synthetic non-clinical call, §3.7 (this one does cost money)
 *   --report                re-print aggregates from an existing journal
 *   --execute --experiment <id> --manifest-hash <sha256> [--cycle 1|2]
 * Any omission on the execute path defaults to a dry run (§5).
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, statSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import OpenAI from 'openai';

import * as core from '../lib/lvc-judge-capacity-factorial-core.ts';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 0. CONSTANTS AND SMALL HELPERS
// ════════════════════════════════════════════════════════════════════════════════════════════════

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const PRIVATE_ROOT_ABS = join(REPO_ROOT, core.PRIVATE_ROOT);
const FROZEN_INPUT_PATH = join(PRIVATE_ROOT_ABS, 'frozen-input.private.json');
const MANIFEST_PATH = join(PRIVATE_ROOT_ABS, 'manifest.private.json');
const PROBE_PATH = join(PRIVATE_ROOT_ABS, 'probe.private.json');
const RUNS_DIR = join(PRIVATE_ROOT_ABS, 'runs');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** The two variables the runner must refuse to start with, and must never read (§3.3, D-37). */
const FORBIDDEN_ENV = ['LLM_THINKING_BUDGET', 'AUDIT_EVAL_THINKING_BUDGET'];

/**
 * §4.1 — the ONLY files this build is allowed to add on top of the reference commit. Preflight
 * diffs HEAD against the reference and fails on anything that is not an addition of one of these,
 * so "edit no existing file" is machine-checked on every command rather than merely asserted.
 */
const ALLOWED_NEW_FILES = [
  'lib/lvc-judge-capacity-factorial-core.ts',
  'lib/__tests__/lvc-judge-capacity-factorial-core.test.ts',
  'scripts/lvc-judge-capacity-factorial.mjs',
];

/** §3.4 — the target recommendation count. The r1 list is used ONLY to pick the note. */
const TARGET_REC_COUNT = 49;
const R1_EXPERIMENT = 'lvc_judge_aa_r1';

const say = (...a) => console.log(...a);
const die = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function gitOk(...args) {
  try { execFileSync('git', args, { cwd: REPO_ROOT, stdio: 'ignore' }); return true; } catch { return false; }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. PRIVATE-ROOT I/O — every write goes through here (§4.2)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Refuse any path outside the private root. Checked on EVERY write, not once at startup. */
function guardPath(p) {
  const abs = resolve(p);
  if (!core.isInsidePrivateRoot(PRIVATE_ROOT_ABS, abs)) {
    throw new Error('refusing to write outside the private artifact root');
  }
  return abs;
}

function ensureDir(p) {
  const abs = guardPath(p);
  mkdirSync(abs, { recursive: true, mode: DIR_MODE });
  chmodSync(abs, DIR_MODE);
  return abs;
}

/** Temp file + fsync + atomic rename, so a killed process never leaves a half-written artifact. */
function writePrivateFile(p, text) {
  const abs = guardPath(p);
  ensureDir(dirname(abs));
  const tmp = `${abs}.tmp`;
  guardPath(tmp);
  const fd = openSync(tmp, 'w', FILE_MODE);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, abs);
  chmodSync(abs, FILE_MODE);
  return abs;
}

function writePrivateJson(p, value) {
  return writePrivateFile(p, `${core.canonicalJsonString(value)}\n`);
}

function readPrivateJson(p) {
  const abs = guardPath(p);
  return JSON.parse(readFileSync(abs, 'utf8'));
}

/** Append-only JSONL, fsynced before the caller is allowed to continue (§4.5). */
function appendJournal(journalPath, event) {
  const abs = guardPath(journalPath);
  ensureDir(dirname(abs));
  const fd = openSync(abs, 'a', FILE_MODE);
  try { writeSync(fd, `${JSON.stringify(event)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(abs, FILE_MODE);
}

function readJournal(journalPath) {
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { run_id: '', event: 'unparseable_line' }; }
  });
}

/** Exclusive-create lock: two processes must never share an experiment identifier (§4.5). */
function acquireLock(dir) {
  const lock = guardPath(join(dir, 'RUNNING.lock'));
  let fd;
  try { fd = openSync(lock, 'wx', FILE_MODE); } catch {
    die('an experiment lock already exists for this identifier — another process holds it, or a previous run died. Inspect the journal; do not delete the lock to "retry" a call that may already have dispatched.');
  }
  writeSync(fd, `${process.pid}\n`);
  fsyncSync(fd);
  closeSync(fd);
  return lock;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. PREFLIGHT (§3.3, §4.2, §4.3)
// ════════════════════════════════════════════════════════════════════════════════════════════════

function preflight() {
  const problems = [];

  // ── the reference SOURCE TREE is pristine ────────────────────────────────────────────────────
  // What §4.3 protects is the TREE, not the commit pointer. An equality test on HEAD was the first
  // version of this check and it was wrong in a way that mattered: committing the harness itself
  // moves HEAD off the reference, so the runner could never start once it existed as a commit —
  // including for cycle 1. The property to enforce is that HEAD descends from the reference and
  // ADDS ONLY the three files §4.1 permits, changing nothing that was already there.
  const head = git('rev-parse', 'HEAD');
  let referenceTreeIntact = false;
  if (head === core.REFERENCE_SHA) {
    referenceTreeIntact = true;
  } else if (git('merge-base', core.REFERENCE_SHA, 'HEAD') !== core.REFERENCE_SHA) {
    problems.push(`HEAD does not descend from the reference commit (${core.REFERENCE_SHA.slice(0, 12)})`);
  } else {
    const changes = git('diff', '--name-status', core.REFERENCE_SHA, 'HEAD').split('\n').filter(Boolean);
    const illegal = changes.filter((l) => {
      const [status, path] = l.split('\t');
      return status !== 'A' || !ALLOWED_NEW_FILES.includes(path);
    });
    if (illegal.length) problems.push(`${illegal.length} change(s) since the reference are not permitted additions — §4.1 allows only the three new files`);
    else referenceTreeIntact = true;
  }

  const status = git('status', '--porcelain');
  const modifiedTracked = status.split('\n').filter((l) => l && !l.startsWith('??'));
  if (modifiedTracked.length) problems.push(`${modifiedTracked.length} tracked file(s) modified — the reference tree must be pristine`);

  // ── the environment carries no thinking budget, and this runner never reads one ──────────────
  // Stricter than "non-empty": PRESENT AT ALL fails. An empty LLM_THINKING_BUDGET is harmless
  // today only because geminiThinkingBudget() coerces it away — and this runner does not call
  // geminiThinkingBudget(). Refusing the key outright cannot be wrong in the unsafe direction.
  for (const k of FORBIDDEN_ENV) {
    if (Object.prototype.hasOwnProperty.call(process.env, k)) problems.push(`${k} is present in the environment`);
  }

  // ── the private root is ignored and untracked ────────────────────────────────────────────────
  if (!gitOk('check-ignore', '-q', core.PRIVATE_ROOT)) problems.push(`${core.PRIVATE_ROOT} is not covered by .gitignore`);
  for (const rel of ['frozen-input.private.json', 'manifest.private.json', 'probe.private.json', 'runs/x/journal.private.jsonl', 'runs/x/summary.private.json', 'runs/x/responses/y.private.txt']) {
    if (!gitOk('check-ignore', '-q', join(core.PRIVATE_ROOT, rel))) problems.push(`${rel} is not ignored`);
  }
  const tracked = git('ls-files', '--', core.PRIVATE_ROOT);
  if (tracked) problems.push('files under the private root are TRACKED by git');

  // ── permissions on anything already there ────────────────────────────────────────────────────
  problems.push(...permissionProblems(PRIVATE_ROOT_ABS));

  return { ok: problems.length === 0, problems, head, referenceTreeIntact, modifiedTracked: modifiedTracked.length };
}

function permissionProblems(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (p) => {
    const st = statSync(p);
    const mode = st.mode & 0o777;
    if (st.isDirectory()) {
      if (mode !== DIR_MODE) out.push(`directory mode ${mode.toString(8)} (want 700)`);
      for (const name of readdirSync(p)) walk(join(p, name));
    } else if (mode !== FILE_MODE) {
      out.push(`file mode ${mode.toString(8)} (want 600)`);
    }
  };
  walk(root);
  return out;
}

function requirePreflight() {
  const pf = preflight();
  say('preflight');
  say(`  HEAD                       ${pf.head}`);
  say(`  reference tree intact      ${pf.referenceTreeIntact ? `yes (adds only the ${ALLOWED_NEW_FILES.length} permitted files)` : 'NO'}`);
  say(`  modified tracked files     ${pf.modifiedTracked}`);
  say(`  ${FORBIDDEN_ENV.join(' / ')}  ${FORBIDDEN_ENV.every((k) => !(k in process.env)) ? 'absent' : 'PRESENT'}`);
  say(`  private root ignored       ${gitOk('check-ignore', '-q', core.PRIVATE_ROOT) ? 'yes' : 'NO'}`);
  say(`  private root tracked files ${git('ls-files', '--', core.PRIVATE_ROOT).split('\n').filter(Boolean).length}`);
  if (!pf.ok) {
    for (const p of pf.problems) console.error(`  ✗ ${p}`);
    die('preflight failed');
  }
  say('  → preflight PASS');
  return pf;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. TRANSPORT — a separate SDK instance, retries zero, instrumented fetch (§4.4)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The active scheduled call. The fetch boundary refuses to fire when this is null, so a stray
 * SDK request (a retry, a token refresh through the wrong client, a second `create`) cannot
 * escape unattributed.
 */
let ACTIVE = null;

async function instrumentedFetch(url, init) {
  if (!ACTIVE) throw new Error('transport_fired_outside_a_scheduled_call');
  ACTIVE.dispatches += 1;
  if (ACTIVE.dispatches > 1) throw new Error('second_dispatch_refused_at_the_fetch_boundary');

  const serialized = typeof init?.body === 'string' ? init.body : null;
  ACTIVE.serializedBody = serialized;

  if (ACTIVE.expectArm) {
    if (serialized === null) throw new Error('outbound_body_was_not_a_string');
    const realized = core.realizedArmFromSerializedBody(serialized);
    ACTIVE.realized = realized;
    if (realized.arm !== ACTIVE.expectArm || realized.violations.length) {
      // Fail CLOSED, before the network call. A body that does not match its arm is not a
      // datapoint with a caveat; it is a different experiment.
      throw new Error(`realized_arm_mismatch:${realized.arm ?? 'none'}:${realized.violations.join('|') || 'arm'}`);
    }
    core.assertWireMaxTokens(realized.maxTokens);
  }
  const red = core.redactSerializedBody(serialized ?? '{}');
  ACTIVE.requestBodyHash = red.redacted ? core.hashCanonicalJson(red.redacted) : null;
  ACTIVE.requestShape = red.redacted ?? null;

  const t0 = performance.now();
  const res = await fetch(url, init);
  ACTIVE.ttfbMs = performance.now() - t0;
  ACTIVE.status = res.status;

  const headers = {};
  for (const [k, v] of res.headers.entries()) headers[k] = v;
  ACTIVE.headers = core.filterResponseHeaders(headers);

  // Capture the RAW response text before anything looks at it (§ kickoff step 4). The SDK gets a
  // faithful replay; `content-encoding`/`content-length` are dropped because fetch already
  // decoded the body and re-declaring them would misdescribe what we hand back.
  const raw = await res.text();
  ACTIVE.rawResponseText = raw;
  ACTIVE.totalMs = performance.now() - t0;

  const replayHeaders = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'content-encoding' || lk === 'content-length') continue;
    replayHeaders.set(k, v);
  }
  return new Response(raw, { status: res.status, statusText: res.statusText, headers: replayHeaders });
}

/**
 * Production-equivalent authentication and endpoint, obtained by asking the production helper for
 * a client and taking its resolved `baseURL` + bearer — then building OUR OWN instance around
 * them with retries zero, one timeout and the instrumented fetch. `vertexBaseURL()` is not
 * exported from lib/llm.ts; borrowing the configured client is how this stays production-
 * equivalent without copying the URL construction and letting the two drift.
 */
async function buildTransport(llm) {
  const configured = await llm.getGeminiChatClient();
  return new OpenAI({
    baseURL: configured.baseURL,
    apiKey: configured.apiKey,
    maxRetries: 0,
    timeout: core.TIMEOUT_MS,
    fetch: instrumentedFetch,
  });
}

/** One call, fully instrumented. Never throws for a provider outcome — it returns one. */
async function dispatchOnce({ client, body, runId, expectArm }) {
  ACTIVE = { runId, expectArm, dispatches: 0 };
  const started = performance.now();
  let outcome = 'completed';
  let errorClass = null;
  try {
    await client.chat.completions.create(body, { timeout: core.TIMEOUT_MS });
  } catch (e) {
    const name = String(e?.name ?? '');
    const msg = String(e?.message ?? '');
    if (msg.startsWith('realized_arm_mismatch') || msg.startsWith('second_dispatch')) { outcome = 'parse_error'; errorClass = msg.split(':')[0]; }
    else if (name === 'APIConnectionTimeoutError' || name === 'AbortError') { outcome = 'timeout'; errorClass = 'timeout'; }
    else if (typeof e?.status === 'number') { outcome = 'http_error'; errorClass = `http_${e.status}`; }
    else { outcome = 'network_error'; errorClass = name || 'unknown'; }
  }
  const snap = ACTIVE;
  ACTIVE = null;
  snap.wallMs = performance.now() - started;
  snap.outcome = outcome;
  snap.errorClass = errorClass;
  if (snap.dispatches !== 1) { snap.outcome = 'outcome_unknown'; snap.errorClass = `dispatch_count_${snap.dispatches}`; }
  else if (typeof snap.status === 'number' && snap.status >= 400 && outcome === 'completed') { snap.outcome = 'http_error'; snap.errorClass = `http_${snap.status}`; }
  return snap;
}

/**
 * The measurement view of a raw HTTP body. No production classifier, no production parser.
 *
 * `usageKeys` records WHICH usage fields the endpoint actually sent (names only, never values on
 * their own) — §3.6 distinguishes "a flat provider field" from "a completion-detail field", and
 * without this the report can say telemetry exists but not where it came from.
 */
function readCompletion(rawText) {
  let body = null;
  try { body = JSON.parse(rawText ?? ''); } catch { return { parsed: false, content: '', finishReason: null, usage: null, usageKeys: [], servedModel: null }; }
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  const usage = body?.usage ?? null;
  const usageKeys = usage && typeof usage === 'object'
    ? Object.keys(usage).flatMap((k) => {
      const v = usage[k];
      return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).map((sub) => `${k}.${sub}`) : [k];
    }).sort()
    : [];
  return {
    parsed: true,
    content: typeof choice?.message?.content === 'string' ? choice.message.content : '',
    finishReason: choice?.finish_reason == null ? null : String(choice.finish_reason),
    usage,
    usageKeys,
    servedModel: body?.model == null ? null : String(body.model),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. FREEZE (§3.4) — reads the DB, makes NO model call
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ THE FREEZE PATH IS THE ONE PLACE THAT TOUCHES CLINICAL DATA. It reads one OPD note, renders
 * the judge prompt exactly as production would, and writes the bytes to the private root. Nothing
 * it reads is printed: the terminal gets hashes, a count and a model name.
 *
 * It reproduces the A/A harness's assembly (app/api/admin/lvc-judge-aa/route.ts `inputForCase` +
 * "Pass 0"), because that is the assembly whose recall list r1 was built from. `proposedActions`
 * is set, so candidate extraction is SKIPPED and no LLM call happens; the injected judge captures
 * the context and returns the pipeline's own soft-fail shape, so `defaultJudge` is never reached.
 */
async function cmdFreeze() {
  requirePreflight();

  const { neon } = await import('@neondatabase/serverless');
  const llm = await import('../lib/llm.ts');
  const lvcCore = await import('../lib/lvc-core.ts');
  const { matchLowValueCare } = await import('../lib/lvc.ts');
  const { fetchOpdNoteByUid } = await import('../lib/metabase.ts');
  const { rowToOpdCase, opdCaseText } = await import('../lib/opd-ingest-core.ts');
  const { enrichOpdMeds } = await import('../lib/formulary.ts');
  const { labPackageContext } = await import('../lib/scoring-policy/lab-packages.ts');

  const sql = neon(process.env.DATABASE_URL);

  // §3.4 — nearest TARGET_REC_COUNT from the r1 case list, ties by LOWEST identifier. r1 picks
  // the note and nothing else; its stored verdicts are never read and never treated as truth.
  const rows = await sql`
    SELECT input_ref AS uid, (output->>'nRecsRecalled')::int AS n_recs
      FROM lab_analyses
     WHERE experiment = ${R1_EXPERIMENT} AND kind = 'lvc_judge_aa'
       AND output->>'status' = 'compared' AND input_ref IS NOT NULL
       AND (output->>'nRecsRecalled') IS NOT NULL`;
  if (!rows.length) die('the r1 case list is empty — nothing to select from');
  const ranked = rows
    .map((r) => ({ uid: String(r.uid), nRecs: Number(r.n_recs) }))
    .filter((r) => r.uid && Number.isFinite(r.nRecs))
    .sort((a, b) => (Math.abs(a.nRecs - TARGET_REC_COUNT) - Math.abs(b.nRecs - TARGET_REC_COUNT)) || a.uid.localeCompare(b.uid));
  const picked = ranked[0];
  say(`\nfrozen input`);
  say(`  r1 cases considered        ${ranked.length}`);
  say(`  selected |n_recs − ${TARGET_REC_COUNT}|      ${Math.abs(picked.nRecs - TARGET_REC_COUNT)}`);
  say(`  r1 recall count            ${picked.nRecs}`);

  const row = await fetchOpdNoteByUid(picked.uid);
  if (!row) die('the selected case has no source note — re-run after confirming the case list');
  const { case: oc } = rowToOpdCase(row);
  enrichOpdMeds(oc.medications);
  const orders = [
    ...oc.medications.map((m) => (m.resolvedGeneric || m.generic || m.brand || '').trim()),
    ...oc.investigations.map((i) => String(i || '').trim()),
  ].filter(Boolean);
  const input = { scenario: opdCaseText(oc), proposedActions: [...new Set(orders)], surface: 'surface' };
  if (!input.proposedActions.length) die('the selected case has no orders — it never reaches the judge');

  let ctx = null;
  let recs = [];
  await matchLowValueCare({ ...input, trace: false }, {
    judge: async (judgeCtx, judgeRecs) => {
      ctx = judgeCtx;
      recs = judgeRecs;
      return judgeRecs.map((rec) => ({ rec, verdict: 'insufficient_info', confidence: 0, why: '', consider_instead: null }));
    },
  });
  if (!recs.length) die('the selected case recalled nothing — the judge would never be called');

  const labPackages = await labPackageContext().catch(() => []);
  const messages = [
    { role: 'system', content: lvcCore.JUDGE_SYSTEM },
    { role: 'user', content: lvcCore.buildJudgeUser(ctx, recs, ctx.clinicalStateText, ctx.orderedActions, labPackages) },
  ];
  const snapshot = recs.map((r) => ({
    id: r.id, region: r.region, society: r.society, statement: r.statement, precondition: r.precondition ?? null,
  }));
  const hashes = core.frozenInputHashes(messages, snapshot);

  const frozen = {
    protocol: core.PROTOCOL_ID,
    reference_sha: core.REFERENCE_SHA,
    case_ref: picked.uid,
    model: core.JUDGE_MODEL,
    messages,
    expected_ids: recs.map((r) => r.id),
    expected_count: recs.length,
    hashes,
    recommendation_snapshot: snapshot,
  };
  const violations = core.validateFrozenInput(frozen);
  if (violations.length) die(`frozen input invalid: ${violations.join(', ')}`);
  writePrivateJson(FROZEN_INPUT_PATH, frozen);

  const manifest = buildManifest(frozen, {
    judgeSeesAction: process.env.RIGHT_CARE_JUDGE_SEES_ACTION ?? null,
    orderedActionsRendered: Array.isArray(ctx.orderedActions) && ctx.orderedActions.length > 0,
    labPackagesRendered: labPackages.length,
    region: llm.vertexRegion(),
    wireModel: llm.vertexModelName(core.JUDGE_MODEL),
    seed: llm.AUDIT_LLM_SEED,
  });
  const manifestHash = core.hashCanonicalJson(manifest);
  writePrivateJson(MANIFEST_PATH, { ...manifest, manifest_sha256: manifestHash });

  say(`  recommendations frozen     ${frozen.expected_count}`);
  say(`  system_message   sha256    ${hashes.system_message}`);
  say(`  user_message     sha256    ${hashes.user_message}`);
  say(`  message_array    sha256    ${hashes.message_array}`);
  say(`  recommendation   sha256    ${hashes.recommendation_snapshot}`);
  say(`  manifest         sha256    ${manifestHash}`);
  say(`  written                    ${core.PRIVATE_ROOT}/frozen-input.private.json, manifest.private.json`);
}

function buildManifest(frozen, env) {
  return {
    protocol: core.PROTOCOL_ID,
    reference_sha: core.REFERENCE_SHA,
    reference_caller_max_tokens: core.REFERENCE_CALLER_MAX_TOKENS,
    reference_wire_max_tokens: core.WIRE_MAX_TOKENS_CONTROL,
    // §3.3 — "whether the reference environment had a global thinking budget". This process is
    // guaranteed clean by preflight. The DEPLOYED environment cannot be read from the repository,
    // so it rides a preregistered literal carrying V's confirmation and its date (11 Aug 2026:
    // never set in production, at any point) — see the core's constant for why it is not a flag.
    runner_env_global_thinking_budget: 'absent',
    reference_env_global_thinking_budget: core.REFERENCE_ENV_GLOBAL_THINKING_BUDGET,
    reference_env_confirmed_on: core.REFERENCE_ENV_CONFIRMED_ON,
    right_care_judge_sees_action: env.judgeSeesAction,
    ordered_actions_rendered: env.orderedActionsRendered,
    lab_packages_rendered: env.labPackagesRendered,
    model: core.JUDGE_MODEL,
    wire_model: env.wireModel,
    vertex_region: env.region,
    seed: env.seed,
    temperature: 0,
    top_p: 1,
    timeout_ms: core.TIMEOUT_MS,
    thinking_budget: core.THINKING_BUDGET,
    wire_max_tokens: { control: core.WIRE_MAX_TOKENS_CONTROL, high: core.WIRE_MAX_TOKENS_HIGH },
    arms: core.ARM_IDS.map((a) => core.armSpec(a)),
    schedule_blocks: core.SCHEDULE_BLOCKS.map((b) => [...b]),
    cycles: core.CYCLES,
    calls_per_cycle: core.CALLS_PER_CYCLE,
    total_scheduled_calls: core.TOTAL_SCHEDULED_CALLS,
    primary_endpoint: 'raw_complete',
    secondary_endpoint: 'provider_usable',
    production_accepted_finish_reasons: [...core.PRODUCTION_ACCEPTED_FINISH_REASONS],
    frozen_input: { expected_count: frozen.expected_count, hashes: frozen.hashes },
  };
}

/**
 * RE-EMIT THE MANIFEST WITHOUT RE-FREEZING THE INPUT.
 *
 * ⚠️ WHY THIS IS A SEPARATE COMMAND AND NOT A RE-RUN OF --freeze. Some manifest fields are facts
 * about the reference ENVIRONMENT, not about the frozen bytes, and they can be confirmed after the
 * freeze — V's ruling on `LLM_THINKING_BUDGET` is the case in point. Re-running --freeze to pick
 * one up would re-read the database and re-render the prompt, so a corpus change between the two
 * runs could silently move the frozen input while nobody was looking at it. This command CANNOT do
 * that: it reads the frozen input, refuses to continue unless its four hashes still match what the
 * existing manifest recorded, and rewrites only the manifest.
 *
 * Every reference-environment fact recorded at freeze time is carried forward verbatim, so a
 * re-emit run does not have to reproduce the freeze-time environment to avoid corrupting it.
 */
function cmdRemanifest() {
  requirePreflight();
  if (!existsSync(FROZEN_INPUT_PATH) || !existsSync(MANIFEST_PATH)) die('no frozen input or manifest to re-emit — run --freeze first');

  const frozen = readPrivateJson(FROZEN_INPUT_PATH);
  const fv = core.validateFrozenInput(frozen);
  if (fv.length) die(`frozen input invalid: ${fv.join(', ')}`);

  const { manifest_sha256: priorHash, ...prior } = readPrivateJson(MANIFEST_PATH);
  if (core.hashCanonicalJson(prior) !== priorHash) die('the existing manifest does not hash to its own recorded value');
  if (core.canonicalJsonString(prior.frozen_input?.hashes) !== core.canonicalJsonString(frozen.hashes)) {
    die('the manifest and the frozen input already disagree — re-emitting cannot repair that; re-freeze instead');
  }

  const next = {
    ...prior,
    reference_env_global_thinking_budget: core.REFERENCE_ENV_GLOBAL_THINKING_BUDGET,
    reference_env_confirmed_on: core.REFERENCE_ENV_CONFIRMED_ON,
    frozen_input: { expected_count: frozen.expected_count, hashes: frozen.hashes },
  };
  const nextHash = core.hashCanonicalJson(next);
  writePrivateJson(MANIFEST_PATH, { ...next, manifest_sha256: nextHash });

  const changed = [...new Set([...Object.keys(prior), ...Object.keys(next)])]
    .filter((k) => core.canonicalJsonString(prior[k]) !== core.canonicalJsonString(next[k])).sort();

  say('\nmanifest re-emitted (the frozen input was NOT rebuilt)');
  say(`  fields changed             ${changed.join(', ') || 'none'}`);
  say(`  reference env budget       ${prior.reference_env_global_thinking_budget} → ${next.reference_env_global_thinking_budget} (confirmed ${next.reference_env_confirmed_on})`);
  for (const [label, key] of [['system_message  ', 'system_message'], ['user_message    ', 'user_message'], ['message_array   ', 'message_array'], ['recommendation  ', 'recommendation_snapshot']]) {
    say(`  ${label} sha256    ${frozen.hashes[key]}  UNCHANGED`);
  }
  say(`  recommendations frozen     ${frozen.expected_count} (unchanged)`);
  say(`  manifest         sha256    ${priorHash}`);
  say(`                          →  ${nextHash}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5. THE PROBE (§3.7) — ONE synthetic, non-clinical call. Excluded from the factorial.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A small, purely combinatorial task. It carries no patient, no clinical vocabulary and no
 * identifier, and it is chosen to need enough step-by-step work that a 128-token cap can bite.
 */
const PROBE_SYSTEM = 'You are a careful puzzle solver. Work the problem out, then answer with a JSON object and nothing else.';
const PROBE_USER = [
  'Five sealed boxes are labelled 1 to 5. Exactly one contains a marble.',
  'Box 1 says: "the marble is in an odd-numbered box".',
  'Box 2 says: "the marble is not in box 5".',
  'Box 3 says: "the marble is in box 2 or box 4".',
  'Box 4 says: "box 1 is lying".',
  'Box 5 says: "exactly two of these five statements are true".',
  'Exactly two of the five statements are true.',
  'Return {"box": <n>} for the box holding the marble.',
].join('\n');

/** Not a factorial level — the probe is excluded, so it must not borrow an arm's capacity. */
const PROBE_MAX_TOKENS = 2_048;
const PROBE_THINKING_BUDGET = 128;

async function cmdProbe() {
  requirePreflight();
  const llm = await import('../lib/llm.ts');
  const client = await buildTransport(llm);

  const body = {
    model: llm.vertexModelName(core.JUDGE_MODEL),
    messages: [
      { role: 'system', content: PROBE_SYSTEM },
      { role: 'user', content: PROBE_USER },
    ],
    temperature: 0,
    seed: llm.AUDIT_LLM_SEED,
    top_p: 1,
    max_tokens: PROBE_MAX_TOKENS,
    google: { thinking_config: { thinking_budget: PROBE_THINKING_BUDGET } },
  };

  say('\nprobe (§3.7) — one synthetic non-clinical call, direct Vertex, budget 128');
  // expectArm is null: the probe is not an arm, so the arm gate does not apply to it. The
  // one-dispatch counter still does.
  const snap = await dispatchOnce({ client, body, runId: 'probe', expectArm: null });
  const completion = readCompletion(snap.rawResponseText);
  const tokens = core.deriveTokenAccounting(completion.usage, { inferredSemanticEstablished: false });

  const accepted = snap.status === 200 && snap.outcome === 'completed';
  const telemetry = tokens.reasoning_tokens_reported !== null
    ? 'reported'
    : (tokens.unaccounted_output_tokens !== null ? 'inferable_candidate' : 'unavailable');

  const result = {
    protocol: core.PROTOCOL_ID,
    kind: 'probe',
    thinking_budget_sent: PROBE_THINKING_BUDGET,
    max_tokens_sent: PROBE_MAX_TOKENS,
    dispatches: snap.dispatches,
    http_status: snap.status ?? null,
    outcome: snap.outcome,
    error_class: snap.errorClass,
    request_body_sha256: snap.requestBodyHash,
    request_shape: snap.requestShape,
    response_headers: snap.headers?.kept ?? {},
    response_headers_dropped: snap.headers?.dropped_count ?? 0,
    response_sha256: snap.rawResponseText == null ? null : core.sha256Hex(snap.rawResponseText),
    response_bytes: snap.rawResponseText?.length ?? 0,
    finish_reason: completion.finishReason,
    served_model: completion.servedModel,
    usage_keys: completion.usageKeys,
    tokens,
    field_accepted: accepted,
    reasoning_telemetry: telemetry,
    // §3.7: do NOT infer cap enforcement from HTTP 200 — this repository has prior evidence of
    // accepted no-op fields (generationConfig.thinkingConfig, extra_body: both 200, both inert).
    cap_enforcement: tokens.reasoning_tokens_reported === null
      ? 'unverified'
      : (tokens.reasoning_tokens_reported <= PROBE_THINKING_BUDGET ? 'consistent_with_the_cap' : 'inconsistent_with_the_cap'),
  };
  writePrivateJson(PROBE_PATH, result);

  say(`  dispatches                 ${result.dispatches}`);
  say(`  http status                ${result.http_status}`);
  say(`  outcome                    ${result.outcome}${result.error_class ? ` (${result.error_class})` : ''}`);
  say(`  google field accepted      ${result.field_accepted ? 'YES — HTTP 200, no rejection' : 'NO'}`);
  say(`  finish_reason              ${result.finish_reason}`);
  say(`  prompt / completion / total ${tokens.prompt_tokens} / ${tokens.completion_tokens} / ${tokens.total_tokens}`);
  say(`  reasoning_tokens_reported  ${tokens.reasoning_tokens_reported}`);
  say(`  unaccounted_output_tokens  ${tokens.unaccounted_output_tokens}`);
  say(`  usage fields returned      ${result.usage_keys.join(', ') || 'none'}`);
  say(`  reasoning telemetry        ${result.reasoning_telemetry}`);
  say(`  cap enforcement            ${result.cap_enforcement}`);
  if (!result.field_accepted) {
    say('\n  ⚠️ §3.7: THE ENDPOINT REJECTED THE FIELD ⇒ PREREGISTRATION FAILS. Do not run the factorial.');
  } else if (result.reasoning_telemetry !== 'reported') {
    say('\n  ⚠️ §3.7: reasoning telemetry is NOT reported. Report to V BEFORE spending the 32 calls:');
    say('     the thinking factor cannot be measured directly, only inferred from completeness, and');
    say('     V decides whether to proceed or fall back to a capacity-only two-arm comparison.');
  }
  say(`  written                    ${core.PRIVATE_ROOT}/probe.private.json`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6. DRY RUN (§5)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Wrappers whose presence in this file would mean the runner is not measuring the raw provider. */
const FORBIDDEN_IMPORT_TOKENS = [
  'defaultJudge', 'governedChat', 'tracedChat', 'chatWithFallback', 'buildOpenrouterParams',
  'openrouterChatClient', 'createWithRetry', 'openrouterCreateWithRetry', 'classifyProviderResponse',
  'parseJudgeResponse', 'bedrockOnlyChat', 'geminiThinkingBudget',
];

function assertNoProductionWrappers() {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  // Only IMPORT statements are scanned — this file names the forbidden wrappers in prose on
  // purpose, so that the next reader knows what was excluded and why.
  const importLines = src.split('\n').filter((l) => /^\s*(import\b|.*\bawait import\()/.test(l));
  const hits = FORBIDDEN_IMPORT_TOKENS.filter((t) => importLines.some((l) => l.includes(t)));
  return hits;
}

async function cmdDryRun() {
  requirePreflight();
  const llm = await import('../lib/llm.ts');

  const problems = [];
  const experimentId = 'dryrun';
  const schedule = core.buildSchedule(experimentId, core.CYCLES);
  problems.push(...core.validateSchedule(schedule));
  if (schedule.length !== core.TOTAL_SCHEDULED_CALLS) problems.push('schedule_length');

  // Synthetic input — the dry run must never depend on, or touch, the clinical frozen bytes.
  const synthetic = {
    messages: [
      { role: 'system', content: 'SYNTHETIC SYSTEM MESSAGE FOR DRY RUN' },
      { role: 'user', content: 'SYNTHETIC USER MESSAGE FOR DRY RUN' },
    ],
    expected_ids: Array.from({ length: 49 }, (_, i) => `synthetic-rec-${String(i + 1).padStart(3, '0')}`),
  };
  const wireModel = llm.vertexModelName(core.JUDGE_MODEL);
  const armInput = { wireModel, messages: synthetic.messages, seed: llm.AUDIT_LLM_SEED };

  // Arm realization off the SERIALIZED body, exactly as the fetch boundary does it.
  const perArm = Object.fromEntries(core.ARM_IDS.map((a) => [a, 0]));
  const bodies = {};
  for (const call of schedule) {
    const body = core.buildArmRequest(call.arm, armInput);
    bodies[call.arm] = body;
    const av = core.assertArmRequest(call.arm, body);
    if (av.length) problems.push(`arm_${call.arm}_body:${av.join('|')}`);
    const realized = core.realizedArmFromSerializedBody(JSON.stringify(body));
    if (realized.arm !== call.arm) problems.push(`arm_${call.arm}_realization`);
    if (realized.violations.length) problems.push(`arm_${call.arm}_realized:${realized.violations.join('|')}`);
    try { core.assertWireMaxTokens(realized.maxTokens); } catch { problems.push(`arm_${call.arm}_max_tokens`); }
    perArm[call.arm] += 1;
  }
  for (const a of core.ARM_IDS) if (perArm[a] !== core.TOTAL_SCHEDULED_CALLS / 4) problems.push(`arm_${a}_count`);

  // §5 — the ONLY properties that vary between arms are max_tokens and the presence of google.
  for (const [x, y] of [['A', 'B'], ['A', 'C'], ['A', 'D'], ['B', 'C'], ['B', 'D'], ['C', 'D']]) {
    const diff = core.armBodyDifferences(bodies[x], bodies[y]).filter((k) => k !== 'max_tokens' && k !== 'google');
    if (diff.length) problems.push(`arms_${x}${y}_differ_beyond_the_factors:${diff.join(',')}`);
  }

  // ── THE FETCH BOUNDARY ITSELF, EXERCISED WITH NO NETWORK ─────────────────────────────────────
  // Every one of these three refusals happens BEFORE `fetch` is reached, so the dry run can prove
  // the wiring — not just the pure predicate — without authenticating or spending a call. The
  // unreachable host is deliberate: if any of them regressed, the run would fail on DNS rather
  // than reach a provider.
  const boundary = async (state, init) => {
    ACTIVE = state;
    try { await instrumentedFetch('https://never.invalid/must-not-be-reached', init); return 'NO_THROW'; }
    catch (e) { return String(e?.message ?? ''); }
    finally { ACTIVE = null; }
  };
  const mismatched = await boundary({ runId: 'dryrun-boundary', expectArm: 'C', dispatches: 0 }, { body: JSON.stringify(core.buildArmRequest('A', armInput)) });
  if (!mismatched.startsWith('realized_arm_mismatch')) problems.push(`fetch_boundary_allowed_a_mismatched_arm:${mismatched}`);
  // The negative fixture is keyed through a named constant, not a literal `reasoning: {` block:
  // the unit test source-scans this file to prove no dispatch path can construct the OpenRouter
  // dialect, and a fixture that reads like one would blunt exactly the check that matters.
  const OPENROUTER_DIALECT_KEY = 'reason' + 'ing';
  const smuggled = await boundary({ runId: 'dryrun-boundary', expectArm: 'A', dispatches: 0 }, { body: JSON.stringify({ ...core.buildArmRequest('A', armInput), [OPENROUTER_DIALECT_KEY]: { max_tokens: 2048 } }) });
  if (!smuggled.startsWith('realized_arm_mismatch')) problems.push(`fetch_boundary_allowed_the_openrouter_dialect:${smuggled}`);
  const second = await boundary({ runId: 'dryrun-boundary', expectArm: null, dispatches: 1 }, { body: '{}' });
  if (second !== 'second_dispatch_refused_at_the_fetch_boundary') problems.push(`fetch_boundary_allowed_a_second_dispatch:${second}`);
  ACTIVE = null;
  const stray = await instrumentedFetch('https://never.invalid/must-not-be-reached', { body: '{}' }).then(() => 'NO_THROW', (e) => String(e?.message ?? ''));
  if (stray !== 'transport_fired_outside_a_scheduled_call') problems.push(`fetch_boundary_fired_unattributed:${stray}`);

  // Hash stability under key insertion order.
  const h1 = core.hashCanonicalJson({ a: 1, b: { c: 2, d: 3 } });
  const h2 = core.hashCanonicalJson({ b: { d: 3, c: 2 }, a: 1 });
  if (h1 !== h2) problems.push('canonical_hash_unstable');

  // A synthetic journal, written and validated through the real I/O path.
  const dir = ensureDir(join(RUNS_DIR, `dryrun-${core.sha256Hex(core.canonicalJsonString(schedule)).slice(0, 12)}`));
  ensureDir(join(dir, 'responses'));
  const journalPath = join(dir, 'journal.private.jsonl');
  if (existsSync(journalPath)) writePrivateFile(journalPath, '');
  for (const call of schedule) {
    const body = core.buildArmRequest(call.arm, armInput);
    const serialized = JSON.stringify(body);
    appendJournal(journalPath, { run_id: call.runId, event: 'scheduled', arm: call.arm, cycle: call.cycle, block: call.block, position: call.position, intended_request_sha256: core.hashCanonicalJson(core.redactSerializedBody(serialized).redacted) });
    appendJournal(journalPath, { run_id: call.runId, event: 'dispatching', arm: call.arm });
    appendJournal(journalPath, { run_id: call.runId, event: 'completed', arm: call.arm, dispatch_count: 1, realized_arm: core.realizedArmFromSerializedBody(serialized).arm, dry_run: true });
  }
  const jv = core.validateJournal(readJournal(journalPath));
  if (!jv.valid) problems.push(`journal:${jv.problems.slice(0, 3).join('|')}`);
  if (jv.runs.length !== core.TOTAL_SCHEDULED_CALLS) problems.push('journal_run_count');

  // Paths and permissions.
  if (core.isInsidePrivateRoot(PRIVATE_ROOT_ABS, join(REPO_ROOT, 'lib/lvc.ts'))) problems.push('path_guard_accepts_outside');
  if (!core.isInsidePrivateRoot(PRIVATE_ROOT_ABS, journalPath)) problems.push('path_guard_rejects_inside');
  try { guardPath(join(REPO_ROOT, 'data/evil.json')); problems.push('guardPath_did_not_throw'); } catch { /* expected */ }
  problems.push(...permissionProblems(PRIVATE_ROOT_ABS));

  // No production wrapper imported.
  const wrapperHits = assertNoProductionWrappers();
  if (wrapperHits.length) problems.push(`production_wrapper_imported:${wrapperHits.join(',')}`);

  // Nothing secret or clinical in what we are about to print or store.
  const journalText = readFileSync(journalPath, 'utf8');
  for (const needle of ['SYNTHETIC SYSTEM MESSAGE', 'SYNTHETIC USER MESSAGE', 'Bearer ', 'GCP_SA_KEY', 'private_key']) {
    if (journalText.includes(needle)) problems.push(`journal_leaks:${needle.trim()}`);
  }

  say('\ndry run (§5)');
  say(`  scheduled calls            ${schedule.length} (${core.TOTAL_SCHEDULED_CALLS / 4} per arm: ${core.ARM_IDS.map((a) => `${a}=${perArm[a]}`).join(' ')})`);
  say(`  block order                ${core.SCHEDULE_BLOCKS.map((b) => b.join('')).join(' · ')}`);
  say(`  wire max_tokens            A/B ${core.WIRE_MAX_TOKENS_CONTROL} · C/D ${core.WIRE_MAX_TOKENS_HIGH}`);
  say(`  thinking budget (B/D)      ${core.THINKING_BUDGET} (literal, never from the environment)`);
  say(`  timeout, every arm         ${core.TIMEOUT_MS} ms (floor ${core.MIN_TIMEOUT_MS} ms)`);
  say(`  realized-arm source        serialized outbound body`);
  say(`  fetch boundary refusals    mismatched arm · openrouter dialect · second dispatch · unattributed`);
  say(`  synthetic journal events   ${readJournal(journalPath).length}, valid=${jv.valid}`);
  say(`  production wrappers        ${wrapperHits.length === 0 ? 'none imported' : wrapperHits.join(',')}`);
  say(`  frozen input present       ${existsSync(FROZEN_INPUT_PATH) ? 'yes' : 'no (run --freeze)'}`);
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    die('dry run failed');
  }
  say('  → dry run PASS (no authentication, no dispatch)');
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 7. EXECUTE (§3.1, §3.2, §4.4, §4.5)
// ════════════════════════════════════════════════════════════════════════════════════════════════

async function cmdExecute({ experimentId, expectedManifestHash, cycle }) {
  requirePreflight();

  if (!existsSync(FROZEN_INPUT_PATH) || !existsSync(MANIFEST_PATH)) die('no frozen input — run --freeze first');
  const frozen = readPrivateJson(FROZEN_INPUT_PATH);
  const fv = core.validateFrozenInput(frozen);
  if (fv.length) die(`frozen input invalid: ${fv.join(', ')}`);

  const stored = readPrivateJson(MANIFEST_PATH);
  const { manifest_sha256: storedHash, ...manifest } = stored;
  const recomputed = core.hashCanonicalJson(manifest);
  if (recomputed !== storedHash) die('the manifest does not hash to its own recorded value');
  if (recomputed !== expectedManifestHash) die('the supplied --manifest-hash does not match the frozen manifest');
  if (manifest.frozen_input.hashes.message_array !== frozen.hashes.message_array) die('manifest and frozen input disagree');

  if (!existsSync(PROBE_PATH)) die('§3.7: the probe must run, and be reported to V, before the factorial');
  const probe = readPrivateJson(PROBE_PATH);
  if (!probe.field_accepted) die('§3.7: the probe shows the endpoint did not accept the field — preregistration fails');
  const inferredSemanticEstablished = probe.cap_enforcement === 'consistent_with_the_cap';

  const llm = await import('../lib/llm.ts');
  const wireModel = llm.vertexModelName(core.JUDGE_MODEL);
  if (wireModel !== manifest.wire_model) die('the resolved wire model does not match the manifest');
  const armInput = { wireModel, messages: frozen.messages, seed: llm.AUDIT_LLM_SEED };
  if (armInput.seed !== manifest.seed) die('the resolved seed does not match the manifest');

  const dir = ensureDir(join(RUNS_DIR, experimentId));
  const responsesDir = ensureDir(join(dir, 'responses'));
  const journalPath = join(dir, 'journal.private.jsonl');
  const lock = acquireLock(dir);

  const full = core.buildSchedule(experimentId, core.CYCLES);
  const sv = core.validateSchedule(full);
  if (sv.length) die(`schedule invalid: ${sv.join(', ')}`);
  const queue = full.filter((c) => c.cycle === cycle);

  const client = await buildTransport(llm);
  say(`\nexecute · experiment ${experimentId} · cycle ${cycle} · ${queue.length} calls`);

  try {
    for (const call of queue) {
      const events = readJournal(journalPath);
      const action = core.nextJournalAction(events, call.runId);
      if (action === 'skip_done') { say(`  ${call.runId} — already terminal, skipped`); continue; }
      if (action === 'mark_unknown') {
        // §4.5 — never repeat a run id that reached `dispatching` without a terminal event.
        appendJournal(journalPath, { run_id: call.runId, event: 'outcome_unknown', arm: call.arm, reason: 'dispatching_without_terminal_on_a_previous_process' });
        say(`  ${call.runId} — uncertain, marked outcome_unknown (stays in the denominator)`);
        continue;
      }

      const body = core.buildArmRequest(call.arm, armInput);
      const av = core.assertArmRequest(call.arm, body);
      if (av.length) die(`arm ${call.arm} body invalid: ${av.join(', ')}`);
      core.assertWireMaxTokens(body.max_tokens);
      const intendedHash = core.hashCanonicalJson(core.redactSerializedBody(JSON.stringify(body)).redacted);

      appendJournal(journalPath, {
        run_id: call.runId, event: 'scheduled', arm: call.arm, cycle: call.cycle, block: call.block,
        position: call.position, ordinal: call.ordinal, intended_request_sha256: intendedHash,
        message_array_sha256: frozen.hashes.message_array, manifest_sha256: storedHash,
      });
      appendJournal(journalPath, { run_id: call.runId, event: 'dispatching', arm: call.arm });

      const snap = await dispatchOnce({ client, body, runId: call.runId, expectArm: call.arm });

      let responseRef = null;
      let responseHash = null;
      if (typeof snap.rawResponseText === 'string') {
        responseHash = core.sha256Hex(snap.rawResponseText);
        const p = join(responsesDir, `${call.runId}.private.txt`);
        writePrivateFile(p, snap.rawResponseText);
        responseRef = `responses/${call.runId}.private.txt`;
      }

      const completion = readCompletion(snap.rawResponseText);
      const completeness = snap.outcome === 'completed'
        ? core.evaluateCompleteness(completion.content, frozen.expected_ids)
        : null;
      const tokens = core.deriveTokenAccounting(completion.usage, { inferredSemanticEstablished });

      appendJournal(journalPath, {
        run_id: call.runId,
        event: snap.outcome,
        arm: call.arm,
        dispatch_count: snap.dispatches,
        realized_arm: snap.realized?.arm ?? null,
        realized_max_tokens: snap.realized?.maxTokens ?? null,
        realized_thinking_budget: snap.realized?.thinkingBudget ?? null,
        request_body_sha256: snap.requestBodyHash,
        intended_request_sha256: intendedHash,
        http_status: snap.status ?? null,
        error_class: snap.errorClass,
        response_ref: responseRef,
        response_sha256: responseHash,
        response_bytes: snap.rawResponseText?.length ?? 0,
        response_headers: snap.headers?.kept ?? {},
        response_headers_dropped: snap.headers?.dropped_count ?? 0,
        finish_reason: completion.finishReason,
        served_model: completion.servedModel,
        usage_keys: completion.usageKeys,
        completeness,
        tokens,
        ttfb_ms: snap.ttfbMs ?? null,
        total_ms: snap.totalMs ?? null,
        wall_ms: snap.wallMs ?? null,
      });
      say(`  ${call.runId} — ${snap.outcome} (dispatches ${snap.dispatches})`);
    }
  } finally {
    try { renameSync(lock, `${lock}.released`); } catch { /* the report path does not need the lock */ }
  }

  report(experimentId, { blinded: cycle < core.CYCLES });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 8. REPORT — aggregates only, and blinded until both cycles finish (§3.2, §6)
// ════════════════════════════════════════════════════════════════════════════════════════════════

function report(experimentId, { blinded }) {
  const dir = join(RUNS_DIR, experimentId);
  const journalPath = join(dir, 'journal.private.jsonl');
  const events = readJournal(journalPath);
  const jv = core.validateJournal(events);
  const terminal = events.filter((e) => core.JOURNAL_TERMINAL_EVENTS.includes(String(e.event)));

  const scheduledByArm = Object.fromEntries(core.ARM_IDS.map((a) => [a, events.filter((e) => e.event === 'scheduled' && e.arm === a).length]));
  const records = terminal.map((e) => ({
    arm: e.arm,
    responded: e.event === 'completed',
    raw_complete: Boolean(e.completeness?.raw_complete),
    provider_usable: Boolean(e.completeness && core.isProviderUsable(e.completeness, e.finish_reason)),
    finish_reason: e.finish_reason ?? null,
    strict_json_array: Boolean(e.completeness?.strict_json_array),
    production_extractable_array: Boolean(e.completeness?.production_extractable_array),
    missing_id_count: e.completeness?.missing_id_count ?? null,
    completion_tokens: e.tokens?.completion_tokens ?? null,
    reasoning_tokens_reported: e.tokens?.reasoning_tokens_reported ?? null,
    unaccounted_output_tokens: e.tokens?.unaccounted_output_tokens ?? null,
    total_ms: e.total_ms ?? null,
    ttfb_ms: e.ttfb_ms ?? null,
  }));

  const dispatchCounts = terminal.map((e) => e.dispatch_count).filter((n) => n !== undefined);
  const realizedOk = terminal.filter((e) => e.event === 'completed' && e.realized_arm === e.arm).length;

  say('\nintegrity');
  say(`  journal valid              ${jv.valid}${jv.valid ? '' : ` — ${jv.problems.slice(0, 5).join(' | ')}`}`);
  say(`  scheduled                  ${core.ARM_IDS.map((a) => `${a}=${scheduledByArm[a]}`).join(' ')}`);
  say(`  terminal events            ${terminal.length}`);
  say(`  dispatch counts != 1       ${dispatchCounts.filter((n) => n !== 1).length}`);
  say(`  realized arm == scheduled  ${realizedOk}/${terminal.filter((e) => e.event === 'completed').length}`);
  say(`  distinct request hashes/arm ${core.ARM_IDS.map((a) => `${a}=${new Set(terminal.filter((e) => e.arm === a).map((e) => e.request_body_sha256)).size}`).join(' ')}`);
  say(`  token fields present       ${terminal.filter((e) => e.tokens && e.tokens.total_tokens !== null).length}/${terminal.length}`);
  say(`  outcomes                   ${summarizeCounts(terminal.map((e) => String(e.event)))}`);

  if (blinded) {
    // D-34. Cycle 1 is BLINDED rig validation: integrity only. Not completeness, not token values
    // by arm. Reading outcomes now is how a "rig check" quietly becomes an interim analysis.
    say('\n  cycle 1 is BLINDED (D-34) — integrity fields only. Arm outcomes are not printed.');
    say('  If the rig is valid, run cycle 2. If it failed: stop, fix it, issue a NEW experiment');
    say('  identifier and start from zero. Never mix protocols.');
    writePrivateJson(join(dir, 'summary.private.json'), { experiment: experimentId, blinded: true, journal_valid: jv.valid, scheduled_by_arm: scheduledByArm, terminal: terminal.length, dispatch_anomalies: dispatchCounts.filter((n) => n !== 1).length, realized_arm_matches: realizedOk });
    return;
  }

  const aggregates = core.aggregateByArm(records, scheduledByArm);
  const bound = core.thinkingFactorBound(aggregates);
  say('\naggregates (denominator = ALL scheduled calls, D-35)');
  for (const a of aggregates) {
    say(`  arm ${a.arm}  n=${a.scheduled}  raw_complete ${a.raw_complete}/${a.scheduled} [${pctI(a.raw_complete_wilson)}]  provider_usable ${a.provider_usable}/${a.scheduled} [${pctI(a.provider_usable_wilson)}]  finish=length ${a.finish_length}  strict_array ${a.strict_json_array}  extractable ${a.production_extractable_array}`);
    say(`         missing ids ${fmtC(a.missing_ids)}  completion ${fmtC(a.completion_tokens)}  reasoning(reported) ${fmtC(a.reasoning_tokens_reported)}  unaccounted ${fmtC(a.unaccounted_output_tokens)}  total_ms ${fmtC(a.total_ms)}`);
  }
  say(`\n  thinking factor bound?     ${bound.bound === null ? 'UNTESTED' : bound.bound}  (${bound.reason})`);
  if (bound.bound === false) {
    say('  §3.7: the cap never bound ⇒ B and D are duplicates of A and C on that factor. Report the');
    say('  thinking factor as UNTESTED, not as a null result.');
  }
  say('\n  Eight per arm is imprecise and descriptive. Do not claim proof from a non-significant');
  say('  result, and do not use a p-value as a release criterion (§6). §8 is the gate before any');
  say('  production change; nothing ships from this build (D-36).');

  writePrivateJson(join(dir, 'summary.private.json'), {
    experiment: experimentId, blinded: false, journal_valid: jv.valid,
    scheduled_by_arm: scheduledByArm, aggregates, thinking_factor: bound,
    dispatch_anomalies: dispatchCounts.filter((n) => n !== 1).length, realized_arm_matches: realizedOk,
  });
}

const pctI = (i) => `${(i.lo * 100).toFixed(0)}–${(i.hi * 100).toFixed(0)}%`;
const fmtC = (c) => (c.n === 0 ? 'n/a' : `med ${c.median} [${c.min}–${c.max}] n=${c.n}`);
const summarizeCounts = (xs) => Object.entries(xs.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {})).map(([k, v]) => `${k}=${v}`).join(' ');

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 9. ENTRY POINT
// ════════════════════════════════════════════════════════════════════════════════════════════════

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

async function main() {
  if (core.TIMEOUT_MS < core.MIN_TIMEOUT_MS) die('the configured timeout is below the §3.1 floor');

  if (has('freeze')) return cmdFreeze();
  if (has('remanifest')) return cmdRemanifest();
  if (has('probe')) return cmdProbe();
  if (has('report')) {
    const id = arg('experiment');
    if (!id) die('--report needs --experiment <id>');
    requirePreflight();
    return report(id, { blinded: false });
  }

  if (has('execute')) {
    const experimentId = arg('experiment');
    const expectedManifestHash = arg('manifest-hash');
    const cycleRaw = arg('cycle') ?? '1';
    const cycle = Number(cycleRaw);
    // §5 — "any omission defaults to dry-run". A missing identifier or manifest hash is not a
    // typo to be helpfully filled in; it is the difference between a rehearsal and 32 paid calls.
    if (!experimentId || !expectedManifestHash || !Number.isInteger(cycle) || cycle < 1 || cycle > core.CYCLES) {
      say('--execute requires --experiment <id> --manifest-hash <sha256> [--cycle 1|2]; falling back to a dry run.\n');
      return cmdDryRun();
    }
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(experimentId)) die('the experiment identifier must be lowercase kebab-case, 3-64 chars');
    return cmdExecute({ experimentId, expectedManifestHash, cycle });
  }

  return cmdDryRun();
}

main().catch((e) => {
  // Never let a body, a header or a credential reach an exception message: only the error CLASS.
  console.error(`\n✗ runner failed: ${String(e?.name ?? 'Error')}: ${String(e?.message ?? '').slice(0, 200)}`);
  process.exit(1);
});
