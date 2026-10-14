/**
 * lib/__tests__/lvp-operator-core.test.ts — LVP L2: the operator's pure core.
 *
 * The load-bearing claims: model text never reaches the page unfiltered, a violation is rejected
 * ROW-WISE so one bad decoration cannot cost the others their copy, and the decoration path can
 * touch two strings and nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  forbiddenHits, frozenNumberHits, LVP_CONTENT_NOUNS, LVP_COUNT_NOUNS, LVP_COUNT_WINDOW,
  LVP_FORBIDDEN_STRINGS, LVP_NUMBER_WORDS, LVP_OPERATOR_MODEL_DEFAULT, LVP_OPERATOR_SYSTEM,
  LVP_RANKING_PATTERNS, LVP_RECOMPUTED_COUNT_NOUNS, LVP_TITLE_MAX, LVP_VOLUME_MARKERS, LVP_WHY_MAX,
  operatorModel, operatorUserMessage, parseOperatorOutput, problemRule, rejectionLogLines,
  screenDecorations, validateDecoration,
  type OperatorPatternInput,
} from '../lvp-operator-core.ts';
import { LVP_DECORATIONS_DDL, UPSERT_DECORATION_SQL } from '../lvp-operator.ts';
import { BEDROCK_MODELS, isKnownBedrockModel } from '../bedrock-core.ts';

const pattern = (id: string, over: Partial<OperatorPatternInput> = {}): OperatorPatternInput => ({
  pattern_id: id, concept_id: id.replace('pattern:', ''),
  direction: 'overuse', action: 'rx', target: 'montelukast_containing',
  volume_week: 31, doctor_count: 9,
  examples: ['12 Jul 2026 — montelukast prescribed for viral URTI'],
  ...over,
});

const good = { pattern_id: 'pattern:overuse:rx:x', title: 'Montelukast for viral sore throat', why: 'These may include courses started for a short viral illness. Worth a look.' };

// ══ the model (O12) ═════════════════════════════════════════════════════════════════════════════

test('the default model is Opus on Bedrock, and it is a model Bedrock actually serves', () => {
  assert.equal(LVP_OPERATOR_MODEL_DEFAULT, 'global.anthropic.claude-opus-4-6-v1');
  assert.ok(isKnownBedrockModel(LVP_OPERATOR_MODEL_DEFAULT),
    `the default must be in BEDROCK_MODELS: ${Object.keys(BEDROCK_MODELS).join(', ')}`);
  assert.equal(BEDROCK_MODELS[LVP_OPERATOR_MODEL_DEFAULT], 'Opus 4.6');
});

test('LVP_OPERATOR_MODEL overrides, and a blank or whitespace override does NOT', () => {
  assert.equal(operatorModel({}), LVP_OPERATOR_MODEL_DEFAULT);
  assert.equal(operatorModel({ LVP_OPERATOR_MODEL: '' }), LVP_OPERATOR_MODEL_DEFAULT);
  assert.equal(operatorModel({ LVP_OPERATOR_MODEL: '   ' }), LVP_OPERATOR_MODEL_DEFAULT);
  assert.equal(operatorModel({ LVP_OPERATOR_MODEL: 'global.anthropic.claude-sonnet-4-6' }), 'global.anthropic.claude-sonnet-4-6');
  assert.equal(operatorModel({ LVP_OPERATOR_MODEL: '  global.anthropic.claude-sonnet-4-6  ' }), 'global.anthropic.claude-sonnet-4-6');
});

// ══ the forbidden-strings filter (§5, acceptance 4) ═════════════════════════════════════════════

test('the forbidden list is exactly the ten strings L1 §4.6 forbids on this page', () => {
  assert.deepEqual([...LVP_FORBIDDEN_STRINGS], [
    'Ratify', 'physician-ratified', 'Even Adjudicated', 'Route to doctor', 'Valid signal',
    'Audit bug', 'Generate candidates', 'pending ratification', 'will affect the score',
    'metal detector',
  ]);
});

test('every forbidden string is caught, in any casing, anywhere in the text', () => {
  for (const f of LVP_FORBIDDEN_STRINGS) {
    assert.deepEqual(forbiddenHits(f), [f], `${f} must be caught verbatim`);
    assert.deepEqual(forbiddenHits(f.toUpperCase()), [f], `${f} must be caught upper-cased`);
    assert.deepEqual(forbiddenHits(`a sentence that says ${f.toLowerCase()} in the middle`), [f]);
  }
  assert.deepEqual(forbiddenHits('a clean sentence about montelukast'), []);
});

test('a decoration carrying a forbidden string is REJECTED, in either field', () => {
  assert.deepEqual(validateDecoration(good), []);
  const inTitle = validateDecoration({ ...good, title: 'Ratify this montelukast pattern' });
  assert.equal(inTitle.length, 1);
  assert.match(inTitle[0], /^title: forbidden on this page — Ratify$/);
  const inWhy = validateDecoration({ ...good, why: 'Worth a look; it will affect the score.' });
  assert.equal(inWhy.length, 1);
  assert.match(inWhy[0], /^why: forbidden on this page — will affect the score$/);
});

// ══ length caps (§5, acceptance 5) ═════════════════════════════════════════════════════════════

test('length caps are 90 and 400, measured on the TRIMMED string the card renders', () => {
  assert.equal(LVP_TITLE_MAX, 90);
  assert.equal(LVP_WHY_MAX, 400);
  assert.deepEqual(validateDecoration({ ...good, title: 'x'.repeat(90) }), [], '90 is allowed');
  assert.deepEqual(validateDecoration({ ...good, why: 'y'.repeat(400) }), [], '400 is allowed');
  assert.deepEqual(validateDecoration({ ...good, title: `  ${'x'.repeat(90)}  ` }), [], 'surrounding space is not length');

  const longTitle = validateDecoration({ ...good, title: 'x'.repeat(91) });
  assert.equal(longTitle.length, 1);
  assert.match(longTitle[0], /^title: 91 characters exceeds the 90-character cap$/);
  const longWhy = validateDecoration({ ...good, why: 'y'.repeat(401) });
  assert.match(longWhy[0], /^why: 401 characters exceeds the 400-character cap$/);
});

test('an empty or missing field is a REJECTION, not a silent stub fallback', () => {
  for (const f of ['title', 'why'] as const) {
    assert.ok(validateDecoration({ ...good, [f]: '' }).some((p) => p === `${f}: required`));
    assert.ok(validateDecoration({ ...good, [f]: '   ' }).some((p) => p === `${f}: required`));
    const missing: Record<string, unknown> = { ...good };
    delete missing[f];
    assert.ok(validateDecoration(missing).some((p) => p === `${f}: required`));
  }
  assert.deepEqual(validateDecoration({ ...good, pattern_id: '' }), ['pattern_id: required']);
  assert.deepEqual(validateDecoration(null), ['decoration: must be an object']);
  assert.deepEqual(validateDecoration('a string'), ['decoration: must be an object']);
});

// ══ ROW-WISE rejection (§5, acceptance 4 and 5) ════════════════════════════════════════════════

test('ROW-WISE: a violating decoration keeps its stub copy while every other pattern proceeds', () => {
  const { accepted, rejected } = screenDecorations([
    { pattern_id: 'p1', title: 'Clean title one', why: 'A clean argument.' },
    { pattern_id: 'p2', title: 'Ratify this one', why: 'A clean argument.' },
    { pattern_id: 'p3', title: 'x'.repeat(120), why: 'A clean argument.' },
    { pattern_id: 'p4', title: 'Clean title four', why: 'z'.repeat(401) },
    { pattern_id: 'p5', title: 'Clean title five', why: 'Another clean argument.' },
  ]);
  assert.deepEqual(accepted.map((d) => d.pattern_id), ['p1', 'p5'], 'the clean ones are written');
  assert.deepEqual(rejected.map((r) => r.pattern_id), ['p2', 'p3', 'p4'], 'the violations are not');
  assert.match(rejected[0].problems[0], /forbidden on this page/);
  assert.match(rejected[1].problems[0], /exceeds the 90-character cap/);
  assert.match(rejected[2].problems[0], /exceeds the 400-character cap/);
  // A whole run is never lost to one bad row.
  assert.equal(accepted.length + rejected.length, 5);
});

test('accepted decorations are stored trimmed — what was validated is what is written', () => {
  const { accepted } = screenDecorations([{ pattern_id: 'p1', title: '  Padded title  ', why: '  Padded why.  ' }]);
  assert.deepEqual(accepted, [{ pattern_id: 'p1', title: 'Padded title', why: 'Padded why.' }]);
});

// ══ output parsing ═════════════════════════════════════════════════════════════════════════════

const ALLOWED = ['pattern:a', 'pattern:b'];

test('the array is found through a markdown fence and through surrounding prose', () => {
  const body = '[{"pattern_id":"pattern:a","title":"T","why":"W"}]';
  for (const raw of [body, '```json\n' + body + '\n```', 'Here you go:\n' + body + '\nThanks!']) {
    assert.deepEqual(parseOperatorOutput(raw, ALLOWED), [{ pattern_id: 'pattern:a', title: 'T', why: 'W' }]);
  }
});

test('an UNKNOWN pattern_id is DROPPED, never mapped onto a card it might have meant', () => {
  const raw = '[{"pattern_id":"pattern:a","title":"T","why":"W"},{"pattern_id":"pattern:invented","title":"X","why":"Y"}]';
  assert.deepEqual(parseOperatorOutput(raw, ALLOWED).map((d) => d.pattern_id), ['pattern:a']);
});

test('a duplicated pattern_id keeps the FIRST occurrence', () => {
  const raw = '[{"pattern_id":"pattern:a","title":"first","why":"W"},{"pattern_id":"pattern:a","title":"second","why":"W"}]';
  assert.deepEqual(parseOperatorOutput(raw, ALLOWED).map((d) => d.title), ['first']);
});

test('unusable output parses to nothing, and nothing is what gets written', () => {
  for (const raw of ['', 'I cannot help with that.', '{"pattern_id":"pattern:a"}', '[', 'null', '[not json]']) {
    assert.deepEqual(parseOperatorOutput(raw, ALLOWED), [], `${JSON.stringify(raw)} must parse to []`);
  }
});

test('an omitted pattern is honoured: the operator may decline an item and it keeps stub copy', () => {
  // §5 tells the operator to omit an item it cannot argue for, rather than invent one.
  const raw = '[{"pattern_id":"pattern:b","title":"T","why":"W"}]';
  assert.deepEqual(parseOperatorOutput(raw, ALLOWED).map((d) => d.pattern_id), ['pattern:b']);
});

// ══ the user message: the shelved head only, and no PHI ════════════════════════════════════════

test('the user message carries the head\'s facts and nothing the operator was not given', () => {
  const msg = operatorUserMessage([pattern('pattern:overuse:rx:montelukast_containing')]);
  assert.match(msg, /^1 pattern on this week's shelf\./);
  assert.match(msg, /pattern_id: pattern:overuse:rx:montelukast_containing/);
  assert.match(msg, /findings this week: 31/);
  assert.match(msg, /distinct doctors: 9/);
  assert.match(msg, /montelukast prescribed for viral URTI/);
  assert.match(msg, /Return the JSON array now/);
});

test('a null doctor count and an empty example list are stated, never faked', () => {
  const msg = operatorUserMessage([pattern('pattern:p', { doctor_count: null, examples: [] })]);
  assert.match(msg, /distinct doctors: \(unknown\)/);
  assert.match(msg, /de-identified example lines: \(none available\)/);
  assert.doesNotMatch(msg, /distinct doctors: 0/, 'unknown is not zero');
});

test('plural agreement, because the operator reads this sentence too', () => {
  assert.match(operatorUserMessage([pattern('p1')]), /^1 pattern on/);
  assert.match(operatorUserMessage([pattern('p1'), pattern('p2')]), /^2 patterns on/);
});

// ══ the prompt itself (§5 voice) ═══════════════════════════════════════════════════════════════

test('the system prompt states every voice constraint §5 requires', () => {
  const p = LVP_OPERATOR_SYSTEM;
  assert.match(p, /You are an operator\./);
  assert.match(p, /not Even policy, it is not a physician's ruling/, 'not policy, not a physician\'s opinion');
  assert.match(p, /Do not assert that anything is wrong\./);
  assert.match(p, /Say what the pattern IS and why it is worth a look/);
  assert.match(p, /Do not tell the care manager to do anything/, 'no instruction — the shelf is not a queue');
  assert.match(p, /No blame\./);
  assert.match(p, /At most 90 characters/);
  assert.match(p, /At most 400 characters/);
  assert.match(p, /You are given no patient record and no note text/);
});

test('the prompt names every forbidden string, so the model is told before it is filtered', () => {
  for (const f of LVP_FORBIDDEN_STRINGS) {
    assert.ok(LVP_OPERATOR_SYSTEM.includes(f), `the prompt must name ${f}`);
  }
});

test('the prompt itself contains no instruction the filter would reject as page copy', () => {
  // The prompt legitimately NAMES the forbidden strings in its own ban list; what it must not do is
  // model them as acceptable output. The output contract is a bare JSON array and nothing else.
  assert.match(LVP_OPERATOR_SYSTEM, /Return ONLY a JSON array, no prose before or after it/);
  assert.match(LVP_OPERATOR_SYSTEM, /\{"pattern_id": "<the id exactly as given>", "title": "<= 90 chars", "why": "<= 400 chars"\}/);
});

// ══ the SQL and the migration (O14, §4) ════════════════════════════════════════════════════════

test('the reference .sql and the executable DDL agree — they cannot fork silently', () => {
  const migration = readFileSync(new URL('../../migrations/0040_lvp_decorations.sql', import.meta.url), 'utf8');
  const statements = migration
    .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*(?:\n|$)/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statements, [LVP_DECORATIONS_DDL.replace(/\s+/g, ' ').trim()]);
});

test('migration 0040 is additive and single-target — it names no other table', () => {
  const migration = readFileSync(new URL('../../migrations/0040_lvp_decorations.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /^\s*UPDATE\b/im);
  assert.doesNotMatch(migration, /\bALTER\s+TABLE\b/i);
  const targets = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(targets, ['lvp_decorations']);
  // SQL-comment-stripped (`--`, not `//`): the header legitimately EXPLAINS why lvp_hidden stays
  // append-only (O14), and a comment saying so is the opposite of a statement touching it.
  const sqlOnly = migration.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(sqlOnly, /lvp_hidden/, 'no statement touches the human ledger');
});

test('O14: decorations UPSERT per pattern_id — machine output, not an append-only ledger', () => {
  assert.match(UPSERT_DECORATION_SQL, /INSERT INTO lvp_decorations/);
  assert.match(UPSERT_DECORATION_SQL, /ON CONFLICT \(pattern_id\) DO UPDATE/);
  assert.match(UPSERT_DECORATION_SQL, /SET title = EXCLUDED\.title, why = EXCLUDED\.why, model = EXCLUDED\.model/);
  assert.match(LVP_DECORATIONS_DDL, /pattern_id\s+text PRIMARY KEY/);
  // The four columns §4 specifies, and no fifth carrying anything identifying.
  const cols = [...LVP_DECORATIONS_DDL.matchAll(/^\s{2}(\w+)\s/gm)].map((m) => m[1]);
  assert.deepEqual(cols, ['pattern_id', 'title', 'why', 'model', 'generated_at']);
});

// ══ decoration-only, asserted against the store's source (acceptance 2 and 7) ═══════════════════

const STORE = readFileSync(new URL('../lvp-store.ts', import.meta.url), 'utf8');
const OPERATOR = readFileSync(new URL('../lvp-operator.ts', import.meta.url), 'utf8');

/** Source with `//` and block comments removed. Every "this file must not contain X" assertion runs
 *  over THIS: both modules' headers name the hazards they avoid (`noLocalFallback`, `lvp_hidden`,
 *  `openrouter`), and a prose mention of a hazard is the opposite of committing it. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}
const OPERATOR_CODE = code(OPERATOR);

test('the decoration block writes ONLY title, why and model — no number, no order, no id', () => {
  const block = STORE.slice(STORE.indexOf('const decRows = await run(DECORATIONS_SQL'));
  const assignments = [...block.matchAll(/^\s+s\.(\w+) = /gm)].map((m) => m[1]).sort();
  assert.deepEqual(assignments, ['model', 'title', 'why'],
    'a decoration may touch two strings and the model label, and nothing else');
  for (const zone of ['volume_week', 'doctor_count', 'first_seen', 'examples', 'pill', 'pattern_id', 'concept_id']) {
    assert.equal(new RegExp(`s\\.${zone}\\s*=`).test(block), false, `${zone} must stay deterministic`);
  }
});

test('decoration runs AFTER shelving, so it cannot promote, reorder or cap a card', () => {
  const shelve = STORE.indexOf('const suggested = shelveSuggestions(candidates);');
  const decorate = STORE.indexOf('const decRows = await run(DECORATIONS_SQL');
  assert.ok(shelve > 0 && decorate > shelve, 'the shelf is decided before any decoration is read');
  // And the decoration read is scoped to the shelved head, so an off-shelf kind is never fetched.
  assert.match(STORE, /DECORATIONS_SQL, \[suggested\.map\(\(s\) => s\.pattern_id\)\]/);
});

test('a half-written decoration row decorates nothing — both zones or neither', () => {
  assert.match(STORE, /if \(!title \|\| !why\) continue;/);
});

test('the operator writes lvp_decorations and NOTHING else (acceptance 7 and 8)', () => {
  // `UPDATE` is excluded when it is the ON CONFLICT DO UPDATE clause, which targets no new table.
  const writes = [...OPERATOR_CODE.matchAll(/\b(?:INSERT INTO|DELETE FROM)\s+(\w+)|^UPDATE\s+(\w+)/gm)]
    .map((m) => m[1] ?? m[2]);
  assert.deepEqual([...new Set(writes)], ['lvp_decorations']);
  for (const forbidden of ['lvp_hidden', 'opd_gov_signal', 'mksap_chunks', 'even_lvc_assertions', 'opd_note_audits', 'lvc_recommendations']) {
    assert.equal(OPERATOR_CODE.includes(forbidden), false, `the operator must not name ${forbidden}`);
  }
  // R3-A is dormant and must not gain an importer.
  assert.equal(/rule-governance/.test(OPERATOR_CODE), false, 'the operator must not import R3-A');
});

test('O12/F11: the governed call names bedrock and NOTHING else — no ladder to fall down', () => {
  assert.match(OPERATOR_CODE, /\{ bedrock: model \}/);
  assert.equal(/openrouter/i.test(OPERATOR_CODE), false, 'never OpenRouter');
  assert.equal(/gemini/i.test(OPERATOR_CODE), false, 'never Gemini');
  assert.equal(/noLocalFallback/.test(OPERATOR_CODE), false, 'an explicit Bedrock target has nothing to switch off');
  // The model is refused before the transport, so an unlisted id can never be served by something else.
  assert.ok(OPERATOR_CODE.indexOf('assertKnownBedrockModel(model)') < OPERATOR_CODE.indexOf('await loadShelf()'),
    'the model is checked before any shelf read or provider call');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// L2.1 — NO FROZEN COUNTS IN OPERATOR COPY (kickoff 20 Aug 2026)
//
// The card recomputes `×N this week` and `N doctors` on EVERY read from a rolling seven-day window.
// Copy that states a number froze it at generation time, and the two drift apart inside a day. L2
// left this rule in the prompt alone and Opus broke it in 12 of 28 cards; the rules that had a
// validator held perfectly. These tests are that validator.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** validateDecoration's verdict on one field, as a boolean, so a test can name a sentence. */
const rejectsWhy = (why: string) => validateDecoration({ ...good, why }).some((p) => p.startsWith('why: the card recomputes'));
const rejectsTitle = (title: string) => validateDecoration({ ...good, title }).some((p) => p.startsWith('title: the card recomputes'));

