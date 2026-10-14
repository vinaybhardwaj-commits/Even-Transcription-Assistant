/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-r10-record-reach.test.ts
 *
 * R10 — the agent reads the whole record (CDMSS-READMISSIONS-R10-RECORD-REACH-PRD-27-AUG-2026-GO,
 * R10-D1..R10-D12). What this file exists to hold still:
 *
 *   SLICE A   the extract contract (`verbatim_sections`, copy-not-summarise, 6 × 4,000) and its
 *             version bump · which printed blocks are OPERATIVE and which are not · the DOT evidence
 *             source and its INTERESTED weight · the fifth coverage state and the refusal copy that
 *             is finally true · T-5 PRESERVED: a legitimately non-surgical case still reads plain
 *             absence, and a missing template is still never a negative finding.
 *   SCRUBBER  a synthetic artefact carrying the patient's name and UHID stores and renders as
 *             [PATIENT] / [UHID] — the R10-D8 acceptance, tested through the ONE choke point.
 *   NAMESPACE the `X…` gate: an id the thread holds resolves, an id it does not is an invented id and
 *             the whole answer dies; the ledger namespace is unchanged either way.
 *   LOOP      the fetch cap is a number the prompt and the code share; the exhaustion copy is honest
 *             rather than an error; a junk tool argument is refused, not guessed.
 *   TOOL      the Converse mapping, both directions, INCLUDING the byte-identity of the no-tool path.
 *   PINS      engine version unchanged · the recon prompt fingerprints unchanged (the armed refresh
 *             probe stays armed) · rates files untouched · the model pin, F11, no new catalogue row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  EXTRACT_SYSTEM, VERBATIM_SECTION_MAX, VERBATIM_SECTION_MAX_CHARS, parseExtraction,
  parseVerbatimSections,
} from '../doc-audit-core.ts';
import { DOC_EXTRACT_VERSION } from '../discharge-extract-store.ts';
import {
  DOC_OPERATIVE_ID_PREFIX, coverageFor, isOperativeSection, operativeVerbatimSections,
  reduceTemplateCoverage,
} from '../readmission-template-core.ts';
import { evidenceWeight, templateRefusalLines } from '../readmission-reconcile-core.ts';
import { artefactStateWord, chipText, templateChipState } from '../readmission-surface-core.ts';
import { deidText, docOperativeItems } from '../readmission/assemble.ts';
import { reconPromptFingerprints } from '../readmission-refresh-core.ts';
import {
  EMPTY_RECORD_INDEX, FETCH_RECORD_INPUT_SCHEMA, FETCH_RECORD_TOOL_NAME, RECORD_ARTEFACT_MAX_CHARS,
  RECORD_FETCH_MAX, RECORD_HELD_IN_PROMPT_MAX,
  RECORD_KINDS, RECORD_MAX_PER_KIND, askVerdict, isRecordId, loopExhaustedCopy, mintRecordIndex,
  parseFetchRecordArgs, renderRecordIndex, retrievedChipLabel, unknownRecordCopy,
  ASK_ADVISORY, ASK_TOOL_CALL_BUDGET_MS, ASK_TOOL_TOTAL_BUDGET_MS,
  type RecordSourceResult,
} from '../readmission-ask-core.ts';
import { fromConverseOutput, toConverseInput, toolCallsOf } from '../bedrock-core.ts';
import { READMIT_ENGINE_VERSION } from '../readmission/store.ts';
import { gainedOperativeText } from '../readmission/reextract.ts';
import { toRetrievedArtefact } from '../readmission/records.ts';

const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const body = (p: string): string => { const src = code(p); const end = src.indexOf('*/'); return end < 0 ? src : src.slice(end + 2); };

// ══ SLICE A · the extract contract (R10-D1, §3.1) ═══════════════════════════════════════════

