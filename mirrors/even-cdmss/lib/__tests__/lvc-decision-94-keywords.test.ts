/**
 * F14 decision 94 — a proposed rule carries its keywords and its category all the way into the
 * live rulebook (LAB-MCP-V2-PRD-v1.0 §17.7 round C2.1).
 *
 * ⚠️ WHAT WAS WRONG. A rule matches through its keywords and nothing else — `matchRule` in
 * `lib/opd-lvc-classify-core.ts` says *"zero-keyword / empty-token rules never match"*. But
 * `parseProposeArgs` had no `keywords` field, `lvcPropose`'s INSERT did not name the column, and
 * `lvcRatify`'s promotion INSERT did not name it either, though BOTH tables have had it all along.
 * So every rule promoted through F14 landed active and permanently inert, and nothing said so.
 * Measured live 06 Sep 2026: all 109 active rules DO carry keywords — the seed loader wrote them —
 * so the promotion path was the one place that lost them, which is why nobody had noticed.
 *
 * ⚠️ THE TWO COLUMNS ARE DIFFERENT TYPES, MEASURED LIVE THE SAME DAY.
 *   `lvc_recommendation_proposals.keywords` → `jsonb`
 *   `lvc_recommendations.keywords`          → `ARRAY` / `_text`, i.e. `text[]`, DEFAULT `'{}'::text[]`
 *   `category` on both                      → `text`, nullable, no default
 * The promotion therefore converts rather than passing through, and the conversion is tested below
 * against real tables of both shapes rather than asserted as a string.
 *
 * ⚠️ AND AN OLD-SHAPE PROPOSE STILL WORKS AND STILL LANDS AN INERT RULE, BY TEST. Decision 94 makes
 * the fields available; it does not make them mandatory. Refusing an inert rule is Lab MCP v2's job,
 * at `rule_simulate` and `release_prepare`, and that refusal stays.
 *
 * ⚠️ HOW THE "v1's own path" TESTS WORK. `lvcPropose`, `lvcRatify` and `getLvcRules` all reach the
 * database through a module-private `sql` binding that cannot be injected, so this file executes
 * THEIR OWN STATEMENTS, extracted from their source files at runtime and never retyped, against a
 * PGlite fixture built from production's own DDL. The pure half — `parseProposeArgs` — is the real
 * function, called directly. Decision 87.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { embedded } from '../lab-v2/db';
import {
  MAX_KEYWORDS, PROPOSAL_CATEGORIES, checkKeywordFields, parseProposeArgs,
} from '../lvc-proposal-core';
import { LVC_CATEGORIES, matchLvcRule, stampLvcMetadata } from '../opd-lvc-classify-core';

const ROOT = process.cwd();
const MCP_TOOLS = readFileSync(join(ROOT, 'lib/mcp-tools.ts'), 'utf8');
const AUDIT = readFileSync(join(ROOT, 'lib/opd-note-audit.ts'), 'utf8');

const GOOD_CITE = { citation_url: 'https://example.org/cw-94', source_release_year: 2024, license_status: 'open' };
const STATEMENT = 'Avoid routine preoperative chest radiography in asymptomatic adults under forty.';

// ─────────────────────────────────────────────────────────────────────────────────────
// 1. THE PARSER — the real function, called directly
// ─────────────────────────────────────────────────────────────────────────────────────

test('decision 94: the twelve categories a proposal may name ARE the engine’s twelve', () => {
  // ⚠️ `PROPOSAL_CATEGORIES` is a frozen copy rather than an import, so that `lvc-proposal-core`
  // keeps its promise of no coupling. This assertion is what makes the copy safe.
  assert.deepEqual([...PROPOSAL_CATEGORIES], [...LVC_CATEGORIES]);
});

test('decision 94: parseProposeArgs accepts keywords and a category, trimmed and de-duped', () => {
  const r = parseProposeArgs({
    statement: STATEMENT, ...GOOD_CITE,
    keywords: ['  chest radiography ', 'Chest Radiography', 'preoperative x-ray'],
    category: 'imaging',
  }, []);
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  // Trimmed; the case-insensitive duplicate is dropped, because `matchRule` lowercases before
  // matching and a list that differed from the list actually used would be a lie about the rule.
  assert.deepEqual(r.value.keywords, ['chest radiography', 'preoperative x-ray']);
  assert.equal(r.value.category, 'imaging');
});

test('decision 94: an old-shape propose is still valid, and still yields no keywords', () => {
  const r = parseProposeArgs({ statement: STATEMENT, ...GOOD_CITE }, []);
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assert.deepEqual(r.value.keywords, [], 'absent, not invented');
  assert.equal(r.value.category, null);
  // Every field the old contract promised is still exactly where it was.
  assert.equal(r.value.statement, STATEMENT);
  assert.equal(r.value.citation.license_status, 'open');
  assert.equal(r.value.proposed_by, 'cowork-orchestrator');
});

test('decision 94: a malformed keyword list or an unknown category is REFUSED, never repaired', () => {
  const errorFor = (extra: Record<string, unknown>): string => {
    const r = parseProposeArgs({ statement: STATEMENT, ...GOOD_CITE, ...extra }, []);
    assert.equal(r.ok, false, `expected a refusal for ${JSON.stringify(extra)}`);
    return r.ok ? '' : r.error;
  };
  assert.match(errorFor({ keywords: 'chest radiography' }), /must be an array/);
  // ⚠️ A BLANK KEYWORD IS REFUSED, NOT DROPPED. Silently dropping it produces a rule that quietly
  // never matches on that trigger, which is the exact class of failure decision 94 exists to close.
  assert.match(errorFor({ keywords: ['chest radiography', '   '] }), /non-empty phrase/);
  const many = Array.from({ length: MAX_KEYWORDS + 1 }, (_, i) => `phrase ${i}`);
  assert.match(errorFor({ keywords: many }), new RegExp(`at most ${MAX_KEYWORDS}`));
  assert.match(errorFor({ category: 'radiology' }), /category must be one of/);
  // Exactly at the ceiling is fine.
  assert.equal(parseProposeArgs({ statement: STATEMENT, ...GOOD_CITE, keywords: many.slice(0, MAX_KEYWORDS) }, []).ok, true);
});

test('decision 94: the keyword gate runs BEFORE the duplicate scan, so its message is not buried', () => {
  const existing = [{ id: 'h-1', statement: STATEMENT, source: 'EHRC', status: 'live' }];
  const r = parseProposeArgs({ statement: STATEMENT, ...GOOD_CITE, keywords: [''] }, existing);
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  assert.match(r.error, /non-empty phrase/, 'the caller error is named, not the near-duplicate report');
  assert.equal(r.duplicates, undefined);
  // And with valid keywords the duplicate scan still runs, unchanged.
  const dup = parseProposeArgs({ statement: STATEMENT, ...GOOD_CITE, keywords: ['x-ray'] }, existing);
  assert.equal(dup.ok, false);
  assert.ok(!dup.ok);
  assert.match(dup.error, /near-duplicate/);
});

test('decision 94: checkKeywordFields is total — absent, null and empty are all "no keywords"', () => {
  for (const input of [{}, { keywords: null }, { keywords: undefined }, { keywords: [] }]) {
    const r = checkKeywordFields(input);
    assert.equal(r.ok, true);
    assert.ok(r.ok);
    assert.deepEqual(r.keywords, []);
    assert.equal(r.category, null);
  }
  for (const c of PROPOSAL_CATEGORIES) {
    const r = checkKeywordFields({ category: c });
    assert.ok(r.ok && r.category === c, `${c} must be accepted`);
  }
  assert.ok(checkKeywordFields({ category: '   ' }).ok, 'blank reads as absent, the same as an omitted field');
});

// ─────────────────────────────────────────────────────────────────────────────────────
// 2. v1's OWN STATEMENTS, against real tables of production's two shapes (decision 87)
// ─────────────────────────────────────────────────────────────────────────────────────

/** A statement extracted from a source file verbatim. Never retyped here. */
function statementFrom(src: string, marker: RegExp, what: string): string {
  const m = src.match(marker);
  assert.ok(m, `${what} has moved; read the source before touching this test`);
  return m![1].replace(/^`/, '').replace(/`$/, '').trim();
}

