// lib/__tests__/telemetry-key-guard.test.ts — kickoff test 57.
//
// Two halves, both required by the kickoff line: `telemetryKeyMissingInProduction` across its five
// cases, and the source pin that `next.config.mjs`'s inlined condition matches it.
//
// ⚠️ THIS PIN IS THE THING TWO FILES ALREADY CLAIM EXISTS. `next.config.mjs:8` and
// `lib/telemetry-key-guard.ts:9` each tell the next reader that a source pin holds the two copies
// of the D8 predicate together. Until this file was written neither sentence was true: the guard
// module was imported by nothing, and a deploy-blocking condition was written twice with nothing
// keeping the copies honest. A condition that is duplicated and unpinned is how a deploy check
// stops checking — it keeps passing while one copy quietly stops meaning what the other means.
//
// ⚠️ AND THE FIRST VERSION OF THIS PIN COULD BE DEFEATED BY ONE SPACE. It compared the two copies
// as TEXT with all whitespace stripped, including whitespace inside string literals — so changing
// `'1'` to `'1 '` in next.config.mjs made the guard unable to fire ever again while all eight tests
// stayed green. It counted `&&` to forbid a fourth clause, which a fourth clause joined by `||` did
// not touch. Both holes had the same cause: a condition was being compared as characters instead of
// as a condition.
//
// WHAT REPLACES IT, IN TWO HALVES THAT PROVE DIFFERENT THINGS.
//
// (a) THE ORACLE, below. Both copies of the predicate are PARSED and compared as syntax trees.
//     String literals are compared by their exact value, so a space inside one is a difference.
//     What it does NOT count is not a short list and is not worth pretending is one: formatting,
//     line breaks, the `process.env.` / `env.` spelling, parentheses, optional chaining, and — most
//     of all — whether `env` is the process environment at all. Its subject is DRIFT BETWEEN THE
//     TWO COPIES. ⚠️ IT LOCATES THE GUARD AS THE FIRST TOP-LEVEL `IfStatement` and compares that
//     one condition; a shadowed `process`, a redefined `String` or an `uncaughtException` handler
//     leaves the condition byte-identical and the guard dead, and the oracle cannot see any of
//     them. (A prepended top-level `if` is a different matter: it becomes the located statement and
//     fails the comparison. It is the file contract below, not the oracle, that refuses the rest.)
//
// (b) THE EXECUTION, immediately below this comment. `next.config.mjs` is SPAWNED in a fresh child
//     process, three times, with the three guard inputs fixed explicitly. Its subject is WHETHER
//     THE GUARD STILL FIRES. Nothing about a source pin can answer that, and for one pass this file
//     passed 8 of 8 while the production deploy precondition was dead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { telemetryKeyMissingInProduction, TELEMETRY_HMAC_KEY_ENV } from '../telemetry-key-guard';

const GUARD_FILE = 'lib/telemetry-key-guard.ts';
const CONFIG_FILE = 'next.config.mjs';

/**
 * ⚠️ READ AND PARSED LAZILY, INSIDE THE CASES, NOT AT MODULE SCOPE. These reads used to happen while
 * the module initialized, and `inlinedGuard()` was called there too — so a deleted, emptied or
 * truncated `next.config.mjs` threw before `node --test` registered a single case. The suite still
 * failed, loudly, but it reported `not ok 1 - lib/__tests__/telemetry-key-guard.test.ts` and nothing
 * about a missing deploy precondition. A deleted guard is the most important thing this file can
 * find; it should say so by name.
 */
let sourcesCache: { guardSrc: string; nextConfigSrc: string; configAst: ts.SourceFile; guardAst: ts.SourceFile } | null = null;
function sources() {
  if (!sourcesCache) {
    const nextConfigSrc = readFileSync(CONFIG_FILE, 'utf8');
    const guardSrc = readFileSync(GUARD_FILE, 'utf8');
    sourcesCache = {
      guardSrc,
      nextConfigSrc,
      configAst: parse(CONFIG_FILE, nextConfigSrc, ts.ScriptKind.JS),
      guardAst: parse(GUARD_FILE, guardSrc, ts.ScriptKind.TS),
    };
  }
  return sourcesCache;
}

