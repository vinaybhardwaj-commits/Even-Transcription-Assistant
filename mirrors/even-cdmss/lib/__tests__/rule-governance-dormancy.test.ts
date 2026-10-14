/**
 * lib/__tests__/rule-governance-dormancy.test.ts — R3-A §4: DORMANCY, the acceptance that matters
 * most. Four proofs, all required. This module must be provably inert.
 *
 *   1. Zero inbound edges          — nothing in the repo reaches into it
 *   2. Flag-off byte-identity      — the key is ABSENT, not false, for every non-'1' value
 *   3. Registry SQL unchanged      — every lvc_recommendations statement in the repo, frozen
 *   4. Migration additive + single-target — no removal, no bare UPDATE, no ALTER of the registry
 *
 * Plus the acceptance items that ride on dormancy: no activation event from bootstrap or from a
 * proposal (S4), no cron, no engine bump, no prompt, one statement per governance write (O2), and
 * the .sql-vs-inline agreement (kickoff §6 trap 6) — that last one lives in
 * rule-governance-migration.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MAP_EDGES, VERSION_REGISTRY } from '../architecture/map.generated.ts';
import { MODULE_MANIFESTS } from '../architecture/manifests.ts';
import {
  isRuleGovernanceEnabled, RULE_GOVERNANCE_FLAG, ruleGovernanceGate,
} from '../rule-governance-core.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const MODULE_ID = 'rule-governance';
const MODULE_FILES = ['lib/rule-governance-core.ts', 'lib/rule-governance-store.ts'];
const MODULE_ROUTES = [
  'app/api/admin/migrate-rule-governance/route.ts',
  'app/api/admin/rule-governance/propose-pattern/route.ts',
];
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(rel);
  }
  return out;
}
const SOURCE_FILES = ['lib', 'app', 'scripts', 'components']
  .flatMap((d) => walk(d))
  .filter((f) => !f.includes('__tests__/'));

/** Source with `//` and block comments removed, strings preserved. Every "the module must not
 *  contain X" assertion runs over THIS, not the raw file — the module's headers name the traps
 *  they avoid (`approved_by='admin'`, `ensureRuleGovernanceTables`), and a prose mention of a
 *  hazard is the opposite of committing it. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; const start = i; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === quote) break;
        if (quote !== '`' && src[i] === '\n') break;
        out += src[i]; i++;
      }
      if (i < n && src[i] === quote) { out += src[i]; i++; } else { i = start + 1; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PROOF 1 — ZERO INBOUND EDGES (§4.1)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('proof 1a: NO lib/ module imports the rule book — not even `import type`', () => {
  // MAP_EDGES records every import edge including type-only ones, which is exactly the trap
  // (kickoff §6 trap 4): one `import type { RuleVersionRow } from './rule-governance-core'` in
  // lib/lvc.ts would be an edge from the live engine into the dormant module.
  const fromLib = MAP_EDGES.filter((e) => e.to === MODULE_ID && !e.from.startsWith('app'));
  assert.deepEqual(fromLib, [], `a lib module imports the dormant rule book: ${JSON.stringify(fromLib)}`);
});

test('proof 1b: the ONLY inbound edge is app/api — the module’s own two dormant admin routes', () => {
  // The literal §4.1 assertion (`MAP_EDGES.filter(e => e.to === id).length === 0`) cannot hold for
  // any module that ships a route, because architecture-map-gen.mjs resolves every app/api/** file
  // to the single aggregated 'app/api' node: lvp-store, scoring-policy and adjudication-ledger all
  // carry the same edge. The edge is therefore not evidence of liveness; it is this module's own
  // surface. Proof 1c is the modelling-independent form of the same claim.
  const inbound = MAP_EDGES.filter((e) => e.to === MODULE_ID);
  assert.deepEqual(inbound.map((e) => e.from), ['app/api'],
    'the rule book must have no inbound edge other than its own admin routes');
});

test('proof 1c: at SOURCE level, the only importers are the module’s own store and routes', () => {
  // Import SPECIFIERS, not mentions: lib/architecture/manifests.ts names both files in its `paths`
  // glob list, which is a claim of ownership and not an edge.
  const IMPORTS_MODULE = /(?:from|import|require)\s*\(?\s*['"][^'"]*rule-governance-(?:core|store)['"]/;
  const importers = SOURCE_FILES.filter((f) => {
    if (MODULE_FILES.includes(f) || MODULE_ROUTES.includes(f)) return false;
    return IMPORTS_MODULE.test(read(f));
  });
  assert.deepEqual(importers, [],
    `these files reach into the dormant rule book: ${importers.join(', ')}`);
});

test('proof 1d: the rule book’s own imports are a leaf set — nothing it pulls in makes it live', () => {
  const outbound = MAP_EDGES.filter((e) => e.from === MODULE_ID).map((e) => e.to).sort();
  assert.deepEqual(outbound, ['db'],
    'the module itself may reach the db wrapper and nothing else (its routes resolve to app/api)');
});

test('proof 1e: it is a MANIFESTED module, not a new lib/ subdirectory (O3, kickoff §6 trap 2)', () => {
  const m = MODULE_MANIFESTS.find((x) => x.id === MODULE_ID);
  assert.ok(m, 'the rule book must carry an explicit manifest');
  assert.deepEqual([...m!.paths].sort(), [...MODULE_FILES].sort());
  assert.equal(m!.versionConst, undefined, 'no *_VERSION constant — that would auto-register it');
});

test('proof 1f: no exported const here carries the _VERSION token (kickoff §6 trap 2)', () => {
  // The registry rule is a TEXT SCAN (VERSION_EXPORT_RE): an exported UPPER_SNAKE const whose name
  // carries `_VERSION`/`_VERSIONS`. `RULE_VERSIONS_INDEX_DDL` matched it and put a CREATE INDEX
  // statement in VERSION_REGISTRY as a "version" — this is that regression, pinned.
  for (const f of MODULE_FILES) {
    assert.doesNotMatch(read(f), /^export const [A-Z0-9_]*_VERSIONS?(_[A-Z0-9_]+)?\s*(:|=)/m,
      `${f} must export no version constant`);
  }
  const registered = VERSION_REGISTRY.filter((v) => MODULE_FILES.includes(v.file));
  assert.deepEqual(registered, [], 'the module must contribute nothing to the version registry');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PROOF 2 — FLAG-OFF BYTE-IDENTITY (§4.2), copying lib/__tests__/opd-normative-leg-gate.test.ts
// ════════════════════════════════════════════════════════════════════════════════════════════════

const OFF = {};   // today's exact gate: an EMPTY object

test('proof 2: flag off ⇒ the gate is byte-identical to today (no `enabled` key)', () => {
  assert.deepEqual(ruleGovernanceGate({}), OFF);
  assert.deepEqual(ruleGovernanceGate({ LVC_RULE_GOVERNANCE_ENABLED: '0' }), OFF);
  assert.ok(!('enabled' in ruleGovernanceGate({})), 'the key must be ABSENT, not false');
});

test('proof 2: only LVC_RULE_GOVERNANCE_ENABLED === "1" enables — the anti-truthiness sweep', () => {
  for (const v of [undefined, '', '0', 'true', 'yes', '2', 'on', ' 1 ']) {
    assert.deepEqual(ruleGovernanceGate({ LVC_RULE_GOVERNANCE_ENABLED: v }), OFF,
      `value ${JSON.stringify(v)} must not enable`);
    assert.equal(isRuleGovernanceEnabled({ LVC_RULE_GOVERNANCE_ENABLED: v }), false);
  }
  assert.deepEqual(ruleGovernanceGate({ LVC_RULE_GOVERNANCE_ENABLED: '1' }), { enabled: true });
});

test('proof 2: the flag is compared in EXACTLY ONE place in the whole module', () => {
  const code = MODULE_FILES.concat(MODULE_ROUTES).map((f) => stripComments(read(f))).join('\n');
  const comparisons = [...code.matchAll(/===\s*'1'/g)];
  assert.equal(comparisons.length, 1, 'exactly one === "1" comparison in the module');
  assert.match(code, /env\[RULE_GOVERNANCE_FLAG\] === '1'/, 'and it is the pure gate');
  assert.equal((code.match(new RegExp(RULE_GOVERNANCE_FLAG, 'g')) ?? []).length, 2,
    'the flag literal appears only as its own constant and in the store’s refusal message');
  assert.doesNotMatch(code, /process\.env\.[A-Z_]*RULE_GOVERNANCE/,
    'nothing reads the flag off process.env by name — the store goes through the pure core');
  assert.doesNotMatch(code, new RegExp(`${RULE_GOVERNANCE_FLAG}[^\\n]*!==`),
    'no negated check — only the exact === "1" form, so no value but "1" can enable');
});

test('proof 2: both routes 404 on the flag BEFORE any auth work (kickoff §6 trap 5)', () => {
  for (const r of MODULE_ROUTES) {
    // From the handler declaration only: `isAdminUnlocked` also appears in the import list.
    const whole = stripComments(read(r));
    const handlerAt = whole.search(/export async function (GET|POST)\b/);
    assert.ok(handlerAt > 0, `${r} must export a handler`);
    const src = whole.slice(handlerAt);
    const flagAt = src.indexOf('ruleGovernanceEnabled()');
    const authAt = Math.min(
      ...['isAdminUnlocked', 'requireAdmin'].map((s) => {
        const i = src.indexOf(s + '(');
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      }));
    assert.ok(flagAt > 0, `${r} must check the flag`);
    assert.ok(authAt < Number.MAX_SAFE_INTEGER, `${r} must also gate on auth`);
    assert.ok(flagAt < authAt, `${r} must check the flag BEFORE auth — requireAdmin fails OPEN when ADMIN_TOKEN is unset`);
    assert.match(src, /status:\s*404/, `${r} must 404 when the flag is unset`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PROOF 3 — REGISTRY SQL UNCHANGED (§4.3)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every string literal in the repo that names `lvc_recommendations` AND opens with a SQL keyword,
 * whitespace-normalised, keyed by file — frozen at main = f800b45.
 *
 * WIDER THAN THE §4.3 FIXTURE ON PURPOSE. §4.3 names the eleven readers and five writers; this set
 * is scanned over all of lib/, app/, scripts/ and components/, so it also holds the two DDL sites
 * §2 identifies as column sources but §5 does not list (migrate-choosing-wisely, migrate-learning),
 * and a TWELFTH reader appearing anywhere would fail this test rather than pass unnoticed.
 *
 * Prose is excluded by the SQL-keyword filter, not by a file allowlist: the MCP tool descriptions
 * and the engine changelog both discuss the table at length and must stay editable.
 *
 * NOTE ON scripts/lvc-attribution-dryrun.mjs — it holds a literal NUL byte at line 98 (a
 * deliberate `join('\0')` separator), so `grep lvc_recommendations` treats the file as binary and
 * silently reports NOTHING for it. A grep-built reader list therefore counts TEN readers, not
 * eleven. The scanner below reads bytes as UTF-8 and does not have that blind spot; the PRD's
 * count of eleven is correct.
 */