const PROPOSAL_INSERT = () => statementFrom(MCP_TOOLS, /(`INSERT INTO lvc_recommendation_proposals[\s\S]*?RETURNING id::text AS id, status, proposed_at`)/, "lvcPropose's INSERT");
const PROPOSAL_READ = () => statementFrom(MCP_TOOLS, /(`SELECT id::text AS id, statement, rationale, evidence_note[\s\S]*?FROM lvc_recommendation_proposals WHERE id = \$1::uuid`)/, "lvcRatify's proposal read");
const PROMOTION_INSERT = () => statementFrom(MCP_TOOLS, /(`INSERT INTO lvc_recommendations\s*\n\s*\(id, region[\s\S]*?RETURNING id`)/, "lvcRatify's promotion INSERT");
const GET_LVC_RULES_SQL = () => statementFrom(AUDIT, /(`SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'`)/, "getLvcRules' selection");

/**
 * The two tables in production's shapes.
 *
 * ⚠️ `lvc_recommendations` FROM MIGRATION 0005, VERBATIM — `keywords TEXT[] DEFAULT '{}'` is the
 * declaration this whole decision turns on. The staging table from v1's own `PROPOSALS_DDL`, where
 * `keywords` is `jsonb`. The two really are different types; that is the fact, not a simplification.
 */