// ══ acceptance 1 — every §1 example, named ═════════════════════════════════════════════════════

test('§1: every count-bearing line the live run actually produced is REJECTED, verbatim', () => {
  // Quoted from `lvp_decorations` in the kickoff. The pattern_id is named so a reader can trace it.
  const measured: Array<[string, string]> = [
    ['pattern:overuse:rx:etoricoxib',
      'Forty-three findings from 13 doctors suggests this is worth a look.'],
    ['pattern:documentation:documentation:diagnosis-complaint concordance',
      'This is the second-highest volume pattern this week and spans 27 doctors.'],
    ['pattern:overuse:rx:aceclofenac',
      'Ten findings from only 5 doctors suggests a concentrated prescribing habit.'],
    ['pattern:overuse:rx:nsaid',
      'Only 4 doctors are involved, so the pattern is concentrated.'],
    // §2.3's second repair also carries a count, so the validator catches this one too.
    ['pattern:overuse:rx:medication',
      'It spans 20 doctors, which is nearly the full panel.'],
  ];
  for (const [patternId, why] of measured) {
    assert.ok(rejectsWhy(why), `${patternId} must be rejected: ${why}`);
  }
});

test('§1: the eight cards quoted only by their doctor count are rejected in that shape too', () => {
  // §1 names twelve failing cards but quotes copy for only four. For the other eight it gives the
  // doctor count the card carried; the count is what the copy restated, so that is what is tested.
  const byDoctorCount: Array<[string, number]> = [
    ['pattern:documentation:documentation:management plan', 10],
    ['pattern:duplication:rx:antihistamine', 9],
    ['pattern:duplication:rx:nsaid', 13],
    ['pattern:duplication:rx:paracetamol', 7],
    ['pattern:overuse:investigation:investigation', 18],
    ['pattern:overuse:rx:medication', 20],
    ['pattern:overuse:rx:multivitamin', 9],
    ['pattern:overuse:rx:supplement', 9],
  ];
  for (const [patternId, n] of byDoctorCount) {
    assert.ok(rejectsWhy(`This kind spans ${n} doctors.`), `${patternId}: "${n} doctors" must be rejected`);
    assert.ok(rejectsWhy(`It spans ${n} doctors, which is a wide spread.`), `${patternId}: in a sentence`);
  }
});