const REGISTRY_SQL_AT_F800B45: Record<string, string[]> = {
  "lib/learning.ts": [
    "INSERT INTO lvc_recommendations (id, region, society, specialty, statement, precondition, action_type, consider_instead, rationale, keywords, citation_doi, citation_pmid, citation_url, source_release_year, status, provenance, license_status) VALUES (${lvcId}, 'IN', 'EHRC', NULL, ${statement}, NULL, ${actionType}, NULL, ${rationale}, ${keywords}::text[], NULL, ${pmid}, ${url}, NULL, 'active', 'EHRC-mined', 'ok') ON CONFLICT (id) DO UPDATE SET statement = EXCLUDED.statement, action_type = EXCLUDED.action_type, rationale = EXCLUDED.rationale, keywords = EXCLUDED.keywords, citation_pmid = EXCLUDED.citation_pmid, citation_url = EXCLUDED.citation_url, status = 'active', provenance = 'EHRC-mined', license_status = 'ok', updated_at = NOW()",
  ],
  "lib/lvc-ratified-wording.ts": [
    "SELECT id, precondition, status, ratified_by, ratified_at FROM lvc_recommendations WHERE id = ANY($1)",
    "UPDATE lvc_recommendations SET precondition = $2, ratified_by = $3, ratified_at = $4::timestamptz, updated_at = now() WHERE id = $1 AND (precondition IS DISTINCT FROM $2 OR ratified_by IS DISTINCT FROM $3 OR ratified_at IS DISTINCT FROM $4::timestamptz) RETURNING id",
    "UPDATE lvc_recommendations SET status = $2, ratified_by = $3, ratified_at = $4::timestamptz, updated_at = now() WHERE id = $1 AND (status IS DISTINCT FROM $2 OR ratified_by IS DISTINCT FROM $3 OR ratified_at IS DISTINCT FROM $4::timestamptz) RETURNING id",
  ],
  "lib/lvc.ts": [
    "SELECT ${REC_COLS} FROM lvc_recommendations WHERE status = 'active'",
    "SELECT ${REC_COLS} FROM lvc_recommendations WHERE status = 'active' AND region = ANY($1)",
  ],
  "lib/mcp-tools.ts": [
    "INSERT INTO lvc_recommendations (id, region, society, statement, rationale, citation_url, citation_doi, citation_pmid, source_release_year, license_status, provenance, proposed_by, ratified_by, ratified_at) VALUES ('ehrc-' || gen_random_uuid()::text, 'IN', 'EHRC', $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) RETURNING id",
    "SELECT id::text AS id, statement, society AS source, 'live' AS status FROM lvc_recommendations",
    "WITH fires AS ( SELECT f->>'rule_ref' AS rule_ref, count(*)::int AS n FROM opd_note_audits a, LATERAL jsonb_array_elements(a.findings) f WHERE a.app_source = $1 AND a.engine_version LIKE 'opd-note-audit/0.81%' AND f->>'rule_ref' IS NOT NULL GROUP BY 1 ) SELECT r.id::text AS id, r.statement, r.society AS source, r.citation_url, r.citation_doi, r.citation_pmid, r.source_release_year, r.license_status, COALESCE(fires.n, 0)::int AS fires FROM lvc_recommendations r LEFT JOIN fires ON fires.rule_ref = r.id::text",
  ],
  "lib/opd-note-audit.ts": [
    "SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'",
  ],
  "lib/provenance-tier.ts": [
    "SELECT id, citation_doi, citation_pmid, citation_url FROM lvc_recommendations WHERE id = ANY($1)",
    "SELECT id, citation_pmid, citation_url FROM lvc_recommendations WHERE id = ANY($1)",
  ],
  "app/admin/opd-audit/[id]/page.tsx": [
    "SELECT id, plain_rationale, statement, citation_doi, citation_pmid, citation_url FROM lvc_recommendations WHERE id = ANY($1)",
  ],
  "app/api/admin/lvc-ref-backfill/route.ts": [
    "SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'",
  ],
  "app/api/admin/migrate-choosing-wisely/route.ts": [
    "CREATE INDEX IF NOT EXISTS lvc_action_type_idx ON lvc_recommendations (action_type)",
    "CREATE INDEX IF NOT EXISTS lvc_keywords_gin ON lvc_recommendations USING GIN (keywords)",
    "CREATE INDEX IF NOT EXISTS lvc_region_idx ON lvc_recommendations (region)",
    "CREATE INDEX IF NOT EXISTS lvc_specialty_idx ON lvc_recommendations (specialty)",
    "CREATE INDEX IF NOT EXISTS lvc_status_idx ON lvc_recommendations (status)",
    "CREATE TABLE IF NOT EXISTS lvc_recommendations ( id TEXT PRIMARY KEY, region TEXT NOT NULL, society TEXT NOT NULL, specialty TEXT, statement TEXT NOT NULL, precondition TEXT, action_type TEXT, consider_instead TEXT, rationale TEXT, keywords TEXT[] DEFAULT '{}', citation_doi TEXT, citation_pmid TEXT, citation_url TEXT, source_release_year INT, status TEXT DEFAULT 'active', chunk_text_hash TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW() )",
  ],
  "app/api/admin/migrate-learning/route.ts": [
    "ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS license_status TEXT",
    "ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS provenance TEXT",
  ],
  "app/api/admin/migrate-opd-audits/route.ts": [
    "ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS category TEXT",
    "ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS plain_rationale TEXT",
    "UPDATE lvc_recommendations SET plain_rationale = left(btrim(statement), 240) WHERE plain_rationale IS NULL AND statement IS NOT NULL AND btrim(statement) <> '' RETURNING id",
  ],
  "app/api/admin/seed-choosing-wisely/route.ts": [
    "INSERT INTO lvc_recommendations (id, region, society, specialty, statement, precondition, action_type, consider_instead, rationale, keywords, citation_doi, citation_pmid, citation_url, source_release_year, status, chunk_text_hash, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,$14,$15,$16, now()) ON CONFLICT (id) DO UPDATE SET region=EXCLUDED.region, society=EXCLUDED.society, specialty=EXCLUDED.specialty, statement=EXCLUDED.statement, precondition=EXCLUDED.precondition, action_type=EXCLUDED.action_type, consider_instead=EXCLUDED.consider_instead, rationale=EXCLUDED.rationale, keywords=EXCLUDED.keywords, citation_doi=EXCLUDED.citation_doi, citation_pmid=EXCLUDED.citation_pmid, citation_url=EXCLUDED.citation_url, source_release_year=EXCLUDED.source_release_year, status=EXCLUDED.status, chunk_text_hash=EXCLUDED.chunk_text_hash, updated_at=now()",
  ],
  "scripts/lvc-attribution-dryrun.mjs": [
    "SELECT id, keywords, category, statement FROM lvc_recommendations WHERE status = 'active'",
  ],
  "scripts/lvc-stage3-restamp.mjs": [
    "SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'",
  ],
};

