/**
 * lib/__tests__/ipd-episode-resolve.test.ts — the deterministic omission resolver (PRD decision 33).
 *
 * WHY THIS FILE MATTERS MORE THAN ITS SIZE SUGGESTS. Three runs of IP-1286 scored 96, 100 and 80
 * on byte-identical checkpoints, and every point of that spread came from the judge's verdicts on
 * omissions. Decision 33 moves those verdicts into code. If this module is deterministic and
 * correct, the omission half of the score stops moving; these tests are what "deterministic and
 * correct" means in practice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classIsRepresented, confoundFor, findMatch, termMatches, haystackFor, eventTypesFor,
  resolveEntry, resolveAll, resolutionCounts, panelContaining, ESCALATION_SECTION, MATCHER_KINDS,
  CLINICAL_SHORTHAND, expandClinicalShorthand,
  type ExpectationMatcher, type ResolvableEntry,
} from '../ipd-episode/resolve-core';
import { DEATH_DISCHARGE_TYPES, dischargeIndicatesDeath } from '../ipd-episode/assemble-core';
import { asRecurrence } from '../ipd-episode/checkpoint-core';
import { findingsFromResolved, domainForSection, countFindings, resolverGroupKey } from '../ipd-episode/judge-core';
import type { EpisodeEvent } from '../ipd-episode/assemble-core';

const ev = (o: Partial<EpisodeEvent> & { event_id: string }): EpisodeEvent => ({
  occurred_at: '2026-08-02T04:00:00.000Z', day_index: 0, event_type: 'note', summary: '', detail: {},
  author_name: null, author_role: null, responsible_clinician_id: null,
  provenance: { source_table: 't', source_record_id: o.event_id, source_timestamp: null },
  evidence_tier: 'A', ...o,
});

const drugOrder = (name: string, day = 0) => ev({
  event_id: `d-${name}-${day}`, event_type: 'order', day_index: day,
  detail: { service_type: 'Pharmacy', ordered_item_name: name },
  provenance: { source_table: 'kx_billing_records', source_record_id: `b-${name}`, source_timestamp: null },
});
const labOrder = (name: string, day = 0) => ev({
  event_id: `l-${name}-${day}`, event_type: 'lab_order', day_index: day,
  detail: { service_name: name },
  provenance: { source_table: 'kx_lab_reports', source_record_id: `l-${name}`, source_timestamp: null },
});

const noteEvent = (day: number, summary = 'ward round, plan continued') => ev({
  event_id: `n-${day}`, event_type: 'note', day_index: day, summary,
  provenance: { source_table: 'kx_clinical_template_progress_reports', source_record_id: `n-${day}`, source_timestamp: null },
});

const entry = (o: Partial<ResolvableEntry> & { matcher: ExpectationMatcher | null }): ResolvableEntry => ({
  ref: 'cp-d0/therapeutics/1', checkpointId: 'cp-d0', dayIndex: 0, section: 'therapeutics',
  item: 'an expectation', rationale: 'because', byDay: 0, citationIds: [4021],
  proposedSeverity: 'major', ...o,
});

// ── PRESENT ─────────────────────────────────────────────────────────────────────────────────

test('PRESENT: a matching drug order resolves concordant', () => {
  const events = [drugOrder('ENOXAPARIN 40MG INJ'), labOrder('Complete Blood Count')];
  const r = resolveEntry(entry({ matcher: { kind: 'drug', terms: ['enoxaparin', 'heparin'] } }), events);
  assert.equal(r.resolution, 'present');
  assert.equal(r.verdict, 'concordant');
  assert.equal(r.matchedTerm, 'enoxaparin');
  assert.match(r.statement, /The record shows it/);
});

test('PRESENT: an event EARLIER than by_day still counts — the course was ahead of the expectation', () => {
  const events = [drugOrder('ENOXAPARIN 40MG', 0)];
  const r = resolveEntry(entry({ byDay: 2, matcher: { kind: 'drug', terms: ['enoxaparin'] } }), events);
  assert.equal(r.resolution, 'present', 'narrowing to an exact day would manufacture omissions out of timing');
});

test('a matcher only searches its own event types — a drug is not satisfied by a note mentioning it', () => {
  const events = [ev({ event_id: 'n', event_type: 'note', summary: 'plan: start enoxaparin tomorrow' })];
  const r = resolveEntry(entry({ matcher: { kind: 'drug', terms: ['enoxaparin'] } }), events);
  assert.notEqual(r.resolution, 'present', 'a plan to give a drug is not a drug order');
  assert.deepEqual(eventTypesFor('drug'), ['order']);
});

// ── ABSENT, class present → divergent ───────────────────────────────────────────────────────

test('DECISION 44: ABSENT with the class represented is CONTEXT_DEPENDENT, not divergent', () => {
  const events = [drugOrder('PARACETAMOL 1G'), drugOrder('CEFAZOLIN 1G')];
  const r = resolveEntry(entry({ proposedSeverity: 'major', matcher: { kind: 'drug', terms: ['enoxaparin', 'heparin'] } }), events);
  assert.equal(r.resolution, 'absent_class_present');
  assert.equal(r.verdict, 'context_dependent', 'decision 44: an unverified absence is not asserted');
  assert.equal(r.severity, 'major', 'severity was chosen while the model was blinded, and code does not revisit it');
  // ⚠️ IT NO LONGER SAYS "the absence is real". On IPNO-495, 22 of 29 divergent findings had an
  // empty evidence_basis and carried 141 of 167 penalty points — 84% of the score asserting a
  // negative the engine had never verified, most of them contradicted by the event list. What the
  // resolver actually knows is narrower and duller: its matcher did not fire.
  assert.match(r.statement, /Not detected by matcher/);
  assert.ok(!/the absence is real/.test(r.statement));
  assert.match(r.confound ?? '', /not verified/);
});

// ── ABSENT, class missing → unassessable (the ONLY path) ────────────────────────────────────

test('ABSENT with NO data of that class resolves unassessable — the only path that may', () => {
  const events = [drugOrder('PARACETAMOL 1G')];   // drugs exist, labs do not
  const r = resolveEntry(entry({ matcher: { kind: 'lab', terms: ['creatinine'] } }), events);
  assert.equal(r.resolution, 'absent_class_missing');
  assert.equal(r.verdict, 'unassessable');
  assert.match(r.statement, /cannot answer/);
});

test('vitals and imaging are NEVER represented — this mirror holds neither', () => {
  const rich = [drugOrder('X'), labOrder('Y'), ev({ event_id: 'n', event_type: 'note', summary: 'BP 120/80 recorded' })];
  for (const kind of ['vitals', 'imaging'] as const) {
    assert.equal(classIsRepresented(kind, rich), false, kind);
    const r = resolveEntry(entry({ matcher: { kind, terms: ['blood pressure', 'chest x-ray'] } }), rich);
    assert.equal(r.verdict, 'unassessable', `${kind} must always be unassessable`);
    assert.match(r.statement, /absent from the mirror entirely/);
  }
});

test('class representation is measured off the events, per class', () => {
  const none: EpisodeEvent[] = [];
  assert.equal(classIsRepresented('lab', none), false);
  assert.equal(classIsRepresented('lab', [labOrder('CBC')]), true);
  assert.equal(classIsRepresented('drug', [drugOrder('X')]), true);
  assert.equal(classIsRepresented('drug', [labOrder('CBC')]), false);
  assert.equal(classIsRepresented('note', [ev({ event_id: 'n', event_type: 'note' })]), true);
  assert.equal(classIsRepresented('other', [drugOrder('X')]), false, '"other" is not checkable by construction');
});

// ── AMBIGUOUS: the confounds, enumerated in code ────────────────────────────────────────────

test('a bundled billing line makes a missing drug AMBIGUOUS, not divergent', () => {
  const events = [
    drugOrder('PARACETAMOL 1G'),
    ev({ event_id: 'pkg', event_type: 'order', detail: { service_type: 'Procedure', service_item_name: 'LAP HERNIA SURGERY PACKAGE' } }),
  ];
  const r = resolveEntry(entry({ matcher: { kind: 'drug', terms: ['enoxaparin'] } }), events);
  assert.equal(r.resolution, 'ambiguous_confounded');
  assert.equal(r.verdict, 'context_dependent');
  assert.match(r.confound ?? '', /hide a dispensed drug/);
});

test('ITEM 6: a panel that CONTAINS the analyte resolves it PRESENT, and names the panel', () => {
  // Was `ambiguous_confounded`. On IPNO-416 that rule made r-1 (creatinine, urea) and r-4
  // (electrolytes) context_dependent against the CBC panel — which holds none of them — while a
  // KFT ordered on day 0 holds all three. A confound attributed to a panel that cannot contain the
  // analyte is a wrong answer wearing a caveat's clothes.
  const events = [labOrder('LIVER FUNCTION PROFILE')];
  const r = resolveEntry(entry({ matcher: { kind: 'lab', terms: ['bilirubin'] } }), events);
  assert.equal(r.resolution, 'present');
  assert.equal(r.verdict, 'concordant');
  assert.match(r.statement, /liver function test/, 'the panel is NAMED, not alluded to');
  assert.match(r.statement, /bilirubin/);
});

test('ITEM 6: the IPNO-416 case exactly — a KFT covers creatinine, urea and electrolytes', () => {
  const events = [labOrder('KFT'), labOrder('CBC')];
  for (const terms of [['creatinine'], ['urea'], ['electrolytes'], ['sodium', 'potassium']]) {
    const r = resolveEntry(entry({ matcher: { kind: 'lab', terms } }), events);
    assert.equal(r.resolution, 'present', `${terms.join('/')} is covered by the KFT`);
    assert.match(r.statement, /renal function test/);
  }
  // and the CBC is not offered as an explanation for any of them
  for (const terms of [['creatinine'], ['electrolytes']]) {
    const r = resolveEntry(entry({ matcher: { kind: 'lab', terms } }), events);
    assert.ok(!/complete blood count/.test(r.statement), 'the CBC explains nothing about renal analytes');
  }
});

test('ITEM 6: a panel that CANNOT contain the analyte is not a confound — the absence is real', () => {
  const events = [labOrder('CBC')];
  const r = resolveEntry(entry({ matcher: { kind: 'lab', terms: ['creatinine'] } }), events);
  assert.equal(r.resolution, 'absent_class_present');
  assert.equal(r.verdict, 'context_dependent', 'decision 44: an unverified absence is not asserted');
  assert.equal(confoundFor('lab', events, ['creatinine']), null);
});

test('ITEM 6: only an UNENUMERATED panel is still a confound, and it says which analyte', () => {
  const events = [labOrder('AUTOIMMUNE SCREEN')];
  const c = confoundFor('lab', events, ['anti-ccp']);
  assert.ok(c, 'a panel this table cannot enumerate may genuinely hide the analyte');
  assert.match(c!.reason, /unenumerated panel order/);
  assert.match(c!.reason, /anti-ccp/, 'and names what it might be hiding');
  assert.equal(confoundFor('lab', [labOrder('SERUM SODIUM')], ['creatinine']), null,
    'a single named test confounds nothing');
});

test('an entry with NO matcher is uncheckable, and says so rather than scoring', () => {
  const r = resolveEntry(entry({ matcher: null }), [drugOrder('X')]);
  assert.equal(r.resolution, 'ambiguous_confounded');
  assert.equal(r.verdict, 'context_dependent');
  assert.match(r.confound ?? '', /no matcher/);
});

// ── matching mechanics ──────────────────────────────────────────────────────────────────────

test('a single-word term matches on a word boundary, not a substring', () => {
  assert.equal(termMatches('heparin', 'ENOXAPARIN SODIUM 40MG'), false, '"heparin" is not inside "enoxaparin"');
  assert.equal(termMatches('heparin', 'HEPARIN 5000IU'), true);
  assert.equal(termMatches('low molecular weight heparin', 'inj low molecular weight heparin'), true, 'a phrase matches as a substring');
  assert.equal(termMatches('iv', 'IV FLUIDS'), false, 'terms under 3 chars are ignored — they match everything');
});

test('the haystack is narrow per event type, so a matcher cannot match on unrelated JSON', () => {
  assert.equal(haystackFor(labOrder('Serum Creatinine')).trim(), 'Serum Creatinine');
  assert.ok(haystackFor(drugOrder('ENOXAPARIN')).includes('ENOXAPARIN'));
});

test('findMatch returns the first satisfying event, or null', () => {
  const events = [drugOrder('PARACETAMOL'), drugOrder('ENOXAPARIN')];
  assert.equal(findMatch({ kind: 'drug', terms: ['enoxaparin'] }, null, events)?.event.event_id, 'd-ENOXAPARIN-0');
  assert.equal(findMatch({ kind: 'drug', terms: ['warfarin'] }, null, events), null);
  assert.equal(findMatch({ kind: 'other', terms: ['anything'] }, null, events), null, '"other" matches nothing');
});

// ── determinism, which is the whole point ───────────────────────────────────────────────────

test('the resolver is a pure function: the same inputs give byte-identical output, every time', () => {
  const events = [drugOrder('PARACETAMOL'), labOrder('AUTOIMMUNE SCREEN'), drugOrder('CEFAZOLIN')];
  const entries = [
    entry({ ref: 'cp-d0/therapeutics/1', matcher: { kind: 'drug', terms: ['enoxaparin'] } }),
    entry({ ref: 'cp-d0/diagnostics/1', section: 'diagnostics', matcher: { kind: 'lab', terms: ['anti-ccp'] } }),
    entry({ ref: 'cp-d1/therapeutics/1', matcher: { kind: 'drug', terms: ['cefazolin'] } }),
    entry({ ref: 'cp-d1/monitoring/1', section: 'monitoring', matcher: { kind: 'vitals', terms: ['blood pressure'] } }),
  ];
  const a = JSON.stringify(resolveAll(entries, events).map((r) => r.outcome));
  for (let i = 0; i < 25; i++) {
    assert.equal(JSON.stringify(resolveAll(entries, events).map((r) => r.outcome)), a,
      'this is what replaces a judge that returned 0, 12 and 11 unassessable on identical input');
  }
  const counts = resolutionCounts(resolveAll(entries, events));
  // one of each path, which is also the clearest statement of what the resolver does:
  //   cefazolin ordered            -> present
  //   enoxaparin absent, drugs exist and nothing bundles -> absent_class_present (divergent)
  //   anti-ccp absent behind an unenumerated screen      -> ambiguous_confounded
  //   blood pressure, a class this mirror lacks          -> absent_class_missing (unassessable)
  assert.deepEqual(counts, { present: 1, absent_class_present: 1, absent_class_missing: 1, ambiguous_confounded: 1 });
});

test('every outcome carries the four fields a reader needs to re-run the lookup by hand', () => {
  const events = [drugOrder('ENOXAPARIN 40MG')];
  const r = resolveEntry(entry({ matcher: { kind: 'drug', terms: ['enoxaparin'] } }), events);
  assert.ok(r.resolution && r.verdict && r.severity && r.statement);
  assert.equal(r.matchedEvent?.provenance.source_table, 'kx_billing_records');
  assert.equal(r.matchedTerm, 'enoxaparin');
});

// ── ROUND 12 ITEM 2: GROUPING, NOT TRUNCATION ────────────────────────────────────────────────
//
// IPNO-416 produced 112 findings, 79 of them from the resolver — 71% — because a daily checkpoint
// re-states the same standing expectation every day. Capping that by truncation would drop real
// findings silently, so the members of one expectation class become ONE finding instead. These
// tests pin the two properties that makes acceptable: nothing is lost, and nothing is merged that
// a reader would need kept apart.

const resolvedFor = (entries: ResolvableEntry[], events: EpisodeEvent[]) =>
  findingsFromResolved(resolveAll(entries, events), domainForSection);

const dayEntry = (day: number, terms: string[], section = 'therapeutics') =>
  entry({ ref: `cp-d${day}/${section}/1`, checkpointId: `cp-d${day}`, dayIndex: day, section,
          matcher: { kind: 'drug', terms } });

test('GROUPING: the same expectation across four days becomes one finding that says so', () => {
  const entries = [0, 1, 2, 3].map((d) => dayEntry(d, ['enoxaparin']));
  const out = resolvedFor(entries, [labOrder('Complete Blood Count')]);
  assert.equal(out.length, 1, 'four days, one expectation class, one finding');
  const f = out[0];
  assert.equal(f.group_size, 4);
  assert.deepEqual(f.grouped_days, [0, 1, 2, 3]);
  assert.equal(f.grouped_refs.length, 4, 'every member stays addressable — nothing is discarded');
  assert.equal(f.day_index, 0, 'dated to the day the question was FIRST asked');
  assert.ok(/expected at 4 checkpoints/.test(f.statement), 'the recurrence is in the statement, not hidden in a field');
  assert.equal(f.finding_id, 'r-1', 'short, whole ids — the id the model is asked to annotate');
});

test('GROUPING: term order and case do not split a class, but a different drug does', () => {
  const entries = [
    dayEntry(0, ['Enoxaparin', 'heparin']),
    dayEntry(1, ['heparin', 'ENOXAPARIN']),
    dayEntry(2, ['cefazolin']),
  ];
  const out = resolvedFor(entries, []);
  assert.equal(out.length, 2, 'the same matcher written differently is the same class');
  assert.equal(out.find((f) => f.group_size === 2)?.grouped_days.length, 2);
});

test('GROUPING NEVER MERGES A DONE DAY INTO A MISSED ONE — that is concordant-erasure', () => {
  // ⚠️ RESTORED BY DECISION 45, AFTER ROUND 23 REMOVED IT AND THE DEFECT CAME STRAIGHT BACK.
  // Round 23 took `resolution` out of the key so that a standing expectation raised on six days
  // would be one finding rather than six. It was — and IPNO-495 r-29 then let a single day-5 note
  // ("peripheral pulses present") speak for days 5, 6, 7, 8 and 10, four of which nothing was
  // checked on. One finding, five days, one observation, and a statement that read as though the
  // whole group had been verified.
  //
  // Deduplication across checkpoints survives; it is keyed on section and SUBJECT. What may never
  // merge is two different ANSWERS to the same question.
  const e = dayEntry(0, ['enoxaparin']);
  const done = { resolution: 'present' as const, verdict: 'concordant' as const };
  const missed = { resolution: 'absent_class_present' as const, verdict: 'context_dependent' as const };
  const key = (o: { resolution: 'present' | 'absent_class_present'; verdict: 'concordant' | 'context_dependent' }) =>
    resolverGroupKey(e, { ...o, severity: 'major', statement: 's', matchedEvent: null, matchedTerm: null, confound: null });
  assert.notEqual(key(done), key(missed), 'the same expectation with two different answers is two findings');

  const ev0 = drugOrder('ENOXAPARIN 40MG', 0);
  const found = { entry: dayEntry(0, ['enoxaparin']), outcome: {
    resolution: 'present' as const, verdict: 'concordant' as const, severity: 'major' as const,
    statement: 'found', matchedEvent: ev0, matchedTerm: 'enoxaparin', confound: null } };
  const notFound = { entry: dayEntry(2, ['enoxaparin']), outcome: {
    resolution: 'absent_class_present' as const, verdict: 'context_dependent' as const, severity: 'major' as const,
    statement: 'not detected', matchedEvent: null, matchedTerm: null, confound: null } };
  for (const order of [[found, notFound], [notFound, found]]) {
    const out = findingsFromResolved(order, domainForSection);
    assert.equal(out.length, 2, 'the found day and the unfound day are separate findings');
    assert.ok(out.every((f) => f.group_size === 1), 'and neither absorbed the other');
    const concordant = out.find((f) => f.verdict === 'concordant')!;
    assert.ok(concordant.evidence_basis.length > 0, 'the found day carries its event');
    assert.equal(out.find((f) => f.verdict === 'context_dependent')!.evidence_basis.length, 0,
      'and the unfound day claims no evidence it does not have');
  }
});

test('DECISION 45: two expectations are one class by SUBJECT, never by term resemblance', () => {
  // ⚠️ IPNO-495 r-16, `group_size` 8, said: "The record shows it: lab_order on day 5 matching cbc"
  // — and two of its eight members were BLOOD CULTURE expectations. Round 23's second pass merged
  // any two classes sharing half the smaller term set, so "blood cultures" and "repeat CBC" became
  // one class and the CBC's match was then reported as the evidence that the cultures were drawn.
  // A culture that was never sent was recorded as done, in a finding a reader would have believed.
  const cultures = entry({ ref: 'cp-d1/diagnostics/1', checkpointId: 'cp-d1', dayIndex: 1, section: 'diagnostics',
    item: 'Blood cultures drawn before the first antibiotic dose',
    matcher: { kind: 'lab', terms: ['blood culture', 'culture', 'cbc differential'] } });
  const cbc = entry({ ref: 'cp-d1/diagnostics/2', checkpointId: 'cp-d1', dayIndex: 1, section: 'diagnostics',
    item: 'Repeat CBC to follow the white cell count',
    matcher: { kind: 'lab', terms: ['cbc', 'complete blood count'] } });
  assert.notEqual(resolverGroupKey(cultures, {
    resolution: 'present', verdict: 'concordant', severity: 'moderate', statement: 's',
    matchedEvent: null, matchedTerm: null, confound: null }),
    resolverGroupKey(cbc, {
      resolution: 'present', verdict: 'concordant', severity: 'moderate', statement: 's',
      matchedEvent: null, matchedTerm: null, confound: null }),
    'blood cultures and a repeat CBC are two clinical questions, however their term lists overlap');

  // and end to end: a CBC on the record answers the CBC, never the cultures
  const out = resolvedFor([cultures, cbc], [labOrder('CBC', 1)]);
  assert.equal(out.length, 2, 'two findings');
  const culturesFinding = out.find((f) => /culture/i.test(f.statement))!;
  assert.ok(!/cbc/i.test(culturesFinding.statement.replace(/cbc differential/ig, '')),
    'the cultures finding does not cite a CBC as its evidence');
});

test('GROUPING: sections never merge, and severity takes the WORST member', () => {
  const a = entry({ ref: 'cp-d0/therapeutics/1', dayIndex: 0, section: 'therapeutics',
                    proposedSeverity: 'minor', matcher: { kind: 'drug', terms: ['enoxaparin'] } });
  const b = entry({ ref: 'cp-d1/therapeutics/1', checkpointId: 'cp-d1', dayIndex: 1, section: 'therapeutics',
                    proposedSeverity: 'major', matcher: { kind: 'drug', terms: ['enoxaparin'] } });
  const c = entry({ ref: 'cp-d0/diagnostics/1', dayIndex: 0, section: 'diagnostics',
                    proposedSeverity: 'major', matcher: { kind: 'drug', terms: ['enoxaparin'] } });
  const out = resolvedFor([a, b, c], []);
  assert.equal(out.length, 2, 'therapeutics and diagnostics are different questions');
  const ther = out.find((f) => f.domain === 'therapeutics')!;
  assert.equal(ther.group_size, 2);
  assert.equal(ther.severity, 'major', 'a major day must not hide behind a minor one by checkpoint order');
});

test('GROUPING: an entry with no matcher only ever groups with identical text', () => {
  const noMatch = (day: number, item: string) =>
    entry({ ref: `cp-d${day}/monitoring/1`, checkpointId: `cp-d${day}`, dayIndex: day,
            section: 'monitoring', item, matcher: null });
  const out = resolvedFor([noMatch(0, 'watch  the  patient'), noMatch(1, 'Watch the patient'), noMatch(2, 'something else')], []);
  assert.equal(out.length, 2, 'normalised text groups; different text does not');
});

test('GROUPING: the two counts describe the same list, and neither can be read alone', () => {
  const entries = [0, 1, 2, 3, 4].map((d) => dayEntry(d, ['enoxaparin']));
  const out = resolvedFor(entries, []);
  const counters = countFindings(out, 0, 0);
  assert.equal(counters.n_resolver_grouped, 1, 'what the reader is shown');
  assert.equal(counters.n_resolver_ungrouped, 5, 'what it stands for');
  assert.equal(counters.n_findings, 1, 'the headline count is the presented one');
});


// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 14 ITEMS 2, 3 AND 5 — THE DAY WINDOW, AND THE SHORTHAND
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test('DECISION 42: a `once` expectation resolves across the WHOLE EPISODE', () => {
  // ⚠️ THIS REVERSES ROUND 14 ITEM 3, DELIBERATELY (V, round 21 item 1). That rule floored the
  // search at the expectation's own day so a "repeat CBC" could not be satisfied by the order that
  // prompted it. Right about repeats, wrong about everything else: most expectations are a
  // checkpoint noticing on day N that something ought to have happened, and the floor turned
  // "already done on day 0" into "never done".
  //
  // IPNO-486 measured it: an EEG billed on DAY 0, expected again at cp-d1 and cp-d2, each searching
  // only from its own day forward — two MAJOR omissions, 16 of that episode's 106 penalty points,
  // for a test the event list shows was performed. The day-2 entry even read "(if not yet
  // completed)": the model was asking whether it had already happened and the resolver could not look.
  const events = [labOrder('COMPLETE BLOOD COUNT', 0)];
  const r = resolveEntry(entry({ dayIndex: 2, byDay: 2, recurrence: 'once',
    matcher: { kind: 'lab', terms: ['complete blood count'] } }), events);
  assert.equal(r.resolution, 'present', 'a day-0 order answers a day-2 `once` expectation');
  assert.match(r.statement, /day 0/, 'and the statement names the day it actually happened');
});

test('DECISION 42: a `repeat` expectation is NOT satisfied by the order that prompted it', () => {
  // r-32 on IPNO-416, and the defect round 21 item 1 re-opened by widening the window for
  // everything. "Repeat CBC on day 2" answered by the DAY 0 order is the audit reporting a thing
  // was done, using as proof the very order whose repetition was being asked for.
  const events = [labOrder('COMPLETE BLOOD COUNT', 0)];
  const r = resolveEntry(entry({ dayIndex: 2, byDay: 2, recurrence: 'repeat',
    matcher: { kind: 'lab', terms: ['complete blood count'] } }), events);
  assert.notEqual(r.resolution, 'present', 'the day-0 order is not a day-2 repeat');
});

test('DECISION 42: the DEFAULT is `repeat` — a missing field must not silently satisfy', () => {
  // An omitted or unrecognised value takes the conservative direction: a wrong finding is visible
  // and arguable, a silently satisfied expectation is neither.
  const events = [labOrder('COMPLETE BLOOD COUNT', 0)];
  for (const rec of [undefined, 'sometimes' as never, '' as never, null as never]) {
    const r = resolveEntry(entry({ dayIndex: 2, recurrence: rec,
      matcher: { kind: 'lab', terms: ['complete blood count'] } }), events);
    assert.notEqual(r.resolution, 'present', `recurrence=${String(rec)} must default to repeat`);
  }
  assert.equal(asRecurrence(undefined), 'repeat');
  assert.equal(asRecurrence('nonsense'), 'repeat');
  assert.equal(asRecurrence('REPEAT'), 'repeat');
  assert.equal(asRecurrence('Once'), 'once', 'and `once` is honoured whatever its case');
});

test('DECISION 42: a `once` order on ANY day satisfies, and the day is reported honestly', () => {
  for (const day of [0, 2, 3]) {
    const r = resolveEntry(
      entry({ dayIndex: 2, recurrence: 'once', matcher: { kind: 'lab', terms: ['complete blood count'] } }),
      [labOrder('COMPLETE BLOOD COUNT', day)],
    );
    assert.equal(r.resolution, 'present', `a day-${day} order satisfies a day-2 expectation`);
    assert.match(r.statement, new RegExp(`day ${day}`));
  }
});

test('ROUND 21 ITEM 1: class presence is STILL day-scoped — the two are different questions', () => {
  // Matching asks "did this ever happen"; class presence asks "could it have been observed in the
  // window this expectation was about". Widening both would put back the four day-3 findings that
  // fired on a day with zero notes.
  const notesEarly = [noteEvent(0), noteEvent(1), noteEvent(2)];
  const r = resolveEntry(entry({ dayIndex: 3, matcher: { kind: 'note', terms: ['stent assessment'] } }), notesEarly);
  assert.equal(r.resolution, 'absent_class_missing');
  assert.equal(r.verdict, 'unassessable');
  assert.match(r.confound ?? '', /from day 3 onward/);
});

test('ITEM 2: a class empty in the expectation’s OWN window is unassessable, not divergent', () => {
  // THE IPNO-416 CASE: four day-3 findings fired as real divergences on a day with zero notes,
  // because notes existed on days 0-2 and the class counted as "represented".
  const notesEarly = [
    noteEvent(0), noteEvent(1), noteEvent(2),
  ];
  const r = resolveEntry(entry({ dayIndex: 3, matcher: { kind: 'note', terms: ['stent assessment'] } }), notesEarly);
  assert.equal(r.resolution, 'absent_class_missing');
  assert.equal(r.verdict, 'unassessable');
  assert.match(r.statement, /from day 3 onward/, 'and it says which window it could not answer for');
  assert.match(r.confound ?? '', /from day 3 onward/);
});

test('ITEM 2: a class present IN the window still yields a real divergence', () => {
  const events = [noteEvent(0), noteEvent(3)];
  const r = resolveEntry(entry({ dayIndex: 3, matcher: { kind: 'note', terms: ['stent assessment'] } }), events);
  assert.equal(r.resolution, 'absent_class_present');
  assert.equal(r.verdict, 'context_dependent', 'a note was written that day, but the matcher not firing is not proof');
});

test('ITEM 5: clinical shorthand is expanded before a negative may be asserted', () => {
  // "P/A- SOFT NONTENDER" IS an abdominal examination.
  const events = [noteEvent(1, 'o/e pallor+ BP-110/70 S/E- CVS-S1S2+ RS-B/L NVBS+ CNS-NAD P/A- SOFT NONTENDER')];
  const r = resolveEntry(entry({ dayIndex: 1, matcher: { kind: 'note', terms: ['abdominal examination'] } }), events);
  assert.equal(r.resolution, 'present', 'P/A is an abdominal examination');
  const sys = resolveEntry(entry({ dayIndex: 1, matcher: { kind: 'note', terms: ['systemic examination'] } }), events);
  assert.equal(sys.resolution, 'present', 'S/E is a systemic examination');
});

test('ITEM 5: every shorthand V named is covered, and expansion is additive and whole-token', () => {
  for (const tok of ['P/A', 'O/E', 'S/E', 'C/S/B', 'POD', 'K/C/O']) {
    assert.ok(CLINICAL_SHORTHAND[tok.toLowerCase()], `${tok} is expanded`);
    const out = expandClinicalShorthand(`note ${tok} something`);
    assert.ok(out.startsWith(`note ${tok} something`), 'the original text is never substituted away');
    assert.ok(out.length > `note ${tok} something`.length, `${tok} adds its expansion`);
  }
  // C/S/B is "Case Seen By" — read off the real note, where it precedes a doctor and a problem list
  assert.match(CLINICAL_SHORTHAND['c/s/b'], /case seen by/);
  // whole-token only: "hd" inside a word must not become dialysis
  assert.equal(expandClinicalShorthand('childhood asthma'), 'childhood asthma');
  assert.match(expandClinicalShorthand('for HD today'), /dialysis/);
});

test('ITEM 5: shorthand cannot manufacture a match out of nothing', () => {
  const events = [noteEvent(1, 'patient comfortable, no fresh complaints')];
  const r = resolveEntry(entry({ dayIndex: 1, matcher: { kind: 'note', terms: ['abdominal examination'] } }), events);
  assert.notEqual(r.resolution, 'present', 'a note with no examination shorthand still resolves absent');
});


// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 17 ITEM 1 — THE ESCALATION GATE, IN CODE
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test('ITEM 1: a trigger with a DRUG matcher does not become a divergent omission', () => {
  // THE EXACT CASE. The prompt's schema example suggests {"kind":"other"} in the escalation slot,
  // and until round 17 that suggestion was the only thing standing between a conditional and a
  // false finding. A model returning a drug matcher — a perfectly reasonable reading of "the
  // action they should trigger" — would have had this resolved as a drug lookup: no noradrenaline
  // order, pharmacy data present, therefore absent_class_present, therefore DIVERGENT. A patient
  // who never became hypotensive, marked as denied a vasopressor.
  const events = [drugOrder('PARACETAMOL 1G'), drugOrder('CEFAZOLIN 1G')];
  const r = resolveEntry(entry({
    section: 'escalation',
    item: 'SBP < 90 mmHg → start noradrenaline',
    matcher: { kind: 'drug', terms: ['noradrenaline'] },
  }), events);
  assert.notEqual(r.verdict, 'divergent', 'a conditional that never fired is not an omission');
  assert.equal(r.verdict, 'unassessable');
  assert.equal(r.resolution, 'absent_class_missing');
  assert.match(r.statement, /conditional/);
  assert.match(r.confound ?? '', /antecedent cannot be evaluated/);
});

test('ITEM 1: the gate holds for EVERY matcher kind, not just the one that was reported', () => {
  const events = [drugOrder('NORADRENALINE 2MG'), labOrder('LACTATE'), noteEvent(0, 'shock reviewed')];
  for (const kind of MATCHER_KINDS) {
    const r = resolveEntry(entry({
      section: 'escalation', item: 'trigger → action',
      matcher: { kind, terms: ['noradrenaline', 'lactate', 'shock'] },
    }), events);
    assert.equal(r.verdict, 'unassessable', `kind ${kind} must not produce a judgement`);
    assert.notEqual(r.resolution, 'present', `kind ${kind} must not claim the condition was met`);
  }
});

test('ITEM 1: the gate is keyed on the section, and NON-escalation sections are untouched', () => {
  const events = [drugOrder('PARACETAMOL 1G')];
  const therapeutic = resolveEntry(entry({
    section: 'therapeutics', item: 'VTE prophylaxis',
    matcher: { kind: 'drug', terms: ['enoxaparin'] },
  }), events);
  assert.equal(therapeutic.verdict, 'context_dependent', 'a plain expectation still resolves, now unasserted (decision 44)');
  // and run.ts pushes escalation entries under the exact constant the gate reads
  assert.equal(ESCALATION_SECTION, 'escalation');
  const run = readFileSync('lib/ipd-episode/compute.ts', 'utf8');  // lab-v2 decision 55
  assert.match(run, /push\(ESCALATION_SECTION,/, 'no repeated literal to drift from the gate');
});


// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ROUND 20 ITEM 1 / DECISION 41 — THE TERMINAL DAY IS UNASSESSABLE
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test('ITEM 1: the death values are exactly the three the mirror uses, case-insensitively', () => {
  // Derived from db13 kx_discharge_summary_records, all 2,496 rows, 14 distinct values.
  for (const v of ['Expired', 'expired', 'Admitted Dead', 'ADMITTED DEAD', 'Mortuary', 'mortuary']) {
    assert.equal(dischargeIndicatesDeath(v), true, v);
  }
  // BOTH capitalisations of mortuary exist in the data (3 + 2); a case-sensitive list would have
  // exempted three episodes and audited two of the same kind normally.
  assert.deepEqual([...DEATH_DISCHARGE_TYPES], ['expired', 'admitted dead', 'mortuary']);
});

test('ITEM 1: everything else audits NORMALLY — the failure direction V asked for', () => {
  for (const v of ['Normal Discharge', 'LAMA', 'DAMA', 'Discharge On Request', 'Referral',
                   'Refer External Hospital', 'Absconded', 'None', '', '   ', null, undefined]) {
    assert.equal(dischargeIndicatesDeath(v as string), false, String(v));
  }
  // ⚠️ `Early Neonatal` (n=1) is DELIBERATELY not matched. It may be a neonatal death category or a
  // discharge category and one row cannot settle it. Exempting on a guess silently stops auditing a
  // real admission; auditing a death as a discharge produces findings a human notices.
  assert.equal(dischargeIndicatesDeath('Early Neonatal'), false);
  // and no substring rule: a value merely CONTAINING a death word is not a death
  assert.equal(dischargeIndicatesDeath('Transferred to mortuary annexe'), false);
});

test('ITEM 1: an expectation formed ON the day of death is unassessable, not divergent', () => {
  // THE IPNO-573 CASE: three majors on day 5, the day the patient died, including hourly neuro obs.
  const events = [noteEvent(5, 'ward round'), drugOrder('NORADRENALINE', 5)];
  const onTheDay = resolveEntry(
    entry({ dayIndex: 5, section: 'monitoring', item: 'Hourly neurological assessment (GCS, pupil reactivity)',
            matcher: { kind: 'note', terms: ['neurological assessment', 'GCS'] } }),
    events, 5);
  assert.equal(onTheDay.verdict, 'unassessable');
  assert.equal(onTheDay.resolution, 'absent_class_missing');
  assert.match(onTheDay.statement, /on or after the day the patient died/);
  assert.match(onTheDay.confound ?? '', /day of death/);
});

test('ITEM 1: an expectation formed BEFORE the day of death is still judged', () => {
  const events = [noteEvent(3, 'ward round'), noteEvent(4, 'ward round')];
  const earlier = resolveEntry(
    entry({ dayIndex: 3, section: 'monitoring', item: 'Neurological assessment',
            matcher: { kind: 'note', terms: ['neurological assessment'] } }),
    events, 5);
  assert.notEqual(earlier.verdict, 'unassessable',
    'day 3 had a living patient and two days to act — that is assessable');
  assert.equal(earlier.resolution, 'absent_class_present');
});

test('ITEM 1: terminalDay null (an unrecognised discharge_type) changes nothing', () => {
  const events = [noteEvent(5, 'ward round')];
  const withGate = resolveEntry(entry({ dayIndex: 5, section: 'monitoring', item: 'X',
    matcher: { kind: 'note', terms: ['neuro'] } }), events, 5);
  const without = resolveEntry(entry({ dayIndex: 5, section: 'monitoring', item: 'X',
    matcher: { kind: 'note', terms: ['neuro'] } }), events, null);
  assert.equal(withGate.verdict, 'unassessable');
  assert.equal(without.verdict, 'context_dependent', 'an unknown discharge_type audits normally');
});

test('ITEM 1: resolveAll threads the terminal day, and the episode checkpoint is covered too', () => {
  // cp-episode carries day_index = losDays (assemble-core checkpointPlan), so on a death episode
  // its expectations open on the day of death and are covered by the same rule.
  const events = [noteEvent(2, 'ward round')];
  const entries = [
    entry({ ref: 'cp-d1/monitoring/1', dayIndex: 1, section: 'monitoring', matcher: { kind: 'note', terms: ['zzz'] } }),
    entry({ ref: 'cp-episode/monitoring/1', dayIndex: 2, section: 'monitoring', matcher: { kind: 'note', terms: ['zzz'] } }),
  ];
  const out = resolveAll(entries, events, 2).map((r) => r.outcome.verdict);
  assert.deepEqual(out, ['context_dependent', 'unassessable']);
});