// ══ acceptance 3 — number WORDS, not only digits ═══════════════════════════════════════════════

test('acceptance 3: number WORDS are caught — "Forty-three findings" and "Ten findings"', () => {
  assert.ok(rejectsWhy('Forty-three findings this week.'), 'the hyphenated compound splits into two number words');
  assert.ok(rejectsWhy('Ten findings this week.'));
  assert.ok(rejectsWhy('TEN FINDINGS THIS WEEK.'), 'any case');
  assert.ok(rejectsWhy('forty-three findings this week.'), 'any case');
});

test('every number word §2.1 lists is caught next to a count noun, in any case', () => {
  assert.deepEqual([...LVP_NUMBER_WORDS], [
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
    'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy',
    'eighty', 'ninety', 'hundred',
  ], 'one through twenty, then the tens, then hundred');
  for (const w of LVP_NUMBER_WORDS) {
    assert.ok(rejectsWhy(`${w} doctors are involved.`), `"${w} doctors" must be rejected`);
    assert.ok(rejectsWhy(`${w.toUpperCase()} DOCTORS ARE INVOLVED.`), `"${w}" upper-cased must be rejected`);
  }
});

test('every count noun §2.1 lists is caught next to a digit', () => {
  assert.deepEqual([...LVP_COUNT_NOUNS], [
    'doctor', 'doctors', 'finding', 'findings', 'prescription', 'prescriptions',
    'case', 'cases', 'encounter', 'encounters', 'note', 'notes', 'time', 'times',
  ]);
  for (const n of LVP_COUNT_NOUNS) {
    assert.ok(rejectsWhy(`There were 13 ${n} this week.`), `"13 ${n}" must be rejected`);
  }
});

