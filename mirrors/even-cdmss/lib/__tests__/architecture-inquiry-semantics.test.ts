// Inquiry K1 — architecture-suite semantics tests (PRD §15, +2), following the ratified
// source-level pattern (architecture-advisory-no-band-visuals.test.ts):
//   #1 inquiry output never carries scored-band language — the advisory lane must be
//      unrepresentable as a scored surface, in prompt text, skeleton questions and source refs.
//   #2 scored cores do not import lib/inquiry — the reverse direction of check rule 5, pinned
//      here so a valueOnly-evading regression (e.g. a type import turned value) is still caught
//      at the source line level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INQUIRY_SELECT_SYSTEM, candidatesFromUnknowns } from '../inquiry/inquiry-core';
import type { UnknownItem } from '../inquiry/unknowns-core';
import type { DeidOpdCase } from '../opd-ingest-core';

const ROOT = process.cwd();
const BAND_LANGUAGE = /\b(band [A-E]|scoreColor|bandColor|score band|graded [A-E]|0–100 grade)\b/i;

test('semantics: inquiry output never carries scored-band language', () => {
  assert.equal(BAND_LANGUAGE.test(INQUIRY_SELECT_SYSTEM), false, 'prompt is band-free');
  const episode: DeidOpdCase = {
    consultType: null, reasonForConsult: null, presentingComplaints: ['cough'], diagnosisCodes: [], impressionCodes: [],
    impressions: [], history: [], comorbidities: [], medications: [{ generic: 'Metformin' }], investigations: [],
    advice: ['Repeat HbA1c after 3 months'], examination: [], allergies: null, followUpType: null, followUpDateSet: false,
  };
  const unknowns: UnknownItem[] = [{
    id: 'unk-care_gap:hba1c', kind: 'care_gap', subject: 'HbA1c', detail: 'abnormal (9.1) % — not rechecked in 8mo',
    criticality: 'review', sourceRefs: ['hba1c'], stateRef: { kind: 'member', version: 'member-state/1.1', computedAt: null },
  }];
  for (const c of candidatesFromUnknowns(unknowns, episode, { presc_uid: 'p1234567', individual_uid: 'i1234567' })) {
    assert.equal(BAND_LANGUAGE.test(c.question), false, `${c.id} question is band-free`);
    assert.equal(BAND_LANGUAGE.test(c.why), false, `${c.id} why is band-free`);
  }
  // source-level: nothing in lib/inquiry references the scored-band palette or the score core
  for (const f of readdirSync(join(ROOT, 'lib/inquiry')).filter((x) => x.endsWith('.ts'))) {
    const src = readFileSync(join(ROOT, 'lib/inquiry', f), 'utf8');
    assert.equal(/bandColor|scoreColor|opd-audit-ui/.test(src), false, `lib/inquiry/${f} has no scored-band reference`);
  }
});

test('semantics: scored cores do not import lib/inquiry (rule 5 reverse direction, source-pinned)', () => {
  const SCORED = ['lib/opd-note-audit-core.ts', 'lib/opd-note-score-core.ts', 'lib/doc-audit-core.ts', 'lib/formulary-match-core.ts'];
  for (const f of SCORED) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      if (/^\s*(import|export)\b.*from\s*['"][^'"]*inquiry[^'"]*['"]/.test(line) || /require\(\s*['"][^'"]*inquiry/.test(line)) {
        assert.fail(`${f}:${i + 1} imports lib/inquiry — scored cores must never depend on the advisory lane`);
      }
    }
  }
});