test('EXTRACT_SYSTEM instructs the extractor to COPY, names the 6 × 4,000 caps, keeps the no-identifier rule on the new field, and the JSON shape carries verbatim_sections', () => {
  assert.match(EXTRACT_SYSTEM, /VERBATIM SECTIONS/);
  assert.match(EXTRACT_SYSTEM, /COPY, DO NOT SUMMARISE/);
  assert.match(EXTRACT_SYSTEM, /REPRODUCED WORD FOR WORD/);
  assert.match(EXTRACT_SYSTEM, /At most 6 sections/);
  assert.match(EXTRACT_SYSTEM, /4,000 characters/);
  // The privacy rule is RESTATED on this field, not merely assumed from the header.
  assert.match(EXTRACT_SYSTEM, /never the patient's name, UHID, hospital number, address or phone/);
  assert.match(EXTRACT_SYSTEM, /"verbatim_sections":\[\{"heading":/);
  assert.equal(VERBATIM_SECTION_MAX, 6);
  assert.equal(VERBATIM_SECTION_MAX_CHARS, 4_000);
});

test('parseVerbatimSections: caps at 6, truncates at 4,000, drops a heading with no text, tolerates a missing heading, and returns undefined for absent / malformed / all-empty', () => {
  assert.equal(parseVerbatimSections(undefined), undefined);
  assert.equal(parseVerbatimSections('nope'), undefined);
  assert.equal(parseVerbatimSections([]), undefined);
  assert.equal(parseVerbatimSections([{ heading: 'OPERATIVE NOTES' }]), undefined, 'a heading alone evidences nothing');
  assert.deepEqual(parseVerbatimSections([{ text: 'incision made' }]), [{ heading: 'section', text: 'incision made' }]);
  const many = Array.from({ length: 20 }, (_, i) => ({ heading: `H${i}`, text: `T${i}` }));
  assert.equal(parseVerbatimSections(many)!.length, VERBATIM_SECTION_MAX);
  const long = parseVerbatimSections([{ heading: 'OT', text: 'x'.repeat(9_000) }])!;
  assert.equal(long[0].text.length, VERBATIM_SECTION_MAX_CHARS + 1, 'capped, with the ellipsis that says so');
  assert.ok(long[0].text.endsWith('…'));
});

test('parseExtraction carries verbatim_sections through, and a pre-R10 payload (no such key) parses to undefined — one absent shape for every reader', () => {
  const base = { course_summary: 'uneventful recovery', diagnosis: 'fracture' };
  const withSections = parseExtraction(JSON.stringify({ ...base, verbatim_sections: [{ heading: 'OPERATIVE NOTES', text: 'hemiarthroplasty, calcar crack, cerclage wire' }] }), 'discharge_summary');
  assert.deepEqual(withSections?.verbatimSections, [{ heading: 'OPERATIVE NOTES', text: 'hemiarthroplasty, calcar crack, cerclage wire' }]);
  const without = parseExtraction(JSON.stringify(base), 'discharge_summary');
  assert.equal(without?.verbatimSections, undefined);
});

test('DOC_EXTRACT_VERSION bumped to doc-extract/2 — a doc-extract/1 row cannot answer the question R10 asks of it', () => {
  assert.equal(DOC_EXTRACT_VERSION, 'doc-extract/2');
});

// ══ SLICE A · which printed blocks are operative (§3.2) ═════════════════════════════════════

test('isOperativeSection: an operative HEADING wins; a clearly non-operative heading loses whatever the text says; a GENERIC heading falls back to unmistakable text markers only', () => {
  const op = (heading: string, text = 'the block') => isOperativeSection({ heading, text });
  for (const h of ['OPERATIVE NOTES', 'Operation Record', 'OT Note', 'Procedure Details', 'Intra-operative findings', 'Anaesthesia Note', 'Surgery Notes', 'Surgical Findings']) {
    assert.equal(op(h), true, h);
  }
  // A discharge summary's ordinary sections are NOT operative, however surgical they read. This is
  // the guard that stops a course-in-hospital paragraph becoming a fabricated operative record.
  assert.equal(isOperativeSection({ heading: 'Discharge Medications', text: 'incision site clean, anaesthesia tolerated well' }), false);
  assert.equal(isOperativeSection({ heading: 'Chief Complaints', text: 'pain in the hip' }), false);
  // Generic heading + a real operative marker ⇒ operative. Generic heading + ordinary prose ⇒ not.
  assert.equal(isOperativeSection({ heading: 'Notes', text: 'Under spinal anaesthesia, incision over the lateral hip…' }), true);
  assert.equal(isOperativeSection({ heading: 'Notes', text: 'Patient advised rest and review in one week.' }), false);
  assert.equal(isOperativeSection({ heading: 'Course in Hospital', text: 'Patient remained afebrile.' }), false);
  // No text at all is never operative, whatever the heading claims.
  assert.equal(isOperativeSection({ heading: 'OPERATIVE NOTES', text: '   ' }), false);
});

test('operativeVerbatimSections: picks only the operative blocks, in order, and answers [] for a pre-R10 extraction — the same answer as "the document printed none"', () => {
  assert.deepEqual(operativeVerbatimSections(undefined), []);
  assert.deepEqual(operativeVerbatimSections([{ heading: 'Diet Advice', text: 'low salt' }]), []);
  const got = operativeVerbatimSections([
    { heading: 'Diet Advice', text: 'low salt' },
    { heading: 'OPERATIVE NOTES', text: 'hemiarthroplasty' },
    { heading: 'Procedure Details', text: 'cerclage wire applied' },
  ]);
  assert.deepEqual(got.map((x) => x.heading), ['OPERATIVE NOTES', 'Procedure Details']);
});

// ══ SLICE A · the DOT source, its weight, and the coverage state (§3.2, R10-D10) ════════════

test('evidenceWeight: doc_operative_text is INTERESTED on BOTH sides — the fail-closed weight, because interested evidence can never carry an avoidable verdict alone', () => {
  assert.equal(evidenceWeight({ source: 'doc_operative_text', side: 'index' }), 'interested');
  assert.equal(evidenceWeight({ source: 'doc_operative_text', side: 'readmit' }), 'interested');
  assert.equal(evidenceWeight({ source: 'doc_operative_text', side: null }), 'interested');
  // The neighbours are untouched.
  assert.equal(evidenceWeight({ source: 'index_summary', side: 'index' }), 'interested');
  assert.equal(evidenceWeight({ source: 'ot_note', side: 'readmit' }), 'disinterested');
});

test('coverageFor: the document fallback fires ONLY on the absent branch — a real OT row outranks it, and a FAULT is still fetch_failed (a fault is never an absence)', () => {
  const usable = [{ narrative: 'OT note text', facts: [] }];
  assert.deepEqual(coverageFor('ok', [], false), { status: 'absent', count: 0 });
  assert.deepEqual(coverageFor('ok', [], true), { status: 'absent_document_text', count: 0 });
  assert.deepEqual(coverageFor('ok', usable, true), { status: 'present', count: 1 }, 'a db13 row outranks a printed block');
  assert.deepEqual(coverageFor('ok', [{ narrative: '', facts: [] }], true), { status: 'empty', count: 1 });
  assert.deepEqual(coverageFor('fetch_failed', [], true), { status: 'fetch_failed', count: 0 }, 'a fault is never an absence');
});

test('reduceTemplateCoverage: the document flag reaches OT and ONLY OT — PAC and progress have no document fallback and inventing one would put words in a record nobody wrote', () => {
  const outcomes = { ot_note: 'ok', pac_note: 'ok', progress_note: 'ok' } as const;
  const cov = reduceTemplateCoverage(outcomes, [], { documentOperativeText: true });
  assert.equal(cov.ot.status, 'absent_document_text');
  assert.equal(cov.pac.status, 'absent');
  assert.equal(cov.progress.status, 'absent');
  // Absent the option, the object is exactly what R2 produced.
  assert.deepEqual(reduceTemplateCoverage(outcomes, []), {
    ot: { status: 'absent', count: 0 }, pac: { status: 'absent', count: 0 }, progress: { status: 'absent', count: 0 },
  });
});

test('the refusal that was a lie becomes true — and the PLAIN-absence line survives untouched for a genuinely non-surgical case (acceptance #2, T-5)', () => {
  const lines = templateRefusalLines({
    ot: { status: 'absent_document_text', count: 0 },
    pac: { status: 'absent', count: 0 },
    progress: { status: 'absent', count: 0 },
  });
  const ot = lines.find((l) => l.lookedFor === 'ot_note')!;
  assert.equal(ot.found, false, 'what was looked for — a STRUCTURED OT row — is still not there');
  assert.equal(ot.note, 'no structured OT row; operative text found in the discharge document');
  // The other two keep R2's wording exactly.
  assert.equal(lines.find((l) => l.lookedFor === 'pac_note')!.note, 'no row in db13 for this stay/window');
  // T-5 / acceptance #2: a case whose document prints nothing reads exactly as it did before R10.
  const plain = templateRefusalLines({
    ot: { status: 'absent', count: 0 }, pac: { status: 'absent', count: 0 }, progress: { status: 'absent', count: 0 },
  });
  assert.equal(plain.find((l) => l.lookedFor === 'ot_note')!.note, 'no row in db13 for this stay/window');
  assert.ok(!JSON.stringify(plain).includes('discharge document'));
  // And in EITHER case `found` is false — a missing template is never a positive or negative finding.
  assert.ok(plain.every((l) => l.found === false));
});

test('the chip: a sixth state that is neither present nor absent, with copy a care manager can act on', () => {
  assert.equal(templateChipState({ status: 'absent_document_text' }), 'document_text');
  assert.equal(chipText({ key: 'ot', label: 'OT', state: 'document_text' }), 'OT in document');
  assert.equal(artefactStateWord({ key: 'ot', state: 'document_text' }), 'no structured OT row; operative text found in the discharge document');
  // Nothing else moved.
  assert.equal(templateChipState({ status: 'absent' }), 'absent');
  assert.equal(templateChipState({ status: 'fetch_failed' }), 'unknown');
  assert.equal(chipText({ key: 'ot', label: 'OT', state: 'absent' }), 'OT none');
});

test('docOperativeItems: DOT ids, the label that refuses to be a theatre record, de-identified text, and NOTHING at all when the document printed no operative block', () => {
  const identity = { names: ['Ramesh Nadagowda'], uhids: ['UHID-26415'] };
  const ec = { verbatimSections: [{ heading: 'OPERATIVE NOTES', text: 'Nadagowda underwent hemiarthroplasty. UHID-26415.' }] };
  const items = docOperativeItems(ec as never, 'index', 1, identity);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, `${DOC_OPERATIVE_ID_PREFIX}1`);
  assert.equal(items[0].source, 'doc_operative_text');
  assert.match(items[0].text, /operative text printed in the first stay's discharge document under "OPERATIVE NOTES" — not a structured OT note/);
  assert.ok(items[0].text.includes('[PATIENT]') && items[0].text.includes('[UHID]'));
  assert.ok(!/Nadagowda|26415/.test(items[0].text), 'no identifier survives the choke point');
  // A document with no operative block contributes nothing at all, and so does a pre-R10 extraction.
  assert.deepEqual(docOperativeItems({ verbatimSections: [{ heading: 'Diet', text: 'low salt' }] } as never, 'index', 1, identity), []);
  assert.deepEqual(docOperativeItems(null, 'index', 1, identity), []);
});

test('gainedOperativeText: sections AND no usable db13 OT row. A present OT row is not a gain; zero sections is never a gain; an unwritten coverage has no db13 answer to outrank', () => {
  assert.equal(gainedOperativeText({ otStatus: 'absent', sections: 1 }), true);
  assert.equal(gainedOperativeText({ otStatus: 'empty', sections: 2 }), true);
  assert.equal(gainedOperativeText({ otStatus: 'fetch_failed', sections: 1 }), true);
  assert.equal(gainedOperativeText({ otStatus: null, sections: 1 }), true);
  assert.equal(gainedOperativeText({ otStatus: 'present', sections: 3 }), false);
  assert.equal(gainedOperativeText({ otStatus: 'absent', sections: 0 }), false);
});

// ══ R10-D8 · the scrubber, through the ONE choke point ══════════════════════════════════════

test('R10-D8 acceptance — a synthetic retrieved artefact carrying the patient name and UHID stores and renders as [PATIENT] / [UHID], in the text AND in the label', () => {
  const identity = { names: ['Sunita Bakale'], uhids: ['AH2425/008247'] };
  const entry = { id: 'X3', kind: 'ip_stay' as const, date: '2026-05-02', label: 'inpatient stay for Sunita Bakale', sourceKey: 'ip_stay:IP-9' };
  const raw = 'Sunita Bakale (AH2425/008247) underwent laparoscopic cholecystectomy. BAKALE tolerated the procedure well.';
  const art = toRetrievedArtefact(entry, raw, identity);
  assert.ok(!/Sunita|Bakale|BAKALE|AH2425\/008247/i.test(art.text), `identity survived: ${art.text}`);
  assert.ok(!/Sunita|Bakale/i.test(art.label), `identity survived in the label: ${art.label}`);
  assert.match(art.text, /\[PATIENT\]/);
  assert.match(art.text, /\[UHID\]/);
  // The scrub is case-insensitive and catches name PARTS, which is the whole reason deidText is reused
  // rather than reimplemented — a bespoke scrubber here would have had to rediscover both rules.
  assert.equal(deidText('BAKALE', identity), '[PATIENT]');
  // Identity, id, kind and date survive intact; only the free text is rewritten.
  assert.equal(art.id, 'X3');
  assert.equal(art.kind, 'ip_stay');
  assert.equal(art.date, '2026-05-02');
  assert.equal(art.sourceKey, 'ip_stay:IP-9');
});

test('records.ts reuses the exported choke point and never reimplements it — asserted by reading the source', () => {
  const src = code('lib/readmission/records.ts');
  assert.match(src, /import \{ deidText \} from '\.\/assemble'/);
  assert.ok(!/function deidText/.test(src), 'the scrubber must never be redefined here');
  assert.ok(!/\[PATIENT\]|\[UHID\]/.test(body('lib/readmission/records.ts')), 'the tokens belong to assemble.ts alone');
  // The one function that builds an artefact is the one that scrubs it.
  assert.match(src, /export function toRetrievedArtefact/);
  assert.equal((src.match(/deidText\(/g) ?? []).length >= 2, true, 'label AND text both go through it');
});

// ══ R10-D5/D6 · the record index, the namespace gate, the loop cap ══════════════════════════

test('R10-D4 — five kinds, exactly, and the caps are the PRD kickoff numbers', () => {
  assert.deepEqual([...RECORD_KINDS], ['ip_stay', 'opd_note', 'lab', 'member_state', 'cm_interaction']);
  assert.equal(RECORD_MAX_PER_KIND, 20);
  assert.equal(RECORD_FETCH_MAX, 5);
});

test('mintRecordIndex: newest first, capped at 20 per kind with the overflow STATED, an unreadable source reported as unknown rather than empty', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({
    kind: 'opd_note' as const, date: `2026-01-${String(i + 1).padStart(2, '0')}`, label: 'clinic visit', sourceKey: `opd_note:u${i}`,
  }));
  const idx = mintRecordIndex([
    { kind: 'opd_note', ok: true, items },
    { kind: 'lab', ok: false, items: [] },
  ] as RecordSourceResult[]);
  assert.equal(idx.entries.length, RECORD_MAX_PER_KIND);
  assert.equal(idx.entries[0].date, '2026-01-25', 'newest first');
  assert.deepEqual(idx.truncated, [{ kind: 'opd_note', shown: 20, total: 25 }]);
  assert.deepEqual(idx.unavailable, ['lab']);
  const rendered = renderRecordIndex(idx);
  assert.match(rendered, /Only the 20 most recent of 25/);
  assert.match(rendered, /could not be read just now — that is an unknown, not an absence/);
  // An EMPTY index says so in words rather than rendering a blank the model could read as "none".
  assert.match(renderRecordIndex(EMPTY_RECORD_INDEX), /No other records for this patient could be listed/);
});

test('R10-D7 — an id, once bound, stays bound: a persisted binding is reused verbatim and a NEW artefact can never take an id a stored citation points at', () => {
  const bound = new Map([['opd_note:u2', 'X7']]);
  const idx = mintRecordIndex([{
    kind: 'opd_note', ok: true, items: [
      { kind: 'opd_note', date: '2026-02-02', label: 'clinic visit', sourceKey: 'opd_note:u2' },
      { kind: 'opd_note', date: '2026-02-01', label: 'clinic visit', sourceKey: 'opd_note:u9' },
    ],
  }] as RecordSourceResult[], bound);
  const byKey = new Map(idx.entries.map((e) => [e.sourceKey, e.id]));
  assert.equal(byKey.get('opd_note:u2'), 'X7', 'the stored binding is reused');
  assert.notEqual(byKey.get('opd_note:u9'), 'X7', 'a fresh artefact never steals a bound id');
  assert.equal(new Set(idx.entries.map((e) => e.id)).size, idx.entries.length, 'ids are unique');
});

test('R10-D6 — the namespace gate: an X id the thread holds resolves; one it does not is an invented id and the WHOLE answer dies; the ledger namespace is unchanged', () => {
  const parsed = { answer: 'Her previous admission was for cholecystectomy [X2].', answerable: true };
  assert.equal(askVerdict(parsed, ['S1', 'S2'], ['X2']).ok, true);
  const bad = askVerdict(parsed, ['S1', 'S2'], ['X5']);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.invalidIds, ['X2']);
  assert.equal(bad.reason, 'unresolved_ids');
  // With NO record namespace passed (the R9 call shape), behaviour is exactly R9's.
  assert.equal(askVerdict({ answer: 'She was stable [S1].', answerable: true }, ['S1']).ok, true);
  assert.equal(askVerdict(parsed, ['S1']).ok, false, 'an X id resolves against nothing by default');
  // A mixed answer must have EVERY id resolve — one bad id is enough.
  assert.equal(askVerdict({ answer: 'A [S1] and B [X9].', answerable: true }, ['S1'], ['X2']).ok, false);
  assert.equal(askVerdict({ answer: 'A [S1] and B [X2].', answerable: true }, ['S1'], ['X2']).ok, true);
});

test('isRecordId / parseFetchRecordArgs: only X-plus-digits, and junk arguments are REFUSED rather than guessed', () => {
  assert.equal(isRecordId('X1'), true);
  assert.equal(isRecordId('X1234'), true);
  assert.equal(isRecordId('X'), false);
  assert.equal(isRecordId('S1'), false);
  assert.equal(isRecordId('X12345'), false);
  assert.equal(parseFetchRecordArgs('{"id":"X3"}'), 'X3');
  assert.equal(parseFetchRecordArgs('{"id":"  X3  "}'), 'X3');
  assert.equal(parseFetchRecordArgs('{"id":"S3"}'), null, 'a ledger id is not a record id');
  assert.equal(parseFetchRecordArgs('not json'), null);
  assert.equal(parseFetchRecordArgs('{}'), null);
  assert.equal(parseFetchRecordArgs(null), null);
});

test('the loop cap is ONE number shared by the prompt and the code, and exhaustion is an honest sentence rather than an error (acceptance #5)', () => {
  // The prompt states the cap by interpolating the same constant the loop enforces.
  const prompts = code('lib/readmission-prompts.ts');
  assert.match(prompts, /import \{ RECORD_FETCH_MAX \} from '\.\/readmission-ask-core'/);
  assert.match(prompts, /at most \$\{RECORD_FETCH_MAX\} records per question/);
  // The loop enforces it, and offers tools only while a fetch AND the time for one both remain.
  const ask = code('lib/readmission/ask.ts');
  assert.match(ask, /const offerTools = fetches < RECORD_FETCH_MAX && spent \+ ASK_TOOL_CALL_BUDGET_MS <= ASK_TOOL_TOTAL_BUDGET_MS;/);
  assert.match(ask, /if \(fetches >= RECORD_FETCH_MAX\)/);
  assert.ok(ASK_TOOL_CALL_BUDGET_MS * (RECORD_FETCH_MAX + 1) > ASK_TOOL_TOTAL_BUDGET_MS,
    'the wall must be able to bite before the cap does — otherwise it is decoration');
  // The exhaustion message tells the model to answer and to SAY it stopped. It is not an error.
  const copy = loopExhaustedCopy(5);
  assert.match(copy, /Answer now from those/);
  assert.match(copy, /say plainly that you stopped after 5/);
  assert.ok(!/error|failed/i.test(copy));
  // An id outside the index is refused in the tool's own channel, with the rule restated.
  assert.match(unknownRecordCopy('X99'), /No record with id X99 is in this patient's index/);
  assert.match(unknownRecordCopy('X99'), /do not answer from an id you were not given/);
});

test('the retrieved chip says where the evidence came from, in plain clinical English, with no system vocabulary', () => {
  const chip = retrievedChipLabel({ kind: 'ip_stay', date: '2026-05-02' });
  assert.equal(chip, "from the patient's record · earlier hospital stay · 2026-05-02");
  assert.equal(retrievedChipLabel({ kind: 'cm_interaction', date: null }), "from the patient's record · care-manager call");
  for (const k of RECORD_KINDS) {
    const c = retrievedChipLabel({ kind: k, date: null });
    assert.ok(!/ip_stay|opd_note|cm_interaction|member_state|dedup|engine|lane/.test(c), `system vocabulary leaked: ${c}`);
  }
});

// ══ R10-D9 · the Converse tool mapping, both directions ═════════════════════════════════════

test('toConverseInput: NO toolConfig and NO block change when the caller declares none — the byte-identity every existing Bedrock call site depends on', () => {
  const before = toConverseInput({ messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], temperature: 0.1, max_tokens: 1500 }, 'global.anthropic.claude-opus-4-6-v1');
  assert.deepEqual(before, {
    modelId: 'global.anthropic.claude-opus-4-6-v1',
    system: [{ text: 'sys' }],
    messages: [{ role: 'user', content: [{ text: 'hi' }] }],
    inferenceConfig: { maxTokens: 4096, temperature: 0.1 },
  });
  assert.ok(!('toolConfig' in before));
  // An EMPTY tools array is also no toolConfig — Converse rejects one, and a deployment with nothing
  // to offer must degrade to a plain answer, not to a 400.
  const empty = toConverseInput({ messages: [{ role: 'user', content: 'hi' }], toolConfig: { tools: [] } }, 'global.anthropic.claude-opus-4-6-v1');
  assert.ok(!('toolConfig' in empty));
});

test('toConverseInput: contentBlocks are used VERBATIM, merge losslessly with a same-role neighbour, and a declared tool reaches the wire', () => {
  const toolConfig = { tools: [{ toolSpec: { name: FETCH_RECORD_TOOL_NAME, description: 'd', inputSchema: { json: FETCH_RECORD_INPUT_SCHEMA } } }] };
  const input = toConverseInput({
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'question' },
      { role: 'assistant', contentBlocks: [{ toolUse: { toolUseId: 't1', name: 'fetch_record', input: { id: 'X1' } } }] },
      { role: 'user', contentBlocks: [{ toolResult: { toolUseId: 't1', content: [{ text: 'the record' }], status: 'success' } }] },
      { role: 'user', content: 'and also this' },
    ],
    toolConfig,
  }, 'global.anthropic.claude-opus-4-6-v1');
  assert.deepEqual(input.toolConfig, toolConfig);
  assert.deepEqual(input.messages[1].content, [{ toolUse: { toolUseId: 't1', name: 'fetch_record', input: { id: 'X1' } } }]);
  // The two consecutive user turns MERGED rather than being sent as two (Converse rejects two) —
  // and the merge is by concatenation, so the toolResult block is not lost to a text round-trip.
  assert.equal(input.messages.length, 3);
  assert.deepEqual(input.messages[2].content, [
    { toolResult: { toolUseId: 't1', content: [{ text: 'the record' }], status: 'success' } },
    { text: 'and also this' },
  ]);
});