test('either order, and a short window of intervening words', () => {
  assert.ok(rejectsWhy('13 doctors'), 'number first, adjacent');
  assert.ok(rejectsWhy('doctors: 13'), 'noun first — the card renders it this way too');
  assert.ok(rejectsWhy('43 similar findings'), 'one intervening word');
  assert.ok(rejectsWhy('13 of the doctors'), `${LVP_COUNT_WINDOW} tokens is still one claim`);
  // Wider than the window is not a count claim, it is two clauses that happen to share a sentence.
  assert.equal(LVP_COUNT_WINDOW, 3);
  assert.ok(!rejectsWhy('13 of the very many doctors'), 'beyond the window is not read as one claim');
});

// ══ acceptance 4 — superlatives and percentages ════════════════════════════════════════════════

test('acceptance 4: superlative volume claims are rejected — a ranking drifts like a count', () => {
  for (const s of [
    'This is the second-highest volume pattern this week.',
    'This is the second highest volume pattern this week.',
    'The highest-volume kind on the shelf.',
    'The highest volume kind on the shelf.',
    'The most common this week.',
    'The largest group here.',
  ]) assert.ok(rejectsWhy(s), `must be rejected: ${s}`);
  assert.deepEqual(LVP_RANKING_PATTERNS.map((r) => r.label),
    ['highest-volume', 'second-highest', 'most common this week', 'largest']);
});