// ── the five cases ──────────────────────────────────────────────────────────────────────────────
//
// The kickoff says "its five cases" and does NOT enumerate them; neither does D8. These five are
// chosen so that each of the three clauses is exercised in BOTH directions, which is the only
// reading under which "five" is a property of the predicate rather than of a list someone wrote:
// one case per clause failing (3), plus the two distinct ways the key clause can hold — no key at
// all, and a key that is only whitespace. That the report names them is deliberate; a different
// five would be defensible, an unnamed five would not.

test('57 case 1 — production Vercel build with no key at all: MISSING', () => {
  assert.equal(telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production' }), true);
  // An explicitly-undefined value is the same fact as an absent one; the `?? ''` says so.
  assert.equal(
    telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: undefined }),
    true,
  );
});

test('57 case 2 — production Vercel build with an unusable key (empty or whitespace): MISSING', () => {
  // ⚠️ THE CLAUSE THAT `telemetryHmac` DID NOT HAVE. Both sides trim now (test 71 asserts they
  // agree). A key of three spaces was ABSENT to this guard and USABLE to the HMAC before that.
  assert.equal(
    telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: '   ' }),
    true,
  );
  assert.equal(
    telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: '' }),
    true,
  );
  assert.equal(
    telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: '\t\n ' }),
    true,
  );
});

test('57 case 3 — production Vercel build with a usable key: NOT missing', () => {
  assert.equal(
    telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: 'k' }),
    false,
  );
  // Surrounding whitespace does not make a real key unusable — trim decides emptiness, not shape.
  assert.equal(
    telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: '  k  ' }),
    false,
  );
});

// The key values this case sweeps. `undefined` is absence; the rest are every shape case 2 and case
// 3 distinguish. The title says "at any key value", so the test tries every one of them rather than
// only the absent case, which is all it used to try.
const EVERY_KEY_SHAPE = [undefined, '', '   ', '\t\n ', 'k', '  k  '];

test('57 case 4 — a Vercel build that is not production: NOT missing, at any key value', () => {
  for (const env of ['preview', 'development', undefined]) {
    for (const key of EVERY_KEY_SHAPE) {
      assert.equal(
        telemetryKeyMissingInProduction({ VERCEL: '1', VERCEL_ENV: env, [TELEMETRY_HMAC_KEY_ENV]: key }), false,
        `VERCEL_ENV=${String(env)} is not a production build (key ${JSON.stringify(key)})`,
      );
    }
  }
});

test('57 case 5 — not a Vercel build, even when the environment says production: NOT missing', () => {
  // The local case. A developer whose `.env.local` carries VERCEL_ENV=production is not deploying.
  for (const key of EVERY_KEY_SHAPE) {
    assert.equal(telemetryKeyMissingInProduction({ VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: key }), false);
    assert.equal(
      telemetryKeyMissingInProduction({ VERCEL: '0', VERCEL_ENV: 'production', [TELEMETRY_HMAC_KEY_ENV]: key }), false,
    );
  }
  assert.equal(telemetryKeyMissingInProduction({}), false);
});

// ── the guard, EXECUTED, AND THE WHOLE FILE CONSTRAINED ─────────────────────────────────────────
//
// ⚠️ THREE PASSES, THREE DEFEATED PINS, AND THE PATTERN IS ALWAYS THE SAME: the attack lives at a
// level the pin does not inspect. Whitespace-stripped text lost to a space inside a literal. An AST
// oracle over one `IfStatement` lost to a line prepended above it. An execution harness that ran the
// config as `process.argv[1]` lost to five discriminators keyed on exactly that — because a real
// build IMPORTS the config from `next/dist/bin/next`, and anything that can tell the two apart can
// switch the guard off for the test and leave it on for nobody.
//
// So two things are constrained, and neither is sufficient alone:
//
//   (a) THE WHOLE FILE, structurally. Not the guard — the file. Exactly three top-level statements,
//       in order, each pinned to its exact shape, with no imports, no directives and no executable
//       syntax anywhere else. Every kill in the class above is a PREPENDED STATEMENT, and this is
//       what refuses them: `process.env.VERCEL = …`, an `existsSync('.env.local')` discriminator, a
//       `VERCEL_URL` check, a `NODE_TEST_CONTEXT` check, a `/proc/<ppid>/cmdline` check.
//
//   (b) THE IMPORT, in a child process that a build cannot be distinguished from. The config is
//       never `process.argv[1]`; `NODE_TEST_CONTEXT` is deleted; `VERCEL_URL` is set the way a real
//       deployment sets it. That removes the specific signals a subtler discriminator would reach
//       for, so (a) is not carrying the whole load on its own.