/** Every string literal in a source file, with `//` and block comments removed first so an
 *  apostrophe in prose ("the row's fields") cannot be read as an opening quote. */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; const start = i; i++;
      let buf = '';
      while (i < n) {
        if (src[i] === '\\') { buf += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === quote) break;
        if (quote !== '`' && src[i] === '\n') break;
        buf += src[i]; i++;
      }
      if (i < n && src[i] === quote) { out.push(buf); i++; } else { i = start + 1; }
      continue;
    }
    i++;
  }
  return out;
}

/**
 * ⚠️ ADDED AFTER f800b45 — NOT part of the frozen baseline above, which stays byte-identical.
 *
 * The LVC RULEBOOK REPAIR PRD v1.1 Phase 1 (25 Aug 2026) adds an authorised writer to the registry:
 * the ratification surface at /admin/lvc-ratify, whose accept updates a surviving rule and retires
 * the variants it absorbs. That is a deliberate, reviewed change to the rulebook — the opposite of
 * the silent drift proof 3 exists to catch — so it is recorded HERE, in its own block, rather than
 * by editing the f800b45 fixture. The baseline's file and statement counts below are therefore
 * still asserted against the baseline alone and are unchanged.
 */
const REGISTRY_SQL_ADDED_BY_LVC_RULE_MERGE: Record<string, string[]> = {
  "lib/lvc-rule-merge.ts": [
    "ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS merged_into TEXT",
    "CREATE INDEX IF NOT EXISTS lvc_merged_into_idx ON lvc_recommendations (merged_into)",
    "SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'lvc_recommendations' AND column_name = 'merged_into'",
    "SELECT id, statement, precondition, keywords, category, citation_url, status, merged_into, ratified_by, ratified_at FROM lvc_recommendations WHERE id = ANY($1)",
    "UPDATE lvc_recommendations SET statement = $2, precondition = $3, keywords = $4::text[], category = $5, citation_url = $6, ratified_by = $7, ratified_at = now(), updated_at = now() WHERE id = $1 AND (statement IS DISTINCT FROM $2 OR precondition IS DISTINCT FROM $3 OR keywords IS DISTINCT FROM $4::text[] OR category IS DISTINCT FROM $5 OR citation_url IS DISTINCT FROM $6 OR ratified_by IS DISTINCT FROM $7) RETURNING id",
    "UPDATE lvc_recommendations SET status = $2, merged_into = $3, ratified_by = $4, ratified_at = now(), updated_at = now() WHERE id = $1 AND (status IS DISTINCT FROM $2 OR merged_into IS DISTINCT FROM $3 OR ratified_by IS DISTINCT FROM $4) RETURNING id",
  ],
  "lib/lvc-ratify-surface-core.ts": [
    "SELECT 1 AS ok FROM information_schema.columns WHERE table_name = 'lvc_recommendations' AND column_name = 'merged_into'",
  ],
  "app/api/admin/lvc-merge-compare/route.ts": [
    "SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'",
  ],
};

