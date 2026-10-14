/**
 * LAB-MCP-V2 §17.7 round C2 — the rules target (decisions 82, 89, 90).
 *
 * ⚠️ THE MOST IMPORTANT TEST IN THIS FILE IS `§17.7 C2: a rule promoted through v1's own path can
 * never match a finding`. It does not test something this round built; it PROVES the one thing this
 * round found and could not fix under its file contract, so that the finding cannot quietly stop
 * being true and cannot quietly be forgotten. Read `KEYWORDLESS_PROPOSAL` in `tools/rules.ts`.
 *
 * ⚠️ THE SECOND MOST IMPORTANT IS THE GREP, extended from decision 79's `mksap_chunks` to `lvc_*`.
 * The rules target is the exact inverse of the corpus: v1 HAS the inverse (`RETIREMENT_UPDATE_SQL`,
 * decision 90) and it was the FORWARD write that could not be reached, which decision 89 fixed with
 * one token. So v2 has NO statement of its own in either direction, and the grep says so.
 *
 * ⚠️ AND DECISION 87 IS NOW STANDING. Every inferred `lvc_` statement in this round runs against a
 * real table below, on a fixture whose DDL and whose rows come from production's own text — the
 * `CREATE TABLE` read out of `migrations/0005_choosing_wisely.sql`, the two staging DDLs and the
 * three promotion statements read out of `lib/mcp-tools.ts` at runtime, never retyped here. That is
 * the closest a sandbox can get to "written by the production writer", and it is what would have
 * caught decision 86.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { embedded, type Db } from '../db';
import { LabError, RULES_ROLLBACK_CAVEAT, V1_DEPRECATIONS, hash } from '../contracts';
import { applyMigrations, ensureBudget, getObject, getReceipt, putObject, putReview, submitRun } from '../store';
import {
  ACTIVE_RULES_SQL, ACTIVE_RULE_IDS_SQL, PROPOSAL_SQL, RATIFICATIONS_SQL, RECOMMENDATION_SQL,
  RETIRED_STATUS, activeRuleIds, activeRules, parseKeywords, promoteProposal, readProposal,
  retireRecommendation,
} from '../releases/rules-target';
import {
  KEYWORDLESS_PROPOSAL, LIVE_TRANSPORT_FORBIDDEN, RULES_SCHEMAS, SIMULATION_MEASURES,
  rulePropose, ruleSimulate,
} from '../tools/rules';
import { releasePrepare } from '../releases/prepare';
import { reviewSubmit } from '../releases/review';
import { releaseApply } from '../releases/apply';
import { releaseRollback } from '../releases/rollback';
import { releaseStatus } from '../tools/release';
import { RETIREMENT_UPDATE_SQL } from '../../lvc-ratified-wording';
import { matchLvcRule } from '../../opd-lvc-classify-core';
import { parseProposeArgs } from '../../lvc-proposal-core';
import { BY_NAME } from '../registry';

const ROOT = process.cwd();
const MCP_TOOLS = readFileSync(join(ROOT, 'lib/mcp-tools.ts'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────────────
// The v2 store, both migrations — the same shape C1 builds, for the same reason
// (helpers.ts loads 0001 only and §17.7 leaves it alone).
// ─────────────────────────────────────────────────────────────────────────────────────
function migrationFiles() {
  const dir = join(ROOT, 'migrations', 'lab-v2');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

async function storeDb(): Promise<Db> {
  const db = await embedded();
  await applyMigrations(db, migrationFiles());
  return db;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// DECISION 87 — the lvc_ fixture, built from PRODUCTION'S OWN TEXT
// ─────────────────────────────────────────────────────────────────────────────────────

/** Pull a backticked constant out of a source file verbatim. Never a retyped copy. */
function constantFrom(src: string, name: string): string {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\`([\\s\\S]*?)\``));
  assert.ok(m, `${name} is no longer a backticked constant; read the file before touching this test`);
  return m![1];
}

/** v1's own INSERT statements, read out of lib/mcp-tools.ts rather than restated here. */
function v1Statement(marker: RegExp): string {
  const m = MCP_TOOLS.match(marker);
  assert.ok(m, `v1's statement matching ${marker} has moved; read lib/mcp-tools.ts before touching this test`);
  return m![1].trim();
}

const PROPOSAL_INSERT = () => v1Statement(/(`INSERT INTO lvc_recommendation_proposals[\s\S]*?RETURNING id::text AS id, status, proposed_at`)/);
const PROMOTION_INSERT = () => v1Statement(/(`INSERT INTO lvc_recommendations\s*\n\s*\(id, region[\s\S]*?RETURNING id`)/);
// ⚠️ THE `ratified` ONE. v1 writes two: rejection is first-class and comes first in the file, so a
// lazier pattern would have seeded a REJECTION and the ledger read would have quietly agreed.
const RATIFICATION_INSERT = () => v1Statement(/(`INSERT INTO lvc_ratifications \(proposal_id[^`]*'ratified'[^`]*`)/);

const unquote = (s: string) => s.replace(/^`/, '').replace(/`$/, '');

/**
 * A database carrying the three `lvc_` tables in production's shape.
 *
 * ⚠️ `lvc_recommendations` COMES FROM MIGRATION 0005, VERBATIM — including `keywords TEXT[] DEFAULT
 * '{}'`, which is the column the whole flag in this round is about.
 *
 * ⚠️ `category` IS ADDED SEPARATELY AND THAT IS NOT A MISTAKE HERE. No migration in this repo adds
 * it, yet `getLvcRules` selects it and the engine runs in production, so production's table has it
 * out of band. The fixture reproduces production, and the comment records why the two disagree.
 */
async function lvcDb(): Promise<Db> {
  const db = await embedded();
  const m0005 = readFileSync(join(ROOT, 'migrations/0005_choosing_wisely.sql'), 'utf8');
  const create = m0005.match(/CREATE TABLE IF NOT EXISTS lvc_recommendations \([\s\S]*?\n\);/);
  assert.ok(create, 'migration 0005 no longer creates lvc_recommendations in the shape this test reads');
  await db.exec(create![0]);
  // ⚠️ THREE OF THESE ARE IN NO MIGRATION IN THIS REPO, AND THAT IS THE POINT OF SAYING SO.
  // `category` is selected by getLvcRules, and `license_status` and `provenance` are named by
  // lvcRatify's promotion INSERT; migration 0024's own comment records that the last two "ALREADY
  // EXIST". All three were added to production out of band. The fixture reproduces PRODUCTION, and
  // this comment records where the file tree and the database disagree.
  for (const col of ['category text', 'license_status text', 'provenance text']) {
    await db.exec(`ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS ${col}`);
  }
  // migration 0024, the three columns it does add.
  await db.exec(`ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS proposed_by text`);
  await db.exec(`ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS ratified_by text`);
  await db.exec(`ALTER TABLE lvc_recommendations ADD COLUMN IF NOT EXISTS ratified_at timestamptz`);
  // v1's own staging DDL, read out of lib/mcp-tools.ts.
  await db.exec(constantFrom(MCP_TOOLS, 'PROPOSALS_DDL'));
  await db.exec(constantFrom(MCP_TOOLS, 'RATIFICATIONS_DDL'));
  return db;
}

/** One active recommendation, written with v1's OWN promotion INSERT. */
async function seedRecommendation(
  db: Db, proposalId: string, statement: string,
  keywords: string[] = [], category: string | null = null,
) {
  const rows = await db.query<{ id: string }>(unquote(PROMOTION_INSERT()), [
    statement, 'because the evidence says so', 'https://example.org/x', null, null,
    2024, 'open', 'EHRC review', 'research', 'dr-reviewer',
    // §17.7 C2.1 decision 94 — the two columns the promotion now copies from the proposal.
    category, keywords,
  ]);
  await db.query(`UPDATE lvc_recommendation_proposals SET status = 'ratified', promoted_id = $2 WHERE id = $1::uuid`, [proposalId, rows[0].id]);
  await db.query(unquote(RATIFICATION_INSERT()), [proposalId, 'dr-reviewer', 'read the citation', rows[0].id]);
  return String(rows[0].id);
}

/** One staged proposal, written with v1's OWN staging INSERT. */
async function seedProposal(
  db: Db, statement: string, keywords: string[] = [], category: string | null = null,
): Promise<string> {
  const rows = await db.query<{ id: string }>(unquote(PROPOSAL_INSERT()), [
    statement, 'rationale', 'evidence', 'https://example.org/x', null, null,
    2024, 'open', 'EHRC', 'research', null,
    // §17.7 C2.1 decision 94 — `category` text and `keywords` jsonb.
    category, JSON.stringify(keywords),
  ]);
  return String(rows[0].id);
}

const readerFor = (db: Db) =>
  (async <T,>(_source: string, statement: string, params: unknown[] = []) => db.query(statement, params) as Promise<T[]>) as never;

// ═════════════════════════════════════════════════════════════════════════════════════
// 1. THE FLAG — raised by C2, CLOSED by decision 94 (C2.1). What is left is the half
//    that was always v2's job: an inert rule is still refused, by name.
// ═════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE, AND THAT IS WHY IT IS HERE.
 *
 * C2 shipped it as *"a rule promoted through v1's own path can NEVER match a finding"*, with every
 * assertion carrying the message *"if this fails the flag is stale — re-read the round"*. Decision
 * 94 made it fail, exactly as intended, and the round it demanded is C2.1. It is now the closure
 * test: the keywords a proposer writes reach the engine, end to end, through v1's own statements.
 *
 * The keyword-free half is NOT relaxed. `matchRule` still refuses a zero-keyword rule, an old-shape
 * propose still lands an inert one, and v2 still refuses to simulate or release it — decision 94
 * made keywords available, not mandatory.
 */