const CONFIG_URL = pathToFileURL(resolve(CONFIG_FILE)).href;

/**
 * The child. ⚠️ `--input-type=module --eval` DELIBERATELY: it leaves the config out of `argv`
 * entirely, so a discriminator cannot ask whether it is the entry point. The config URL arrives in
 * the environment, and the child's ONLY output on success is nothing at all.
 *
 * Exit 86 is arbitrary and that is the point — it is a status nothing else in this toolchain
 * produces, so "the import threw" cannot be confused with a loader failure, a syntax error, or a
 * child that died for a reason of its own.
 */
const IMPORTER = [
  'const url = process.env.CDMSS_TEST_CONFIG_URL;',
  'try { await import(url); } catch (e) {',
  '  process.stdout.write(JSON.stringify({ name: e && e.name, message: e && e.message }));',
  '  process.exit(86);',
  '}',
].join('\n');

interface ImportOutcome { status: number; record: { name?: string; message?: string } | null; stderr: string }

function importConfig(vercel: string, vercelEnv: string, key: string | null): ImportOutcome {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VERCEL: vercel,
    VERCEL_ENV: vercelEnv,
    CDMSS_TEST_CONFIG_URL: CONFIG_URL,
    // A real production deployment always has one. A discriminator that switches the guard off when
    // it is absent would otherwise be invisible here and live everywhere else.
    VERCEL_URL: 'cdmss-rerank-telemetry.vercel.app',
  };
  // Inherited from `node --test`. A build never sets it, so anything keyed on it is a test-only
  // escape hatch — and one of the five kills was exactly that.
  delete env.NODE_TEST_CONTEXT;
  if (key === null) delete env[TELEMETRY_HMAC_KEY_ENV];
  else env[TELEMETRY_HMAC_KEY_ENV] = key;

  const r = spawnSync(process.execPath, ['--input-type=module', '--eval', IMPORTER], { env, encoding: 'utf8' });
  // Asserted BEFORE the status is read: a spawn that never started and one killed by a signal both
  // leave `status` null, which `!== 0` would happily accept as "the guard fired".
  assert.equal(r.error, undefined, `spawn failed: ${String(r.error)}`);
  assert.equal(r.signal, null, `killed by ${String(r.signal)}`);
  assert.equal(typeof r.status, 'number', 'no numeric exit status');
  // ⚠️ STDOUT ONLY. Searching combined output would let a stack trace, a warning or an unrelated
  // log line satisfy the message check.
  const out = r.stdout.trim();
  return { status: r.status as number, record: out ? JSON.parse(out) as { name?: string; message?: string } : null, stderr: r.stderr };
}

test('57 EXECUTED — importing the config in production with no key throws, and names the variable', () => {
  const { status, record } = importConfig('1', 'production', null);
  assert.equal(status, 86, 'the production deploy precondition did not throw on import');
  assert.ok(record, 'the child reported no caught value');
  assert.equal(record.name, 'Error');
  assert.ok(
    String(record.message).includes(TELEMETRY_HMAC_KEY_ENV),
    `the thrown message does not name the variable: ${String(record.message)}`,
  );
});

test('57 EXECUTED — a production import WITH a key succeeds', () => {
  // A control. Without it, a config that threw unconditionally would pass the case above.
  const { status, record } = importConfig('1', 'production', 'local-test-key-not-a-secret');
  assert.equal(status, 0);
  assert.equal(record, null, 'nothing was caught, so nothing is reported');
});