async function lvcDb() {
  const db = await embedded();
  const m0005 = readFileSync(join(ROOT, 'migrations/0005_choosing_wisely.sql'), 'utf8');
  const create = m0005.match(/CREATE TABLE IF NOT EXISTS lvc_recommendations \([\s\S]*?\n\);/);
  assert.ok(create, 'migration 0005 no longer creates lvc_recommendations in the shape this test reads');
  await db.exec(create![0]);
  // On production these six exist; three of them are in no migration in this tree (`category`,
  // `license_status`, `provenance` — 0024's own comment records the last two as "ALREADY EXIST").
  for (const col of ['category text', 'license_status text', 'provenance text', 'proposed_by text', 'ratified_by text', 'ratified_at timestamptz']) {
    await db.exec(`ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS ${col}`);
  }
  const ddl = MCP_TOOLS.match(/const PROPOSALS_DDL\s*=\s*`([\s\S]*?)`/);
  assert.ok(ddl, 'PROPOSALS_DDL is no longer a backticked constant');
  await db.exec(ddl![1]);
  return db;
}

test('decision 94: the two keywords columns really are jsonb and text[], as measured live', async () => {
  const db = await lvcDb();
  const types = await db.query<{ table_name: string; column_name: string; data_type: string; udt_name: string }>(
    `SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_name IN ('lvc_recommendations','lvc_recommendation_proposals')
        AND column_name IN ('keywords','category') ORDER BY table_name, column_name`);
  const at = (t: string, c: string) => types.find((r) => r.table_name === t && r.column_name === c)!;
  assert.equal(at('lvc_recommendations', 'keywords').udt_name, '_text', 'the live rulebook stores text[]');
  assert.equal(at('lvc_recommendations', 'category').data_type, 'text');
  assert.equal(at('lvc_recommendation_proposals', 'keywords').data_type, 'jsonb', 'the staging table stores jsonb');
  assert.equal(at('lvc_recommendation_proposals', 'category').data_type, 'text');
  // And the default that made the old failure silent rather than loud.
  const def = await db.query<{ column_default: string }>(
    `SELECT column_default FROM information_schema.columns WHERE table_name = 'lvc_recommendations' AND column_name = 'keywords'`);
  assert.match(String(def[0].column_default), /\{\}/, "an unnamed keywords column defaults to empty, never to null — which is why an inert rule looked normal");
});