test('§17.7 C2.1 decision 94: the keywords a proposal carries reach the engine, end to end', async () => {
  // (a) The matcher needs keywords, and still says so.
  const keywordless = { id: 'ehrc-new', keywords: [] as string[], category: 'imaging' };
  assert.equal(
    matchLvcRule({ verdict: 'low-value', subject: 'routine chest x-ray', rationale: 'not indicated' }, [keywordless]),
    null, 'a zero-keyword rule matched something; the inert-rule refusals below would then be wrong too');
  assert.equal(
    matchLvcRule({ verdict: 'low-value', subject: 'routine chest x-ray', rationale: 'not indicated' },
      [{ ...keywordless, keywords: ['chest x-ray'] }]),
    'ehrc-new', 'the same rule WITH keywords matches');

  // (b) The parser now carries them — decision 94, item 1.
  const parsed = parseProposeArgs({
    statement: 'Avoid routine preoperative chest radiography in asymptomatic adults.',
    citation_url: 'https://example.org/x', source_release_year: 2024, license_status: 'open',
    keywords: ['chest radiography'], category: 'imaging',
  }, []);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.keywords, ['chest radiography']);
  assert.equal(parsed.value.category, 'imaging');

  // (c) Both v1 writes now name the columns — decision 94, item 2.
  assert.ok(/keywords/.test(PROPOSAL_INSERT()), 'lvc_propose writes keywords');
  assert.ok(/keywords/.test(PROMOTION_INSERT()), 'lvc_ratify copies them into the rulebook');
  const m0005 = readFileSync(join(ROOT, 'migrations/0005_choosing_wisely.sql'), 'utf8');
  assert.match(m0005, /keywords\s+TEXT\[\] DEFAULT '\{\}'/, 'the column, where it always was');

  // (d) End to end on real tables, through v1's own statements: the rule FIRES.
  const db = await lvcDb();
  const statement = 'Avoid routine preoperative chest radiography in asymptomatic adults.';
  const pid = await seedProposal(db, statement, ['chest radiography'], 'imaging');
  const rid = await seedRecommendation(db, pid, statement, ['chest radiography'], 'imaging');
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'`);
  const landed = rows.find((r) => String(r.id) === rid);
  assert.ok(landed, 'the promoted row is active');
  assert.deepEqual(parseKeywords(landed!.keywords), ['chest radiography']);
  assert.equal(matchLvcRule({ verdict: 'low-value', subject: 'preoperative chest radiography', rationale: 'asymptomatic adult' },
    [{ id: rid, keywords: parseKeywords(landed!.keywords), category: String(landed!.category) }]), rid,
    'the rule created through v1’s own path now matches — this is what decision 94 bought');
});

test('§17.7 C2.1: an OLD-SHAPE propose still lands an inert rule, and v2 still refuses it', async () => {
  // ⚠️ Decision 94 made keywords AVAILABLE, not mandatory, so this path still exists and still
  // produces a rule that can never fire. Refusing it is v2's job and v2 still does it.
  const db = await lvcDb();
  const statement = 'Avoid routine vitamin D screening in asymptomatic adults.';
  const pid = await seedProposal(db, statement);                       // no keywords, no category
  const rid = await seedRecommendation(db, pid, statement);
  const rows = await db.query<Record<string, unknown>>(`SELECT id, keywords FROM lvc_recommendations WHERE id = '${rid}'`);
  assert.deepEqual(parseKeywords(rows[0].keywords), [], 'promoted with an empty keyword array');
  assert.equal(matchLvcRule({ verdict: 'low-value', subject: 'vitamin D level', rationale: 'asymptomatic adult' },
    [{ id: rid, keywords: [], category: null }]), null);
});

test('§17.7 C2 FLAG: rule_simulate and release_prepare refuse a keywordless proposal by name', async () => {
  const db = await lvcDb();
  const pid = await seedProposal(db, 'Avoid routine vitamin D screening in asymptomatic adults.');
  const store = await storeDb();
  await assert.rejects(
    () => ruleSimulate(store, 'research', { proposal_id: pid, run_id: pid, idempotency_key: 'k' }, { read: readerFor(db) }),
    (e: LabError) => e.code === 'INVALID_INPUT' && e.message.includes('zero-keyword'),
  );
  // Named, not a silent zero: the message carries the whole reason and the three places it lives.
  assert.match(KEYWORDLESS_PROPOSAL, /parseProposeArgs accepts no keywords field/);
  assert.match(KEYWORDLESS_PROPOSAL, /lvc_recommendations\.keywords/);
  assert.match(KEYWORDLESS_PROPOSAL, /Refused rather than reported/);
});