test('57 EXECUTED — a non-production import with no key succeeds', () => {
  const { status, record } = importConfig('0', 'development', null);
  assert.equal(status, 0);
  assert.equal(record, null);
});

// ── the whole config file, structurally ─────────────────────────────────────────────────────────

/** Parse diagnostics, which `createSourceFile` records but does not expose on the public type. An
 *  empty, truncated or parser-recovered config must not read as a well-formed one. */
function parseDiagnosticCount(sf: ts.SourceFile): number {
  return ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length;
}

/** Every descendant kind present in a subtree — the cheap way to say "and nothing executable". */
function kindsIn(node: ts.Node): Set<ts.SyntaxKind> {
  const out = new Set<ts.SyntaxKind>();
  const walk = (n: ts.Node): void => { out.add(n.kind); ts.forEachChild(n, walk); };
  walk(node);
  return out;
}

test('57 whole file — it parses, and holds EXACTLY three top-level statements in order', () => {
  const { nextConfigSrc, configAst } = sources();
  assert.ok(nextConfigSrc.trim().length > 0, `${CONFIG_FILE} is empty`);
  assert.equal(parseDiagnosticCount(configAst), 0, `${CONFIG_FILE} does not parse cleanly`);
  assert.equal(configAst.statements.length, 3, 'a fourth top-level statement is where every kill lived');
  assert.ok(ts.isIfStatement(configAst.statements[0]), 'statement 1 is the D8 guard');
  assert.ok(ts.isVariableStatement(configAst.statements[1]), 'statement 2 declares nextConfig');
  assert.ok(ts.isExportAssignment(configAst.statements[2]), 'statement 3 is the default export');
  // Not an `export =`, and not an import of any kind anywhere.
  assert.equal((configAst.statements[2] as ts.ExportAssignment).isExportEquals, undefined);
  assert.equal(configAst.statements.some(ts.isImportDeclaration), false, 'the config imports nothing');
});

test('57 whole file — the declaration and the export are exactly what they must be', () => {
  const { configAst } = sources();
  const decl = configAst.statements[1] as ts.VariableStatement;
  assert.ok((decl.declarationList.flags & ts.NodeFlags.Const) !== 0, 'nextConfig is const');
  assert.equal(decl.declarationList.declarations.length, 1, 'one declarator — a second is a free line of code');
  const d = decl.declarationList.declarations[0];
  assert.ok(ts.isIdentifier(d.name) && d.name.text === 'nextConfig');

  // ⚠️ THE INITIALIZER IS PINNED SHAPE-EXACT, because an allowed initializer is somewhere a mutation
  // can hide: `{ ...(kill(), {}) , reactStrictMode: true }` is an object literal too.
  const init = d.initializer;
  assert.ok(init && ts.isObjectLiteralExpression(init), 'the initializer is an object literal');
  assert.equal(init.properties.length, 1, 'one property');
  const prop = init.properties[0];
  assert.ok(ts.isPropertyAssignment(prop), 'a plain property assignment — not a spread, getter or method');
  assert.ok(ts.isIdentifier(prop.name) && prop.name.text === 'reactStrictMode', 'not a computed key');
  assert.equal(prop.initializer.kind, ts.SyntaxKind.TrueKeyword);

  const exp = (configAst.statements[2] as ts.ExportAssignment).expression;
  assert.ok(ts.isIdentifier(exp) && exp.text === 'nextConfig', 'the export is the identifier, not an expression');
});

