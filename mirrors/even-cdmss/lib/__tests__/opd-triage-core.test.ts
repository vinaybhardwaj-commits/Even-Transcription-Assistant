/**
 *   node --experimental-strip-types --test lib/__tests__/opd-triage-core.test.ts
 * Pure core: CM triage queue grouping/ranking + decision validation (opd-triage-core).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueue, validateDecision, severityOf, importanceHint,
  classifyTransition, requireChip, buildTriageEvent, DISMISS_REASONS, RESOLUTION_OUTCOMES,
  type TriageFinding, type TriageDecisionRow,
} from '../opd-triage-core.ts';

const f = (over: Partial<TriageFinding>): TriageFinding => ({
  audit_id: 'a1', doctor_uid: 'docA', note_date: '2026-07-02',
  subject: 'Interaction (major): A + B', rationale: 'r', verdict: 'low-value',
  domain: 'prescribing_safety', signal_type: 'drug_interaction', finding_ref: 'ref1',
  ...over,
});

test('severityOf + importanceHint: known types weighted, unknown → med', () => {
  assert.equal(severityOf('drug_interaction'), 3);
  assert.equal(severityOf('incomplete_dosing'), 2);
  assert.equal(severityOf('dose_ceiling_sos'), 1);
  assert.equal(severityOf('some_slug_type'), 2);
  assert.equal(importanceHint(3), 'high');
  assert.equal(importanceHint(2), 'med');
  assert.equal(importanceHint(1), 'low');
});

test('buildQueue groups by doctor→signal_type, counts, and drops informational', () => {
  const findings: TriageFinding[] = [
    f({ audit_id: 'n1', finding_ref: 'r1' }),
    f({ audit_id: 'n2', finding_ref: 'r2', subject: 'Interaction (moderate): C + D' }),
    f({ audit_id: 'n1', finding_ref: 'r3', signal_type: 'incomplete_dosing', subject: 'Incomplete dosing: Cefixime', verdict: 'context-dependent' }),
    f({ audit_id: 'n3', finding_ref: 'r4', signal_type: 'high_alert_medication', subject: 'High-alert medication: Insulin', informational: true }),
  ];
  const { doctors } = buildQueue(findings, []);
  assert.equal(doctors.length, 1);
  const d = doctors[0];
  assert.equal(d.doctor_uid, 'docA');
  assert.equal(d.notes, 2);            // n1, n2 (n3 was informational-only → excluded)
  const types = d.types.map((t) => t.signal_type);
  assert.ok(types.includes('drug_interaction'));
  assert.ok(types.includes('incomplete_dosing'));
  assert.ok(!types.includes('high_alert_medication'));  // informational never surfaces
  const di = d.types.find((t) => t.signal_type === 'drug_interaction')!;
  assert.equal(di.count, 2);
});

test('buildQueue ranks types by severity×frequency; noisiest marked; doctors by attention', () => {
  const findings: TriageFinding[] = [
    // docA: 1 interaction (sev 3) + 5 incomplete-dosing (sev 2)
    f({ doctor_uid: 'docA', audit_id: 'a1', finding_ref: 'x1' }),
    ...Array.from({ length: 5 }, (_, i) =>
      f({ doctor_uid: 'docA', audit_id: `a${i + 2}`, finding_ref: `d${i}`, signal_type: 'incomplete_dosing', subject: `Incomplete dosing: Drug${i}` })),
    // docB: 1 off-formulary (sev 1)
    f({ doctor_uid: 'docB', audit_id: 'b1', finding_ref: 'o1', signal_type: 'off_formulary', subject: 'Off-formulary items: 1', verdict: 'uncertain' }),
  ];
  const { doctors } = buildQueue(findings, []);
  // docA (has a high-severity type) ranks before docB
  assert.equal(doctors[0].doctor_uid, 'docA');
  assert.equal(doctors[0].max_importance_hint, 'high');
  // within docA, drug_interaction (sev 3) outranks incomplete_dosing (sev 2) despite lower count
  assert.equal(doctors[0].types[0].signal_type, 'drug_interaction');
  assert.equal(doctors[0].types[0].noisiest, true);
  assert.equal(doctors[0].types[1].noisiest, false);
});

test('buildQueue overlays the latest type decision; status filter hides triaged', () => {
  const findings: TriageFinding[] = [
    f({ audit_id: 'n1', finding_ref: 'r1' }),
    f({ audit_id: 'n2', finding_ref: 'r2', signal_type: 'incomplete_dosing', subject: 'Incomplete dosing: X' }),
  ];
  const decisions: TriageDecisionRow[] = [
    { scope: 'type', doctor_uid: 'docA', signal_type: 'drug_interaction', validity: 'valid_signal',
      importance: 'high', routed: true, response_required: 'acknowledgment', created_at: '2026-07-03T04:00:00Z' },
    // an OLDER decision that must be superseded by the newer one below
    { scope: 'type', doctor_uid: 'docA', signal_type: 'incomplete_dosing', validity: 'valid_signal',
      importance: 'low', routed: false, created_at: '2026-07-03T03:00:00Z' },
    { scope: 'type', doctor_uid: 'docA', signal_type: 'incomplete_dosing', validity: 'audit_bug',
      bug_type: 'structural_bug', routed: false, created_at: '2026-07-03T05:00:00Z' },
  ];
  // status=all → both types visible, each carrying its latest decision
  const all = buildQueue(findings, decisions, { status: 'all' });
  const di = all.doctors[0].types.find((t) => t.signal_type === 'drug_interaction')!;
  assert.equal(di.triage?.routed, true);
  const id = all.doctors[0].types.find((t) => t.signal_type === 'incomplete_dosing')!;
  assert.equal(id.triage?.validity, 'audit_bug');   // newest wins (05:00 over 03:00)
  // status=untriaged → both are decided → doctor drops out entirely
  const untri = buildQueue(findings, decisions, { status: 'untriaged' });
  assert.equal(untri.doctors.length, 0);
});

test('buildQueue concentrated flag: doctor holding the whole window share of a type', () => {
  const findings: TriageFinding[] = [
    ...Array.from({ length: 4 }, (_, i) =>
      f({ doctor_uid: 'docA', audit_id: `a${i}`, finding_ref: `r${i}`, signal_type: 'drug_interaction' })),
  ];
  const { doctors } = buildQueue(findings, []);
  assert.equal(doctors[0].types[0].concentrated, true);   // 100% share, ≥3 instances
});

// ── validateDecision ──────────────────────────────────────────────────────────
test('validateDecision: valid batch route decision normalizes', () => {
  const r = validateDecision({
    scope: 'type', doctor_uid: 'docA', signal_type: 'drug_interaction',
    validity: 'valid_signal', importance: 'high', routed: true, response_required: 'acknowledgment',
    window_from: '2026-07-02', window_to: '2026-07-03', cm_user: 'aravind',
  });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.routed, true);
    assert.equal(r.value.response_required, 'acknowledgment');
    assert.equal(r.value.audit_id, null);   // type scope clears instance keys
  }
});

test('validateDecision: audit_bug forces routed=false and requires bug_type', () => {
  const bad = validateDecision({ scope: 'type', doctor_uid: 'd', signal_type: 's', validity: 'audit_bug' });
  assert.equal(bad.ok, false);
  const good = validateDecision({ scope: 'type', doctor_uid: 'd', signal_type: 's', validity: 'audit_bug', bug_type: 'structural_bug', routed: true });
  assert.ok(good.ok);
  if (good.ok) { assert.equal(good.value.routed, false); assert.equal(good.value.importance, null); }
});

test('validateDecision: valid_signal requires importance; routed requires response_required', () => {
  assert.equal(validateDecision({ scope: 'type', doctor_uid: 'd', signal_type: 's', validity: 'valid_signal' }).ok, false);
  assert.equal(validateDecision({ scope: 'type', doctor_uid: 'd', signal_type: 's', validity: 'valid_signal', importance: 'med', routed: true }).ok, false);
  const ok = validateDecision({ scope: 'type', doctor_uid: 'd', signal_type: 's', validity: 'valid_signal', importance: 'med', routed: false });
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.value.response_required, null);  // not routed → cleared
});

test('validateDecision: instance scope requires audit_id + finding_ref; bad enums rejected', () => {
  assert.equal(validateDecision({ scope: 'instance', doctor_uid: 'd', signal_type: 's', validity: 'valid_signal', importance: 'low' }).ok, false);
  const ok = validateDecision({ scope: 'instance', doctor_uid: 'd', signal_type: 's', audit_id: 'aud1', finding_ref: 'ref1', validity: 'valid_signal', importance: 'low' });
  assert.ok(ok.ok);
  assert.equal(validateDecision({ scope: 'bogus', doctor_uid: 'd', signal_type: 's', validity: 'valid_signal', importance: 'low' }).ok, false);
  assert.equal(validateDecision({ scope: 'type', doctor_uid: 'd', signal_type: 's', validity: 'nope' }).ok, false);
  assert.equal(validateDecision({ scope: 'type', doctor_uid: 'd', signal_type: 's', validity: 'valid_signal', importance: 'HIGH' }).ok, false);
});

// ── Feature C — CM instrumentation chip logic (Gold-Label Review-Mode §5) ───────
test('classifyTransition: audit_bug & not-routed → dismiss; routed → resolution', () => {
  assert.deepEqual(classifyTransition({ validity: 'audit_bug', routed: false }), { to_status: 'dismissed', kind: 'dismiss' });
  assert.deepEqual(classifyTransition({ validity: 'valid_signal', routed: false }), { to_status: 'dismissed', kind: 'dismiss' });
  assert.deepEqual(classifyTransition({ validity: 'valid_signal', routed: true }), { to_status: 'routed', kind: 'resolution' });
});

test('requireChip: dismiss/resolution require an in-vocabulary chip', () => {
  assert.equal(requireChip('dismiss', '').ok, false);            // required
  assert.equal(requireChip('dismiss', 'resolved_with_doctor').ok, false); // wrong vocab
  assert.equal(requireChip('dismiss', 'patient_constraint').ok, true);
  assert.equal(requireChip('resolution', 'unable_to_contact').ok, true);
  assert.equal(requireChip('resolution', 'not_clinically_relevant').ok, false);
  for (const r of DISMISS_REASONS) assert.equal(requireChip('dismiss', r).ok, true);
  for (const o of RESOLUTION_OUTCOMES) assert.equal(requireChip('resolution', o).ok, true);
});

test('buildTriageEvent: enforces chip, free text optional, telemetry columns normalized', () => {
  const bad = buildTriageEvent({ validity: 'audit_bug', routed: false, actor: 'V' });
  assert.equal(bad.ok, false); // dismiss without a reason chip
  const ok = buildTriageEvent({ validity: 'audit_bug', routed: false, chip: 'not_clinically_relevant', actor: 'V', triage_id: 't1', audit_id: 'a1' });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.value.to_status, 'dismissed');
    assert.equal(ok.value.reason, 'not_clinically_relevant');
    assert.equal(ok.value.note, null);           // free text omitted → null (not required)
    assert.equal(ok.value.app_source, 'standalone');
  }
  const routed = buildTriageEvent({ validity: 'valid_signal', routed: true, chip: 'resolved_with_doctor', note: 'called, agreed to stop', actor: 'Zaki' });
  assert.ok(routed.ok);
  if (routed.ok) { assert.equal(routed.value.to_status, 'routed'); assert.equal(routed.value.note, 'called, agreed to stop'); }
});

// ── Right Care routing-context passthrough (decision 16) ────────────────────────
test('buildQueue: representative carries complexity_band/inputs + lvc_category (passthrough)', () => {
  const findings: TriageFinding[] = [
    f({ audit_id: 'n1', finding_ref: 'r1', complexity_band: 'HIGH',
        complexity_inputs: { chronic_codes: 3, abnormal_labs: 5, enc_12m: 7 }, lvc_category: 'antibiotic' }),
  ];
  const { doctors } = buildQueue(findings, []);
  const rep = doctors[0].types[0].representative;
  assert.equal(rep.complexity_band, 'HIGH');
  assert.equal(rep.lvc_category, 'antibiotic');
  assert.equal((rep.complexity_inputs as Record<string, unknown>).enc_12m, 7);
});

test('buildQueue: missing complexity → representative fields null (no placeholder)', () => {
  const { doctors } = buildQueue([f({ audit_id: 'n2', finding_ref: 'r9' })], []);
  const rep = doctors[0].types[0].representative;
  assert.equal(rep.complexity_band, null);
  assert.equal(rep.lvc_category, null);
  assert.equal(rep.complexity_inputs, null);
});