// ═════════════════════════════════════════════════════════════════════════════════════
// 2. DECISION 79 EXTENDED TO lvc_, AND DECISION 89'S ONE TOKEN
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.7 decision 79 (extended): v2 writes lvc_* in exactly ZERO places of its own', () => {
  const files: string[] = [join(ROOT, 'lib/lab-v2/tools/rules.ts'), join(ROOT, 'lib/lab-v2/tools/corpus.ts')];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(ROOT, 'lib/lab-v2/releases'));
  assert.ok(files.length >= 8, `expected the release tree plus the two tool files, saw ${files.length}`);

  // Decision 80a's corpus carve-out, unchanged. There is NO rules carve-out: both rules writers
  // are v1's own, reached by import, so the exemption list does not grow.
  const EXEMPT_FILE = join(ROOT, 'lib/lab-v2/releases/corpus-writer.ts');
  const EXEMPT = `UPDATE mksap_chunks SET source = $1, visible = false WHERE id = ANY($2) RETURNING id`;

  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const body = f === EXEMPT_FILE ? code.split(EXEMPT).join('«exempt»') : code;
    for (const [i, line] of body.split('\n').entries()) {
      for (const verb of ['INSERT INTO', 'UPDATE ', 'DELETE FROM']) {
        if (!line.includes(verb)) continue;
        if (!/mksap_chunks|lvc_/.test(line)) continue;
        hits.push(`${f.slice(ROOT.length + 1)}:${i + 1} — ${line.trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `a v2 write path to lvc_* or mksap_chunks:\n${hits.join('\n')}`);

  // And prove the grep can see one, so a green result means something.
  const probe = `${'UPDATE '}lvc_recommendations SET status = 'retired'`;
  assert.ok(/lvc_/.test(probe) && probe.includes('UPDATE '), 'the pattern matches a real write');
});

test('§17.7 C2: the three statements the governance registry now pins are all SELECTs', () => {
  // ⚠️ `rule-governance-dormancy.test.ts` freezes every `lvc_recommendations` SQL string in the
  // repo and compares against an explicit, authorised list. C2 adds three, all reads, in one file.
  // The assertion that they are READS lives here, in the round that added them.
  const registry = readFileSync(join(ROOT, 'lib/__tests__/rule-governance-dormancy.test.ts'), 'utf8');
  const m = registry.match(/const REGISTRY_SQL_ADDED_BY_LAB_V2_C2[\s\S]*?\n\};/);
  assert.ok(m, 'the C2 block is no longer in the frozen registry; read that file before touching this');
  const listed = [...m![0].matchAll(/"(SELECT[^"]*)"/g)].map((x) => x[1]);
  assert.equal(listed.length, 3, 'three statements, all of them SELECT');
  assert.equal(m![0].split('lvc_recommendations').length - 1, 3, 'and they are the only statements in the block');
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP']) {
    assert.ok(!m![0].includes(`${verb} `), `the C2 block names ${verb}; v2 has no write of its own`);
  }
  // The block's own statements are the ones the code exports, normalised the way the scan does.
  const flat = (x: string) => x.replace(/\s+/g, ' ').trim();
  assert.ok(listed.includes(flat(ACTIVE_RULE_IDS_SQL)));
  assert.ok(listed.includes(flat(ACTIVE_RULES_SQL)));
});

test('§17.7 decisions 89 and 90: both rules writers are v1’s, imported, and neither is restated', () => {
  const src = readFileSync(join(ROOT, 'lib/lab-v2/releases/rules-target.ts'), 'utf8');
  assert.match(src, /import \{ lvcRatify \} from '\.\.\/\.\.\/mcp-tools'/);
  assert.match(src, /import \{ RETIREMENT_UPDATE_SQL \} from '\.\.\/\.\.\/lvc-ratified-wording'/);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('SET status'), 'the retirement statement is v1’s and is not restated in code here');
  assert.ok(!code.includes('INSERT INTO'), 'the promotion statements are v1’s and are not restated in code here');
  // v1's own text, where it was. If either moves, read the file before touching anything here.
  assert.match(RETIREMENT_UPDATE_SQL, /UPDATE lvc_recommendations\n\s+SET status\s+= \$2/);
  assert.match(RETIREMENT_UPDATE_SQL, /RETURNING id$/);
  assert.ok(MCP_TOOLS.includes('export async function lvcRatify('), 'decision 89’s token');
});

/**
 * ⚠️ §14.3 FREEZES `lib/mcp-tools.ts`, AND IT NOW CARRIES EXACTLY TWO RATIFIED CARVE-OUTS.
 *
 * Decision 89 (C2): the word `export` on `lvcRatify`, and nothing else. C2 asserted that as literal
 * byte-identity against `6f5cfa81`.
 * Decision 94 (C2.1): `keywords` and `category` through `lvcPropose`, `lvcRatify` and the
 * `lvc_propose` input schema — which makes byte-identity no longer the right assertion.
 *
 * So the guarantee is restated in the two forms that survive both and still bite:
 *   1. THE MODULE'S EXPORT SURFACE is `6f5cfa81`'s plus exactly `lvcRatify`. That is what decision
 *      89 was actually protecting, and decision 94 adds no export at all.
 *   2. EVERY LINE DECISION 94 CHANGED lies inside decision 94's own scope — the `lvc_propose` tool
 *      schema, or the two functions. A change anywhere else in this frozen file fails here.
 */
const exportedSymbols = (src: string) =>
  [...src.matchAll(/^export (?:async function|function|const|class|type|interface) (\w+)/gm)]
    .map((m) => m[1]).sort();

const gitShow = (rev: string) => {
  try {
    return execFileSync('git', ['show', `${rev}:lib/mcp-tools.ts`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return assert.fail(`could not read lib/mcp-tools.ts at ${rev}; both rulings are claims about a diff and a diff must be checkable`);
  }
};

test('§17.7 decision 89 + §17.11 decision 149: the export surface of lib/mcp-tools.ts is C1’s plus exactly lvcRatify and RETIRED_TOOLS', () => {
  const before = exportedSymbols(gitShow('6f5cfa81'));
  const now = exportedSymbols(MCP_TOOLS);
  // ⚠️ RULE 1a, §17.11 DECISION 149. This allow-list gained ONE symbol. Decision 149 orders the
  // constant verbatim — `export const RETIRED_TOOLS = [...] as const` — and `lib/mcp-server.ts`
  // must import it to consult it at the name gate, so the export is the ruling, not a choice made
  // here. The list is still exhaustive: anything else added to the frozen file still fails.
  assert.deepEqual(now, [...before, 'lvcRatify', 'RETIRED_TOOLS'].sort(),
    'lib/mcp-tools.ts exports something decisions 89 and 149 did not authorise');
  assert.ok(MCP_TOOLS.includes('export async function lvcRatify('), 'the token is actually there');
  assert.ok(!before.includes('lvcRatify'), 'and it was not there before');
  assert.ok(MCP_TOOLS.includes('export const RETIRED_TOOLS = ['), 'decision 149’s constant is there');
  assert.ok(!before.includes('RETIRED_TOOLS'), 'and it was not there before either');
});

test('§17.7 C2.1 decision 94: every line it changed in the frozen file is inside its own scope', () => {
  const lineOf = (needle: string) => {
    const i = MCP_TOOLS.indexOf(needle);
    assert.notEqual(i, -1, `${needle} has moved; read lib/mcp-tools.ts before touching this test`);
    return MCP_TOOLS.slice(0, i).split('\n').length;
  };
  /**
   * Decision 94's two regions: the `lvc_propose` tool schema, and the two F14 functions.
   *
   * ⚠️ RULE 1a, §17.11 DECISION 143 — CARVE-OUT THREE, AND IT IS A DELETION. `lab_query` is retired:
   * its entry is removed from `LAB_TOOLS` and its `switch` arm now returns the RETIRED object
   * instead of results, so a stale v1 client gets a message naming its two replacements rather than
   * "unknown tool". Two regions, bracketed by the neighbours the edits sit between, because a
   * deletion has no line of its own in the new file to anchor on:
   *
   *   3a  the LAB_TOOLS entry, between `lab_case_audit`'s and `audit_query`'s;
   *   3b  the dispatch arm, between `lab_retrieve`'s and `audit_query`'s.
   *
   * ⚠️ THE `labQuery` FUNCTION ITSELF IS UNTOUCHED, deliberately: deleting it would orphan three
   * imports from `lib/lab.ts` and turn a two-line retirement into a fourth region in a frozen file.
   * It is now unreachable, and `lab_analyses` — every row it ever listed — is still readable
   * through `audit_query`.
   *
   * ⚠️ RULE 1a, §17.11 DECISION 149 — REGION 3c, AND IT WIDENS THIS TEST'S AUTHORISATION. Decision
   * 143's dispatch arm was unreachable over the wire: `dispatchMcp`'s name gate tests `LAB_TOOLS`,
   * which no longer holds `lab_query`, so a stale client got "unknown tool" — the very answer the
   * retirement existed to replace. The gate now also consults `RETIRED_TOOLS`, and that constant
   * has to live somewhere. Region 3a is an interval strictly INSIDE the `LAB_TOOLS` array literal,
   * so no top-level declaration can be placed there; decision 149 ruled the constant sits
   * immediately after the array closes, and authorised this fifth region for it:
   *
   *   3c  the `RETIRED_TOOLS` constant, between `LAB_TOOLS`'s closing `] as const;` and the
   *       dispatch banner — the tightest bracket the placement allows, containing that constant
   *       and its comment and nothing else.
   *
   * This is a rule 1a edit to a file outside decision 149's kickoff contract, and it is NOT a
   * mechanical one: it enlarges the set of changes this test permits. It is recorded as such in
   * the round report rather than filed quietly as a pin.
   */
  const regions: [number, number][] = [
    [lineOf("name: 'lvc_propose',"), lineOf("name: 'lvc_ratify',")],
    [lineOf('async function lvcPropose('), lineOf('async function lvcGaps(')],
    [lineOf("name: 'lab_case_audit',"), lineOf("name: 'audit_query',")],
    [lineOf("case 'lab_retrieve':"), lineOf("case 'audit_query':")],
    [lineOf('] as const;'), lineOf('// ── dispatch ─')],
  ];
  const diff = execFileSync('git', ['diff', '--unified=0', '9c440fcc', '--', 'lib/mcp-tools.ts'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const hunks = [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((m) => ({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) }));
  assert.ok(hunks.length > 0, 'decision 94 changed this file; if there is no diff the ruling has not landed');
  const outside = hunks.filter((h) =>
    !regions.some(([lo, hi]) => h.start >= lo && h.start + Math.max(h.count, 1) <= hi + 1));
  assert.deepEqual(outside, [],
    `decisions 94 and 143 authorise lvcPropose, lvcRatify, the lvc_propose schema, and lab_query's `
    + `removal from LAB_TOOLS and its dispatch arm; these hunks are elsewhere: ${JSON.stringify(outside)}`);
});

/**
 * §17.11 DECISION 143 — THE RETIREMENT ITSELF, asserted on both halves of what it promises.
 *
 * A retirement has two obligations and they pull in opposite directions: the tool must be GONE from
 * the list a client discovers, and a client that already knows the name must get an ANSWER rather
 * than "unknown tool". Testing only the first would let the second rot silently.
 */
test('§17.11 decision 143: lab_query is out of LAB_TOOLS and its dispatch arm answers RETIRED', async () => {
  const { LAB_TOOLS, callLabTool } = await import('../../mcp-tools');
  // ⚠️ WIDENED TO `string` ON PURPOSE. `LAB_TOOLS` is `as const`, so after the removal the literal
  // union no longer CONTAINS 'lab_query' and `t.name === 'lab_query'` is a compile error — which is
  // a stronger guarantee than this assertion, and the reason the comparison is written this way
  // rather than deleted: the runtime list is what a client is served.
  const names = LAB_TOOLS.map((t) => String(t.name));
  assert.ok(!names.includes('lab_query'), 'lab_query is off the v1 list');
  // Its two replacements are v2 tools and are unaffected by anything here; the v1 list keeps
  // audit_query, which is how every lab_analyses row lab_query used to list is still reachable.
  assert.ok(names.includes('audit_query'), 'audit_query is untouched');

  const res = await callLabTool('lab_query', {});
  assert.notEqual(res.isError, true, 'a retirement is an answer, not an error result');
  const body = JSON.parse(res.content[0].text);
  assert.deepEqual(body, {
    error: 'RETIRED',
    replaced_by: ['audit_search', 'corpus_search'],
    since: 'e5f53c55',
  });
  // ⚠️ AND IT IS THE SAME OBJECT `system_capabilities` ADVERTISES. Two hand-written copies of a
  // deprecation would drift; this asserts they agree today.
  const [dep] = V1_DEPRECATIONS;
  assert.equal(dep.tool, 'lab_query');
  assert.deepEqual([...dep.replaced_by], body.replaced_by);
  assert.equal(dep.since, body.since);
  // The unknown-tool arm is untouched: retirement is not the same fact as never existing.
  const unknown = await callLabTool('lab_nonesuch', {});
  assert.equal(unknown.isError, true);
});

