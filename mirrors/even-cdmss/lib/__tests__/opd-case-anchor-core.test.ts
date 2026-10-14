import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorFindings, anchorsByTarget } from '../opd-case-anchor-core.ts';

const note = {
  medications: ['Nitrofurantoin', 'Paracetamol', 'Cranberry extract'],
  investigations: ['URINE CULTURE AND SENSITIVITY', 'CT KUB PLAIN'],
};

test('matches a low-value investigation to its line', () => {
  const [a] = anchorFindings([{ subject: 'CT KUB in uncomplicated UTI', domain: 'appropriateness', verdict: 'low-value' }], note);
  assert.equal(a.section, 'investigations');
  assert.equal(a.itemIndex, 1);
  assert.equal(a.num, 1);
});

test('matches a dosing finding to the specific medication line', () => {
  const [a] = anchorFindings([{ subject: 'Incomplete dosing — cranberry extract', domain: 'prescribing_safety' }], note);
  assert.equal(a.section, 'medications');
  assert.equal(a.itemIndex, 2);
});

test('prescribing finding prefers the med line on a tie', () => {
  const [a] = anchorFindings([{ subject: 'Nitrofurantoin in renal impairment', domain: 'prescribing_safety' }], note);
  assert.equal(a.section, 'medications');
  assert.equal(a.itemIndex, 0);
});

test('documentation finding falls back to keyword section', () => {
  const [a] = anchorFindings([{ subject: 'No examination recorded', domain: 'documentation' }], note);
  assert.equal(a.section, 'examination');
});

test('follow-up keyword routes to followup section', () => {
  const [a] = anchorFindings([{ subject: 'Follow-up advised but no date set', domain: 'patient_centred' }], note);
  assert.equal(a.section, 'followup');
});

test('unmatched appropriateness finding falls back to investigations section', () => {
  const [a] = anchorFindings([{ subject: 'Broad empirical workup', domain: 'appropriateness' }], note);
  assert.equal(a.section, 'investigations');
  assert.equal(a.itemIndex, undefined);
});

test('appropriateness fallback goes to diagnosis when no investigations exist', () => {
  const [a] = anchorFindings([{ subject: 'Broad empirical workup', domain: 'appropriateness' }], { medications: [], investigations: [] });
  assert.equal(a.section, 'diagnosis');
});

test('note_quality findings anchor to the whole note', () => {
  const [a] = anchorFindings([{ subject: 'Fragmented narrative', domain: 'note_quality' }], note);
  assert.equal(a.section, 'note');
});

test('numbers follow findings order and grouping keys are stable', () => {
  const anchors = anchorFindings([
    { subject: 'CT KUB in uncomplicated UTI', domain: 'appropriateness' },
    { subject: 'Incomplete dosing — cranberry extract', domain: 'prescribing_safety' },
    { subject: 'No examination recorded', domain: 'documentation' },
  ], note);
  assert.deepEqual(anchors.map((a) => a.num), [1, 2, 3]);
  const grouped = anchorsByTarget(anchors);
  assert.equal(grouped['investigations:1'][0].num, 1);
  assert.equal(grouped['medications:2'][0].num, 2);
  assert.equal(grouped['examination'][0].num, 3);
});

test('stopwords alone never force a spurious med match', () => {
  const [a] = anchorFindings([{ subject: 'Dosing incomplete for the combination', domain: 'prescribing_safety' }], note);
  assert.equal(a.section, 'medications');
  assert.equal(a.itemIndex, undefined); // falls to section, not a random line
});