test('fromConverseOutput: a toolUse turn maps to OpenAI tool_calls (so an EMPTY content is not judged a provider defect), carries the raw blocks for the echo, and a plain turn is unchanged', () => {
  const withTool = fromConverseOutput({
    output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'fetch_record', input: { id: 'X2' } } }] } },
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 4 },
  }, 'global.anthropic.claude-opus-4-6-v1');
  assert.equal(withTool.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(toolCallsOf(withTool), [{ id: 't1', type: 'function', function: { name: 'fetch_record', arguments: '{"id":"X2"}' } }]);
  assert.equal(withTool.choices[0].message.content, '', 'a tool turn legitimately carries no prose');
  assert.equal(withTool.converseContent?.length, 1, 'the raw block is carried so the loop can echo it');
  // A plain text turn is EXACTLY what it was before R10-B: no tool_calls key, no converseContent.
  const plain = fromConverseOutput({ output: { message: { content: [{ text: 'the answer' }] } }, stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2 } }, 'global.anthropic.claude-opus-4-6-v1');
  assert.deepEqual(toolCallsOf(plain), []);
  assert.ok(!('tool_calls' in plain.choices[0].message));
  assert.ok(!('converseContent' in plain));
  assert.equal(plain.choices[0].message.content, 'the answer');
  assert.equal(plain.choices[0].finish_reason, 'stop');
});

