import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectClinicianTriage } from '../triage/clinician-stamp.ts';

test('doctor Findings omits stamp jev reason and shadow policy id', () => {
  assert.equal(projectClinicianTriage({
    reason: 'jev:route conf=0.67 should_route=0.70; hard_bar_jev_route',
    policy_version: 'triage-shadow-policy/0.1.4',
  }), null);
});

test('doctor Findings omits raw stamp reason and policy_version even when they are not jev-shaped', () => {
  assert.equal(projectClinicianTriage({
    reason: 'Safety signal requires a doctor',
    policy_version: 'triage/1',
  }), null);
  assert.equal(projectClinicianTriage(null), null);
  assert.equal(projectClinicianTriage(), null);
});