test('percentages are rejected, in digits and in words', () => {
  for (const s of ['Roughly 40% of these.', '40 % of these.', 'Forty percent of these.',
    'Forty per cent of these.', 'A 40 percentage share.']) {
    assert.ok(rejectsWhy(s), `must be rejected: ${s}`);
  }
});

// ══ acceptance 2 — the keep-list, named one by one ═════════════════════════════════════════════

test('acceptance 2: every clinical number §2.1 protects SURVIVES, named one by one', () => {
  const keep: Array<[string, string]> = [
    ['200 mg/day', 'Etoricoxib continued at 200 mg/day well beyond the short course it is meant for.'],
    ['120 mg', 'Etoricoxib 120 mg repeated for chronic use rather than a flare.'],
    ['4 g/day', 'Two products containing paracetamol can push the daily total past 4 g/day.'],
    ['60,000 IU', 'Vitamin D 60,000 IU repeated without an interval in between.'],
    ['25-OH-D', '25-OH-D repeated inside the same quarter.'],
    ['COX-2', 'COX-2 selective agents appearing alongside a second anti-inflammatory.'],
  ];
  for (const [number, why] of keep) {
    assert.deepEqual(validateDecoration({ ...good, why }), [],
      `${number} is the most valuable content in this copy and must survive: ${why}`);
    assert.deepEqual(frozenNumberHits(why), [], `${number} must produce no hit at all`);
  }
});

test('a clinical number standing NEXT TO a count noun still survives — the mask runs first', () => {
  // The hard direction. A dose is exempt because it is bound to a unit, not because it happens to
  // sit far from the word "doctors"; the two must be separable in the same sentence.
  assert.deepEqual(frozenNumberHits('Doctors continuing etoricoxib at 120 mg/day past the usual course.'), []);
  assert.deepEqual(frozenNumberHits('These prescriptions run to 200 mg/day.'), []);
  assert.deepEqual(frozenNumberHits('Notes recording 60,000 IU without an interval.'), []);
  assert.deepEqual(frozenNumberHits('Cases where COX-2 agents overlap.'), []);
  // …and the count in the SAME sentence as a dose is still caught, so the mask did not blind it.
  assert.ok(rejectsWhy('13 doctors continued etoricoxib at 120 mg/day.'));
});

test('a dosing FREQUENCY is a schedule, not a volume — "four times a day" survives', () => {
  for (const s of ['Paracetamol 500 mg four times a day alongside a combination product.',
    'Given 4 times daily for a week.', 'Three times a week is the usual interval.']) {
    assert.deepEqual(frozenNumberHits(s), [], `must survive: ${s}`);
  }
  // The narrowness is the safety: "this week" is a volume window, not a rate, and is still caught.
  assert.ok(rejectsWhy('Seen 43 times this week.'));
});

test('a count noun cannot hyphenate its way out of the rule', () => {
  assert.ok(rejectsWhy('A 13-doctor spread.'), 'the compound mask refuses a match containing a count noun');
});

// ══ both fields, and acceptance 5 — ROW-WISE ═══════════════════════════════════════════════════

test('the count rule applies to BOTH title and why', () => {
  assert.ok(rejectsTitle('Etoricoxib across 13 doctors'));
  assert.ok(rejectsWhy('Etoricoxib across 13 doctors.'));
  assert.deepEqual(validateDecoration({ ...good, title: 'Etoricoxib at 120 mg for chronic use' }), [],
    'a dose in the title is wanted, not rejected');
});

test('a count rejection NAMES the span it found, so the run log can be read', () => {
  const p = validateDecoration({ ...good, why: 'Forty-three findings from 13 doctors.' });
  assert.equal(p.length, 1);
  assert.match(p[0], /^why: the card recomputes this on every read — /);
  assert.match(p[0], /count "Forty-three findings"/, 'quoted from the text as written, casing intact');
});