/** What proof 3 compares against: the frozen baseline plus every authorised addition since. */
const REGISTRY_SQL_EXPECTED: Record<string, string[]> = {
  ...REGISTRY_SQL_AT_F800B45,
  ...REGISTRY_SQL_ADDED_BY_LVC_RULE_MERGE,
};

function scanRegistrySql(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const f of SOURCE_FILES) {
    if (f.startsWith('lib/rule-governance-')) continue;   // asserted separately, below
    const src = read(f);
    if (!src.includes('lvc_recommendations')) continue;
    const hits = stringLiterals(src)
      .filter((s) => s.includes('lvc_recommendations'))
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => /^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/i.test(s))
      .sort();
    if (hits.length) result[f] = hits;
  }
  return result;
}

test('proof 3: every lvc_recommendations SQL string in the repo is unchanged from f800b45', () => {
  assert.deepEqual(scanRegistrySql(), REGISTRY_SQL_EXPECTED);
});

test('proof 3: the frozen fixture covers the §5 readers and writers, all sixteen sites', () => {
  const flat = Object.entries(REGISTRY_SQL_AT_F800B45);
  assert.equal(flat.length, 14, 'fourteen files hold registry SQL');
  assert.equal(flat.flatMap(([, v]) => v).length, 28, 'twenty-eight registry statements');
  for (const f of [
    'lib/lvc.ts', 'lib/opd-note-audit.ts', 'app/admin/opd-audit/[id]/page.tsx',
    'lib/provenance-tier.ts', 'lib/mcp-tools.ts', 'app/api/admin/lvc-ref-backfill/route.ts',
    'lib/lvc-ratified-wording.ts', 'scripts/lvc-stage3-restamp.mjs',
    'scripts/lvc-attribution-dryrun.mjs', 'lib/learning.ts',
    'app/api/admin/seed-choosing-wisely/route.ts', 'app/api/admin/migrate-opd-audits/route.ts',
  ]) {
    assert.ok(f in REGISTRY_SQL_AT_F800B45, `§5 names ${f} — it must be in the fixture`);
  }
});