/** Run v1's staging INSERT with exactly the parameters `lvcPropose` binds. */
async function propose(db: Awaited<ReturnType<typeof lvcDb>>, args: Record<string, unknown>) {
  const parsed = parseProposeArgs({ statement: STATEMENT, ...GOOD_CITE, ...args }, []);
  assert.ok(parsed.ok, `the proposal must parse: ${!parsed.ok ? parsed.error : ''}`);
  const v = parsed.value;
  const rows = await db.query<{ id: string }>(PROPOSAL_INSERT(), [
    v.statement, v.rationale, v.evidence_note, v.citation.citation_url, v.citation.citation_doi,
    v.citation.citation_pmid, v.citation.source_release_year, v.citation.license_status,
    v.citation.provenance, v.proposed_by, v.supersedes_id,
    v.category, JSON.stringify(v.keywords),
  ]);
  return String(rows[0].id);
}

/** Run v1's proposal read and promotion INSERT with exactly the parameters `lvcRatify` binds. */
async function ratify(db: Awaited<ReturnType<typeof lvcDb>>, proposalId: string) {
  const props = await db.query<Record<string, unknown>>(PROPOSAL_READ(), [proposalId]);
  const prop = props[0];
  assert.ok(prop, 'the proposal read must find the row it is about to promote');
  const promotedKeywords: string[] = Array.isArray(prop.keywords)
    ? (prop.keywords as unknown[]).map((k) => String(k)).filter((k) => k.trim().length > 0)
    : [];
  const ins = await db.query<{ id: string }>(PROMOTION_INSERT(), [
    prop.statement, prop.rationale, prop.citation_url, prop.citation_doi, prop.citation_pmid,
    prop.source_release_year, prop.license_status, prop.provenance, prop.proposed_by, 'dr-reviewer',
    prop.category ?? null, promotedKeywords,
  ]);
  return { id: String(ins[0].id), promotedKeywords, prop };
}

/** `getLvcRules`' own statement and its own mapping — `_dirRun` cannot be injected. */
async function activeRules(db: Awaited<ReturnType<typeof lvcDb>>) {
  const rows = await db.query<Record<string, unknown>>(GET_LVC_RULES_SQL());
  return rows.map((r) => ({
    id: String(r.id),
    keywords: Array.isArray(r.keywords) ? (r.keywords as unknown[]).map((x) => String(x)) : [],
    category: r.category == null ? null : String(r.category),
  }));
}

test('decision 94: propose with keywords → ratify → getLvcRules returns them → the rule FIRES', async () => {
  const db = await lvcDb();

  // 1. propose, through v1's own parser and v1's own INSERT
  const pid = await propose(db, { keywords: ['chest radiography', 'preoperative x-ray'], category: 'imaging' });
  const staged = await db.query<Record<string, unknown>>(PROPOSAL_READ(), [pid]);
  assert.deepEqual(staged[0].keywords, ['chest radiography', 'preoperative x-ray'], 'jsonb round-trips as an array');
  assert.equal(staged[0].category, 'imaging');

  // 2. ratify, through v1's own promotion INSERT — jsonb converted to text[]
  const { id, promotedKeywords } = await ratify(db, pid);
  assert.deepEqual(promotedKeywords, ['chest radiography', 'preoperative x-ray']);

  // 3. getLvcRules' own statement returns the rule WITH its keywords
  const rules = await activeRules(db);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, id);
  assert.deepEqual(rules[0].keywords, ['chest radiography', 'preoperative x-ray'],
    'the whole point: the engine now sees the keywords the proposer wrote');
  assert.equal(rules[0].category, 'imaging');

  // 4. and matchRule FIRES on a finding carrying one of them
  const finding = { verdict: 'low-value', subject: 'Preoperative chest radiography ordered', rationale: 'asymptomatic adult, no indication' };
  assert.equal(matchLvcRule(finding, rules), id, 'the rule this path created actually matches');
  // The engine's stamp is what a reader of an audit sees: rule_ref AND the rule's own category,
  // rather than the category the text classifier would have guessed.
  const [stamped] = stampLvcMetadata([finding], rules);
  assert.equal((stamped as { rule_ref?: string }).rule_ref, id);
  assert.equal((stamped as { lvc_category?: string }).lvc_category, 'imaging');
});