// ══ R10-D12 · the advisory, and R10-D11 · the pins ══════════════════════════════════════════

test('R10-D12 — the advisory says all four things: it answers from the case, it can FETCH other records, retrieved evidence is labelled and cited, and nothing changes incidence', () => {
  assert.equal(ASK_ADVISORY, "Advisory — the agent answers from this case's evidence and can fetch this patient's other records into the conversation; retrieved evidence is labelled and cited; your stated judgement is saved as clinical review; nothing here changes incidence.");
  const page = code('components/care/ReadmissionCasePage.tsx');
  assert.match(page, /\{ASK_ADVISORY\}/, 'the surface renders the constant, never a copy of it');
});

test('R10-D11 — the pins: engine version unchanged, the rates files untouched, detect-core untouched, no dependency change, and the model pin / F11 still hold', () => {
  assert.equal(READMIT_ENGINE_VERSION, 'readmission/0.2');
  const changed = execFileSync('git', ['diff', '--name-only', '335e7a6', '--'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  // Acceptance #6 is BYTE-IDENTITY of the rates outputs, and the only way to promise that without a
  // live DB is to prove the files that compute them were not touched at all.
  for (const f of ['lib/readmission-rates-core.ts', 'lib/readmission/rates.ts', 'lib/readmission-detect-core.ts', 'package.json']) {
    assert.ok(!changed.includes(f), `${f} must not change in R10`);
  }
  // The Ask path still targets the one Opus id with no ladder behind it (T7 / F11 carried over).
  // Count CALL SITES, not mentions: `}, {` is the tracedChat options argument and appears nowhere in
  // the prose, which legitimately quotes the options object it is describing.
  const ask = code('lib/readmission/ask.ts');
  assert.equal((ask.match(/\}, \{ bedrock: NARRATIVE_MODEL_ID/g) ?? []).length, 2, 'both call paths, one target');
  // The no-reach path keeps R9's options object BYTE FOR BYTE — that is what "a deployment with no
  // reachable record behaves exactly as it did before R10" means in code.
  assert.match(ask, /\}, \{ bedrock: NARRATIVE_MODEL_ID, timeoutMs: ASK_BUDGET_MS, maxTries: ASK_MAX_TRIES \}\);/);
  assert.ok(!/gemini|openrouter|noLocalFallback: false/.test(ask), 'F11: an explicit Bedrock target has no ladder');
  assert.ok(!/global\.anthropic\.claude/.test(body('lib/readmission/ask.ts')), 'the pin is the constant, never a literal');
});

