/**
 *   node --test --import tsx lib/__tests__/preop-extract-core.test.ts
 *
 * B5 — the extraction rail's four gates, and the one property the whole rail exists to
 * keep: a model may fill an input the record left UNKNOWN, and it may do nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  aboveFloor, buildExtraction, buildExtractPrompt, extractionObservations,
  extractionSourceFingerprint, hasExtractableText, parseExtractOutput, reconcileExtraction,
  targetLabel, verifyExtraction,
  EXTRACT_SOURCE_FIELDS, EXTRACT_TARGETS, EXTRACT_TARGET_IDS, NEVER_EXTRACTABLE,
  PREOP_EXTRACT_RULE_VERSION,
  type ExtractProposal, type PreopExtraction,
} from '../preop-extract-core.ts';
import { EXTRACT_CONFIDENCE_FLOOR, resolveInputs, type Observation } from '../preop-assemble-core.ts';

const src = (p: string) => readFileSync(p, 'utf8');

const FIELDS: Record<string, string> = {
  pac_other_history: 'K/C/O DM on insulin since 12 years. No history of stroke. Old MI 2019, on aspirin.',
  pac_examination: 'Conscious, oriented. Not ambulating since 15 days, needs help to sit up.',
};

const p = (o: Partial<ExtractProposal>): ExtractProposal => ({
  input: 'insulin_treated_diabetes', status: 'present', field: 'pac_other_history',
  rawText: 'DM on insulin since 12 years', confidence: 0.9, note: null, ...o,
});

// ── gate 1 · the target whitelist ───────────────────────────────────────────────

test('the three inputs a model may never propose are refused BY NAME, not by absence', () => {
  for (const id of ['age', 'high_risk_surgery', 'creatinine_over_2']) {
    assert.ok(NEVER_EXTRACTABLE.has(id as never), `${id} must be on the never-extractable list`);
    assert.ok(!EXTRACT_TARGET_IDS.has(id), `${id} must not be an extraction target`);
    const r = verifyExtraction([p({ input: id, rawText: 'Conscious, oriented', field: 'pac_examination' })], FIELDS);
    assert.equal(r.accepted.length, 0);
    assert.equal(r.rejected[0].reason, 'never_extractable');
  }
});

test('an unknown input is rejected BEFORE its span is looked for', () => {
  // The span below genuinely occurs in the field. A rail that verified first and
  // whitelisted second would accept a hallucinated id backed by real text.
  const r = verifyExtraction([p({ input: 'pregnancy', rawText: 'Conscious, oriented', field: 'pac_examination' })], FIELDS);
  assert.equal(r.rejected[0].reason, 'unknown_input');
});

test('every target carries a definition the model can act on, and a label the card uses', () => {
  for (const t of EXTRACT_TARGETS) {
    assert.ok(t.definition.length > 20, `${t.id} needs a real definition`);
    assert.equal(targetLabel(t.id), t.label);
  }
});

// ── gate 2 · span verification (the anti-fabrication gate) ──────────────────────

test('a span that does not occur verbatim in the named field is REJECTED, never kept', () => {
  const r = verifyExtraction([p({ rawText: 'diabetic on insulin therapy' })], FIELDS);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0].reason, 'span_not_found');
});

test('a span from a field that was never sent is rejected', () => {
  const r = verifyExtraction([p({ field: 'pac_cvs_note' })], FIELDS);
  assert.equal(r.rejected[0].reason, 'unknown_field');
});

test('a verbatim span is accepted and carries its field, status and confidence', () => {
  const r = verifyExtraction([p({})], FIELDS);
  assert.equal(r.accepted.length, 1);
  assert.deepEqual(
    { id: r.accepted[0].inputId, st: r.accepted[0].status, f: r.accepted[0].field, c: r.accepted[0].confidence },
    { id: 'insulin_treated_diabetes', st: 'present', f: 'pac_other_history', c: 0.9 },
  );
});

test('a second proposal for the same input is dropped — one reading per input', () => {
  const r = verifyExtraction([p({}), p({ status: 'absent', rawText: 'No history of stroke' })], FIELDS);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected[0].reason, 'duplicate');
});

test('accepted readings are sorted, so two runs over the same text are byte-identical', () => {
  const a = verifyExtraction([p({}), p({ input: 'cerebrovascular_disease', status: 'absent', rawText: 'No history of stroke' })], FIELDS);
  const b = verifyExtraction([p({ input: 'cerebrovascular_disease', status: 'absent', rawText: 'No history of stroke' }), p({})], FIELDS);
  assert.deepEqual(a.accepted, b.accepted);
});

// ── polarity: MARKED, never removed ─────────────────────────────────────────────

test('a negated span asserting presence is MARKED and KEPT — the ClinicalState ruling, carried', () => {
  const r = verifyExtraction([p({ input: 'cerebrovascular_disease', status: 'present', rawText: 'history of stroke' })], FIELDS);
  assert.equal(r.accepted.length, 1, 'the finding survives — a false deletion cost a diagnosis once');
  assert.equal(r.accepted[0].polaritySuspect, true);
  assert.equal(r.polarityMarked.length, 1);
});

test('an "absent" status is never polarity-marked — its status already carries the negation', () => {
  const r = verifyExtraction([p({ input: 'cerebrovascular_disease', status: 'absent', rawText: 'No history of stroke' })], FIELDS);
  assert.equal(r.accepted[0].polaritySuspect, undefined);
});

// ── gate 3 · the confidence floor is the ASSEMBLER's, not a second one ──────────

test('a low-confidence reading is accepted here and DROPPED by the assembler — one floor, not two', () => {
  const rec = buildExtraction({
    fields: FIELDS,
    verified: verifyExtraction([p({ confidence: 0.4 })], FIELDS),
    extractedAt: '2026-08-27T04:00:00Z', model: 'gemini-2.5-pro', provider: 'vertex', traceId: 't1',
  });
  assert.equal(rec.inputs.length, 1, 'the reading is stored — the rail is honest about what it proposed');
  assert.equal(aboveFloor(rec), 0);
  const resolved = resolveInputs(extractionObservations(rec), { includeExtracted: true, bookingEnumerated: false });
  assert.equal(resolved.insulin_treated_diabetes.status, 'unknown', 'below the floor the instrument widens');
  assert.equal(resolved.insulin_treated_diabetes.droppedBelowFloor.length, 1, 'and the drop is shown, not silent');
  assert.ok(EXTRACT_CONFIDENCE_FLOOR === 0.8);
});

// ── gate 4 · anti-flap ──────────────────────────────────────────────────────────

const rec = (over: Partial<PreopExtraction> = {}, fields = FIELDS): PreopExtraction => ({
  ...buildExtraction({
    fields,
    verified: verifyExtraction([p({})], fields),
    extractedAt: '2026-08-27T04:00:00Z', model: 'gemini-2.5-pro', provider: 'vertex', traceId: 't1',
  }),
  ...over,
});

test('the fingerprint is of the TEXT — not the episode, not the clock, not the model', () => {
  const a = extractionSourceFingerprint(FIELDS);
  assert.equal(a, extractionSourceFingerprint({ ...FIELDS }));
  assert.equal(a, extractionSourceFingerprint({ pac_examination: FIELDS.pac_examination, pac_other_history: FIELDS.pac_other_history }));
  assert.notEqual(a, extractionSourceFingerprint({ ...FIELDS, pac_other_history: `${FIELDS.pac_other_history} Also hypertensive.` }));
});

test('a field the rail does not read cannot change the fingerprint', () => {
  assert.equal(
    extractionSourceFingerprint(FIELDS),
    extractionSourceFingerprint({ ...FIELDS, pac_conclusion: 'PATIENT CAN BE TAKEN FOR SURGERY' }),
  );
});

test('unchanged text + the same reading = stable, and nothing about the reading moves', () => {
  const stored = rec();
  const r = reconcileExtraction(stored, rec());
  assert.equal(r.outcome, 'stable');
  assert.deepEqual(r.moved, []);
  assert.deepEqual(r.record.inputs, stored.inputs);
  assert.equal(r.record.reextractions, 1);
});

test('unchanged text + a DIFFERENT reading: the stored reading stands and the input goes unstable', () => {
  const stored = rec();
  const moved = rec({
    inputs: [{ inputId: 'insulin_treated_diabetes', status: 'absent', field: 'pac_other_history', rawText: 'DM on insulin since 12 years', confidence: 0.9, note: null }],
  });
  const r = reconcileExtraction(stored, moved);
  assert.equal(r.outcome, 'unstable');
  assert.deepEqual(r.moved, ['insulin_treated_diabetes']);
  assert.equal(r.record.inputs[0].status, 'present', 'the STORED reading stands — the model does not get to move a score by disagreeing with itself');
  assert.deepEqual(r.record.unstable, ['insulin_treated_diabetes']);
});

test('an unstable input still scores, and says so — flagging is not retraction', () => {
  const r = reconcileExtraction(rec(), rec({ inputs: [] }));
  const obs = extractionObservations(r.record);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].unstable, true);
  assert.equal(obs[0].status, 'present');
});

test('changed source text is a real ripening: the fresh reading replaces the stored one', () => {
  const stored = rec();
  const fields2 = { ...FIELDS, pac_other_history: `${FIELDS.pac_other_history} Also COPD.` };
  const fresh = rec({}, fields2);
  const r = reconcileExtraction(stored, fresh);
  assert.equal(r.outcome, 'resource_changed');
  assert.equal(r.record.sourceFingerprint, extractionSourceFingerprint(fields2));
});

test('no stored record at all is the first reading', () => {
  assert.equal(reconcileExtraction(null, rec()).outcome, 'first');
});

// ── the observations ────────────────────────────────────────────────────────────

test('the verbatim span rides OUTSIDE the detail, so a re-worded quotation mints no version', () => {
  const a = extractionObservations(rec())[0];
  const b = extractionObservations(rec({
    inputs: [{ inputId: 'insulin_treated_diabetes', status: 'present', field: 'pac_other_history', rawText: 'on insulin since 12 years', confidence: 0.9, note: null }],
  }))[0];
  assert.equal(a.detail, b.detail, 'detail is in the fingerprint and must not move with the wording');
  assert.notEqual(a.sourceSpan, b.sourceSpan, 'the span is what the reader sees, and it did move');
});

test('the model label is DERIVED — a record with no served model carries none', () => {
  assert.equal(extractionObservations(rec())[0].extractedBy, 'vertex:gemini-2.5-pro');
  assert.equal(extractionObservations(rec({ model: null, provider: null }))[0].extractedBy, null);
});

// ── the prompt ──────────────────────────────────────────────────────────────────

test('the prompt shows every target and only the fields that actually have text', () => {
  const { user } = buildExtractPrompt({ ...FIELDS, pac_cvs_note: '   ', pac_conclusion: 'ignored' });
  for (const t of EXTRACT_TARGETS) assert.ok(user.includes(t.id), `${t.id} missing from the prompt`);
  assert.ok(user.includes('### pac_other_history'));
  assert.ok(!user.includes('### pac_cvs_note'), 'a blank field is not shown');
  assert.ok(!user.includes('### pac_conclusion'), 'a field outside the rail is never shown');
});

test('parse survives a fenced reply and clamps confidence into 0..1', () => {
  const out = parseExtractOutput('```json\n{"inputs":[{"input":"dementia","status":"present","field":"pac_examination","rawText":"x","confidence":7}]}\n```');
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 1);
});

test('no extractable text means the rail never runs', () => {
  assert.equal(hasExtractableText({}), false);
  assert.equal(hasExtractableText({ pac_other_history: '   ' }), false);
  assert.equal(hasExtractableText(FIELDS), true);
});

// ── structural pins ─────────────────────────────────────────────────────────────

test('every source field the rail reads is a VERBATIM field on the PAC map — the D4 line', () => {
  const map = src('lib/preop-pac-map-core.ts');
  for (const f of EXTRACT_SOURCE_FIELDS) {
    if (f.id === 'opd_narrative') continue;
    const spec = new RegExp(`id: '${f.id}'[\\s\\S]{0,260}?read: '(\\w+)'`).exec(map);
    assert.ok(spec, `${f.id} is not a field on the PAC map`);
    assert.equal(spec![1], 'verbatim', `${f.id} is read deterministically — the rail must not re-read it`);
  }
});

test('the rail carries no model id of its own — the label comes off the call', () => {
  // B8b moved the impure half from lib/preop/extract.ts to lib/preop/suggest.ts when the
  // rail was demoted from assertor to suggester. The three properties pinned here did not
  // change, which is the point of pinning them.
  const s = src('lib/preop/suggest.ts');
  assert.ok(s.includes('servedCallForAudit'), 'the served model must be read back');
  assert.ok(s.includes('noLocalFallback: true'), 'a cloud failure must not become a silent local extraction');
  assert.ok(!/model:\s*'gemini/.test(s), 'no typed model label anywhere in the rail');
});

test('the rule version is pinned — a change to the gates is a change to the version', () => {
  assert.equal(PREOP_EXTRACT_RULE_VERSION, 'preop-extract/1');
});