test('proof 3: the post-f800b45 additions are exactly the LVC merge surface, and nothing else', () => {
  const added = Object.entries(REGISTRY_SQL_ADDED_BY_LVC_RULE_MERGE);
  assert.equal(added.length, 3, 'three files added registry SQL since f800b45');
  assert.equal(added.flatMap(([, v]) => v).length, 8, 'eight added statements');
  // Every addition belongs to the LVC rulebook-repair build. A statement appearing here from any
  // other module is drift wearing this block as cover, so the file names are pinned too.
  assert.deepEqual(added.map(([f]) => f).sort(), [
    'app/api/admin/lvc-merge-compare/route.ts',
    'lib/lvc-ratify-surface-core.ts',
    'lib/lvc-rule-merge.ts',
  ]);
  // The only writes are the two guarded UPDATEs of the merge, and the DDL is additive.
  const writes = added.flatMap(([, v]) => v).filter((s) => /^(INSERT|UPDATE|DELETE|DROP)\b/i.test(s));
  assert.equal(writes.length, 2, 'a survivor update and a retirement update — no INSERT, no DELETE');
  for (const w of writes) assert.match(w, /IS DISTINCT FROM/, 'every registry write stays guarded');
  const ddl = added.flatMap(([, v]) => v).filter((s) => /^(ALTER|CREATE|DROP)\b/i.test(s));
  assert.equal(ddl.length, 2, 'ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS');
  for (const d of ddl) assert.match(d, /IF NOT EXISTS/, 'DDL is additive and idempotent');
});