test('the recon prompt fingerprints did NOT move — the R4.1 refresh probe that was armed before R10 is still armed after it', () => {
  // Measured on 335e7a6 (the branch point) and pinned here. The DOT source label was added to
  // `sourceLabel`, whose new case the FIXTURE catalog never exercises, so the four recon builders and
  // the narrative builder emit byte-identical text for it. That is what keeps V from having to
  // re-probe before the R10-D3 refresh can run.
  assert.equal(reconPromptFingerprints(), '59fe9addffa993dc.22170f09ffd188c1.88b7fc2dd3d06b4b.8eb4054a9a6810f9.dad75db58c605cb4');
});

test('the reference DDL and the migrate route agree, and the artefact store has BOTH unique keys R10-D7 needs', () => {
  const ddl = code('migrations/0048_readmission_retrieved_artefacts.sql');
  const route = code('app/api/admin/migrate-readmission-records/route.ts');
  for (const col of ['dedup_key', 'engine_version', 'artefact_id', 'source_key', 'kind', 'artefact_date', 'label', 'content', 'actor', 'turn_id']) {
    assert.match(ddl, new RegExp(`\\b${col}\\b`), `${col} in the reference DDL`);
    assert.match(route, new RegExp(`\\b${col}\\b`), `${col} in the migrate route`);
  }
  for (const idx of ['readmission_retrieved_artefacts_id_idx', 'readmission_retrieved_artefacts_source_idx']) {
    assert.match(ddl, new RegExp(idx));
    assert.match(route, new RegExp(idx));
  }
  // First fetch wins: the insert can only ever DO NOTHING on a conflict, never overwrite.
  const store = code('lib/readmission/ask-store.ts');
  assert.match(store, /ON CONFLICT DO NOTHING/);
  assert.ok(!/readmission_retrieved_artefacts[\s\S]{0,400}DO UPDATE/.test(store), 'a stored artefact is never rewritten');
});

