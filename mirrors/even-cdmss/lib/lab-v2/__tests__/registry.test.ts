// LAB-MCP-V2 §15.1–15.3 — the registry's metadata, the four keys, and scope visibility.
// Pure: no database, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCOPES, EFFECTS, PRINCIPALS, SCOPES_BY_PRINCIPAL, KEY_ENV_BY_PRINCIPAL, COST_CLASSES, CLASSIFICATIONS } from '../contracts';
import { REGISTRY, annotationsFor, visibleTools } from '../registry';
import { principalFor, labV2KeysConfigured, scopesFor } from '../../mcp-v2/auth';

// ── §15.1 registry ───────────────────────────────────────────────────────────────────
test('§15.1: round 1 registers exactly the fifteen named tools', () => {
  // lab-v2 round A2 (§17.2): the registry grew by the nine observation tools. Round 1's fifteen
  // are pinned BY SLICE below, which is stronger than the bare count this line used to carry.
  assert.equal(REGISTRY.filter((t) => t.slice === 'A-1').length, 15);
  assert.deepEqual(REGISTRY.filter((t) => t.slice === 'A-1').map((t) => t.name).sort(), [
    'dataset_create', 'dataset_preview', 'dataset_validate', 'engine_describe',
    'experiment_create', 'experiment_run', 'model_capabilities', 'run_cancel',
    'run_result', 'run_retry', 'run_status', 'system_capabilities', 'system_health',
    'worker_control', 'worker_status',
  ]);
});

test('§15.1: every tool carries every field §8 declares', () => {
  // §8 names nine: name, description, inputSchema, outputSchema, scopes, effect,
  // classification, cost_class, slice. (§15.1 says "eight"; the list in §8 is the
  // authority and is what is asserted here. The discrepancy is flagged in the report.)
  for (const t of REGISTRY) {
    for (const field of ['name', 'description', 'inputSchema', 'outputSchema', 'scopes', 'effect', 'classification', 'cost_class', 'slice'] as const) {
      assert.ok(t[field] !== undefined && t[field] !== null, `${t.name} is missing ${field}`);
    }
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
  }
});

test('§15.1: every scope in the registry is one of the six', () => {
  for (const t of REGISTRY) {
    for (const s of t.scopes) assert.ok((SCOPES as readonly string[]).includes(s), `${t.name}: unknown scope ${s}`);
    assert.ok((EFFECTS as readonly string[]).includes(t.effect), `${t.name}: unknown effect ${t.effect}`);
    assert.ok((COST_CLASSES as readonly string[]).includes(t.cost_class));
    assert.ok((CLASSIFICATIONS as readonly string[]).includes(t.classification));
  }
});

test("§15.1: every tool's effect matches its annotations", () => {
  for (const t of REGISTRY) {
    const a = annotationsFor(t.effect);
    assert.equal(a.readOnlyHint, t.effect === 'read', `${t.name}: readOnlyHint disagrees with effect`);
    // Annotations describe; they never authorise. A read tool must never be marked destructive.
    if (t.effect === 'read') assert.equal(a.destructiveHint, false);
  }
});

test('§3.3: Slice A stores and returns only de-identified objects', () => {
  for (const t of REGISTRY) assert.equal(t.classification, 'deidentified', `${t.name} must not be identifying in Slice A`);
});

test('§8.1: only the tools that run an engine are metered', () => {
  // lab-v2 decision 68 (§17.6): reaudit_execute is the third, and it is metered for the same
  // reason as the other two — it runs a clinical engine against a provider. It is also the only
  // one of the three that WRITES A PRODUCTION ROW, which is why it is production_write and not
  // research_write; the two facts are asserted together so neither can drift alone.
  /**
   * ⚠️ RULE 1a, §17.11 DECISION 142 — THE FOURTH METERED TOOL, and it earns the word the same way
   * the other three do: `failure_minimize` re-runs the failed run's own engine at the failed run's
   * own arm, up to eight cases at a time, and every one of those calls goes through the gateway.
   * It is `research_write` and NOT `production_write`, because it writes datasets, experiments and
   * runs in `lab_v2` and touches no clinical row — the distinction `reaudit_execute` exists to make.
   */
  assert.deepEqual(REGISTRY.filter((t) => t.cost_class === 'metered').map((t) => String(t.name)).sort(),
    ['experiment_run', 'failure_minimize', 'reaudit_execute', 'run_retry']);
  const minimize = REGISTRY.find((t) => String(t.name) === 'failure_minimize')!;
  assert.deepEqual([...minimize.scopes], ['research_write']);
  assert.equal(minimize.effect, 'research_write');
  // `t.name` is typed as round 1's union — every later round's tools are cast into it in the
  // registry — so the comparison is on the string, not on the type.
  const repair = REGISTRY.find((t) => String(t.name) === 'reaudit_execute')!;
  assert.deepEqual([...repair.scopes], ['production_write']);
  assert.equal(repair.effect, 'production_write');
  // And the production_write set is closed at three. `worker_control` pauses the queue and
  // `budget_reconcile` moves money between two columns of the v2 store; `reaudit_execute` is the
  // only one that writes a CLINICAL row, which is why decision 67 exists at all. A fourth would
  // need its own ruling, and this is where it would be noticed.
  assert.deepEqual(REGISTRY.filter((t) => t.effect === 'production_write').map((t) => String(t.name)).sort(),
    ['budget_reconcile', 'reaudit_execute', 'worker_control']);
});

