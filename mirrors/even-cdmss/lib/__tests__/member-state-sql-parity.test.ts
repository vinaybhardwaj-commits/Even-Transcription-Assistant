import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __sqlForTest, individualForPrescSql, individualUidForPresc } from '../member-state/member-state';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SHADOW = readFileSync(resolve(REPO, 'scripts/member-state-shadow.mjs'), 'utf8');
const UID = 'ABC123def456';   // valid isUid
const asTemplate = (s: string) => s.split(UID).join('${uid}');   // re-express the interpolated uid as the template

// SQL-parity guard: the wired member-state.ts SQL must stay BYTE-IDENTICAL to the FROZEN
// scripts/member-state-shadow.mjs (so the app renders the same snapshot the freeze gate validated).
test('prescriptionsSql is byte-identical to shadow.mjs (drift fails CI)', () => {
  const body = asTemplate(__sqlForTest.prescriptionsSql(UID));
  assert.ok(SHADOW.includes(body), 'prescriptionsSql drifted from scripts/member-state-shadow.mjs');
  assert.match(body, /FROM "individuals-prescriptions"/);
  assert.match(body, /to_jsonb\(medications\) AS medications/);
});

test('labsSql is byte-identical to shadow.mjs (drift fails CI)', () => {
  const body = asTemplate(__sqlForTest.labsSql(UID));
  assert.ok(SHADOW.includes(body), 'labsSql drifted from scripts/member-state-shadow.mjs');
  assert.match(body, /JOIN test_digital_values_view d/);
});

test('individualForPrescSql: pinned shape + injection guard (bad uid throws)', () => {
  assert.equal(individualForPrescSql(UID), `SELECT _parent_id AS individual_uid FROM "individuals-prescriptions" WHERE uid = '${UID}' LIMIT 1`);
  for (const bad of [`x'; DROP TABLE y; --`, 'a b', "'", 'short', '']) assert.throws(() => individualForPrescSql(bad), /bad presc uid/);
});

test('individualUidForPresc: a bad uid returns null WITHOUT touching the DB', async () => {
  assert.equal(await individualUidForPresc(`x' OR '1'='1`), null);
  assert.equal(await individualUidForPresc(''), null);
});