test('acceptance 5: ROW-WISE — a frozen count costs ONE card its copy, on a mixed fixture', () => {
  const { accepted, rejected } = screenDecorations([
    // real §1 copy, and clean copy carrying the clinical numbers §2.1 protects, interleaved
    { pattern_id: 'pattern:overuse:rx:etoricoxib', title: 'Etoricoxib for musculoskeletal pain', why: 'Forty-three findings from 13 doctors suggests this is worth a look.' },
    { pattern_id: 'pattern:duplication:rx:paracetamol', title: 'Two paracetamol-containing products together', why: 'These may include pairs that together pass 4 g/day. Worth a look.' },
    { pattern_id: 'pattern:overuse:rx:nsaid', title: 'NSAID courses beyond a short flare', why: 'Only 4 doctors are involved, so the pattern is concentrated.' },
    { pattern_id: 'pattern:overuse:investigation:vitamin-d', title: 'Repeat 25-OH-D testing', why: 'These may include repeats inside one quarter, alongside 60,000 IU dosing. Worth a look.' },
    { pattern_id: 'pattern:documentation:documentation:concordance', title: 'Diagnosis and complaint not matching', why: 'This is the second-highest volume pattern this week and spans 27 doctors.' },
  ]);
  assert.deepEqual(accepted.map((d) => d.pattern_id),
    ['pattern:duplication:rx:paracetamol', 'pattern:overuse:investigation:vitamin-d'],
    'the clinical-number cards are written');
  assert.deepEqual(rejected.map((r) => r.pattern_id),
    ['pattern:overuse:rx:etoricoxib', 'pattern:overuse:rx:nsaid', 'pattern:documentation:documentation:concordance'],
    'only the frozen-count cards fall back to stub copy');
  assert.equal(accepted.length + rejected.length, 5, 'a whole run is never lost to one bad row');
  for (const r of rejected) assert.match(r.problems[0], /the card recomputes this on every read/);
});

// ══ §2.3 — the motivation rule stays a PROMPT rule, knowingly ══════════════════════════════════

test('§2.3: the motivation line is NOT regexed — over-fitting a filter to two examples is refused', () => {
  // "may reflect a habit of adding supplements as a feel-good measure." is a real §2.3 violation and
  // the prompt now forbids it. It carries no number, and the validator must not pretend otherwise:
  // motivation cannot be regexed, and a filter fitted to two sentences would reject good copy.
  const motivation = 'These may reflect a habit of adding supplements as a feel-good measure.';
  assert.deepEqual(frozenNumberHits(motivation), [], 'the count rule has nothing to say about motivation');
  assert.deepEqual(validateDecoration({ ...good, why: motivation }), [],
    'this one is caught by the prompt or not at all — §2.3 says so knowingly');
});

// ══ §2.2 — the prompt ══════════════════════════════════════════════════════════════════════════

test('§2.2: the prompt states the count rule as a worked instruction, in both fields', () => {
  const p = LVP_OPERATOR_SYSTEM;
  assert.match(p, /NUMBERS — THE CARD ALREADY SHOWS THEM/);
  assert.match(p, /recomputes on every read from a rolling seven-day window/, 'names WHY, not just what');
  assert.match(p, /how many findings there were this week, how many distinct doctors they came from, and the date this kind was first seen/,
    'names volume, doctor spread and first-seen date explicitly');
  assert.match(p, /So, in BOTH fields:/);
  assert.match(p, /Not in digits and not in words/);
  assert.match(p, /"Forty-three findings" is the same violation as "43 findings"/);
  assert.match(p, /Never write a percentage, in digits or in words\./);
  assert.match(p, /no "highest-volume", no "second-highest", no "most common this week", no "largest"/);
  assert.match(p, /Doses, ceilings, thresholds, strengths, frequencies and units are WANTED\./,
    'the keep-list is stated as wanted, not merely tolerated');
  // The one-line rule it replaces is gone, from the title bullet and from the prompt entirely.
  assert.doesNotMatch(p, /No counts, no dates, no percentages/);
});

test('§2.2: the prompt carries one positive and one negative example, and they AGREE with the validator', () => {
  const positive = 'Paracetamol appears twice on the same prescription, which can push the daily total past the 4 g/day ceiling.';
  const negative = 'Forty-three findings from 13 doctors — the second-highest volume pattern this week.';
  assert.ok(LVP_OPERATOR_SYSTEM.includes(`Write this: "${positive}"`), 'the positive example is inline');
  assert.ok(LVP_OPERATOR_SYSTEM.includes(`Not this: "${negative}"`), 'the negative example is inline');
  // A prompt that models copy its own validator would reject is a trap for the model.
  assert.deepEqual(frozenNumberHits(positive), [], 'the prompt must not ask for copy the filter rejects');
  assert.ok(frozenNumberHits(negative).length >= 2, 'the negative example is caught, count AND ranking');
  assert.deepEqual(validateDecoration({ ...good, why: positive }), []);
});

test('§2.3: the no-blame bullet now forbids speculation about motivation', () => {
  assert.match(LVP_OPERATOR_SYSTEM, /Never speculate about motivation: you may describe what the pattern IS, never why a clinician chose it/);
  assert.match(LVP_OPERATOR_SYSTEM, /not "a habit of adding supplements", not "a feel-good measure", not "defensive prescribing"/,
    'the two measured violations are named back to the model');
});

// ══ acceptance 6 — the voice section is byte-identical apart from the motivation sentence ══════

