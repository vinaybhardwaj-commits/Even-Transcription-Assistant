/**
 * Pure-core tests for the 0.81.7 consult-channel classifier + chip (DATA-QUALITY PRD Fix B/D §5).
 * Run: node --test --import tsx lib/__tests__/opd-ingest-core.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTeleconsultEncounter, hasHandsOnExam, formatEncounterChip, parseConsultTypes,
  currentVisitNote, parseTrimester,
} from '../opd-ingest-core.ts';

// the call-site combination (rowToOpdCase): classify, then downgrade tele→in-person on a hands-on exam
const classify = (pt: string | null, ct: string | null, cts: string[] | null, exam: string[] = []): boolean =>
  isTeleconsultEncounter(pt, ct, cts) && !hasHandsOnExam(exam);

test('precedence: explicit consult_type regex wins over everything', () => {
  // explicit IN-PERSON beats a CHAT purpose marker and the GP form default
  assert.equal(isTeleconsultEncounter('GENERAL_PRACTITIONER', 'IN_PERSON', ['CHAT']), false);
  // explicit TELE beats a VISITING_HOSPITAL marker
  assert.equal(isTeleconsultEncounter('HOSPITAL_GP', 'VIDEO', ['VISITING_HOSPITAL']), true);
});

test('consult_types markers: VISITING_HOSPITAL / EMERGENCY → in-person, and WIN over CHAT', () => {
  // V's case: a GP-form note carrying VISITING_HOSPITAL is IN-PERSON (was mis-framed as tele)
  assert.equal(isTeleconsultEncounter('GENERAL_PRACTITIONER', null, ['VISITING_HOSPITAL']), false);
  assert.equal(isTeleconsultEncounter('GENERAL_PRACTITIONER', null, ['EMERGENCY']), false);
  // in-person markers WIN over a co-present CHAT purpose (hospital visit + chat follow-up = in-person)
  assert.equal(isTeleconsultEncounter('GENERAL_PRACTITIONER', null, ['VISITING_HOSPITAL', 'CHAT']), false);
});

test('consult_types markers: CHAT → tele (when no in-person marker); HOSPITAL_* + CHAT = tele', () => {
  assert.equal(isTeleconsultEncounter('HOSPITAL_GP', null, ['CHAT']), true);
  assert.equal(isTeleconsultEncounter('GENERAL_PRACTITIONER', null, ['CHAT']), true);
});

test('fallback: form-type default when no markers (GENERAL_PRACTITIONER → tele; HOSPITAL_* → in-person)', () => {
  assert.equal(isTeleconsultEncounter('GENERAL_PRACTITIONER', null, null), true);
  assert.equal(isTeleconsultEncounter('GENERAL_PRACTITIONER', null, []), true);
  assert.equal(isTeleconsultEncounter('HOSPITAL_GP', null, null), false);
  assert.equal(isTeleconsultEncounter('HOSPITAL_PAEDIATRIC', null, ['UNKNOWN_PURPOSE']), false);
});

test('hands-on-exam downgrade still applies AFTER classification (unchanged)', () => {
  // a GP-form note (tele by default) with a documented palpation → downgraded to in-person
  assert.equal(hasHandsOnExam(['Abdomen soft, non-tender, no organomegaly']), true);
  assert.equal(classify('GENERAL_PRACTITIONER', null, null, ['Abdomen soft, non-tender']), false);
  // a CHAT-marker tele note WITH a hands-on exam → downgraded to in-person
  assert.equal(classify('GENERAL_PRACTITIONER', null, ['CHAT'], ['tenderness in RIF']), false);
  // no exam text → classification stands
  assert.equal(classify('GENERAL_PRACTITIONER', null, null, []), true);
});

test('formatEncounterChip: channel first, form second', () => {
  assert.equal(formatEncounterChip('GENERAL_PRACTITIONER', null, null), 'Tele · GP app');
  assert.equal(formatEncounterChip('HOSPITAL_GP', null, null), 'In-person · Hosp GP');
  assert.equal(formatEncounterChip('HOSPITAL_GYNAECOLOGY_ASSESSMENT', null, null), 'In-person · Gyn');
  // a VISITING_HOSPITAL purpose flips a GP-form note's channel to In-person in the chip too
  assert.equal(formatEncounterChip('GENERAL_PRACTITIONER', null, ['VISITING_HOSPITAL']), 'In-person · GP app');
});

test('parseConsultTypes: JS array / JSON string / PG array literal / empty → clean string[]', () => {
  assert.deepEqual(parseConsultTypes(['VISITING_HOSPITAL', 'CHAT']), ['VISITING_HOSPITAL', 'CHAT']);
  assert.deepEqual(parseConsultTypes('["VISITING_HOSPITAL","CHAT"]'), ['VISITING_HOSPITAL', 'CHAT']);
  assert.deepEqual(parseConsultTypes('{VISITING_HOSPITAL,CHAT}'), ['VISITING_HOSPITAL', 'CHAT']);
  assert.deepEqual(parseConsultTypes('{"EMERGENCY"}'), ['EMERGENCY']);
  assert.deepEqual(parseConsultTypes(null), []);
  assert.deepEqual(parseConsultTypes(''), []);
  assert.deepEqual(parseConsultTypes(42), []);
});

// ── Obstetric-template adapter: current-visit selection + trimester resolution (pure) ────────────
test('currentVisitNote: prefers show_in_prescription; falls back to latest non-carried date_of_visit', () => {
  const notes = [
    { show_in_prescription: false, is_carried_over: true, date_of_visit: '2026-06-01', symptoms_notes: 'old' },
    { show_in_prescription: true, is_carried_over: false, date_of_visit: '2026-07-20', symptoms_notes: 'current' },
    { show_in_prescription: false, is_carried_over: false, date_of_visit: '2026-07-25', symptoms_notes: 'newer but not shown' },
  ];
  assert.equal(currentVisitNote(notes)?.symptoms_notes, 'current', 'show_in_prescription wins');
  // no show flag → latest non-carried date_of_visit
  const noShow = notes.map((n) => ({ ...n, show_in_prescription: false }));
  assert.equal(currentVisitNote(noShow)?.symptoms_notes, 'newer but not shown');
  // all carried-over → falls back to the whole pool's latest
  const allCarried = [{ is_carried_over: true, date_of_visit: '2026-06-01', symptoms_notes: 'a' }, { is_carried_over: true, date_of_visit: '2026-06-05', symptoms_notes: 'b' }];
  assert.equal(currentVisitNote(allCarried)?.symptoms_notes, 'b');
  // tolerates a stringified array + empty
  assert.equal(currentVisitNote(JSON.stringify(notes))?.symptoms_notes, 'current');
  assert.equal(currentVisitNote([]), null);
  assert.equal(currentVisitNote(null), null);
});

test('parseTrimester: numeric / worded / derived-from-GA-weeks; null when unparseable', () => {
  assert.equal(parseTrimester({ trimester_at_visit: '3' }), 3);
  assert.equal(parseTrimester({ trimester_at_visit: 'SECOND' }), 2);
  assert.equal(parseTrimester({ trimester_at_visit: '', gestational_age_at_visit: '31w' }), 3);
  assert.equal(parseTrimester({ gestational_age_at_visit: '8 weeks' }), 1);
  assert.equal(parseTrimester({ gestational_age_at_visit: '20+4' }), 2);
  assert.equal(parseTrimester({ gestational_age_at_visit: '19' }), 2);   // bare weeks
  assert.equal(parseTrimester({}), null);
  assert.equal(parseTrimester({ gestational_age_at_visit: 'n/a' }), null);
});