test('§17.7 decision 89: lvcPropose is NOT exported — rule_propose goes through v1’s own dispatcher', () => {
  assert.ok(MCP_TOOLS.includes('async function lvcPropose('), 'lvcPropose is where it was');
  assert.ok(!MCP_TOOLS.includes('export async function lvcPropose('),
    'lvcPropose is exported; decision 89 permitted ONE token and rule_propose needs none — it calls callLabTool');
  assert.ok(MCP_TOOLS.includes('export async function callLabTool('), 'v1’s dispatcher is the path');
  const src = readFileSync(join(ROOT, 'lib/lab-v2/tools/rules.ts'), 'utf8');
  assert.match(src, /import \{ callLabTool \} from '\.\.\/\.\.\/mcp-tools'/);
  assert.match(src, /call\('lvc_propose',/);
});

// ═════════════════════════════════════════════════════════════════════════════════════
// 3. THE INFERRED READS — shape, then against a real table (decision 87)
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.7 C2: every inferred lvc_ statement is a bounded SELECT, and none is a write', () => {
  const statements: [string, string][] = [
    ['active rules', ACTIVE_RULES_SQL],
    ['active rule ids', ACTIVE_RULE_IDS_SQL],
    ['proposal', PROPOSAL_SQL('11111111-1111-1111-1111-111111111111')],
    ['recommendation', RECOMMENDATION_SQL('ehrc-abc')],
    ['ratifications', RATIFICATIONS_SQL('11111111-1111-1111-1111-111111111111')],
  ];
  for (const [name, sql] of statements) {
    assert.match(sql, /^SELECT/, `${name} must start with SELECT`);
    assert.ok(/\bLIMIT\b/.test(sql), `${name} must be bounded`);
    for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'TRUNCATE']) {
      assert.ok(!new RegExp(`\\b${verb}\\b`).test(sql), `${name} contains ${verb}`);
    }
  }
  // ⚠️ THE PREDICATE IS THE ENGINE'S, NOT OURS. A second predicate here would describe a rulebook
  // the engine does not use.
  const engine = readFileSync(join(ROOT, 'lib/opd-note-audit.ts'), 'utf8');
  assert.ok(engine.includes(`SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'`),
    'getLvcRules’ selection has moved; read it before touching ACTIVE_RULES_SQL');
  assert.ok(ACTIVE_RULES_SQL.includes(`WHERE status = 'active'`));
  assert.ok(ACTIVE_RULE_IDS_SQL.includes(`WHERE status = 'active'`));
});

test('§17.7 C2: an id that is not a uuid or not an id shape is REFUSED, never escaped', () => {
  for (const bad of ["' OR 1=1 --", 'not-a-uuid', '', '11111111-1111-1111-1111-11111111111']) {
    assert.throws(() => PROPOSAL_SQL(bad), (e: LabError) => e.code === 'INVALID_INPUT', `PROPOSAL_SQL accepted ${bad}`);
    assert.throws(() => RATIFICATIONS_SQL(bad), (e: LabError) => e.code === 'INVALID_INPUT');
  }
  for (const bad of ["ehrc-x'; DROP TABLE lvc_recommendations; --", 'a b', '']) {
    assert.throws(() => RECOMMENDATION_SQL(bad), (e: LabError) => e.code === 'INVALID_INPUT', `RECOMMENDATION_SQL accepted ${bad}`);
  }
  assert.ok(RECOMMENDATION_SQL('ehrc-3f2a-b1').includes("'ehrc-3f2a-b1'"));
});

test('§17.7 decision 87: every inferred lvc_ statement runs against a real table, on a v1-written fixture', async () => {
  const db = await lvcDb();
  const pid = await seedProposal(db, 'Avoid routine head CT for uncomplicated headache in adults.');
  const rid = await seedRecommendation(db, pid, 'Avoid routine head CT for uncomplicated headache in adults.');
  // A second, still-staged proposal, so the reads have to discriminate.
  const staged = await seedProposal(db, 'Avoid empirical antibiotics for uncomplicated viral sore throat.');

  // 1. the active rulebook, as the engine selects it
  const active = await db.query<Record<string, unknown>>(ACTIVE_RULES_SQL);
  assert.equal(active.length, 1, 'the promoted row, and only it');
  assert.equal(String(active[0].id), rid);
  assert.equal(String(active[0].society), 'EHRC', 'v1 hardcodes society, and the read returns it');
  // 2. just the ids
  assert.deepEqual((await db.query<{ id: string }>(ACTIVE_RULE_IDS_SQL)).map((r) => String(r.id)), [rid]);
  // 3. one proposal, by id — the columns a reviewer must read
  const prop = await db.query<Record<string, unknown>>(PROPOSAL_SQL(staged));
  assert.equal(prop.length, 1);
  assert.equal(String(prop[0].status), 'proposed');
  assert.equal(String(prop[0].citation_url), 'https://example.org/x');
  // 4. one recommendation, by id — how a receipt's claim is checked after the fact
  const rec = await db.query<Record<string, unknown>>(RECOMMENDATION_SQL(rid));
  assert.equal(String(rec[0].status), 'active');
  assert.equal(String(rec[0].ratified_by), 'dr-reviewer');
  // 5. the ratification ledger
  const rat = await db.query<Record<string, unknown>>(RATIFICATIONS_SQL(pid));
  assert.equal(rat.length, 1);
  assert.equal(String(rat[0].decision), 'ratified');
  assert.equal(String(rat[0].promoted_id), rid);
  // 6. and v1's retirement statement, on the real row: it retires and never deletes
  const moved = await db.query<{ id: string }>(RETIREMENT_UPDATE_SQL, [rid, RETIRED_STATUS, 'ops', new Date().toISOString()]);
  assert.deepEqual(moved.map((r) => String(r.id)), [rid]);
  const after = await db.query<Record<string, unknown>>(RECOMMENDATION_SQL(rid));
  assert.equal(after.length, 1, 'the row is still there — retired, not deleted');
  assert.equal(String(after[0].status), RETIRED_STATUS);
  assert.equal(String(after[0].statement), 'Avoid routine head CT for uncomplicated headache in adults.',
    'the statement, its citation and its ratifier stay on the record');
  // 7. and the engine's own selection no longer returns it
  assert.deepEqual(await db.query(ACTIVE_RULE_IDS_SQL), []);
});

test('§17.7 C2: the readers coerce and refuse at the boundary', async () => {
  const db = await lvcDb();
  const pid = await seedProposal(db, 'Avoid routine thyroid function testing in asymptomatic adults.');
  const deps = { read: readerFor(db) };
  const p = await readProposal(pid, deps);
  assert.equal(p.id, pid);
  assert.equal(p.status, 'proposed');
  assert.deepEqual(p.keywords, [], 'jsonb null parses to an empty list, never to a phantom keyword');
  await assert.rejects(() => readProposal('11111111-1111-1111-1111-111111111111', deps),
    (e: LabError) => e.code === 'CASE_NOT_FOUND');
  assert.deepEqual(await activeRules(deps), []);
  assert.deepEqual(await activeRuleIds(deps), []);
  // v1 stores keywords as jsonb OR as a comma string; `getLvcRules` parses both and so does this.
  assert.deepEqual(parseKeywords('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseKeywords('a, b'), ['a', 'b']);
  assert.deepEqual(parseKeywords(null), []);
});

// ═════════════════════════════════════════════════════════════════════════════════════
// 4. THE TWO WRITERS
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.7 decision 89: promoteProposal calls v1 with confirm:true and parses its envelope', async () => {
  const seen: Record<string, unknown>[] = [];
  const out = await promoteProposal({ proposal_id: 'p-1', ratified_by: 'dr-reviewer', rationale: 'read the citation' }, {
    ratify: (async (a: Record<string, unknown>) => {
      seen.push(a);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ proposal_id: 'p-1', status: 'ratified', promoted_id: 'ehrc-9' }) }] };
    }) as never,
  });
  assert.equal(out.promoted_id, 'ehrc-9');
  assert.equal(seen[0].confirm, true, 'v1 requires it: ratification writes to the governed rulebook path');
  assert.equal(seen[0].ratified_by, 'dr-reviewer');
  assert.equal(seen[0].rationale, 'read the citation');
});

test('§17.7 decision 89: a refusal, an unreadable body, and a success with no id are all reported as themselves', async () => {
  const envelope = (text: string, isError?: boolean) => ({ ratify: (async () => ({ content: [{ type: 'text' as const, text }], isError })) as never });
  await assert.rejects(
    () => promoteProposal({ proposal_id: 'p', ratified_by: 'r', rationale: 'x' }, envelope('Error: ratified_by is required', true)),
    (e: LabError) => e.code === 'SOURCE_UNAVAILABLE' && e.message.includes('ratified_by is required') && !e.message.includes('Error:'));
  await assert.rejects(
    () => promoteProposal({ proposal_id: 'p', ratified_by: 'r', rationale: 'x' }, envelope('not json at all')),
    (e: LabError) => e.code === 'SOURCE_UNAVAILABLE' && e.message.includes('cannot read'));
  // ⚠️ A receipt naming no row could never be rolled back, so this is a failure, not a release.
  await assert.rejects(
    () => promoteProposal({ proposal_id: 'p', ratified_by: 'r', rationale: 'x' }, envelope(JSON.stringify({ status: 'ratified', promoted_id: null }))),
    (e: LabError) => e.code === 'SOURCE_UNAVAILABLE' && e.message.includes('never be rolled back'));
});

test('§17.7 decision 90: retireRecommendation binds v1’s four parameters and refuses a bad id', async () => {
  const seen: unknown[][] = [];
  const out = await retireRecommendation({ recommendation_id: 'ehrc-9', retired_by: 'ops' }, {
    run: (async (s: string, p: unknown[]) => { seen.push([s, ...p]); return [{ id: 'ehrc-9' }]; }) as never,
  });
  assert.deepEqual(out.ids, ['ehrc-9']);
  assert.equal(out.status, RETIRED_STATUS);
  assert.equal(seen[0][0], RETIREMENT_UPDATE_SQL, 'v1’s statement, by import — not a copy');
  assert.equal(seen[0][1], 'ehrc-9');
  assert.equal(seen[0][2], RETIRED_STATUS);
  assert.equal(seen[0][3], 'ops');
  assert.match(String(seen[0][4]), /^\d{4}-\d{2}-\d{2}T/, 'the retirement instant, ISO');
  await assert.rejects(() => retireRecommendation({ recommendation_id: '', retired_by: 'ops' }, {}),
    (e: LabError) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => retireRecommendation({ recommendation_id: "x'; DROP TABLE lvc_recommendations; --", retired_by: 'ops' }, {}),
    (e: LabError) => e.code === 'INVALID_INPUT');
});

