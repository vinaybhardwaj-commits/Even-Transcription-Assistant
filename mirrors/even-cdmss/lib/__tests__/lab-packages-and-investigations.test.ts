/**
 *   node --test --import tsx lib/__tests__/lab-packages-and-investigations.test.ts
 *
 * Phase C. Three properties carry real risk here and all three are pure:
 *   1. THE CSV ROUND TRIP — export → re-import unmodified must be a zero-row diff and create no
 *      version. The kickoff says "write that test first"; it is the first test below.
 *   2. THE EMPTY/MALFORMED-FILE EQUIVALENCE — an absent or broken lab-packages.json must leave the
 *      judge context BYTE-IDENTICAL. If that fails, duplication flagging silently widens.
 *   3. NULL ≠ ZERO on num_investigations — ~half the OPD corpus is null, and reading it as "none
 *      ordered" would assert something the data does not say.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  serialiseLabPackagesCsv, parseLabPackagesCsv, diffLabPackages, splitCsvLine, splitCsvRows,
  cleanMultiValue, parseStoredLabPackages, CSV_MAX_ROWS, LAB_PACKAGE_SOURCE, type LabPackage,
} from '../scoring-policy/lab-packages-csv.ts';
import { buildJudgeUser, buildLabPackageBlock } from '../lvc-core.ts';
import {
  classifyInvestigations, matchesInvestigationsFilter, applyInvestigationsFilter, stateFor,
  INVESTIGATIONS_UNAVAILABLE_NOTICE, type InvestigationsLookupResult,
} from '../opd-audit/investigations-lookup.ts';
import { canonicalByUid, canonicalBy, canonicalByDocument } from '../audit-canonical.ts';
import { constituentsFrom } from '../../scripts/generate-lab-packages.ts';

// The §7.2 worked example, verbatim from the PRD.
const SAMPLE: LabPackage[] = [
  {
    package: 'Even Hospital Advanced Diabetes Screening',
    aliases: [],
    contains: ['CBC (Complete Blood Count)', 'Lipid Profile Test (Package)', 'Liver Function Test',
      'Urine Complete Analysis / Urine Routine (CUE)', 'ECG', 'Thyroid Stimulating Hormone (TSH)',
      'Spot Urine Microalbumin/Creatinine Ratio', 'RENAL FUNCTION TEST',
      'Glycosylated Haemoglobin (Hba1C) - Whole Blood'],
    source: LAB_PACKAGE_SOURCE,
  },
  { package: 'Vitamin profile', aliases: ['vit profile', 'vitamin panel'], contains: ['Vitamin D (25-OH)', 'Vitamin B12'] },
];

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE ROUND-TRIP GUARANTEE (§7.3, hard requirement) — WRITTEN FIRST
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('ROUND TRIP: serialise → parse returns a deeply equal package set', () => {
  const csv = serialiseLabPackagesCsv(SAMPLE);
  const parsed = parseLabPackagesCsv(csv);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  assert.ok(parsed.ok);
  // `source` is not a CSV column, so compare the three round-tripped fields.
  assert.deepEqual(
    parsed.packages.map((p) => ({ package: p.package, aliases: p.aliases, contains: p.contains })),
    SAMPLE.map((p) => ({ package: p.package, aliases: p.aliases, contains: p.contains })),
  );
});

test('ROUND TRIP: re-importing an unmodified export yields a ZERO-ROW DIFF', () => {
  const csv = serialiseLabPackagesCsv(SAMPLE);
  const parsed = parseLabPackagesCsv(csv);
  assert.ok(parsed.ok);
  const diff = diffLabPackages(SAMPLE, parsed.ok ? parsed.packages : []);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
  assert.equal(diff.isEmpty, true, 'THE property that makes download-edit-upload trustworthy');
});

test('ROUND TRIP: the import route refuses to create a version when the diff is empty', () => {
  // Enforced in code, not merely hoped for — the publish branch short-circuits BEFORE publishVersion.
  const src = readFileSync('app/api/scoring-policy/lab-packages/import/route.ts', 'utf8');
  const publishIdx = src.indexOf('publishVersion({');
  const guardIdx = src.indexOf('if (diff.isEmpty)');
  assert.ok(guardIdx > 0, 'the zero-diff guard must exist');
  assert.ok(guardIdx < publishIdx, 'and must run BEFORE publishVersion is called');
  assert.ok(/noChange: true/.test(src));
});

test('ROUND TRIP survives the awkward characters — quotes, commas, semicolons, unicode', () => {
  const tricky: LabPackage[] = [
    { package: 'Panel "A", extended', aliases: ['a;b', 'quote"inside'], contains: ['Test, one', 'Test "two"', 'Vitamin D (25-OH)'] },
    { package: 'Panel — dash · dot', aliases: [], contains: ['α-fetoprotein', 'β-hCG'] },
  ];
  const parsed = parseLabPackagesCsv(serialiseLabPackagesCsv(tricky));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  assert.ok(parsed.ok);
  // NOTE: a semicolon inside an alias is a multi-value separator by definition, so 'a;b' splits.
  // Asserted explicitly so the behaviour is a decision, not a surprise.
  assert.deepEqual(parsed.packages[0].aliases, ['a', 'b', 'quote"inside'],
    'a semicolon inside an alias IS a separator by definition, so "a;b" becomes two aliases');
  assert.deepEqual(parsed.packages[0].contains, ['Test, one', 'Test "two"', 'Vitamin D (25-OH)'],
    'commas and quotes inside a quoted field survive intact');
  assert.equal(parsed.packages[1].package, 'Panel — dash · dot');
  assert.deepEqual(diffLabPackages(tricky, parsed.packages).added, []);
});

test('ROUND TRIP is stable across CRLF and a BOM (what Excel actually writes)', () => {
  const csv = serialiseLabPackagesCsv(SAMPLE);
  const excelish = `﻿${csv.replace(/\n/g, '\r\n')}`;
  const parsed = parseLabPackagesCsv(excelish);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  assert.ok(parsed.ok && diffLabPackages(SAMPLE, parsed.packages).isEmpty);
});

test('an empty package set round-trips to a header-only file and back', () => {
  const csv = serialiseLabPackagesCsv([]);
  assert.equal(csv, 'package,aliases,contains\n');
  const parsed = parseLabPackagesCsv(csv);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.ok && parsed.packages, []);
});

// ── validation: reject the WHOLE file, name the row ──

test('CSV validation rejects each invalid case named in §7.3, and applies nothing', () => {
  const bad: [string, RegExp][] = [
    ['name,alias,tests\n"a","","b"\n', /Expected columns: package, aliases, contains/],
    ['package,aliases,contains\n"","","x"\n', /Row 2: package name is empty/],
    ['package,aliases,contains\n"P","","x"\n"p","","y"\n', /Row 3: duplicate package "p"/],
    ['package,aliases,contains\n"P","",""\n', /Row 2: "P" lists no constituent tests/],
    ['package,aliases,contains\n"P","x"\n', /Row 2: expected 3 columns, found 2/],
    ['', /The file is empty/],
  ];
  for (const [csv, re] of bad) {
    const r = parseLabPackagesCsv(csv);
    assert.equal(r.ok, false, `should have rejected: ${JSON.stringify(csv.slice(0, 40))}`);
    if (!r.ok) assert.match(r.error, re);
  }
  // duplicate detection is CASE-INSENSITIVE, as specified
  const dup = parseLabPackagesCsv('package,aliases,contains\n"CBC","","x"\n"cbc","","y"\n');
  assert.equal(dup.ok, false);
});

test('CSV validation rejects an oversize row count and a non-.csv extension', () => {
  const rows = Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) => `"P${i}","","t"`).join('\n');
  const tooMany = parseLabPackagesCsv(`package,aliases,contains\n${rows}\n`);
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.match(tooMany.error, /Too many rows/);
  // exactly at the cap is fine
  const atCap = Array.from({ length: CSV_MAX_ROWS }, (_, i) => `"P${i}","","t"`).join('\n');
  assert.equal(parseLabPackagesCsv(`package,aliases,contains\n${atCap}\n`).ok, true);
  const wrongExt = parseLabPackagesCsv('package,aliases,contains\n', { filename: 'packages.xlsx' });
  assert.equal(wrongExt.ok, false);
});

test('constituents and aliases are trimmed and de-duplicated case-insensitively on ingest', () => {
  const r = parseLabPackagesCsv('package,aliases,contains\n"P"," a ; A ; b ","CBC; cbc ;  Lipid  "\n');
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.packages[0].aliases, ['a', 'b']);
  assert.deepEqual(r.ok && r.packages[0].contains, ['CBC', 'Lipid'], 'first-seen casing kept');
  assert.deepEqual(cleanMultiValue(' x ;; y ; X '), ['x', 'y']);
});

test('the low-level CSV splitters handle quotes, doubled quotes and embedded newlines', () => {
  assert.deepEqual(splitCsvLine('"a","b,c","d""e"'), ['a', 'b,c', 'd"e']);
  assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsvLine(''), ['']);
  // a newline inside a quoted field does not start a new row
  assert.equal(splitCsvRows('h\n"a\nb",x').length, 2);
  assert.doesNotThrow(() => splitCsvLine('"unterminated'));
});

test('the diff lists REMOVALS explicitly — they can never be inferred from a count alone', () => {
  const next = [SAMPLE[0]];   // Vitamin profile removed
  const d = diffLabPackages(SAMPLE, next);
  assert.deepEqual(d.removed, ['Vitamin profile']);
  assert.equal(d.isEmpty, false);
  // and the UI renders removals first, in danger colour, with the consequence spelled out
  const ui = readFileSync('app/admin/scoring-policy/lab-packages/ui.tsx', 'utf8');
  const removedIdx = ui.indexOf('diff.removed.length > 0');
  const addedIdx = ui.indexOf('diff.added.length > 0');
  assert.ok(removedIdx > 0 && removedIdx < addedIdx, 'removals must render BEFORE additions');
  assert.ok(/flagged as a duplicate again/.test(ui), 'the consequence must be stated, not implied');
});

test('the diff reports constituent and alias movement per package', () => {
  const next: LabPackage[] = [
    { ...SAMPLE[0], contains: [...SAMPLE[0].contains.slice(1), 'NEW TEST'] },
    { ...SAMPLE[1], aliases: ['vit profile'] },
  ];
  const d = diffLabPackages(SAMPLE, next);
  const a = d.changed.find((c) => c.package === SAMPLE[0].package)!;
  assert.deepEqual(a.containsAdded, ['NEW TEST']);
  assert.deepEqual(a.containsRemoved, ['CBC (Complete Blood Count)']);
  const b = d.changed.find((c) => c.package === 'Vitamin profile')!;
  assert.deepEqual(b.aliasesRemoved, ['vitamin panel']);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · EMPTY / MALFORMED FILE ⇒ BYTE-IDENTICAL JUDGE CONTEXT (§7.2, §8.9)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const CTX = { scenario: 'Adult with fatigue; ordering a diabetes screening panel.', patient: { age: 44, sex: 'f' } };
const RECS = [{ id: 'r1', region: 'IN', society: 'ICMR', statement: 'Do not repeat HbA1c within 3 months.', precondition: 'stable glycaemic control' }] as never[];

test('EQUIVALENCE: an empty or malformed package set leaves the judge prompt BYTE-IDENTICAL', () => {
  const baseline = buildJudgeUser(CTX, RECS, undefined, undefined);
  for (const bad of [undefined, null, [], [{}], [{ package: '' }], [{ package: 'X', contains: [] }],
    'nonsense' as unknown, 123 as unknown, [null, undefined] as unknown]) {
    const withBad = buildJudgeUser(CTX, RECS, undefined, undefined, bad as never);
    assert.equal(withBad, baseline, `must be byte-identical for ${JSON.stringify(bad)}`);
  }
  // and the block itself is the empty string, so nothing is concatenated
  assert.equal(buildLabPackageBlock(null), '');
  assert.equal(buildLabPackageBlock([]), '');
  assert.equal(buildLabPackageBlock([{ package: 'X', contains: [] }]), '');
});

test('EQUIVALENCE holds with the other optional context blocks present too', () => {
  const baseline = buildJudgeUser(CTX, RECS, 'PATIENT PICTURE\nDiabetic.', ['HbA1c']);
  assert.equal(buildJudgeUser(CTX, RECS, 'PATIENT PICTURE\nDiabetic.', ['HbA1c'], []), baseline);
  assert.equal(buildJudgeUser(CTX, RECS, 'PATIENT PICTURE\nDiabetic.', ['HbA1c'], null), baseline);
});

test('a REAL package set adds a factual block and changes nothing else', () => {
  const baseline = buildJudgeUser(CTX, RECS, undefined, undefined);
  const withPkgs = buildJudgeUser(CTX, RECS, undefined, undefined, SAMPLE);
  assert.notEqual(withPkgs, baseline);
  assert.ok(withPkgs.includes('LAB PACKAGE COMPOSITION'));
  assert.ok(withPkgs.includes('Even Hospital Advanced Diabetes Screening'));
  assert.ok(withPkgs.includes('also written: vit profile, vitamin panel'), 'aliases surface');
  // the block is ADDITIVE — every line of the baseline survives
  for (const line of baseline.split('\n').filter((l) => l.trim())) {
    assert.ok(withPkgs.includes(line), `baseline line lost: ${line}`);
  }
  // and it is factual, not evaluative: no verdict/severity/scoring language
  const block = buildLabPackageBlock(SAMPLE);
  for (const word of ['low-value', 'inappropriate', 'penalis', 'score', 'severity', 'applies']) {
    assert.ok(!new RegExp(word, 'i').test(block), `judge context must stay factual — found "${word}"`);
  }
});

test('the LVC judge call fails OPEN — a package-context error cannot cost a judgement', () => {
  const src = readFileSync('lib/lvc.ts', 'utf8');
  assert.ok(/labPackageContext\(\)\.catch\(\(\) => \[\]\)/.test(src), 'the read must be try-caught to []');
});

test('the applicability rubric itself is UNTOUCHED — this build adds context, not policy', () => {
  const src = readFileSync('lib/lvc-core.ts', 'utf8');
  // the governed prompt constant must not mention packages at all
  const start = src.indexOf('export const JUDGE_SYSTEM');
  const js = src.slice(start, src.indexOf('export function buildCandidateUser', start) > 0
    ? src.indexOf('export function buildCandidateUser', start) : start + 6000);
  const jsConst = js.slice(0, js.indexOf('`;') + 2);
  assert.ok(jsConst.length > 200, 'the JUDGE_SYSTEM literal must have been located');
  assert.ok(!/package/i.test(jsConst), 'JUDGE_SYSTEM is a governed prompt and must not change');
  // and no severity/floor constant moved
  assert.ok(/export const AUTOFLAG_FLOOR = 0\.75;/.test(src));
  assert.ok(/export const SURFACE_FLOOR = 0\.5;/.test(src));
});

test('parseStoredLabPackages is the ARRAY branch of the divergent weights shape (§12.3)', () => {
  // note_type='lab_packages' stores an ARRAY; the weightage note types store an OBJECT.
  assert.deepEqual(parseStoredLabPackages([{ package: 'P', contains: ['a'] }]), [{ package: 'P', aliases: [], contains: ['a'], source: undefined }]);
  assert.deepEqual(parseStoredLabPackages(JSON.stringify([{ package: 'P', contains: ['a'] }])), [{ package: 'P', aliases: [], contains: ['a'], source: undefined }]);
  // an OBJECT (the weightage shape) must yield [] — never a misread
  assert.deepEqual(parseStoredLabPackages({ date_discharge: 'critical' }), []);
  assert.deepEqual(parseStoredLabPackages(null), []);
  assert.deepEqual(parseStoredLabPackages('garbage'), []);
  // a package with no constituents cannot inform the judge and is dropped
  assert.deepEqual(parseStoredLabPackages([{ package: 'P', contains: [] }]), []);
});

test('the publish path branches on shape so an array is not hashed against field keys', () => {
  const src = readFileSync('lib/scoring-policy/store.ts', 'utf8');
  assert.ok(/const isArrayShape = Array\.isArray\(vector\);/.test(src));
  assert.ok(/isArrayShape\s*\n?\s*\? createHash\('sha256'\)/.test(src), 'arrays hash their own JSON');
});

test('the generator de-duplicates the doubled source strings and drops self-references', () => {
  // The source repeats each test, typically twice, and sometimes lists the package itself.
  assert.deepEqual(
    constituentsFrom('CBC, Lipid Profile, CBC, lipid profile, Even Diabetes Panel', 'Even Diabetes Panel'),
    ['CBC', 'Lipid Profile'],
  );
  assert.deepEqual(constituentsFrom('', 'P'), []);
  assert.deepEqual(constituentsFrom('  A ,, B , a ', 'P'), ['A', 'B']);
});

test('data/lab-packages.json is valid JSON and safe whatever state it is in', () => {
  const raw = readFileSync('data/lab-packages.json', 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  assert.ok(Array.isArray(parsed), 'must be an array — the judge branch expects one');
  // Whether populated or empty, it must produce a defined package set and never throw.
  const pkgs = parseStoredLabPackages(parsed);
  assert.ok(Array.isArray(pkgs));
  // No package may carry a duplicate constituent (case-insensitive) — the generator's contract.
  for (const p of pkgs) {
    assert.equal(new Set(p.contains.map((c) => c.toLowerCase())).size, p.contains.length, `${p.package} has a duplicate constituent`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · NULL ≠ ZERO on num_investigations (§7.1, §8.11)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('NULL means UNKNOWN, never zero — the single most important rule here', () => {
  assert.equal(classifyInvestigations(null), 'unknown');
  assert.equal(classifyInvestigations(undefined), 'unknown');
  assert.equal(classifyInvestigations(''), 'unknown');
  assert.equal(classifyInvestigations('not a number'), 'unknown');
  assert.equal(classifyInvestigations(NaN), 'unknown');
  assert.equal(classifyInvestigations(-1), 'unknown', 'a nonsensical value is not "none"');
  // the two real readings
  assert.equal(classifyInvestigations(0), 'none');
  assert.equal(classifyInvestigations('0'), 'none');
  assert.equal(classifyInvestigations(3), 'ordered');
  assert.equal(classifyInvestigations('3'), 'ordered');
});

test('"None ordered" matches = 0 EXPLICITLY; unknown survives neither filtered view', () => {
  assert.equal(matchesInvestigationsFilter('none', 'none'), true);
  assert.equal(matchesInvestigationsFilter('unknown', 'none'), false, 'NEVER coerced to zero');
  assert.equal(matchesInvestigationsFilter('unknown', 'ordered'), false);
  assert.equal(matchesInvestigationsFilter('unknown', 'all'), true, 'but it is never hidden from All');
  assert.equal(matchesInvestigationsFilter('ordered', 'ordered'), true);
  assert.equal(matchesInvestigationsFilter('ordered', 'none'), false);
});

test('the lookup merges duplicate prescription rows so ORDERED never loses to a sibling 0', () => {
  const lookup: InvestigationsLookupResult = { byUid: { a: 'ordered' }, unavailable: false };
  assert.equal(stateFor(lookup, 'a'), 'ordered');
  assert.equal(stateFor(lookup, 'never-seen'), 'unknown', 'absence is unknown, not none');
  assert.equal(stateFor(lookup, null), 'unknown');
  // the merge precedence is asserted at source (the loop is inside a network function)
  const src = readFileSync('lib/opd-audit/investigations-lookup.ts', 'utf8');
  assert.ok(/if \(cur === 'ordered'\) continue;/.test(src), 'ordered is sticky');
});

test('FAIL-SOFT: an unavailable lookup makes the filter INERT, not empty', () => {
  const rows = [{ uid: 'a' }, { uid: 'b' }];
  const down: InvestigationsLookupResult = { byUid: {}, unavailable: true };
  assert.deepEqual(applyInvestigationsFilter(rows, down, 'ordered'), rows, 'every row survives');
  assert.deepEqual(applyInvestigationsFilter(rows, down, 'none'), rows);
  // …whereas a working lookup does filter
  const up: InvestigationsLookupResult = { byUid: { a: 'ordered', b: 'none' }, unavailable: false };
  assert.deepEqual(applyInvestigationsFilter(rows, up, 'ordered'), [{ uid: 'a' }]);
  assert.deepEqual(applyInvestigationsFilter(rows, up, 'none'), [{ uid: 'b' }]);
  assert.equal(INVESTIGATIONS_UNAVAILABLE_NOTICE, 'Temporarily unavailable');
  assert.doesNotThrow(() => applyInvestigationsFilter(null as never, up, 'all'));
});

test('the investigations query uses the VALIDATED, DOUBLE-QUOTED hyphenated table', () => {
  const src = readFileSync('lib/opd-audit/investigations-lookup.ts', 'utf8');
  assert.ok(/FROM "individuals-prescriptions"/.test(src), 'hyphenated name MUST be double-quoted');
  assert.ok(/SELECT uid, num_investigations/.test(src));
  assert.ok(/WHERE uid IN \(/.test(src));
  // Never coerce null to zero ANYWHERE IN THE CODE. Comments are stripped first: the docblock
  // legitimately says "never IS NOT TRUE", and matching that would be a false positive.
  const code = src.split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
    .join('\n');
  assert.ok(!/COALESCE\(\s*num_investigations/i.test(code), 'null must never be coalesced to 0');
  assert.ok(!/IS NOT TRUE/i.test(code), '"None ordered" must match = 0 explicitly');
  // batched: exactly one call site
  assert.equal((src.match(/await metabaseQuery\(/g) || []).length, 1);
  assert.ok(/const isUid = /.test(src) && /esc\(u\)/.test(src), 'inputs validated + escaped');
});

test('the OPD filter control disables itself rather than disappearing when db13 is down', () => {
  const src = readFileSync('app/admin/opd-audit/audit-table.tsx', 'utf8');
  assert.ok(/disabled=\{investigationsUnavailable\}/.test(src));
  assert.ok(/Temporarily unavailable/.test(src));
  // and 'unknown' is the default when a row carries no reading
  assert.ok(/\(x\.investigations \?\? 'unknown'\)/.test(src));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// FIX 0 · the canonical rule, generalised to OPD
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('FIX 0 ACCEPTANCE: 2026-07-25 collapses 532 audit rows to 429 notes', () => {
  // The live shape: 429 distinct notes, 103 of them re-audited across an engine bump, plus one
  // -mini row. 429 + 103 = 532, exactly the measured count.
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 429; i++) {
    rows.push({ id: `n${i}`, uid: `U${i}`, engine_version: 'opd-note-audit/0.81.13', audited_at: '2026-07-25T06:00:00Z' });
    if (i < 103) rows.push({ id: `n${i}b`, uid: `U${i}`, engine_version: 'opd-note-audit/0.81.14', audited_at: '2026-07-25T09:00:00Z' });
  }
  rows.push({ id: 'mini', uid: 'U0', engine_version: 'opd-note-audit/0.81.14-mini', audited_at: '2026-07-25T23:00:00Z' });
  assert.equal(rows.length, 533, '532 real rows + the -mini row');

  const canonical = canonicalByUid(rows);
  assert.equal(canonical.length, 429, 'THE ACCEPTANCE NUMBER — must be 429, not 532');
  // the newer engine wins…
  assert.equal(canonical.find((r) => r.uid === 'U1')!.id, 'n1b');
  // …but the -mini row does NOT, despite being the most recent
  assert.equal(canonical.find((r) => r.uid === 'U0')!.id, 'n0b');
});

test('FIX 0: numeric version comparison — 0.81.14 beats 0.81.9 (lexicographic gets this wrong)', () => {
  const rows = [
    { id: 'old', uid: 'U', engine_version: 'opd-note-audit/0.81.9', audited_at: '2026-07-01T00:00:00Z' },
    { id: 'new', uid: 'U', engine_version: 'opd-note-audit/0.81.14', audited_at: '2026-07-02T00:00:00Z' },
  ];
  assert.equal(canonicalByUid(rows)[0].id, 'new', "'0.81.14' < '0.81.9' as a string — must not decide it");
});

test('FIX 0: ONE implementation — canonicalByUid and canonicalByDocument are the same function', () => {
  const rows = [
    { id: 'a', uid: 'U', document_id: 'D', engine_version: 'e/0.1', audited_at: '2026-01-01T00:00:00Z' },
    { id: 'b', uid: 'U', document_id: 'D', engine_version: 'e/0.2', audited_at: '2026-02-01T00:00:00Z' },
  ];
  assert.deepEqual(canonicalByUid(rows), canonicalBy(rows, 'uid'));
  assert.deepEqual(canonicalByDocument(rows), canonicalBy(rows, 'document_id'));
  assert.equal(canonicalByUid(rows)[0].id, 'b');
  // and there is exactly one ranking implementation in the file
  const src = readFileSync('lib/audit-canonical.ts', 'utf8');
  assert.equal((src.match(/const winner = new Map/g) || []).length, 1, 'one ranking loop, not two');
});

test('FIX 0: the OPD aggregates filter on the canonical set, and now FAIL CLOSED', () => {
  const page = readFileSync('app/admin/opd-audit/page.tsx', 'utf8');
  // ⚠️ REVERSED 31 Jul 2026 (addendum C §6). FIX 0 originally fetched an id allowlist and DROPPED
  // the filter when the probe returned null — "degrade rather than empty". That is now understood
  // as the worse failure: the page still renders and the number is silently inflated. The separate
  // round trip also capped its scan at 20,000 rows, truncating the allowlist without erroring.
  // Expressing THE RULE as a subquery removes both — there is no null to fall back from.
  assert.ok(/id IN \(SELECT id FROM \(/.test(page), 'the canonical filter is a subquery, not an id allowlist');
  assert.ok(page.includes('canonicalDistinctOnSql'), 'and it comes from the shared fragment');
  assert.ok(!/canonIds \?/.test(page) && !/trendIds \?/.test(page), 'no conditional-on-probe predicate survives');
  assert.ok(!/id = ANY\(\$\d+::uuid\[\]\)/.test(page), 'the id-allowlist predicate is gone');
  assert.ok(!/canonicalOpdAuditIds/.test(page.replace(/^\s*\/\/.*$/gm, '')),
    'the page no longer calls the fail-open probe (comments may still reference it)');
  // the 14-day trend has its own window, so it needs its own canonical subquery
  assert.ok(/TREND_CANON/.test(page), 'the trend window is deduped on its own range');
  // every WIN-based query still carries the window params
  assert.ok((page.match(/canonParams\)/g) || []).length >= 5, 'all five WIN queries carry them');
  const store = readFileSync('lib/opd-audit-store.ts', 'utf8');
  // READ FILTER ONLY — asserted on what FIX 0 ADDED, not on the whole file. `deleteOpdAuditsForUid`
  // is a pre-existing admin utility and is deliberately left alone.
  const added = store.slice(store.indexOf('const OPD_CANONICAL_SCAN_CAP'), store.indexOf('// ── recompute-on-read'));
  assert.ok(added.length > 500, 'the FIX 0 block must have been located');
  for (const verb of ['INSERT', 'UPDATE', 'DELETE']) {
    assert.ok(!new RegExp(`\\b${verb}\\b`).test(added), `FIX 0 must not ${verb} — found one`);
  }
});
