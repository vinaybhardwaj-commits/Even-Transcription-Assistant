// lib/__tests__/icd-master.test.ts — ICD Master Slice 1: the snapshot artifact + the layered
// resolver. Run: npm test. The PRD's gate checks live here so they re-prove on every CI run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICD_MASTER, ICD_META, ICD_MASTER_VERSION } from '../member-state/icd-master.generated';
import { ICD_LABEL_OVERRIDES, resolveProblemLabel, normalizeIcd } from '../member-state/icd-labels';

test('the artifact is the full master: version, size, key shape', () => {
  assert.equal(ICD_MASTER_VERSION, 'icd-master/1.0');
  const n = Object.keys(ICD_MASTER).length;
  assert.ok(n >= 98_000, `expected the ~98k master, got ${n}`);
  assert.equal(Object.keys(ICD_META).length, n, 'META must cover exactly the MASTER keys');
  for (const k of ['E11', 'E11.9', 'G93.3', 'G47.00', 'M67.814']) {
    assert.ok(ICD_MASTER[k], `master missing ${k}`);
  }
  // every key is normalized (dotted, upper-case, trimmed) — sample the whole keyspace cheaply
  const keys = Object.keys(ICD_MASTER);
  for (let i = 0; i < keys.length; i += 997) {
    const k = keys[i];
    assert.equal(k, k.trim().toUpperCase(), `non-normalized key ${JSON.stringify(k)}`);
  }
});

test('PRD spot-checks resolve to real master labels', () => {
  const label = (raw: string) => resolveProblemLabel({ raw }).label;
  assert.equal(label('E11'), 'Type 2 diabetes mellitus');
  assert.equal(label('G93.3'), 'Postviral fatigue syndrome');
  assert.equal(label('G47.00'), 'Insomnia, unspecified');
  assert.match(label('M67.814'), /tendon.*left shoulder|left shoulder.*tendon/i);
  for (const c of ['E11', 'G93.3', 'G47.00', 'M67.814']) {
    assert.equal(resolveProblemLabel({ raw: c }).unmapped, false);
  }
});

test('override precedence: a code in both layers renders the curated phrasing', () => {
  assert.ok(ICD_LABEL_OVERRIDES['E78.5'], 'E78.5 must stay in the curated overrides');
  assert.ok(ICD_MASTER['E78.5'], 'E78.5 must also exist in the master');
  assert.notEqual(ICD_LABEL_OVERRIDES['E78.5'], ICD_MASTER['E78.5'],
    'the two layers word E78.5 differently — otherwise this test proves nothing');
  assert.equal(resolveProblemLabel({ raw: 'E78.5' }).label, ICD_LABEL_OVERRIDES['E78.5']);
  // and normalization still applies before the layers
  assert.equal(resolveProblemLabel({ raw: '  e78.5 ' }).label, ICD_LABEL_OVERRIDES['E78.5']);
});

test('category fallback is EXACT-KEY only; junk still gets the neutral fallback', () => {
  // a dotted code absent from both layers whose 3-char category IS a master row → category label
  const dotted = Object.keys(ICD_MASTER).filter((k) => k.includes('.'));
  const orphan = dotted
    .map((k) => `${k.slice(0, k.indexOf('.'))}.Z9`)                    // synthesize a non-existent child
    .find((c) => !ICD_MASTER[c] && !ICD_LABEL_OVERRIDES[c] && ICD_MASTER[c.slice(0, 3)]);
  assert.ok(orphan, 'could not synthesize an orphan child code');
  const viaCat = resolveProblemLabel({ raw: orphan! });
  assert.equal(viaCat.label, ICD_MASTER[orphan!.slice(0, 3)], 'must use the exact category master row');
  assert.equal(viaCat.unmapped, false);
  // code-shaped but with NO exact key at either the code or its category → neutral, never a guess
  const cats = new Set(Object.keys(ICD_MASTER).map((k) => k.slice(0, 3)));
  let missingCat = '';
  outer: for (const L of 'ABCDEFGHIJKLMNPQRSTVWXYZ') {
    for (let i = 0; i < 100; i++) {
      const c = `${L}${String(i).padStart(2, '0')}`;
      if (!cats.has(c) && !ICD_LABEL_OVERRIDES[c]) { missingCat = c; break outer; }
    }
  }
  assert.ok(missingCat, 'the master somehow covers every possible 3-char category');
  const noParent = `${missingCat}.1`;
  assert.equal(resolveProblemLabel({ raw: noParent }).label, `${noParent} (unmapped ICD-10 code)`);
  assert.equal(resolveProblemLabel({ raw: noParent }).unmapped, true);
  // junk that isn't code-shaped at all → treated as display text / neutral, unchanged behaviour
  assert.equal(normalizeIcd('NOTACODE123'), '');
  assert.equal(resolveProblemLabel({ raw: 'ICD?? garbage' }).label, 'ICD?? garbage');
});

test('Decision-D order unchanged: source display text still wins over every bundled layer', () => {
  const r = resolveProblemLabel({ raw: 'Type 2 diabetes — poorly controlled', normalizedConceptId: 'E11.65' });
  assert.equal(r.label, 'Type 2 diabetes — poorly controlled');
  assert.equal(r.code, 'E11.65');
  assert.equal(r.unmapped, false);
});

test('slice-2 payload: META carries duration + high-risk in the ratified shape (not consumed yet)', () => {
  const [duration, highRisk] = ICD_META['E11'];
  assert.equal(duration, 'CHRONIC');
  assert.ok(highRisk === 0 || highRisk === 1);
  const durations = new Set(Object.values(ICD_META).map(([d]) => d));
  for (const d of durations) assert.ok(['ACUTE', 'SUB_ACUTE', 'CHRONIC'].includes(d), `unexpected duration ${d}`);
  const chronic = Object.values(ICD_META).filter(([d]) => d === 'CHRONIC').length;
  assert.ok(chronic >= 16_000, `expected ~16.3k CHRONIC codes, got ${chronic}`);
});