test('57 whole file — nothing executable outside the guard', () => {
  const { configAst } = sources();
  // The guard's own condition legitimately calls `String(...)` and `.trim()`. Everything else in the
  // file must be inert: no call, no `new`, no `await`, no comma expression, no assignment.
  const forbidden: Array<[string, ts.SyntaxKind]> = [
    ['a call', ts.SyntaxKind.CallExpression],
    ['a new expression', ts.SyntaxKind.NewExpression],
    ['an await', ts.SyntaxKind.AwaitExpression],
    ['a function', ts.SyntaxKind.FunctionDeclaration],
    ['an arrow function', ts.SyntaxKind.ArrowFunction],
  ];
  for (const stmt of [configAst.statements[1], configAst.statements[2]]) {
    const kinds = kindsIn(stmt);
    for (const [label, kind] of forbidden) {
      assert.equal(kinds.has(kind), false, `${ts.SyntaxKind[stmt.kind]} contains ${label}`);
    }
    // A comma expression is a binary expression, so it needs its own walk.
    const walkComma = (n: ts.Node): void => {
      assert.equal(
        ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken, false,
        'a comma expression is a statement wearing an expression\'s clothes',
      );
      ts.forEachChild(n, walkComma);
    };
    walkComma(stmt);
  }
});

// ── the parser, and the one normalization ───────────────────────────────────────────────────────

function parse(file: string, src: string, kind: ts.ScriptKind): ts.SourceFile {
  return ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, /* setParentNodes */ true, kind);
}

/**
 * A structural rendering of an expression. Two conditions render identically when they ARE the same
 * condition, and differently otherwise.
 *
 * ⚠️ WHAT IS NORMALIZED AWAY, IN FULL: the `process.env.X` / `env.X` spelling (both render as
 * `ENV.X`, because a build script and a function taking the environment as a parameter have only
 * those two ways to say it), parentheses, and formatting. Optional chaining renders through the
 * property-access branch and is likewise not distinguished. String literals are rendered from their
 * VALUE — `'1'` and `'1 '` are two different literals here, which is the whole reason this is a
 * parser and not a `replace(/\s+/g, '')`.
 */
function ser(node: ts.Node, sf: ts.SourceFile): string {
  if (ts.isParenthesizedExpression(node)) return ser(node.expression, sf);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return `str(${JSON.stringify(node.text)})`;
  if (ts.isNumericLiteral(node)) return `num(${node.text})`;
  if (ts.isPropertyAccessExpression(node)) {
    const obj = ser(node.expression, sf);
    return obj === 'process.env' || obj === 'env' ? `ENV.${node.name.text}` : `${obj}.${node.name.text}`;
  }
  if (ts.isCallExpression(node)) {
    return `${ser(node.expression, sf)}(${node.arguments.map((a) => ser(a, sf)).join(', ')})`;
  }
  if (ts.isBinaryExpression(node)) {
    return `(${ser(node.left, sf)} ${ts.tokenToString(node.operatorToken.kind)} ${ser(node.right, sf)})`;
  }
  if (ts.isPrefixUnaryExpression(node)) {
    return `(${ts.tokenToString(node.operator)}${ser(node.operand, sf)})`;
  }
  // Anything this renderer does not model renders as its kind AND its text, so an unmodelled node
  // can never accidentally compare equal to a different unmodelled node.
  return `<${ts.SyntaxKind[node.kind]}:${JSON.stringify(node.getText(sf))}>`;
}

/** The `&&` operands at the top level, flattened. A root that is not `&&` yields one clause — which
 *  is how `A && B && C || false` is caught: its root is `||`, so it has ONE clause, not three. */
function ampChain(node: ts.Expression): ts.Expression[] {
  const e = ts.isParenthesizedExpression(node) ? node.expression : node;
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...ampChain(e.left), ...ampChain(e.right)];
  }
  return [e];
}

function containsToken(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === kind) return true;
  let found = false;
  ts.forEachChild(node, (c) => { if (!found && containsToken(c, kind)) found = true; });
  return found;
}

// ── the two copies, located in their trees ──────────────────────────────────────────────────────

/** The top-level `if` in `next.config.mjs` — the guard itself, not a nested one. */
function inlinedGuard(): ts.IfStatement {
  const found = sources().configAst.statements.find(ts.isIfStatement);
  assert.ok(found, `${CONFIG_FILE} still opens with a top-level \`if\` guard`);
  return found;
}