// ═════════════════════════════════════════════════════════════════════════════════════
// 5. rule_propose
// ═════════════════════════════════════════════════════════════════════════════════════

const PROPOSE_ARGS = {
  statement: 'Avoid routine preoperative chest radiography in asymptomatic adults under 40.',
  citation_url: 'https://example.org/cw-1',
  source_release_year: 2024,
  license_status: 'open',
  idempotency_key: 'prop-1',
};

const proposeStub = (body: Record<string, unknown>, isError?: boolean) => {
  const seen: [string, Record<string, unknown>][] = [];
  return {
    seen,
    deps: {
      call: (async (name: string, a: Record<string, unknown>) => {
        seen.push([name, a]);
        return { content: [{ type: 'text' as const, text: isError ? String(body.text) : JSON.stringify(body) }], isError };
      }) as never,
    },
  };
};

test('§17.7 C2: rule_propose goes through v1’s lvc_propose, names the principal, and stages an object', async () => {
  const db = await storeDb();
  const stub = proposeStub({ proposal_id: '22222222-2222-2222-2222-222222222222', status: 'proposed', note: 'STAGED only — lvc_recommendations is untouched.' });
  const out = await rulePropose(db, 'research', PROPOSE_ARGS, stub.deps);
  assert.equal(stub.seen[0][0], 'lvc_propose', 'v1’s own dispatcher, by tool name');
  assert.equal(stub.seen[0][1].proposed_by, 'research', 'the PRINCIPAL, not v1’s default author');
  assert.equal(out.proposal_id, '22222222-2222-2222-2222-222222222222');
  assert.equal(out.status, 'proposed');
  assert.match(out.note, /lvc_recommendations is untouched/);
  assert.equal(out.matching, KEYWORDLESS_PROPOSAL, 'the flag rides on every proposal');
  const staged = await getObject(db, out.staged_set_id);
  assert.equal((staged!.body as { kind: string }).kind, 'staged_set');
  assert.equal((staged!.body as { target: string }).target, 'rules');
  assert.equal((staged!.body as { proposal_hash: string }).proposal_hash, out.proposal_hash);
});

test('§17.7 C2: the proposal hash is over the statement and its citation, never over the row', async () => {
  const db = await storeDb();
  const stub = proposeStub({ proposal_id: '33333333-3333-3333-3333-333333333333', status: 'proposed' });
  const a = await rulePropose(db, 'research', PROPOSE_ARGS, stub.deps);
  const b = await rulePropose(db, 'research', { ...PROPOSE_ARGS, idempotency_key: 'prop-2' }, stub.deps);
  assert.equal(a.proposal_hash, b.proposal_hash, 'the same statement and citation hash the same');
  const c = await rulePropose(db, 'research', { ...PROPOSE_ARGS, statement: `${PROPOSE_ARGS.statement} Except in cardiac surgery.`, idempotency_key: 'prop-3' }, stub.deps);
  assert.notEqual(a.proposal_hash, c.proposal_hash);
  assert.equal(a.proposal_hash, hash({
    statement: PROPOSE_ARGS.statement, citation_url: PROPOSE_ARGS.citation_url,
    citation_doi: null, citation_pmid: null, source_release_year: 2024, supersedes_id: null,
  }));
});

test('§17.7 C2.1 decision 95: rule_propose forwards keywords and category to v1 byte-for-byte', async () => {
  const db = await storeDb();
  const stub = proposeStub({
    proposal_id: '44444444-4444-4444-4444-444444444444', status: 'proposed',
    keywords: ['chest radiography', 'preoperative x-ray'], category: 'imaging',
  });
  const out = await rulePropose(db, 'research', {
    ...PROPOSE_ARGS,
    // ⚠️ Deliberately un-normalised input. v2 must pass it through EXACTLY as given: decision 94 put
    // the trim, the case-insensitive de-dup and every refusal in parseProposeArgs, which is what the
    // row is written from. A second normalisation here would diverge from it the first time either
    // changed, and the artifact a reviewer approved would then describe keywords the table lacks.
    keywords: ['  chest radiography ', 'Chest Radiography', 'preoperative x-ray'],
    category: 'imaging',
    idempotency_key: 'prop-95a',
  }, stub.deps);

  const [tool, sent] = stub.seen[0];
  assert.equal(tool, 'lvc_propose');
  assert.deepEqual(sent.keywords, ['  chest radiography ', 'Chest Radiography', 'preoperative x-ray'],
    'forwarded unchanged — untrimmed, un-de-duplicated, exactly as the caller wrote it');
  assert.equal(sent.category, 'imaging');
  // And the echo is v1's answer about what it STORED, not our copy of what we sent.
  assert.deepEqual(out.keywords, ['chest radiography', 'preoperative x-ray']);
  assert.equal(out.category, 'imaging');
  assert.match(out.matching, /2 keyword phrase\(s\) staged as written/);
  assert.ok(!out.matching.includes('zero-keyword'), 'the inert-rule warning must not fire on a rule that carries keywords');

  // The staged set a review binds carries both, so an approval is about the trigger phrases too.
  const staged = (await getObject(db, out.staged_set_id))!.body as Record<string, unknown>;
  assert.deepEqual(staged.keywords, ['  chest radiography ', 'Chest Radiography', 'preoperative x-ray']);
  assert.equal(staged.category, 'imaging');

  // Nothing forwarded ⇒ nothing sent, and the keyword-free warning is v2's own refusal wording.
  const plain = proposeStub({ proposal_id: '55555555-5555-5555-5555-555555555555', status: 'proposed' });
  const bare = await rulePropose(db, 'research', { ...PROPOSE_ARGS, idempotency_key: 'prop-95b' }, plain.deps);
  assert.equal(plain.seen[0][1].keywords, undefined);
  assert.equal(plain.seen[0][1].category, undefined);
  assert.deepEqual(bare.keywords, []);
  assert.equal(bare.category, null);
  assert.equal(bare.matching, KEYWORDLESS_PROPOSAL);
});

test('§17.7 C2.1 decision 95: the hash moves with a keyword, and an absent field hashes as ABSENT', async () => {
  const db = await storeDb();
  const stub = proposeStub({ proposal_id: '66666666-6666-6666-6666-666666666666', status: 'proposed' });
  const propose = (extra: Record<string, unknown>, key: string) =>
    rulePropose(db, 'research', { ...PROPOSE_ARGS, ...extra, idempotency_key: key }, stub.deps);

  const a = await propose({ keywords: ['chest radiography'], category: 'imaging' }, 'h-1');
  const b = await propose({ keywords: ['chest radiography'], category: 'imaging' }, 'h-2');
  assert.equal(a.proposal_hash, b.proposal_hash, 'the same proposal hashes the same');
  const kw = await propose({ keywords: ['chest x-ray'], category: 'imaging' }, 'h-3');
  assert.notEqual(a.proposal_hash, kw.proposal_hash, 'a changed keyword is a changed artifact');
  const cat = await propose({ keywords: ['chest radiography'], category: 'other' }, 'h-4');
  assert.notEqual(a.proposal_hash, cat.proposal_hash, 'a changed category is a changed artifact');

  /**
   * ⚠️ THE BACKWARD-COMPATIBILITY ASSERTION. `canonicalJson` drops `undefined` keys, so an
   * old-shape propose hashes byte-identically to what it hashed before decision 95. Written as the
   * pre-95 expression VERBATIM: `?? null` on either field here would have expired every approval
   * already on record.
   */
  const bare = await propose({}, 'h-5');
  assert.equal(bare.proposal_hash, hash({
    statement: PROPOSE_ARGS.statement,
    citation_url: PROPOSE_ARGS.citation_url,
    citation_doi: null,
    citation_pmid: null,
    source_release_year: PROPOSE_ARGS.source_release_year,
    supersedes_id: null,
  }), 'an absent keywords/category must not change the hash of a proposal that has neither');
  assert.notEqual(bare.proposal_hash, a.proposal_hash);
  // Absent is not the same as empty: a caller who says "no keywords" out loud said something.
  const empty = await propose({ keywords: [] }, 'h-6');
  assert.notEqual(empty.proposal_hash, bare.proposal_hash, 'an explicit [] is a statement, not an absence');
});

test('§17.7 C2: v1’s refusals reach the caller in v1’s own words', async () => {
  const db = await storeDb();
  const refusal = proposeStub({ text: 'Error: cannot read the existing rulebook to run the mandatory duplicate check — refusing to propose ungated' }, true);
  await assert.rejects(() => rulePropose(db, 'research', PROPOSE_ARGS, refusal.deps),
    (e: LabError) => e.code === 'INVALID_INPUT' && e.message.includes('refusing to propose ungated'));
  const noId = proposeStub({ status: 'proposed' });
  await assert.rejects(() => rulePropose(db, 'research', PROPOSE_ARGS, noId.deps),
    (e: LabError) => e.code === 'SOURCE_UNAVAILABLE' && e.message.includes('no proposal id'));
});