test('proof 3: the rule book NEVER writes lvc_recommendations — its one statement only SELECTs', () => {
  const src = MODULE_FILES.concat(MODULE_ROUTES).map(read).join('\n');
  const sqls = stringLiterals(src)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.includes('lvc_recommendations'));
  assert.equal(sqls.length, 1, 'exactly one statement in the module names the registry at all');
  assert.match(sqls[0], /FROM lvc_recommendations r/, 'and it reads FROM it');
  for (const forbidden of [
    /INSERT INTO lvc_recommendations/i, /UPDATE lvc_recommendations/i,
    /DELETE FROM lvc_recommendations/i, /ALTER TABLE lvc_recommendations/i,
  ]) {
    assert.doesNotMatch(src, forbidden, 'the rule book must never write the registry');
  }
});

test('proof 3: no new status value and no new registry row is named anywhere in the module', () => {
  // kickoff §6 trap 1 — six of the eleven readers do not filter `status`, so a fourth value or a
  // new row silently changes the note page, both provenance-tier reads, the MCP dedup gate,
  // lvc_gaps and the wording readback. The module must not mention the column at all.
  const src = MODULE_FILES.concat(MODULE_ROUTES).map(read).join('\n');
  assert.doesNotMatch(src, /status\s*=\s*'(active|superseded|withdrawn|retired)'/,
    'no registry status value may be written or filtered here');
});