/** The typed twin: whatever `telemetryKeyMissingInProduction` returns. */
function typedCondition(): ts.Expression {
  const fn = sources().guardAst.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'telemetryKeyMissingInProduction',
  );
  assert.ok(fn, 'the typed twin is still exported under that name');
  const ret = fn.body?.statements[0];
  assert.ok(ret && ts.isReturnStatement(ret) && ret.expression, 'its body is still a single returned expression');
  return ret.expression;
}

function copies(): ReadonlyArray<readonly [string, ts.Expression, ts.SourceFile]> {
  return [
    [CONFIG_FILE, inlinedGuard().expression, sources().configAst],
    [GUARD_FILE, typedCondition(), sources().guardAst],
  ];
}

// ── the oracle: each copy validated independently ───────────────────────────────────────────────

test('57 pin — each copy is exactly D8\'s three clauses, and there is no fourth of any kind', () => {
  for (const [where, cond, sf] of copies()) {
    const clauses = ampChain(cond);
    assert.equal(clauses.length, 3, `${where}: D8 specifies three \`&&\` clauses, found ${clauses.length}`);
    // A fourth clause joined by `||` does not change the `&&` count, so the `&&` count is not what
    // is asserted. This is: no disjunction anywhere inside the condition.
    assert.equal(
      containsToken(cond, ts.SyntaxKind.BarBarToken), false,
      `${where}: the condition contains a \`||\` — a fourth clause is V's to add, on both sides at once`,
    );

    // Clause 1 and clause 2: the two comparison roots. `===`, the env read on the left, and a
    // string literal on the right whose VALUE is asserted, so a trailing space is a failure.
    for (const [i, name, value] of [[0, 'VERCEL', '1'], [1, 'VERCEL_ENV', 'production']] as const) {
      const c = clauses[i];
      assert.ok(ts.isBinaryExpression(c), `${where}: clause ${i + 1} is a comparison`);
      assert.equal(
        c.operatorToken.kind, ts.SyntaxKind.EqualsEqualsEqualsToken,
        `${where}: clause ${i + 1} compares with \`===\``,
      );
      assert.equal(ser(c.left, sf), `ENV.${name}`, `${where}: clause ${i + 1} reads ${name}`);
      assert.ok(ts.isStringLiteral(c.right), `${where}: clause ${i + 1} compares against a string literal`);
      assert.equal(
        c.right.text, value,
        `${where}: clause ${i + 1}'s literal is ${JSON.stringify(value)} and nothing else — `
        + `${JSON.stringify(c.right.text)} would never equal the value the platform sets`,
      );
    }

    // Clause 3: `!String(env.<KEY> ?? '').trim()`, asserted joint by joint. The env var name comes
    // from the constant, so the pin and the two copies cannot drift on spelling — a typo'd variable
    // reads as "no key" forever, in production, and nothing else would notice.
    const trimmed = clauses[2];
    assert.ok(
      ts.isPrefixUnaryExpression(trimmed) && trimmed.operator === ts.SyntaxKind.ExclamationToken,
      `${where}: clause 3 is a negation`,
    );
    const trimCall = (trimmed as ts.PrefixUnaryExpression).operand;
    assert.ok(ts.isCallExpression(trimCall), `${where}: clause 3 negates a call`);
    assert.ok(
      ts.isPropertyAccessExpression(trimCall.expression) && trimCall.expression.name.text === 'trim',
      `${where}: clause 3 calls .trim() — without it a key of three spaces is a key`,
    );
    // ⚠️ `.trim()` TAKES NO ARGUMENTS, AND UNTIL THIS ASSERTION EXISTED THAT WAS THE ONE POSITION A
    // FOURTH CLAUSE COULD HIDE IN. `.trim(x && y)` is legal JavaScript, renders identically on both
    // copies, and left every other assertion here satisfied.
    assert.equal(trimCall.arguments.length, 0, `${where}: .trim() takes no arguments`);
    const stringCall = trimCall.expression.expression;
    assert.ok(
      ts.isCallExpression(stringCall) && ser(stringCall.expression, sf) === 'String',
      `${where}: clause 3 coerces with String(...)`,
    );
    assert.equal(stringCall.arguments.length, 1, `${where}: String(...) takes one argument`);
    const coalesce = stringCall.arguments[0];
    assert.ok(
      ts.isBinaryExpression(coalesce) && coalesce.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken,
      `${where}: clause 3 defaults an absent key with \`??\``,
    );
    assert.equal(
      ser(coalesce.left, sf), `ENV.${TELEMETRY_HMAC_KEY_ENV}`,
      `${where}: clause 3 reads ${TELEMETRY_HMAC_KEY_ENV}`,
    );
    assert.ok(ts.isStringLiteral(coalesce.right), `${where}: clause 3's default is a string literal`);
    assert.equal(coalesce.right.text, '', `${where}: clause 3's default is the EMPTY string`);
  }
});