// ═════════════════════════════════════════════════════════════════════════════════════
// 6. rule_simulate — decision 82, exact replay
// ═════════════════════════════════════════════════════════════════════════════════════

/** A baseline opd_note_audit run with two items, each holding a stored audit artifact. */
async function baselineRun(db: Db, findings: Record<string, unknown>[][], owner = 'research') {
  const budget = await ensureBudget(db, owner, 'c2', 1_000_000);
  const { run } = await submitRun(db, owner, 'experiment_run', null, budget.id, 'base-1', 'h', 86_400_000,
    findings.map((_f, i) => ({
      case_key: `case-${i}`, arm_hash: 'arm', repetition: 0,
      payload: { engine: 'opd_note_audit', frozen: { note: {}, lvc_rules: [] } },
    })));
  const items = await db.query<{ id: string; case_key: string }>(
    `SELECT id, case_key FROM lab_v2.items WHERE run_id = $1 ORDER BY case_key`, [run.id]);
  for (const [i, it] of items.entries()) {
    const { object } = await putObject(db, owner, 'artifact', { findings: findings[i] }, 'deidentified', `base-art-${i}`);
    await db.query(`UPDATE lab_v2.items SET state = 'succeeded', result = $2::jsonb WHERE id = $1`,
      [it.id, JSON.stringify({ artifact_id: object.id, result_hash: hash(findings[i]) })]);
  }
  return run;
}

const LOW = (subject: string, rule_ref: string | null, lvc_category: string) =>
  ({ verdict: 'low-value', subject, rationale: 'not indicated', rule_ref, lvc_category });

/**
 * The drive seam standing in for the tick loop: it succeeds each queued item of the simulation with
 * the stamps `after` says it should have. The replay itself is exercised by `run_replay`'s own
 * suite; what THIS round has to prove is the DIFF and the denominator.
 */
const driveWith = (after: (caseKey: string) => Record<string, unknown>[] | 'diverge' | 'fail') =>
  (async (db: Db) => {
    const items = await db.query<{ id: string; case_key: string; run_id: string }>(
      `SELECT i.id, i.case_key, i.run_id FROM lab_v2.items i JOIN lab_v2.runs r ON r.id = i.run_id
        WHERE r.operation = 'rule_simulate' AND i.state = 'queued'`);
    for (const it of items) {
      const out = after(it.case_key);
      if (out === 'diverge' || out === 'fail') {
        await db.query(`UPDATE lab_v2.items SET state = 'failed', error = $2::jsonb WHERE id = $1`,
          [it.id, JSON.stringify({ code: out === 'diverge' ? 'REPLAY_DIVERGED' : 'TRANSPORT_ERROR', message: out === 'diverge' ? 'REPLAY_DIVERGED: no stored step' : 'the provider was unreachable' })]);
        continue;
      }
      const { object } = await putObject(db, 'research', 'artifact', { findings: out }, 'deidentified', `sim-art-${it.id}`);
      await db.query(`UPDATE lab_v2.items SET state = 'succeeded', result = $2::jsonb WHERE id = $1`,
        [it.id, JSON.stringify({ artifact_id: object.id, result_hash: hash(out) })]);
    }
  }) as never;

async function simulateFixture(db: Db) {
  const lvc = await lvcDb();
  // ⚠️ C2 had to set the keywords with an out-of-band UPDATE here, because v1's own staging INSERT
  // could not write them. Decision 94 closed that: they now go in through v1's own statement, on
  // the same call as the statement itself.
  const pid = await seedProposal(
    lvc, 'Avoid routine preoperative chest radiography in asymptomatic adults.',
    ['chest radiography'], 'imaging',
  );
  return { lvc, pid, deps: { read: readerFor(lvc) } };
}

test('§17.7 decision 82: a simulation is an exact replay — zero model calls, structurally', async () => {
  const db = await storeDb();
  const { pid, deps } = await simulateFixture(db);
  const run = await baselineRun(db, [
    [LOW('preoperative chest radiography', null, 'imaging')],
    [LOW('routine vitamin D level', null, 'other')],
  ]);
  const out = await ruleSimulate(db, 'research', { proposal_id: pid, run_id: run.id, idempotency_key: 'sim-1' }, {
    ...deps,
    drive: driveWith((k) => (k === 'case-0'
      ? [LOW('preoperative chest radiography', `proposal:${pid}`, 'imaging')]
      : [LOW('routine vitamin D level', null, 'other')])),
  });
  assert.equal(out.model_calls, 0);
  assert.equal(out.changed_audits, 1, 'one audit’s stamps moved');
  assert.equal(out.denominator.name, 'items replayed equal');
  assert.equal(out.denominator.items, 2);
  assert.equal(out.denominator.replayed_equal, 2);
  assert.equal(out.denominator.diverged, 0);
  assert.equal(out.positives.length, 1);
  assert.equal(out.positives[0].case_key, 'case-0');
  assert.equal(out.positives[0].rule_ref_before, null);
  assert.equal(out.positives[0].rule_ref_after, `proposal:${pid}`);
  assert.equal(out.positives[0].subject, 'preoperative chest radiography');
  assert.deepEqual(out.negatives.map((n) => n.case_key), ['case-1']);
  assert.match(out.negatives[0].reason, /no stamp moved/);
  // The live transport is not merely unused — it throws on contact.
  await assert.rejects(() => LIVE_TRANSPORT_FORBIDDEN(), (e: LabError) => e.code === 'REPLAY_DIVERGED');
});

test('§17.7 C2: the output names what it measures, and it is not a score', async () => {
  const db = await storeDb();
  const { pid, deps } = await simulateFixture(db);
  const run = await baselineRun(db, [[LOW('preoperative chest radiography', null, 'imaging')]]);
  const out = await ruleSimulate(db, 'research', { proposal_id: pid, run_id: run.id, idempotency_key: 'sim-2' }, {
    ...deps, drive: driveWith(() => [LOW('preoperative chest radiography', `proposal:${pid}`, 'imaging')]),
  });
  assert.equal(out.measures, SIMULATION_MEASURES);
  assert.match(out.measures, /never a score movement/);
  assert.match(out.measures, /cannot add or remove a finding/);
  assert.equal(out.rules.simulated, out.rules.active + 1, 'the active rulebook plus the one proposal');
  // The artifact a release binds as its simulation_ref.
  const artifact = await getObject(db, out.simulation_ref);
  assert.equal((artifact!.body as { kind: string }).kind, 'rule_simulation');
  assert.equal((artifact!.body as { proposal_id: string }).proposal_id, pid);
});

test('§17.7 C2: REPLAY_DIVERGED is reported PER ITEM and is never fatal', async () => {
  const db = await storeDb();
  const { pid, deps } = await simulateFixture(db);
  const run = await baselineRun(db, [
    [LOW('preoperative chest radiography', null, 'imaging')],
    [LOW('routine vitamin D level', null, 'other')],
    [LOW('chest radiography before surgery', null, 'imaging')],
  ]);
  const out = await ruleSimulate(db, 'research', { proposal_id: pid, run_id: run.id, idempotency_key: 'sim-3' }, {
    ...deps,
    drive: driveWith((k) => {
      if (k === 'case-1') return 'diverge';
      if (k === 'case-2') return 'fail';
      return [LOW('preoperative chest radiography', `proposal:${pid}`, 'imaging')];
    }),
  });
  assert.equal(out.denominator.items, 3);
  assert.equal(out.denominator.diverged, 1);
  assert.equal(out.denominator.not_measured, 1);
  assert.equal(out.denominator.replayed_equal, 1, 'the one that replayed is still measured');
  assert.equal(out.changed_audits, 1);
  const diverged = out.negatives.find((n) => n.case_key === 'case-1');
  assert.match(diverged!.reason, /REPLAY_DIVERGED/);
  assert.match(diverged!.reason, /not evidence either way/);
  assert.equal(out.per_item.find((p) => p.case_key === 'case-1')!.diverged, true);
  assert.equal(out.per_item.find((p) => p.case_key === 'case-2')!.diverged, false);
});