// ── §15.2 auth ───────────────────────────────────────────────────────────────────────
const KEYS: Record<string, string> = {
  LAB_API_KEY_RESEARCH: 'research-secret-0000000000000000',
  LAB_API_KEY_OPERATOR: 'operator-secret-0000000000000000',
  LAB_API_KEY_REVIEWER: 'reviewer-secret-0000000000000000',
  LAB_API_KEY_RELEASE: 'release-secret-00000000000000000',
};
function withKeys<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(KEYS)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return fn(); } finally { for (const k of Object.keys(KEYS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('§15.2: each of the four keys maps to its principal and its scopes', () => {
  withKeys(() => {
    assert.equal(principalFor(KEYS.LAB_API_KEY_RESEARCH), 'research');
    assert.equal(principalFor(KEYS.LAB_API_KEY_OPERATOR), 'operator');
    assert.equal(principalFor(KEYS.LAB_API_KEY_REVIEWER), 'reviewer');
    assert.equal(principalFor(KEYS.LAB_API_KEY_RELEASE), 'release');
    assert.deepEqual([...scopesFor('research')], ['research_read', 'research_write', 'production_read']);
    // ⚠️ RULE 1a, §17.8 DECISION 108. `research_write` was added because decision 105 makes
    // `operator` the only principal that may send an identifier, and dataset_create,
    // experiment_create and experiment_run are all research_write — so without it no principal
    // could run an identifying experiment at all. The other three rows are unchanged, which is
    // what this assertion is really for.
    assert.deepEqual([...scopesFor('operator')], ['production_read', 'production_write', 'research_read', 'research_write']);
    assert.deepEqual([...scopesFor('reviewer')], ['review', 'research_read', 'production_read']);
    assert.deepEqual([...scopesFor('release')], ['release', 'production_read']);
  });
});

test('§15.2: a wrong key resolves to no principal (→ 401)', () => {
  withKeys(() => {
    assert.equal(principalFor('not-a-key'), null);
    assert.equal(principalFor(''), null);
    assert.equal(principalFor(null), null);
    // A v1 key is not a v2 key (§3.1) — the surfaces share no secret.
    process.env.LAB_API_KEY = 'v1-shared-secret';
    assert.equal(principalFor('v1-shared-secret'), null);
    delete process.env.LAB_API_KEY;
  });
});

test('§15.2: with none of the four set the endpoint is unconfigured (→ 503)', () => {
  const saved = PRINCIPALS.map((p) => [KEY_ENV_BY_PRINCIPAL[p], process.env[KEY_ENV_BY_PRINCIPAL[p]]] as const);
  for (const p of PRINCIPALS) delete process.env[KEY_ENV_BY_PRINCIPAL[p]];
  try {
    assert.equal(labV2KeysConfigured(), false);
    assert.equal(principalFor('anything'), null);
  } finally { for (const [k, v] of saved) { if (v !== undefined) process.env[k] = v; } }
});

test('§15.2: an empty env var cannot be authenticated with the empty string', () => {
  const saved = process.env.LAB_API_KEY_RESEARCH;
  process.env.LAB_API_KEY_RESEARCH = '';
  try { assert.equal(principalFor(''), null); }
  finally { if (saved === undefined) delete process.env.LAB_API_KEY_RESEARCH; else process.env.LAB_API_KEY_RESEARCH = saved; }
});

// ── §15.3 visibility ─────────────────────────────────────────────────────────────────
test('§17.2: round A2 adds nine read-only, free observation tools', () => {
  const a2 = REGISTRY.filter((t) => t.slice === 'A-2');
  assert.equal(a2.length, 9);
  assert.deepEqual(a2.map((t) => t.name).sort(), [
    'audit_aggregate', 'audit_explain', 'audit_search', 'case_snapshot', 'citation_check',
    'corpus_search', 'report_export', 'retrieval_inspect', 'source_freshness',
  ]);
  for (const t of a2) {
    assert.equal(t.effect, 'read', `${t.name} must be read`);
    assert.equal(t.cost_class, 'free', `${t.name} must be free`);
    assert.equal(t.classification, 'deidentified');
  }
  // source_freshness is the only one on production_read; the other eight are research_read.
  assert.deepEqual(a2.filter((t) => t.scopes.includes('production_read')).map((t) => t.name), ['source_freshness']);
});

test('§15.3: tools/list under the research key does NOT include worker_control', () => {
  const names = visibleTools(SCOPES_BY_PRINCIPAL.research).map((t) => t.name);
  assert.ok(!names.includes('worker_control'), 'research must not see worker_control');
  assert.ok(names.includes('dataset_create'));
});

test('§3.1 + §8.1: the operator key sees worker_control; the release key sees neither research write nor it', () => {
  assert.ok(visibleTools(SCOPES_BY_PRINCIPAL.operator).map((t) => t.name).includes('worker_control'));
  const release = visibleTools(SCOPES_BY_PRINCIPAL.release).map((t) => t.name);
  assert.ok(!release.includes('worker_control'));
  assert.ok(!release.includes('dataset_create'));
  assert.ok(release.includes('system_health'), 'release holds production_read');
});
