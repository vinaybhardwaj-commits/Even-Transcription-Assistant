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

test('ABSENT with the class represented resolves divergent at the PROPOSED severity', () => {
  const events = [drugOrder('PARACETAMOL 1G'), drugOrder('CEFAZOLIN 1G')];
  const r = resolveEntry(entry({ proposedSeverity: 'major', matcher: { kind: 'drug', terms: ['enoxaparin', 'heparin'] } }), events);
  assert.equal(r.resolution, 'absent_class_present');
  assert.equal(r.verdict, 'divergent');
  assert.equal(r.severity, 'major', 'severity was chosen while the model was blinded, and code does not revisit it');
  assert.match(r.statement, /the absence is real/);
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
  assert.equal(r.verdict, 'divergent');
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
  // The resolver asks its question of the WHOLE episode, so today two entries with the same
  // matcher always resolve alike and this case cannot arise through resolveAll. Resolution and
  // verdict are in the grouping key anyway, and this test pins the key directly — because the
  // day the resolver becomes day-aware (an expectation "by day 2" that was met on day 4 is a
  // timing finding waiting to be written) is the day a matcher-only key would silently merge a
  // day it happened into a group that says it did not. That is concordant-erasure, which this
  // engine has already had to fix once.
  const e = dayEntry(0, ['enoxaparin']);
  const done = { resolution: 'present' as const, verdict: 'concordant' as const };
  const missed = { resolution: 'absent_class_present' as const, verdict: 'divergent' as const };
  const key = (o: { resolution: 'present' | 'absent_class_present'; verdict: 'concordant' | 'divergent' }) =>
    resolverGroupKey(e, { ...o, severity: 'major', statement: 's', matchedEvent: null, matchedTerm: null, confound: null });
  assert.notEqual(key(done), key(missed), 'the same expectation with two different answers is two findings');
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

test('ITEM 3: a repeat expectation is NOT satisfied by the order that prompted it', () => {
  // r-32 on IPNO-416: "repeat CBC" expected at the day-2 checkpoint, marked present by the DAY 0
  // order. The audit reported a thing was done using as proof the very order whose repetition was
  // being asked for — a silent false negative, and the exact failure the engine exists to catch.
  const events = [labOrder('COMPLETE BLOOD COUNT', 0)];
  const r = resolveEntry(entry({ dayIndex: 2, byDay: 2, matcher: { kind: 'lab', terms: ['complete blood count'] } }), events);
  assert.notEqual(r.resolution, 'present', 'the day-0 order is not a day-2 repeat');
});

test('ITEM 3: an order ON or AFTER the expectation’s day does satisfy it', () => {
  for (const day of [2, 3]) {
    const r = resolveEntry(
      entry({ dayIndex: 2, matcher: { kind: 'lab', terms: ['complete blood count'] } }),
      [labOrder('COMPLETE BLOOD COUNT', day)],
    );
    assert.equal(r.resolution, 'present', `a day-${day} order satisfies a day-2 expectation`);
    assert.match(r.statement, new RegExp(`day ${day}`), 'and the statement names the day it actually happened');
  }
});

test('ITEM 3: the window is the day the expectation was FORMED, not its by_day deadline', () => {
  // formed at day 2, wanted by day 4: an order on day 3 counts (it is after the checkpoint), and
  // lateness against by_day is a timing question, not an eligibility one.
  const r = resolveEntry(
    entry({ dayIndex: 2, byDay: 4, matcher: { kind: 'lab', terms: ['complete blood count'] } }),
    [labOrder('COMPLETE BLOOD COUNT', 3)],
  );
  assert.equal(r.resolution, 'present');
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
  assert.equal(r.verdict, 'divergent', 'a note WAS written that day and it does not mention the thing');
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
  assert.equal(therapeutic.verdict, 'divergent', 'a plain expectation still resolves normally');
  // and run.ts pushes escalation entries under the exact constant the gate reads
  assert.equal(ESCALATION_SECTION, 'escalation');
  const run = readFileSync('lib/ipd-episode/run.ts', 'utf8');
  assert.match(run, /push\(ESCALATION_SECTION,/, 'no repeated literal to drift from the gate');
});