test('§17.7 C2: an item whose FINDING SET moved is not a measurement, and says so', async () => {
  const db = await storeDb();
  const { pid, deps } = await simulateFixture(db);
  const run = await baselineRun(db, [[LOW('preoperative chest radiography', null, 'imaging'), LOW('vitamin D', null, 'other')]]);
  const out = await ruleSimulate(db, 'research', { proposal_id: pid, run_id: run.id, idempotency_key: 'sim-4' }, {
    ...deps, drive: driveWith(() => [LOW('preoperative chest radiography', `proposal:${pid}`, 'imaging')]),
  });
  assert.equal(out.denominator.replayed_equal, 0);
  assert.equal(out.changed_audits, 0, 'never counted: a rule cannot change the finding set');
  assert.match(out.negatives[0].reason, /the finding set differs \(2 → 1/);
});

test('§17.7 C2: rule_simulate refuses a run that is not an opd_note_audit run, and a run it does not own', async () => {
  const db = await storeDb();
  const { pid, deps } = await simulateFixture(db);
  const budget = await ensureBudget(db, 'research', 'c2b', 1000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'ipd-1', 'h', 86_400_000,
    [{ case_key: 'e-1', arm_hash: 'a', repetition: 0, payload: { engine: 'ipd_episode', frozen: {} } }]);
  await assert.rejects(() => ruleSimulate(db, 'research', { proposal_id: pid, run_id: run.id, idempotency_key: 'sim-5' }, deps),
    (e: LabError) => e.code === 'INVALID_INPUT' && e.message.includes('ipd_episode'));
  await assert.rejects(() => ruleSimulate(db, 'someone-else', { proposal_id: pid, run_id: run.id, idempotency_key: 'sim-6' }, deps),
    (e: LabError) => e.code === 'OWNER_ONLY');
});

// ═════════════════════════════════════════════════════════════════════════════════════
// 7. THE RELEASE — prepare, apply, rollback for target `rules`
// ═════════════════════════════════════════════════════════════════════════════════════

async function readyToPrepare(db: Db, key = 'p1') {
  const { lvc, pid, deps } = await simulateFixture(db);
  const stub = proposeStub({ proposal_id: pid, status: 'proposed' });
  const proposal = await rulePropose(db, 'release', {
    ...PROPOSE_ARGS,
    statement: 'Avoid routine preoperative chest radiography in asymptomatic adults.',
    idempotency_key: `prop-${key}`,
  }, stub.deps);
  const run = await baselineRun(db, [[LOW('preoperative chest radiography', null, 'imaging')]], 'release');
  const sim = await ruleSimulate(db, 'release', { proposal_id: pid, run_id: run.id, idempotency_key: `sim-${key}` }, {
    ...deps, drive: driveWith(() => [LOW('preoperative chest radiography', `proposal:${pid}`, 'imaging')]),
  });
  return { lvc, pid, deps, proposal, sim };
}

async function prepared(db: Db, key = 'p1') {
  const f = await readyToPrepare(db, key);
  const release = await releasePrepare(db, 'release', {
    target: 'rules', staged_set_id: f.proposal.staged_set_id, impact_ref: f.sim.simulation_ref,
    idempotency_key: `rel-${key}`,
  }, f.deps);
  return { ...f, release };
}

test('§17.7 C2: release_prepare for rules produces §17.7’s artifact and says what apply will do', async () => {
  const db = await storeDb();
  const { pid, release, sim } = await prepared(db);
  assert.equal(release.target, 'rules');
  assert.equal(release.label, `rule:${pid}`);
  assert.deepEqual(release.chunk_ids, []);
  assert.equal(release.impact_ref, sim.simulation_ref);
  const artifact = (await getObject(db, release.release_id))!.body as Record<string, unknown>;
  assert.equal(artifact.proposal_id, pid);
  assert.equal(artifact.simulation_ref, sim.simulation_ref);
  assert.equal(artifact.predecessor_visible_hash, hash([]), 'the predecessor is the active id set, hashed');
  assert.deepEqual(artifact.predecessor_rule_ids, []);
  assert.match(release.will, /promote proposal .* via v1 lvcRatify/);
  assert.match(release.will, /ratified_by the APPROVING principal/);
  assert.match(release.will, /measured 1 audit\(s\)/);
  assert.match(release.rollback, /retired/);
  assert.match(release.rollback, /never deleted/);
});

test('§17.7 C2: release_prepare for rules refuses no simulation, another proposal’s simulation, and a staged set for the other target', async () => {
  const db = await storeDb();
  const f = await readyToPrepare(db, 'p2');
  await assert.rejects(
    () => releasePrepare(db, 'release', { target: 'rules', staged_set_id: f.proposal.staged_set_id, idempotency_key: 'x1' }, f.deps),
    (e: LabError) => e.code === 'INVALID_INPUT' && e.message.includes('rule_simulate artifact id'));
  // A simulation that measured something else is worse than none.
  const { object: other } = await putObject(db, 'release', 'report', { kind: 'rule_simulation', proposal_id: 'someone-else' }, 'deidentified', 'other-sim');
  await assert.rejects(
    () => releasePrepare(db, 'release', { target: 'rules', staged_set_id: f.proposal.staged_set_id, impact_ref: other.id, idempotency_key: 'x2' }, f.deps),
    (e: LabError) => e.code === 'INVALID_INPUT' && e.message.includes('measured proposal someone-else'));
  // And a corpus staged set may not be released as rules.
  const { object: corpusSet } = await putObject(db, 'release', 'staged_set', { kind: 'staged_set', label: 'b', chunk_ids: [1] }, 'deidentified', 'cs');
  await assert.rejects(
    () => releasePrepare(db, 'release', { target: 'rules', staged_set_id: corpusSet.id, impact_ref: f.sim.simulation_ref, idempotency_key: 'x3' }, f.deps),
    (e: LabError) => e.code === 'INVALID_INPUT' && e.message.includes("is a 'corpus' set"));
});

test('§17.7 C2: release_prepare for rules refuses a proposal that is no longer staged', async () => {
  const db = await storeDb();
  const f = await readyToPrepare(db, 'p3');
  await f.lvc.query(`UPDATE lvc_recommendation_proposals SET status = 'ratified', promoted_id = 'ehrc-x' WHERE id = $1::uuid`, [f.pid]);
  await assert.rejects(
    () => releasePrepare(db, 'release', { target: 'rules', staged_set_id: f.proposal.staged_set_id, impact_ref: f.sim.simulation_ref, idempotency_key: 'x4' }, f.deps),
    (e: LabError) => e.code === 'INVALID_INPUT' && e.message.includes("is 'ratified'"));
});

/**
 * v1's `lvcRatify`, stubbed, plus the read-back the post-check makes.
 *
 * ⚠️ THE READ FALLS THROUGH TO THE REAL FIXTURE for everything that is not the promoted row. The
 * apply re-reads the PROPOSAL from `lvc_recommendation_proposals` before it promotes anything
 * (step 3'), and a stub that answered every query would have hidden that check rather than tested
 * around it.
 */
const ratifyStub = (lvc: Db, promotedId: string | null, status = 'active') => {
  const seen: Record<string, unknown>[] = [];
  return {
    seen,
    ratify: (async (a: Record<string, unknown>) => {
      seen.push(a);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ proposal_id: a.proposal_id, status: 'ratified', promoted_id: promotedId }) }] };
    }) as never,
    readBack: (async (_s: string, statement: string, params: unknown[] = []) => {
      if (/FROM lvc_recommendations\b/.test(statement)) {
        return promotedId && statement.includes(`'${promotedId}'`) ? [{ id: promotedId, status, statement: 'x' }] : [];
      }
      return lvc.query(statement, params);
    }) as never,
    status,
  };
};

test('§17.7 decision 81: the rules apply runs the SAME refusals, in the same order', async () => {
  const db = await storeDb();
  const { release, deps } = await prepared(db, 'p4');
  await assert.rejects(() => releaseApply(db, 'release', { release_id: release.release_id }, deps),
    (e: LabError) => e.code === 'APPROVAL_MISSING');
  // Decision 5, refused at review AND at apply.
  await putReview(db, {
    release_id: release.release_id, reviewer: 'release', artifact_hash: release.artifact_hash,
    decision: 'approved', rationale: 'me',
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), idempotency_key: 'self',
  });
  await assert.rejects(() => releaseApply(db, 'release', { release_id: release.release_id }, deps),
    (e: LabError) => e.code === 'REVIEWER_IS_PREPARER');
});

test('§17.7 C2: the rules apply promotes through v1, ratified_by the APPROVING principal, with the review’s own rationale', async () => {
  const db = await storeDb();
  const f = await prepared(db, 'p5');
  const { pid, release, deps } = f;
  await reviewSubmit(db, 'dr-reviewer', { release_id: release.release_id, decision: 'approved', rationale: 'read the citation and the simulation', idempotency_key: 'rev-1' });
  const stub = ratifyStub(f.lvc, 'ehrc-42');
  const out = await releaseApply(db, 'release', { release_id: release.release_id }, { ...deps, ratify: stub.ratify, read: stub.readBack });
  assert.equal(out.outcome, 'applied');
  assert.equal(out.revision, 1);
  const body = out.body as Record<string, unknown>;
  assert.equal(body.promoted_id, 'ehrc-42');
  assert.equal(body.proposal_id, pid);
  assert.equal(body.ratified_by, 'dr-reviewer');
  assert.equal(body.writer, 'lib/mcp-tools.ts lvcRatify (v1), imported (decision 89)');
  // ⚠️ v1 refuses the default author and demands a named ratifier; decision 5 says the reviewer is
  // the accountable key. Both are satisfied by the same fact, with nothing typed twice.
  assert.equal(stub.seen[0].ratified_by, 'dr-reviewer');
  assert.equal(stub.seen[0].rationale, 'read the citation and the simulation');
  assert.equal(stub.seen[0].confirm, true);
  // Idempotent: a second apply returns the first receipt and promotes nothing.
  const again = await releaseApply(db, 'release', { release_id: release.release_id }, { ...deps, ratify: stub.ratify, read: stub.readBack });
  assert.equal(again.replayed_receipt, true);
  assert.equal(again.receipt_id, out.receipt_id);
  assert.equal(stub.seen.length, 1, 'v1 was called exactly once');
});