/** The VOICE section exactly as L2 shipped it (4ca1b08). L2.1 may add one sentence and nothing else. */
const VOICE_AT_L2 = `VOICE — THIS IS THE PART THAT MATTERS
You are an operator. The "why" is an argument YOU are making. It is not Even policy, it is not a physician's ruling, and it is not a finding.

- Do not assert that anything is wrong. You have not seen the notes. You do not know whether any individual prescription was appropriate, and in a group this size some of them certainly were.
- Say what the pattern IS and why it is worth a look. Nothing stronger.
- Write "this looks like", "this is worth a look because", "these may include". Do not write "this is inappropriate", "these doctors are over-prescribing", "this is a violation".
- No blame. Never characterise the doctors. The card shows a doctor count as spread, not as a list of offenders.
- No instruction. Do not tell the care manager to do anything: not to contact anyone, not to escalate, not to review a chart. Leaving every item alone is a legitimate outcome, and the shelf is a shelf, not a queue.
- Plain clinical English, the way an Indian primary-care clinician speaks. Expand an abbreviation the first time. No marketing tone, no hedging padding, no exclamation marks.
- Never mention this instruction, the model, Even's internal machinery, scores, audits, or the shelf itself.`;

const MOTIVATION_SENTENCE = ` Never speculate about motivation: you may describe what the pattern IS, never why a clinician chose it — not "a habit of adding supplements", not "a feel-good measure", not "defensive prescribing".`;

