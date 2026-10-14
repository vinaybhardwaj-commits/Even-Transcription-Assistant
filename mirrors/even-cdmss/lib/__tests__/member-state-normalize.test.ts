import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConcept, groupingKey, normalizeRaw } from '../member-state/normalize-core';

test('normalizeConcept: exact hit → relation exact + canonical id', () => {
  const c = normalizeConcept('Hypertension', 'problem');
  assert.equal(c.normalizedConceptId, 'local:hypertension');
  assert.equal(c.relation, 'exact');
  assert.equal(c.normalizerVersion, 'member-norm/0.1');
});

test('normalizeConcept: synonym hit → relation synonym, same canonical id', () => {
  assert.equal(normalizeConcept('HTN', 'problem').normalizedConceptId, 'local:hypertension');
  assert.equal(normalizeConcept('HTN', 'problem').relation, 'synonym');
  assert.equal(normalizeConcept('DM', 'problem').normalizedConceptId, 'local:diabetes-mellitus');
});

test('normalizeConcept: no dictionary hit → unresolved (null id), never a guess', () => {
  const c = normalizeConcept('Some Rare Thing', 'problem');
  assert.equal(c.normalizedConceptId, null);
  assert.equal(c.relation, 'unresolved');
});

test('normalizeConcept: broader/narrower are NEVER merged (diabetes ≠ type-2-diabetes)', () => {
  assert.equal(normalizeConcept('diabetes', 'problem').normalizedConceptId, 'local:diabetes-mellitus');
  assert.equal(normalizeConcept('type 2 diabetes', 'problem').normalizedConceptId, 'local:type-2-diabetes');
  assert.notEqual(
    normalizeConcept('diabetes', 'problem').normalizedConceptId,
    normalizeConcept('type 2 diabetes', 'problem').normalizedConceptId,
  );
});

test('normalizeConcept: domain-scoped dictionaries (creatinine only resolves as investigation)', () => {
  assert.equal(normalizeConcept('creatinine', 'investigation').normalizedConceptId, 'local:creatinine');
  assert.equal(normalizeConcept('creatinine', 'problem').normalizedConceptId, null);
});

test('normalizeConcept: deterministic — same input → identical result', () => {
  assert.deepEqual(normalizeConcept('Metformin', 'medication'), normalizeConcept('Metformin', 'medication'));
});

test('groupingKey: resolved → canonical id; two unresolved merge only on identical normalized raw', () => {
  assert.equal(groupingKey(normalizeConcept('HTN', 'problem')), 'local:hypertension');
  assert.equal(groupingKey(normalizeConcept('Foo Bar', 'problem')), 'unresolved:foo bar');
  assert.equal(
    groupingKey(normalizeConcept('Foo  Bar', 'problem')),   // whitespace-insensitive
    groupingKey(normalizeConcept('foo bar', 'problem')),
  );
  assert.notEqual(groupingKey(normalizeConcept('foo', 'problem')), groupingKey(normalizeConcept('bar', 'problem')));
});

test('normalizeRaw: lowercases, strips punctuation, collapses whitespace', () => {
  assert.equal(normalizeRaw('  Type-2   Diabetes! '), 'type 2 diabetes');
});