test('57 pin — next.config.mjs and telemetry-key-guard.ts express the SAME condition', () => {
  const [[whereA, condA, sfA], [whereB, condB, sfB]] = copies();
  const a = ser(condA, sfA);
  const b = ser(condB, sfB);

  // Neither may pass vacuously: a locator that silently produced an empty rendering would satisfy
  // equality. The real rendering is over 100 characters.
  assert.ok(a.length > 80, `${whereA} rendered suspiciously short: ${JSON.stringify(a)}`);
  assert.ok(b.length > 80, `${whereB} rendered suspiciously short: ${JSON.stringify(b)}`);

  assert.equal(
    a, b,
    'the D8 predicate is written twice and the copies have drifted — change both or neither',
  );
});

/**
 * The message, EVALUATED rather than grepped.
 *
 * ⚠️ A SOURCE-TEXT SEARCH FOR THE VARIABLE NAME PASSES ON A COMMENT. This throws, names nothing a
 * reader will ever see, and satisfied the previous version of this test:
 *
 *     throw new Error(/* CDMSS_TELEMETRY_HMAC_KEY *\/ 'build misconfigured')
 *
 * So the argument is required to be literals joined by `+` — nothing computed, nothing interpolated,
 * nothing that could read an environment variable — and then it is folded and checked.
 */
function literalConcat(node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return literalConcat(node.left) + literalConcat(node.right);
  }
  throw new Error(`not a literal concatenation: ${ts.SyntaxKind[node.kind]}`);
}

test('57 pin — the guard THROWS one Error, and the message a reader sees names the variable', () => {
  const guard = inlinedGuard();
  assert.equal(guard.elseStatement, undefined, 'the guard has no else arm to fall into');
  const body = guard.thenStatement;
  assert.ok(ts.isBlock(body), `${CONFIG_FILE}: the guard's consequent is a block`);
  assert.equal(body.statements.length, 1, 'exactly one statement in the block — nothing runs beside the throw');
  const first = body.statements[0];
  assert.ok(
    ts.isThrowStatement(first),
    'the condition guards a THROW, not a warning — a production build must fail, not degrade',
  );
  const thrown = first.expression;
  assert.ok(thrown && ts.isNewExpression(thrown) && ser(thrown.expression, sources().configAst) === 'Error', 'it throws an Error');
  assert.equal(thrown.arguments?.length, 1, 'one argument: the message');

  const message = literalConcat(thrown.arguments![0]);
  assert.ok(
    message.includes(TELEMETRY_HMAC_KEY_ENV),
    `the evaluated message does not name the variable: ${JSON.stringify(message)}`,
  );

  // ⚠️ THIS ASSERTION CHECKS FOR A `try` STATEMENT AND NOTHING ELSE, and it is kept for exactly that
  // much. An `uncaughtException` handler swallows the throw with no `try` anywhere in the file —
  // which the three-statement contract above is what actually refuses. What proves the build fails
  // is the EXECUTED case, which reads the child's exit status.
  let hasTry = false;
  const walk = (n: ts.Node): void => { if (ts.isTryStatement(n)) hasTry = true; ts.forEachChild(n, walk); };
  walk(sources().configAst);
  assert.equal(hasTry, false, `${CONFIG_FILE} has no try statement around its guard`);
});