test('S5: nothing in the module writes approved_by = admin, or touches audit suppression', () => {
  const code = MODULE_FILES.concat(MODULE_ROUTES).map((f) => stripComments(read(f))).join('\n');
  assert.doesNotMatch(code, /approved_by/);
  assert.doesNotMatch(code, /audit[-_]suppression/i);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PROOF 4 — MIGRATION ADDITIVE AND SINGLE-TARGET (§4.4) — see also rule-governance-migration.test.ts
// ════════════════════════════════════════════════════════════════════════════════════════════════

const MIGRATION = readFileSync(new URL('../../migrations/0039_rule_governance.sql', import.meta.url), 'utf8');

test('proof 4: migration 0039 is additive — nothing removed, no bare UPDATE', () => {
  assert.doesNotMatch(MIGRATION, /\bDROP\b/i);
  assert.doesNotMatch(MIGRATION, /^\s*UPDATE\b/im);
  assert.doesNotMatch(MIGRATION, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(MIGRATION, /\bTRUNCATE\b/i);
});

test('proof 4: migration 0039 is single-target — it never alters the registry', () => {
  assert.doesNotMatch(MIGRATION, /ALTER TABLE lvc_recommendations/);
  assert.doesNotMatch(MIGRATION, /\bALTER\s+TABLE\b/i, 'it alters no existing table at all');
  assert.doesNotMatch(MIGRATION, /INSERT INTO lvc_recommendations/i);
  // and it names no other existing table as a target
  const targets = [...MIGRATION.matchAll(/CREATE (?:TABLE IF NOT EXISTS|OR REPLACE VIEW|INDEX IF NOT EXISTS \w+ ON) (\w+)/g)]
    .map((m) => m[1]).sort();
  assert.deepEqual([...new Set(targets)], [
    'lvc_rule_activation_events', 'lvc_rule_versions', 'rule_pattern_map', 'v_lvc_rule_validity',
  ]);
});

test('proof 4: the ordinal is 0039 and no other migration file was touched', () => {
  const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.includes('0039_rule_governance.sql'));
  // ⚠️ CORRECTED BY LVP L2, 21 Aug 2026. This line used to read
  //   assert.ok(!files.some((f) => /^004\d/.test(f)), '0040 belongs to LVP L2 — do not claim it');
  // which was over-tight: it asserted a fact about the NEXT unit, so it failed the moment LVP L2
  // legitimately took 0040. What R3-A actually owns is that its own migration is 0039 and that it
  // contributed exactly one.
  const governanceMigrations = files.filter((f) => /rule.?governance/i.test(f));
  assert.deepEqual(governanceMigrations, ['0039_rule_governance.sql'],
    'R3-A contributes exactly one migration, and its ordinal is 0039');
  assert.match(MIGRATION, /Migration ordinal 0039/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The acceptance items that ride on dormancy (§7)
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('acceptance 3: every governance write is ONE statement — no multi-statement write path', () => {
  const store = read('lib/rule-governance-store.ts');
  // Each write function body may contain exactly one `await run(`.
  for (const fn of ['proposePatternAsRule', 'bootstrapRuleVersions']) {
    const start = store.indexOf(`export async function ${fn}`);
    assert.ok(start > 0, `${fn} must exist`);
    const body = store.slice(start, store.indexOf('\n}\n', start));
    const awaits = [...body.matchAll(/await run\(/g)].length;
    assert.equal(awaits, 1, `${fn} must issue exactly ONE statement (O2) — found ${awaits}`);
  }
  // Neither write SQL is two statements pretending to be one.
  for (const c of ['PROPOSE_PATTERN_SQL', 'BOOTSTRAP_SNAPSHOT_SQL']) {
    const m = new RegExp(`export const ${c} = \`([\\s\\S]*?)\`;`).exec(store);
    assert.ok(m, `${c} must be an exported constant`);
    assert.doesNotMatch(m![1], /;\s*\S/, `${c} must not contain a statement separator`);
  }
});

test('acceptance 5 / S4: neither bootstrap nor proposal creates an activation event', () => {
  const store = read('lib/rule-governance-store.ts');
  for (const c of ['PROPOSE_PATTERN_SQL', 'BOOTSTRAP_SNAPSHOT_SQL']) {
    const m = new RegExp(`export const ${c} = \`([\\s\\S]*?)\`;`).exec(store)!;
    assert.doesNotMatch(m[1], /lvc_rule_activation_events/,
      `${c} must write NO activation event (S4)`);
  }
  assert.match(store, /'bootstrap_snapshot'/, 'bootstrap rows are stamped bootstrap_snapshot');
});

test('acceptance 5: bootstrap is BUILT, NOT EXECUTED — nothing in app/ or scripts/ calls it', () => {
  const callers = SOURCE_FILES
    .filter((f) => !MODULE_FILES.includes(f))
    .filter((f) => /bootstrapRuleVersions/.test(read(f)));
  assert.deepEqual(callers, [], `bootstrap must have no caller: ${callers.join(', ')}`);
});

test('S4: the evaluator disposition is HARDCODED informational, never an argument', () => {
  const store = read('lib/rule-governance-store.ts');
  assert.match(store, /evaluator_disposition text NOT NULL DEFAULT 'informational' CHECK \(evaluator_disposition = 'informational'\)/);
  assert.doesNotMatch(store, /disposition[^\n]*=\s*(input|args?)\./, 'disposition is never taken from the caller');
});

test('acceptance 7: no cron entry, no engine bump, no prompt registered', () => {
  const vercel = read('vercel.json');
  assert.doesNotMatch(vercel, /rule-governance/, 'the module must appear nowhere in vercel.json');
  const core = read('lib/opd-note-audit-core.ts');
  assert.doesNotMatch(core, /rule-governance/, 'no engine file may name the module');
  for (const f of MODULE_FILES.concat(MODULE_ROUTES)) {
    const src = read(f);
    for (const banned of [/governedChat/, /tracedChat/, /registerPrompt/, /PROMPT_REGISTRY/, /generateContent/]) {
      assert.doesNotMatch(src, banned, `${f} must issue no LLM call — the reasoning registry gate does not apply here`);
    }
  }
});

test('§3.7: the bridge verifies against the SERVER-computed shelf and freezes the S8 provenance bit', () => {
  const src = stripComments(read('app/api/admin/rule-governance/propose-pattern/route.ts'));
  assert.match(src, /await loadShelf\(\)/, 'it must call loadShelf() — never trust a client-supplied card');
  assert.match(src, /shelf\.suggested\.find/, 'and look the pattern up in the Suggested set');
  assert.match(src, /status:\s*409/, 'a pattern not on the shelf is rejected');
  assert.match(src, /slots_provenance/, 'the snapshot records which source supplied the slots (S8)');
  for (const k of ['LVP_FLOOR', 'LVP_CAP', 'LVP_NON_OVERUSE_CAP']) {
    assert.ok(src.includes(k), `the snapshot must freeze ${k} (S8)`);
  }
  assert.doesNotMatch(src, /ensureRuleGovernanceTables/, 'ensure* belongs to the migrate route ONLY (trap 3)');
  assert.doesNotMatch(src, /appendHideRow|lvp_hidden/, 'the bridge writes nothing on the shelf');
});

test('§3.5: the map column is lvp_pattern_id (O1) and never becomes a rule_ref', () => {
  const store = read('lib/rule-governance-store.ts');
  assert.match(store, /lvp_pattern_id\s+text NOT NULL/);
  const m = /export const PROPOSE_PATTERN_SQL = `([\s\S]*?)`;/.exec(store)!;
  assert.doesNotMatch(m[1], /rule_ref\s*=\s*\$16/, 'the pattern id must never be written as a rule_ref');
  assert.match(m[1], /SELECT \$16::text, ver\.rule_ref/, 'the two identities sit side by side, not merged');
});