test('§17.7 C2: the rules apply refuses STAGED_SET_CHANGED when the proposal moved after review', async () => {
  const db = await storeDb();
  const f = await prepared(db, 'p6');
  await reviewSubmit(db, 'dr-reviewer', { release_id: f.release.release_id, decision: 'approved', rationale: 'read it', idempotency_key: 'rev-2' });
  await f.lvc.query(`UPDATE lvc_recommendation_proposals SET status = 'ratified', promoted_id = 'ehrc-out-of-band' WHERE id = $1::uuid`, [f.pid]);
  const stub = ratifyStub(f.lvc, 'ehrc-42');
  await assert.rejects(() => releaseApply(db, 'release', { release_id: f.release.release_id }, { ...f.deps, ratify: stub.ratify, read: stub.readBack }),
    (e: LabError) => e.code === 'STAGED_SET_CHANGED' && e.message.includes('ehrc-out-of-band'));
  assert.equal(stub.seen.length, 0, 'v1 was never reached');
});

test('§17.7 C2: a promotion whose row does not read active is ACTIVATION_DRIFT, receipted, and stops', async () => {
  const db = await storeDb();
  const f = await prepared(db, 'p7');
  const { release, deps } = f;
  await reviewSubmit(db, 'dr-reviewer', { release_id: release.release_id, decision: 'approved', rationale: 'read it', idempotency_key: 'rev-3' });
  const stub = ratifyStub(f.lvc, 'ehrc-43', 'superseded');
  await assert.rejects(() => releaseApply(db, 'release', { release_id: release.release_id }, { ...deps, ratify: stub.ratify, read: stub.readBack }),
    (e: LabError) => e.code === 'ACTIVATION_DRIFT' && e.message.includes('superseded'));
  const receipt = await getReceipt(db, release.release_id, 'apply');
  assert.ok(receipt, 'the receipt is written even on drift');
  const body = receipt!.body as Record<string, unknown>;
  assert.equal(body.outcome, 'activation_drift');
  assert.equal(body.promoted_id, 'ehrc-43', 'the id is recorded so a rollback can still name it');
});

test('§17.7 C2: a promotion that fails is receipted as failed, and the revision stays advanced', async () => {
  const db = await storeDb();
  const { release, deps } = await prepared(db, 'p8');
  await reviewSubmit(db, 'dr-reviewer', { release_id: release.release_id, decision: 'approved', rationale: 'read it', idempotency_key: 'rev-4' });
  const out = await releaseApply(db, 'release', { release_id: release.release_id }, {
    ...deps,
    ratify: (async () => ({ content: [{ type: 'text' as const, text: 'Error: rationale is required' }], isError: true })) as never,
  });
  assert.equal(out.outcome, 'failed');
  assert.equal((out.body as Record<string, unknown>).promoted_id, null);
  assert.match(String((out.body as Record<string, unknown>).error), /rationale is required/);
  assert.equal(out.revision, 1, 'the revision moved before the write and stays moved');
});

test('§17.7 decision 90: the rules rollback retires exactly the receipt’s id, never deletes, and carries its own caveat', async () => {
  const db = await storeDb();
  const f = await prepared(db, 'p9');
  const { release, deps } = f;
  await reviewSubmit(db, 'dr-reviewer', { release_id: release.release_id, decision: 'approved', rationale: 'read it', idempotency_key: 'rev-5' });
  const stub = ratifyStub(f.lvc, 'ehrc-44');
  await releaseApply(db, 'release', { release_id: release.release_id }, { ...deps, ratify: stub.ratify, read: stub.readBack });

  const seen: unknown[][] = [];
  const out = await releaseRollback(db, 'release', { release_id: release.release_id }, {
    ...deps,
    run: (async (s: string, p: unknown[]) => { seen.push([s, ...p]); return [{ id: 'ehrc-44' }]; }) as never,
    read: (async () => [{ id: 'ehrc-44', status: RETIRED_STATUS }]) as never,
  });
  assert.equal(out.outcome, 'rolled_back');
  assert.equal(out.caveat, RULES_ROLLBACK_CAVEAT);
  assert.match(out.caveat, /RETIRES the promoted recommendation/);
  assert.match(out.caveat, /never deletes the row/);
  assert.match(out.caveat, /does NOT delete audits/);
  assert.equal(seen[0][0], RETIREMENT_UPDATE_SQL, 'v1’s statement, by import');
  assert.equal(seen[0][1], 'ehrc-44', 'exactly the id the apply receipt recorded');
  const body = out.body as Record<string, unknown>;
  assert.equal(body.recommendation_id, 'ehrc-44');
  assert.equal(body.status_now, RETIRED_STATUS);
  assert.equal(body.writer, 'lib/lvc-ratified-wording.ts RETIREMENT_UPDATE_SQL (v1), imported (decision 90)');
  // Idempotent on (release_id, 'rollback'), exactly as the corpus is.
  const again = await releaseRollback(db, 'release', { release_id: release.release_id }, deps);
  assert.equal(again.replayed_receipt, true);
  assert.equal(seen.length, 1);
});

test('§17.7 decision 90: a row that does not read retired afterwards is PARTIAL, not retried', async () => {
  const db = await storeDb();
  const f = await prepared(db, 'p10');
  const { release, deps } = f;
  await reviewSubmit(db, 'dr-reviewer', { release_id: release.release_id, decision: 'approved', rationale: 'read it', idempotency_key: 'rev-6' });
  const stub = ratifyStub(f.lvc, 'ehrc-45');
  await releaseApply(db, 'release', { release_id: release.release_id }, { ...deps, ratify: stub.ratify, read: stub.readBack });
  const out = await releaseRollback(db, 'release', { release_id: release.release_id }, {
    ...deps,
    run: (async () => [{ id: 'ehrc-45' }]) as never,
    // ⚠️ `RETURNING id` on this statement means "the row exists", not "the status moved" — the
    // guard's third disjunct is a fresh timestamp. So the status is READ BACK.
    read: (async () => [{ id: 'ehrc-45', status: 'active' }]) as never,
  });
  assert.equal(out.outcome, 'partial');
  assert.deepEqual((out.body as Record<string, unknown>).not_flipped, ['ehrc-45']);
  assert.match(String((out.body as Record<string, unknown>).note), /rather than 'retired'/);
});

test('§17.7 C2: a rollback of an apply that promoted nothing is refused, never improvised', async () => {
  const db = await storeDb();
  const { release, deps } = await prepared(db, 'p11');
  await reviewSubmit(db, 'dr-reviewer', { release_id: release.release_id, decision: 'approved', rationale: 'read it', idempotency_key: 'rev-7' });
  await releaseApply(db, 'release', { release_id: release.release_id }, {
    ...deps, ratify: (async () => ({ content: [{ type: 'text' as const, text: 'Error: nope' }], isError: true })) as never,
  });
  await assert.rejects(() => releaseRollback(db, 'release', { release_id: release.release_id }, deps),
    (e: LabError) => e.code === 'INVALID_INPUT' && e.message.includes('no promoted recommendation id'));
});

test('§17.7 C2: release_status covers both targets', async () => {
  const db = await storeDb();
  const f = await prepared(db, 'p12');
  const { pid, release, deps } = f;
  const before = await releaseStatus({ db, principal: 'ops' }, { limit: 5 });
  assert.deepEqual(before.targets.map((t) => t.name).sort(), ['corpus', 'rules']);
  const pending = before.pending_approval.find((p) => p.release_id === release.release_id);
  assert.equal(pending!.target, 'rules');
  assert.equal(pending!.label, `rule:${pid}`, 'a rules release is legible in a status list built for the corpus');
  assert.equal(pending!.state, 'unreviewed');

  await reviewSubmit(db, 'dr-reviewer', { release_id: release.release_id, decision: 'approved', rationale: 'read it', idempotency_key: 'rev-8' });
  const stub = ratifyStub(f.lvc, 'ehrc-46');
  await releaseApply(db, 'release', { release_id: release.release_id }, { ...deps, ratify: stub.ratify, read: stub.readBack });
  const after = await releaseStatus({ db, principal: 'ops' }, { limit: 5 });
  assert.equal(after.targets.find((t) => t.name === 'rules')!.revision, 1);
  assert.equal(after.targets.find((t) => t.name === 'corpus')!.revision, 0, 'the two targets move independently');
  assert.ok(after.recent.some((r) => r.target === 'rules' && r.outcome === 'applied'));
  assert.ok(!after.pending_approval.some((p) => p.release_id === release.release_id), 'applied, so no longer pending');
});

// ═════════════════════════════════════════════════════════════════════════════════════
// 8. THE SURFACE
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.7 C2: both tools are registered with the scopes and the cost class the round names', () => {
  const propose = BY_NAME.rule_propose;
  const simulate = BY_NAME.rule_simulate;
  assert.ok(propose && simulate, 'both C2 tools are in the registry');
  assert.deepEqual([...propose.scopes], ['research_write']);
  assert.equal(propose.effect, 'research_write');
  assert.equal(propose.cost_class, 'free');
  assert.deepEqual([...simulate.scopes], ['research_read']);
  assert.equal(simulate.effect, 'read');
  assert.equal(simulate.cost_class, 'free', 'decision 82: an exact replay is free');
  assert.equal(propose.slice, 'C-2');
  assert.equal(simulate.slice, 'C-2');
  // ⚠️ NEITHER HOLDS `release`. Only release_apply reaches lvc_recommendations.
  assert.ok(!propose.scopes.includes('release'));
  assert.ok(!simulate.scopes.includes('release'));
  // The schemas the registry serves are the ones the handlers validate against.
  assert.equal(propose.inputSchema, RULES_SCHEMAS.rule_propose.input);
  assert.equal(simulate.outputSchema, RULES_SCHEMAS.rule_simulate.output);
});