test('the backfill route offers exactly three actions and REFUSES anything else, and the refresh is gated rather than fused to the extraction', () => {
  const route = code('app/api/admin/readmission-reextract/route.ts');
  for (const a of ['extract', 'scan', 'refresh']) assert.match(route, new RegExp(`'${a}'`));
  assert.match(route, /unknown action/);
  const lib = code('lib/readmission/reextract.ts');
  // The refresh honours the R4.1 probe gate and bedrock reachability rather than re-implementing them.
  assert.match(lib, /refreshRunUnlocked\(\)/);
  assert.match(lib, /probeReachable\('bedrock'\)/);
  // It reuses the existing in-place refresh path; it does not write findings itself.
  assert.match(lib, /reanalyzeOnOpus\(row, \{ save: true/);
  assert.ok(!/UPDATE readmission_findings/.test(lib), 'the backfill never writes a finding itself');
  // And it reports the R8.1 snapshot ids R10-D3 asks for by name.
  assert.match(lib, /listVersionsForCase/);
  assert.match(lib, /snapshotId/);
});

test('a long thread cannot grow its own prompt without bound: only the most recent held artefacts are reprinted, the omission is STATED, and every held id stays citable', () => {
  // The hazard: 200 stored artefacts × 6,000 chars re-injected on every later turn is a conversation
  // that gets silently worse the longer it runs, and then fails outright.
  assert.ok(RECORD_HELD_IN_PROMPT_MAX * RECORD_ARTEFACT_MAX_CHARS < 60_000, 'the reprint must stay bounded');
  const ask = code('lib/readmission/ask.ts');
  assert.match(ask, /const shown = held\.slice\(-RECORD_HELD_IN_PROMPT_MAX\);/);
  // Citation resolution reads the WHOLE held set, not the reprinted slice — an answer that refers
  // back to an artefact fetched ten turns ago is still a valid citation.
  assert.match(ask, /const recordIds = \[\.\.\.held\.map\(\(r\) => r\.id\), \.\.\.fetched\.map\(\(r\) => r\.id\)\];/);
  // And the cut is said out loud, so the model never reads it as "those records are gone".
  const prompts = code('lib/readmission-prompts.ts');
  assert.match(prompts, /are not reprinted above/);
  assert.match(prompts, /you may still cite them by their X id/);
});