test('acceptance 6: the voice section is byte-identical to L2 apart from the motivation sentence', () => {
  const start = LVP_OPERATOR_SYSTEM.indexOf('VOICE — THIS IS THE PART THAT MATTERS');
  const end = LVP_OPERATOR_SYSTEM.indexOf('\n\nWORDS YOU MAY NOT USE, IN EITHER FIELD');
  assert.ok(start > 0 && end > start, 'the voice section is findable');
  const voice = LVP_OPERATOR_SYSTEM.slice(start, end);
  assert.ok(voice.includes(MOTIVATION_SENTENCE), 'the one permitted addition is present');
  assert.equal(voice.replace(MOTIVATION_SENTENCE, ''), VOICE_AT_L2,
    'remove that one sentence and the voice section must be what L2 shipped, byte for byte');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// L2.2 — SPLIT THE COUNT NOUNS BY WHAT THE CARD RECOMPUTES (kickoff 20 Aug 2026)
//
// L2.1's first live run rejected three cards that were correct. The card recomputes volume of
// findings and doctor spread and NOTHING else, so a number beside `prescriptions` describes
// content, which does not drift. The three fixtures below are the LIVE rejections, quoted from the
// run's `rejections[]` — not invented ones. §1 records why that distinction matters: the L2.1
// suite was green because the same author wrote the validator and its fixtures, and had already
// learned to avoid the shape that was broken.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// ══ acceptance 1 — the three live rejections now PASS ══════════════════════════════════════════

test('acceptance 1: every span the live run wrongly rejected now passes, named one by one', () => {
  // Quoted verbatim from the L2.1 re-run: 28 considered, 25 decorated, 3 rejected, all false.
  const live: Array<[string, string]> = [
    ['pattern:overuse:polypharmacy:polypharmacy', 'one prescription'],
    ['pattern:overuse:rx:vitamin d', 'prescriptions (often 60'],
    ['pattern:overuse:duplication:therapeutic', 'prescriptions containing two'],
  ];
  for (const [patternId, span] of live) {
    assert.deepEqual(frozenNumberHits(span), [], `${patternId}: "${span}" is correct copy`);
  }
});

test('acceptance 1: the live spans in the sentences they came from', () => {
  for (const why of [
    'These may include more than one prescription for the same drug class.',
    'Repeat prescriptions (often 60 000 IU) without an interval in between.',
    'Repeat prescriptions (often 60,000 IU) without an interval in between.',
    'Prescriptions containing two anti-inflammatory drugs from the same class.',
    'Two products containing paracetamol on one prescription.',
    'A single prescription carrying two NSAIDs.',
  ]) assert.deepEqual(validateDecoration({ ...good, why }), [], `must survive: ${why}`);
});

// ══ acceptance 2 — the volume-marker forms must NOT be freed ═══════════════════════════════════

test('acceptance 2: a content noun WITH a volume marker still rejects, named one by one', () => {
  assert.ok(rejectsWhy('43 cases this week'), '§2.3: 43 cases this week');
  assert.ok(rejectsWhy('20 encounters in total'), '§2.3: 20 encounters in total');
  assert.ok(rejectsWhy('seen 43 times this week'), '§2.3: seen 43 times this week');
  // §2.3's fourth form, carrying a number — see the deviation note on the literal string below.
  assert.ok(rejectsWhy('Forty notes across the week'), '§2.3: notes across the week');
  assert.ok(rejectsWhy('40 notes across the week'), '§2.3: notes across the week, in digits');
});

test('the literal "notes across the week" has no number, and L2.1 did not reject it either', () => {
  // DEVIATION, flagged in the report. §2.3 lists this as a form that must "still" reject, but it
  // contains no digit and no number word, so no count rule — L2.1's or this one's — can fire on
  // it. Freeing it is therefore not a regression: it was never caught. Asserted, not assumed, so
  // the claim is checked rather than argued.
  assert.deepEqual(frozenNumberHits('notes across the week'), []);
});

test('every volume marker §2.1 lists turns a content noun back into a tally', () => {
  assert.deepEqual(LVP_VOLUME_MARKERS.map((m) => m.join(' ')),
    ['this week', 'in total', 'so far', 'across', 'last seven days', 'per week']);
  for (const marker of LVP_VOLUME_MARKERS) {
    const phrase = marker.join(' ');
    assert.ok(rejectsWhy(`43 prescriptions ${phrase}`), `"43 prescriptions ${phrase}" must reject`);
  }
});

test('a volume marker outside the window does not reach back to reject', () => {
  // The marker must sit WITH the pair, not merely somewhere in the same sentence — otherwise one
  // "across" at the end of a `why` would re-break every card this fix exists to free.
  assert.ok(!rejectsWhy('Two NSAIDs on one prescription, a pattern seen in several clinics across the network.'));
  assert.ok(rejectsWhy('There were 43 prescriptions this week.'), 'in the window, it does reject');
});

// ══ acceptance 3 — the doctor and finding rules are untouched in strength ═══════════════════════

test('acceptance 3: a recomputed noun rejects UNCONDITIONALLY — no marker required', () => {
  assert.deepEqual([...LVP_RECOMPUTED_COUNT_NOUNS], ['doctor', 'doctors', 'finding', 'findings']);
  for (const n of LVP_RECOMPUTED_COUNT_NOUNS) {
    assert.ok(rejectsWhy(`There were 13 ${n}.`), `"13 ${n}" must reject with no volume marker`);
    assert.ok(rejectsWhy(`Ten ${n}.`), `"Ten ${n}" must reject with no volume marker`);
  }
  // The §1 lines from L2.1 carry no volume marker either, and must stay rejected.
  assert.ok(rejectsWhy('Only 4 doctors are involved, so the pattern is concentrated.'));
  assert.ok(rejectsWhy('It spans 20 doctors, which is nearly the full panel.'));
  assert.ok(rejectsWhy('Forty-three findings from 13 doctors suggests this is worth a look.'));
});

test('the two lists are disjoint, and their union is the L2.1 list unchanged', () => {
  const overlap = LVP_RECOMPUTED_COUNT_NOUNS.filter((n) => LVP_CONTENT_NOUNS.includes(n));
  assert.deepEqual(overlap, [], 'a noun is recomputed or content, never both');
  assert.deepEqual([...LVP_COUNT_NOUNS], [...LVP_RECOMPUTED_COUNT_NOUNS, ...LVP_CONTENT_NOUNS]);
  assert.deepEqual([...LVP_CONTENT_NOUNS], [
    'prescription', 'prescriptions', 'case', 'cases', 'encounter', 'encounters',
    'note', 'notes', 'time', 'times',
  ]);
});

// ══ acceptance 4 — the space thousands separator ═══════════════════════════════════════════════

test('acceptance 4: a space thousands separator is matched — 60 000 IU and 60,000 IU both survive', () => {
  // Named, not pasted: an invisible separator in a fixture is a fixture nobody can review.
  const separators: Array<[string, string]> = [
    ['comma', ','], ['space', ' '], ['no-break space', '\u00A0'], ['narrow no-break space', '\u202F'],
  ];
  for (const [name, sep] of separators) {
    const dose = `60${sep}000 IU`;
    assert.deepEqual(frozenNumberHits(`Vitamin D ${dose} repeated without an interval.`), [],
      `${name} separator must read as one clinical number`);
  }
});

test('a grouped number is still a number when it sits beside a recomputed noun', () => {
  assert.ok(rejectsWhy('13 000 doctors'), 'the wider NUM must not become an escape hatch');
  assert.ok(rejectsWhy('13,000 findings this week'));
});

test('NUM cannot swallow the word after it — a separator needs exactly three digits', () => {
  // If `\d+ \w+` were groupable, "13 doctors" would parse as one number token and never pair.
  assert.ok(rejectsWhy('13 doctors'), 'the L2.1 case, unchanged');
  assert.ok(rejectsWhy('43 similar findings'));
  assert.deepEqual(frozenNumberHits('4 g/day'), [], 'and a unit still masks cleanly');
});

// ══ acceptance 5 — rejections are logged, never persisted ══════════════════════════════════════

test('acceptance 5: a warn line carries the pattern id, the rule and the span', () => {
  const lines = rejectionLogLines([
    { pattern_id: 'pattern:a', problems: ['why: the card recomputes this on every read — count "13 doctors"'] },
    { pattern_id: 'pattern:b', problems: ['title: forbidden on this page — Ratify'] },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[lvp-operator\] rejected pattern:a · rule=count · /);
  assert.match(lines[0], /count "13 doctors"/, 'the span survives into the log');
  assert.match(lines[1], /^\[lvp-operator\] rejected pattern:b · rule=forbidden-string · /);
});

test('one line per PROBLEM, so a decoration failing two rules reports both', () => {
  const lines = rejectionLogLines([{
    pattern_id: 'pattern:a',
    problems: ['title: 91 characters exceeds the 90-character cap', 'why: the card recomputes this on every read — ranking "largest"'],
  }]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /rule=length-cap/);
  assert.match(lines[1], /rule=ranking/);
});

test('every rule the validator can emit classifies to a greppable name, never "unknown"', () => {
  const samples = [
    validateDecoration({ ...good, title: 'x'.repeat(91) }),
    validateDecoration({ ...good, title: 'Ratify this' }),
    validateDecoration({ ...good, why: 'It spans 20 doctors.' }),
    validateDecoration({ ...good, why: 'Roughly 40% of these.' }),
    validateDecoration({ ...good, why: 'The largest group here.' }),
    validateDecoration({ ...good, title: '' }),
    validateDecoration(null),
  ].flat();
  assert.ok(samples.length >= 7);
  for (const p of samples) {
    assert.notEqual(problemRule(p), 'unknown', `unclassified problem message: ${p}`);
  }
  assert.deepEqual([...new Set(samples.map(problemRule))].sort(),
    ['count', 'forbidden-string', 'length-cap', 'percentage', 'ranking', 'required', 'shape']);
});

test('§2.4: the log carries the SPAN only — no decoration text is persisted or dumped', () => {
  const OPERATOR_SRC = readFileSync(new URL('../lvp-operator.ts', import.meta.url), 'utf8');
  const warns = [...OPERATOR_SRC.matchAll(/console\.warn\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(warns, ['line'], 'exactly one warn, and it logs a prepared line');
  // Nothing rejected reaches a table: the only write in this module is the accepted-row upsert.
  assert.equal(/upsertDecoration\(\s*(?:d|r)\b/.test(code(OPERATOR_SRC)), true);
  assert.equal(/rejected\.(?:map|forEach)\([^)]*upsert/i.test(OPERATOR_SRC), false, 'no rejected row is written');
  assert.equal(/INSERT INTO \w+[\s\S]{0,200}reject/i.test(OPERATOR_SRC), false, 'no rejection table exists');
});