test('decision 94: an OLD-SHAPE propose still works end to end, and still lands an inert rule', async () => {
  const db = await lvcDb();
  const pid = await propose(db, {});           // no keywords, no category — the pre-94 call
  const staged = await db.query<Record<string, unknown>>(PROPOSAL_READ(), [pid]);
  assert.deepEqual(staged[0].keywords, [], 'an empty list, written explicitly');
  assert.equal(staged[0].category, null);

  const { id } = await ratify(db, pid);
  const rules = await activeRules(db);
  assert.equal(rules[0].id, id, 'it is promoted, and it is active');
  assert.deepEqual(rules[0].keywords, []);
  // ⚠️ AND IT STILL CANNOT FIRE. Decision 94 makes keywords available, not mandatory; refusing an
  // inert rule is Lab MCP v2's job, at rule_simulate and release_prepare, and that refusal stays.
  assert.equal(matchLvcRule(
    { verdict: 'low-value', subject: 'Preoperative chest radiography ordered', rationale: 'asymptomatic adult' },
    rules,
  ), null, 'if this starts matching, the inert-rule refusals in lib/lab-v2 are now wrong too');
});

test('decision 94: the promotion COPIES the proposal’s category and never re-derives one', async () => {
  const db = await lvcDb();
  // A statement whose text the classifier would read as `imaging`, proposed as `other` on purpose.
  const pid = await propose(db, { keywords: ['chest radiography'], category: 'other' });
  const { id } = await ratify(db, pid);
  const rules = await activeRules(db);
  assert.equal(rules[0].category, 'other',
    'the reviewer approved `other`; deriving `imaging` here would promote something nobody reviewed');
  const [stamped] = stampLvcMetadata(
    [{ verdict: 'low-value', subject: 'chest radiography', rationale: 'routine preoperative' }], rules);
  assert.equal((stamped as { rule_ref?: string }).rule_ref, id);
  assert.equal((stamped as { lvc_category?: string }).lvc_category, 'other');
});

test('decision 94: both v1 statements name the two columns, and the writes are still v1’s alone', () => {
  assert.match(PROPOSAL_INSERT(), /category, keywords\)/);
  assert.match(PROPOSAL_INSERT(), /\$12,\$13::jsonb\)/);
  assert.match(PROPOSAL_READ(), /category, keywords/);
  assert.match(PROMOTION_INSERT(), /ratified_at,\s*\n?\s*category, keywords\)/);
  assert.match(PROMOTION_INSERT(), /\$11,\$12::text\[\]\)/);
  // ⚠️ STILL EXACTLY ONE PROMOTION AND ONE STAGING WRITE. Decision 94 widened two statements; it did
  // not add a third write path, and `lvc_recommendations` is still written from this one place.
  const writes = MCP_TOOLS.match(/INSERT INTO lvc_recommendations\b/g) ?? [];
  assert.equal(writes.length, 1, 'one promotion INSERT in the whole file');
  for (const forbidden of [/UPDATE lvc_recommendations/, /DELETE FROM lvc_recommendations/]) {
    assert.doesNotMatch(MCP_TOOLS, forbidden, 'lvc_recommendations is INSERT-only from the MCP surface');
  }
  // And the tool advertises what the parser now accepts — a hidden field is a field nobody sends.
  assert.match(MCP_TOOLS, /keywords: \{\s*\n\s*type: 'array', items: \{ type: 'string' \}, maxItems: 12,/);
});
