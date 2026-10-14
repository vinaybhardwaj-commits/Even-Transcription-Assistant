/**
 * lib/__tests__/stewardship-board.test.ts — S2 of the stewardship MS agent: the board's three
 * columns, its sort, and the danger queue's membership
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A5; spec §4, acceptance #2 / #3 / #7 / #16).
 *
 *   node --test --import tsx lib/__tests__/stewardship-board.test.ts
 *
 * The severity table itself is not re-tested here — `tierFor` has its own suite and this ship does
 * not touch it. What is tested is everything built ON it: which findings the queue admits, what a
 * pill does to one, the lexicographic sort that must never become a weighting, and the honesty copy
 * acceptance #3 asks for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { escalationMatch, tierFor } from '../severity-tier-core';
import {
  ipdDangerVerdict, ipdPillState, opdDangerVerdict, opdPillState, sortBoardRows,
  DANGER_QUEUE_UNIT, DISPUTE_PILLS, IPD_PILL_STATE, IPD_SPLIT_BANNER, IPD_STORED_VERDICTS,
  IPD_UNJOINED_CELL, OPD_PILL_STATE, STEWARDSHIP_HONESTY,
} from '../stewardship-danger-core';
import { BOARD_ESCALATION_PREFILTER, BOARD_INFERRED_SQL } from '../stewardship-board';
import { OPD_CANON_WHERE, OPD_TAIL_SHAPE_SQL, opdCanonical90d } from '../stewardship-canonical';
import { CANONICAL_RANK_SQL } from '../audit-canonical';
import { OPD_ENGINE_VERSIONS_CURRENT } from '../opd-note-audit-core';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const codeJsx = (p: string) => code(p).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const BOARD_PAGE = 'app/admin/stewardship/page.tsx';
const DEPT_PAGE = 'app/admin/stewardship/dept/[dept]/page.tsx';
const BOARD_LIB = 'lib/stewardship-board.ts';

// A tier-1 finding, straight out of the ratified escalation list (finding 36).
const ESCALATED = { signal_type: 'appropriateness_review', verdict: 'low-value', subject: 'Exertional chest pain sent home', rationale: 'Possible acute coronary syndrome routed to OPD review rather than emergency assessment.' };
// A tier-3 finding: logged, never queued.
const TIER3 = { signal_type: 'unverified_brand', verdict: 'low-value', subject: 'Brand not in the formulary', rationale: 'Brand could not be verified.' };
// Praise. It escalates on TEXT and must still never be queued.
const PRAISE = { signal_type: 'appropriateness_high_value', verdict: 'high-value', subject: 'Acute coronary syndrome referred to emergency', rationale: 'Correctly routed for immediate assessment.' };

// ── A5: the seven stored verdicts, mapped (acceptance #16) ────────────────────────────────

test('A5: the IPD mapping is the memo\'s, verdict by verdict', () => {
  assert.equal(ipdPillState('agree'), 'confirmed');
  assert.equal(ipdPillState('true_positive'), 'confirmed');
  assert.equal(ipdPillState('needs_action'), 'open');
  assert.equal(ipdPillState('contested'), 'open');
  assert.equal(ipdPillState('disagree'), 'dropped');
  assert.equal(ipdPillState('false'), 'dropped');
  assert.equal(ipdPillState('nitpick'), 'dropped');
  assert.equal(ipdPillState(null), 'open', 'no pill counts as open');
});

test('A5: every verdict the IPD route accepts is mapped — none falls through unnoticed', () => {
  for (const v of IPD_STORED_VERDICTS) {
    assert.ok(IPD_PILL_STATE[v], `${v} is stored by the route but has no mapping`);
  }
  // and an unrecognised string is OPEN, never silently dropped: removing a possible patient risk
  // from the list on the strength of a word nobody knows is the one unsafe direction here.
  assert.equal(ipdPillState('something_new'), 'open');
  assert.equal(opdPillState('something_new'), 'open');
});

test('A5 / §7: the IPD feedback route is UNTOUCHED — it still accepts what it accepted before', () => {
  const src = code('app/api/admin/ipd-audit-feedback/route.ts');
  for (const v of IPD_STORED_VERDICTS) assert.ok(src.includes(`'${v}'`), `the route no longer names ${v}`);
  assert.match(src, /const VERDICTS = new Set\(\[/);
  // the reader maps; the writer is not edited this ship
  assert.ok(!/stewardship/i.test(src), 'the stewardship ship must not have reached into the feedback route');
});

test('spec §4: the OPD mapping keeps confirmed visible and drops noise off the open count', () => {
  assert.equal(opdPillState('true_positive'), 'confirmed');
  assert.equal(opdPillState('contested'), 'open');
  assert.equal(opdPillState('needs_action'), 'open');
  assert.equal(opdPillState('nitpick'), 'dropped');
  assert.equal(opdPillState('false'), 'dropped');
  assert.equal(opdPillState(null), 'open');
  assert.deepEqual(Object.keys(OPD_PILL_STATE).sort(), ['contested', 'false', 'needs_action', 'nitpick', 'true_positive']);
});

// ── the pill-CLOSURE truth table, exhaustive (validation gap: opd_audit_feedback is PHI-blocked
// from the orchestrator's tool, so neither pill leg could be run end-to-end against the live DB.
// These are the compensating unit tests the validation asked for.) ────────────────────────────

test('closure: OPEN is no pill, contested, or needs_action — on BOTH legs', () => {
  for (const pill of [null, undefined, '', 'contested', 'needs_action']) {
    assert.equal(opdPillState(pill), 'open', `OPD: ${String(pill)} must be open`);
    assert.equal(ipdPillState(pill), 'open', `IPD: ${String(pill)} must be open`);
  }
});

test('closure: CLOSED is false, nitpick, and (inpatient) disagree', () => {
  for (const pill of ['false', 'nitpick']) {
    assert.equal(opdPillState(pill), 'dropped', `OPD: ${pill} must drop off the open count`);
    assert.equal(ipdPillState(pill), 'dropped', `IPD: ${pill} must drop off the open count`);
  }
  assert.equal(ipdPillState('disagree'), 'dropped');
});

test('closure: CONFIRMED is true_positive, and on the inpatient leg also agree', () => {
  assert.equal(opdPillState('true_positive'), 'confirmed');
  assert.equal(ipdPillState('true_positive'), 'confirmed');
  assert.equal(ipdPillState('agree'), 'confirmed');
  // confirmed is visible and NOT open — the distinction the board column depends on
  assert.equal(opdDangerVerdict(ESCALATED, 'true_positive').open, false);
  assert.equal(ipdDangerVerdict({ subject: 's', domain: 'safety', verdict: 'low-value' }, 'agree').open, false);
});

test('closure: praise never enters, at any pill value, on either leg', () => {
  for (const pill of [null, 'contested', 'needs_action', 'true_positive', 'agree', 'false', 'nitpick', 'disagree']) {
    assert.equal(opdDangerVerdict(PRAISE, pill).included, false, `OPD praise entered at pill ${String(pill)}`);
    assert.equal(
      ipdDangerVerdict({ subject: 'Standard prophylaxis given', domain: 'safety', verdict: 'high-value' }, pill).included,
      false, `IPD praise entered at pill ${String(pill)}`);
  }
});

// ── A5 fix (29 Aug validation §3.3): needs_action OPENS the queue on both legs ─────────────

test('A5: needs_action opens the OPD leg — today\'s count is 0 and the route still must exist', () => {
  // Measured 29 Aug: needs_action is an AUDIT-scope verdict and the current audit-scope count is 0,
  // so nothing is missed right now. There was also no route at all for one to enter if filed. There
  // is now.
  const v = opdDangerVerdict(TIER3, 'needs_action');
  assert.equal(v.included, true);
  assert.equal(v.leg, 'contested');
  assert.equal(v.open, true);
  assert.match(v.reason, /still needing action/);
  // and it does not pretend to be an argument — needs_action is agreement plus unfinished work
  assert.ok(!/contested/.test(v.reason));
});

test('A5: needs_action opens the inpatient leg — the one live row measured on 29 Aug', () => {
  // ipd_audit_feedback carries needs_action n=1 alongside contested 77. A NON-safety finding pilled
  // needs_action was excluded by the old outer filter. That is the exact shape of the live row.
  const nonSafety = ipdDangerVerdict(
    { subject: 'Discharge advice omits the anticoagulant stop date', domain: 'documentation', verdict: 'low-value' },
    'needs_action',
  );
  assert.equal(nonSafety.included, true, 'A5 says needs_action counts as open — membership must admit it');
  assert.equal(nonSafety.open, true);
  assert.equal(nonSafety.leg, 'contested');
  // and the SQL that finds it must admit it too, or the membership rule never sees the row
  for (const key of ['danger_contested', 'danger_ipd', 'danger_ipd_count'] as const) {
    assert.match(BOARD_INFERRED_SQL[key], /pill = ANY\(\$\d::text\[\]\)/,
      `${key} must filter on the dispute list, not on a single hard-coded verdict`);
    assert.ok(!/pill = 'contested'/.test(BOARD_INFERRED_SQL[key]),
      `${key} still hard-codes contested as the only dispute`);
  }
  assert.deepEqual([...DISPUTE_PILLS], ['contested', 'needs_action']);
});

// ── membership (acceptance #7) ────────────────────────────────────────────────────────────

test('acceptance #7: an OPD tier-1 finding appears in the queue and counts open', () => {
  assert.equal(tierFor(ESCALATED).tier, 1);
  const v = opdDangerVerdict(ESCALATED, null);
  assert.equal(v.included, true);
  assert.equal(v.leg, 'escalation');
  assert.equal(v.open, true);
  assert.equal(v.escalatedBy, 'E-1');
});

test('acceptance #7: a `false`-pilled finding does not count as open', () => {
  const v = opdDangerVerdict(ESCALATED, 'false');
  assert.equal(v.included, true, 'it is still a tier-1 finding — it is the COUNT it leaves, not the record');
  assert.equal(v.open, false);
  assert.equal(v.state, 'dropped');
  assert.equal(opdDangerVerdict(ESCALATED, 'nitpick').open, false);
});

test('acceptance #7: a confirmed tier-1 finding stays visible as confirmed, not as open', () => {
  const v = opdDangerVerdict(ESCALATED, 'true_positive');
  assert.equal(v.included, true);
  assert.equal(v.state, 'confirmed');
  assert.equal(v.open, false);
});

test('praise never enters the queue — not even when it is contested', () => {
  assert.equal(tierFor(PRAISE).tier, 'praise');
  assert.equal(opdDangerVerdict(PRAISE, null).included, false);
  assert.equal(opdDangerVerdict(PRAISE, 'contested').included, false, 'a contested praise is still praise');
  assert.equal(ipdDangerVerdict({ subject: 'Standard prophylaxis given', domain: 'safety', verdict: 'high-value' }, null).included, false);
});

test('tier 3 is logged, not queued — unless a reviewer contests it', () => {
  assert.equal(tierFor(TIER3).tier, 3);
  assert.equal(opdDangerVerdict(TIER3, null).included, false);
  const contested = opdDangerVerdict(TIER3, 'contested');
  assert.equal(contested.included, true, 'the dispute leg is not a severity claim — it is an unresolved disagreement');
  assert.equal(contested.leg, 'contested');
  assert.equal(contested.open, true);
});

test('IPD membership is the STORED domain and the pill — no invented severity regex', () => {
  const safety = ipdDangerVerdict({ subject: 'Anticoagulant restarted without a platelet count', domain: 'safety', verdict: 'low-value' }, null);
  assert.equal(safety.included, true);
  assert.equal(safety.open, true);
  assert.equal(ipdDangerVerdict({ subject: 'Longer stay than the procedure needs', domain: 'efficiency', verdict: 'low-value' }, null).included, false);
  assert.equal(ipdDangerVerdict({ subject: 'Longer stay than the procedure needs', domain: 'efficiency', verdict: 'low-value' }, 'contested').included, true);
  // needs_action on a safety finding is OPEN — a human said something must still happen
  assert.equal(ipdDangerVerdict({ subject: 's', domain: 'safety', verdict: 'low-value' }, 'needs_action').open, true);
  assert.equal(ipdDangerVerdict({ subject: 's', domain: 'safety', verdict: 'low-value' }, 'agree').state, 'confirmed');
  assert.equal(ipdDangerVerdict({ subject: 's', domain: 'safety', verdict: 'low-value' }, 'disagree').open, false);
  // no text is ever read for severity on this surface
  const src = code('lib/stewardship-danger-core.ts');
  assert.ok(!/new RegExp|\/\^|E1_RE|E2_/.test(src.replace(/'E-[12]'/g, '')), 'no IPD severity regex may be invented here');
});

// ── the sort (acceptance #2, D-no-composite) ──────────────────────────────────────────────

const row = (openDangerous: number, avgNqi: number, ipdCvi: number | null, label: string) =>
  ({ openDangerous, avgNqi, ipdCvi, label });

test('acceptance #2: dangerous desc, then Avg NQI ascending, then IPD — and nothing else', () => {
  const sorted = sortBoardRows([
    row(0, 40, null, 'quiet but weak'),
    row(3, 90, null, 'strong but dangerous'),
    row(3, 60, null, 'dangerous and weaker'),
    row(0, 40, 55, 'quiet, weak, inpatient joined'),
  ]);
  assert.deepEqual(sorted.map((r) => r.label), [
    'dangerous and weaker',       // 3 open, NQI 60
    'strong but dangerous',       // 3 open, NQI 90
    'quiet, weak, inpatient joined',  // 0 open, NQI 40, IPD 55 — a joined row outranks an unjoined tie
    'quiet but weak',
  ]);
});

test('D-no-composite: an unjoined IPD cell sorts LAST, never as a zero', () => {
  const sorted = sortBoardRows([row(0, 50, null, 'unjoined'), row(0, 50, 10, 'joined and poor')]);
  assert.deepEqual(sorted.map((r) => r.label), ['joined and poor', 'unjoined'],
    'ranking an absent measurement as the worst score would be a claim nobody made');
});

test('D-no-composite: the board computes no weighted index anywhere', () => {
  for (const f of [BOARD_LIB, 'lib/stewardship-danger-core.ts', BOARD_PAGE]) {
    const src = code(f);
    assert.ok(!/\b(composite|stewardshipIndex|combinedIndex)\b/i.test(src), `${f} names a composite index`);
    // the shape a weighting would take: an arithmetic operator between two of the three columns
    assert.ok(!/(avgNqi|ipdCvi|openDangerous)\s*[*+]\s*[\d.]+/.test(src), `${f} weights a board column`);
    assert.ok(!/[\d.]+\s*\*\s*(avgNqi|ipdCvi|openDangerous)/.test(src), `${f} weights a board column`);
  }
});

// ── the escalation prefilter is a SUPERSET, and a tripwire guards it ──────────────────────

const prefilterHits = (text: string) =>
  BOARD_ESCALATION_PREFILTER.some((p) => text.toLowerCase().includes(p.replace(/%/g, '').toLowerCase()));

test('the SQL prefilter is a superset of the ratified escalation patterns', () => {
  // Every string tierFor escalates must survive the narrowing, or the queue would silently stop
  // finding it. The prefilter is allowed to be wider; it is not allowed to be narrower.
  const corpus = [
    'Possible acute coronary syndrome routed to OPD review',
    'Query ACS, advised outpatient follow-up',
    'Unstable angina managed as gastritis',
    'Myocardial infarction not considered',
    'Exertional chest pain with no ECG',
    'Exertional chest heaviness, reassured',
    'Persistent neck swelling for 6 weeks with no investigation ordered',
    'Unexplained cervical lymphadenopathy present two months, no work-up',
  ];
  for (const text of corpus) {
    assert.ok(escalationMatch({ subject: text, rationale: '' }), `fixture does not escalate: ${text}`);
    assert.ok(prefilterHits(text), `the prefilter would MISS an escalated finding: ${text}`);
  }
});

test('tripwire: a new escalation entry breaks this test rather than the queue', () => {
  // The prefilter was built for exactly two escalation matchers. If a third is ratified with new
  // vocabulary, this fails HERE — in the same change — instead of the queue quietly going blind.
  const src = read('lib/severity-tier-core.ts');
  const names = [...src.matchAll(/^const (E\d[A-Z0-9_]*_RE)\b/gm)].map((m) => m[1]).sort();
  assert.deepEqual(names, ['E1_RE', 'E2_ENTITY_RE', 'E2_FOLLOWTHROUGH_RE', 'E2_MONTHS_RE', 'E2_NEGATION_STRIP_RE', 'E2_WEEKS_RE', 'E2_WORD_DURATION_RE'],
    'the ratified escalation matchers changed — revisit BOARD_ESCALATION_PREFILTER in this same change');
  // and the decision still belongs to tierFor, not to the SQL
  assert.ok(code(BOARD_LIB).includes('opdDangerVerdict'), 'the board must ask the tier core, not the ILIKE');
});

// ── copy (acceptance #3) ──────────────────────────────────────────────────────────────────

test('acceptance #3: the "not a clinician scorecard" clause is gone from this room', () => {
  for (const f of [BOARD_PAGE, DEPT_PAGE]) {
    const src = codeJsx(f);
    assert.ok(!/not a (standalone )?clinician score/i.test(src), `${f} still calls this not a clinician score`);
    assert.ok(!/clinician scorecard/i.test(src), `${f} still says clinician scorecard`);
  }
});

test('acceptance #3: what replaces it says who never sees this', () => {
  assert.match(STEWARDSHIP_HONESTY, /Internal medical-superintendent stewardship/);
  assert.match(STEWARDSHIP_HONESTY, /Never shown to the clinician being reviewed or to any patient/);
  assert.match(STEWARDSHIP_HONESTY, /advisory rule and model outputs/);
  assert.ok(!/scorecard|accreditation|NABH/i.test(STEWARDSHIP_HONESTY));
  for (const f of [BOARD_PAGE, DEPT_PAGE]) assert.ok(code(f).includes('STEWARDSHIP_HONESTY'), `${f} does not show the honesty line`);
});

test('A1: the split banner is on the board, and the IPD cell is a banner rather than a number', () => {
  assert.equal(IPD_SPLIT_BANNER, 'OPD and IPD are not the same physician key on this spine.');
  const src = code(BOARD_PAGE);
  assert.ok(src.includes('IPD_SPLIT_BANNER'));
  assert.ok(src.includes('IPD_UNJOINED_CELL'));
  assert.equal(IPD_UNJOINED_CELL, 'IPD unjoined');
});

test('§1.4: the danger queue states its reporting unit', () => {
  // TWO units, and the sentence must name both: the counts are over every eligible finding
  // (`opdOpen += r.occurrences` re-expands twins; the inpatient count never groups at all), while
  // only the LIST collapses a twin into one row. The earlier wording named only the second and
  // invited the reader to assume the headline shared it.
  assert.match(DANGER_QUEUE_UNIT, /Open counts are over every eligible finding/);
  assert.match(DANGER_QUEUE_UNIT, /In the list below/);
  assert.match(DANGER_QUEUE_UNIT, /grouped into one row, with a count/);
  assert.ok(!/^One row per finding/.test(DANGER_QUEUE_UNIT),
    'the sentence must not open by claiming one unit for both the count and the list');
  assert.ok(code(BOARD_PAGE).includes('DANGER_QUEUE_UNIT'));
  assert.ok(code(BOARD_LIB).includes('dedupeTwins'), 'the canonical twin helper is what collapses them');
});

// ── §6a — fail-safe, read-only, study-filtered ────────────────────────────────────────────

test('§6a: every board query is a SELECT and the board writes nothing', () => {
  const src = code(BOARD_LIB);
  assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE)\b/i.test(src));
  assert.ok(!/physician_standing/i.test(src), 'the standing overlay is S4');
  for (const [name, q] of Object.entries(BOARD_INFERRED_SQL)) {
    assert.match(q.trim(), /^SELECT\b/i, `${name} is not a SELECT`);
  }
});

test('§8: every read of opd_audit_feedback carries the study predicate', () => {
  for (const [name, q] of Object.entries(BOARD_INFERRED_SQL)) {
    const reads = (q.match(/FROM opd_audit_feedback/g) ?? []).length;
    const preds = (q.match(/study IS NOT DISTINCT FROM/g) ?? []).length;
    assert.equal(reads, preds, `${name}: ${reads} read(s) of opd_audit_feedback, ${preds} study predicate(s)`);
  }
});

// ── the three 29 Aug defects, each with the shape that would let it back in ───────────────

test('defect 1: the inpatient COUNT is uncapped and the LIST is deterministic, newest first', () => {
  const count = BOARD_INFERRED_SQL.danger_ipd_count;
  const list = BOARD_INFERRED_SQL.danger_ipd;

  // The count must not carry a LIMIT at all — the board's headline number must not be a function of
  // a display slice. It groups instead, so the result stays small however large the corpus grows.
  assert.ok(!/\bLIMIT\b/i.test(count.replace(/LIMIT 1\n/g, '')),
    'the eligible-row COUNT must be uncapped (the 29 Aug defect: 500 counted, 1248 eligible)');
  assert.match(count, /GROUP BY 1, 2, 3, 4/);
  assert.match(count, /count\(\*\)::int AS n/);

  // The list may cap, but never arbitrarily: newest audit first, with a deterministic tiebreak.
  assert.match(list, /ORDER BY q\.audited_at_raw DESC NULLS LAST, q\.audit_id, q\.subject/);
  assert.ok(!/ORDER BY q\.audit_id, q\.subject\s*\n\s*LIMIT/.test(list),
    'ordering a capped list by row uuid drops findings by primary key');

  // and the two must agree on what "eligible" means — one clause, two readers
  const eligible = /q\.domain = 'safety' OR q\.pill = ANY\(\$3::text\[\]\)/;
  assert.match(count, eligible);
  assert.match(list, eligible);
});

test('defect 1: no queue query orders a capped list by a primary key', () => {
  for (const [name, q] of Object.entries(BOARD_INFERRED_SQL)) {
    if (!/\bLIMIT \d/.test(q)) continue;
    const order = q.match(/ORDER BY ([^\n]*)\n\s*LIMIT/);
    if (!order) continue;
    const key = order[1];
    assert.ok(/DESC|note_date|note_day|audited_at|n_notes/.test(key),
      `${name} caps on an arbitrary ordering: ORDER BY ${key}`);
  }
});

test('defect 2: pills are found through the NOTE uid, never through the canonical row id', () => {
  // 23% of window rows are non-canonical (29,255 rows over 22,404 uids). A pill left on one of them
  // was invisible: on the contested leg a dispute vanished from the queue, and on the escalation leg
  // a finding CLOSED as `false` went on being counted open.
  const esc = BOARD_INFERRED_SQL.danger_escalation;
  const con = BOARD_INFERRED_SQL.danger_contested;

  assert.match(esc, /JOIN opd_note_audits av ON av\.id = v\.audit_id/);
  assert.match(esc, /WHERE av\.uid = t\.uid/);
  assert.ok(!/v\.audit_id = t\.id/.test(esc), 'the escalation pill lateral still keys on the canonical row id');

  assert.match(con, /JOIN opd_note_audits a ON a\.id = fb\.audit_id/);
  assert.match(con, /JOIN \( SELECT DISTINCT ON \(uid\)[\s\S]*?\) t ON t\.uid = a\.uid/);
  assert.ok(!/ON t\.id = fb\.audit_id/.test(con), 'the contested leg still joins feedback to the canonical row id');

  // current-state must now be settled per NOTE, not per audit row: once pills from every row of a
  // note count, two rows of one note could otherwise contribute a contested AND a false at once.
  assert.match(con, /SELECT DISTINCT ON \(t\.uid, fb\.finding_ref\)/);
  assert.match(con, /ORDER BY t\.uid, fb\.finding_ref, fb\.created_at DESC/);

  // and the finding TEXT comes from the row the reviewer actually pilled
  assert.match(con, /jsonb_typeof\(a\.findings\)/);
});

// ── defect 4: the version-sort cast must survive a suffixed family entry ──────────────────

/** Postgres' `string_to_array(split_part(v,'/',2),'.')::int[]`, including the RAISE that a
 *  non-numeric component produces. Mirrors the simulator in audit-canonical-sql-twin.test.ts. */
const castTail = (v: string): number[] => v.split('/')[1].split('.').map((c) => {
  if (!/^\d+$/.test(c)) throw new Error(`invalid input syntax for type integer: "${c}"`);
  return Number(c);
});
/** The exported shape guard, evaluated the way Postgres would evaluate the `~` operator. */
const shapeGuardAdmits = (v: string): boolean => /^[0-9]+(\.[0-9]+)*$/.test(v.split('/')[1] ?? '');

test('defect 4: a suffixed entry in the engine family cannot crash the board queries', () => {
  // MEASURED 29 Aug: `opd-note-audit/0.81.20-mini` exists with 236 rows, and an independent
  // recompute that reached it died with `invalid input syntax for type integer: "20-mini"`. Today
  // the explicit family list is all that stops it. One append to OPD_ENGINE_VERSIONS_CURRENT would
  // make every board query and every Ask-material query throw at once.
  const SUFFIXED = 'opd-note-audit/0.81.20-mini';

  // 1. the cast really does raise on it — the test is discriminating, not decorative
  assert.throws(() => castTail(SUFFIXED), /invalid input syntax for type integer: "20-mini"/);
  assert.deepEqual(castTail('opd-note-audit/0.81.21'), [0, 81, 21]);

  // 2. the shape guard excludes it BEFORE the cast can see it, and admits every real family member
  assert.equal(shapeGuardAdmits(SUFFIXED), false);
  assert.equal(shapeGuardAdmits('opd-note-audit/0.5-verify'), false, 'the non-mini trap tail too');
  for (const v of OPD_ENGINE_VERSIONS_CURRENT) assert.equal(shapeGuardAdmits(v), true, `${v} must still be admitted`);

  // 3. the guard is actually in the shared WHERE, ahead of the ORDER BY that carries the cast
  assert.ok(OPD_CANON_WHERE.includes(OPD_TAIL_SHAPE_SQL), 'the shared basis must carry the tail-shape guard');
  assert.match(CANONICAL_RANK_SQL, /::int\[\] DESC/, 'the fragment this guards still casts');
  const q = opdCanonical90d('doctor_uid');
  assert.ok(q.indexOf(OPD_TAIL_SHAPE_SQL) < q.indexOf('ORDER BY'), 'the guard must be in the WHERE, not the ORDER BY');

  // 4. every composed query carries it — a guard on one string is not a guard
  for (const [name, sqlText] of Object.entries(BOARD_INFERRED_SQL)) {
    if (!sqlText.includes('opd_note_audits')) continue;
    assert.ok(sqlText.includes(OPD_TAIL_SHAPE_SQL), `${name} would crash on a suffixed family entry`);
  }
});

// ── F-2 (V locked): one window basis everywhere ───────────────────────────────────────────

test('F-2: the board window is the IST calendar day, matching lib/opd-audit-doctor.ts', () => {
  assert.match(OPD_CANON_WHERE,
    /\(note_date AT TIME ZONE 'Asia\/Kolkata'\)::date >= \(now\(\) AT TIME ZONE 'Asia\/Kolkata'\)::date - \(\$2\)::int/);
  assert.ok(!/NOW\(\) - \(\$2 \|\| ' days'\)::interval/.test(OPD_CANON_WHERE),
    'the instant-based window is gone — one basis everywhere (V, 29 Aug)');
  // the same shape the dept helpers already used (they interpolate the IST cast, so the pin is on
  // the template they compose, not on a rendered copy of it)
  const helpers = read('lib/opd-audit-doctor.ts');
  assert.ok(helpers.includes("const IST = \"AT TIME ZONE 'Asia/Kolkata'\""),
    'the dept helpers must still build their window from the IST cast');
  assert.ok(helpers.includes('const WIN90 = `(note_date ${IST})::date >= (now() ${IST})::date - 90`'),
    'the basis being matched must still be the calendar-day window in lib/opd-audit-doctor.ts');
});

test('A6: the inpatient danger read cannot see the stay auditor\'s rows', () => {
  const q = BOARD_INFERRED_SQL.danger_ipd;
  assert.match(q, /SELECT DISTINCT ON \(ip_uid\) ip_uid/);
  assert.match(q, /engine_version = \$1/);
  assert.ok(!q.includes('ipd-stay-audit'), 'the stay engine must not be named');
  // and no clinician is attributed on that leg — the hop is S3's
  assert.ok(!/doctor_uid|doctor_directory/.test(q), 'the inpatient leg must not claim a clinician');
});

// ── S3: the inpatient column, the slice, and the one decision worth arguing with ───────────

test('S3: the board reads the canonical stays on A6\'s recipe and joins no clinician in SQL', () => {
  const q = BOARD_INFERRED_SQL.ipd_board_stays;
  assert.match(q, /SELECT DISTINCT ON \(ip_uid\) ip_uid/);
  assert.match(q, /engine_version = \$1/);
  assert.match(q, /ORDER BY ip_uid, audited_at DESC/);
  assert.ok(!q.includes('ipd-stay-audit'), 'the stay engine never enters the board aggregate (A6)');
  // A1 — the clinician cannot be in this query: the column does not exist and the hop is in db13.
  assert.ok(!/doctor_uid|doctor_directory|practitioner/i.test(q),
    'the inpatient stay read must claim no clinician — the hop is read-time and lives elsewhere');
});

test('S3: an unresolved clinician keeps a NULL inpatient cell, which sorts last', () => {
  // The board type says `number | null` and the sort treats null as "no measurement". A zero here
  // would rank an unjoined clinician as the worst inpatient performer in the hospital.
  const sorted = sortBoardRows([
    row(0, 70, null, 'no stays resolved'),
    row(0, 70, 30, 'resolved and poor'),
  ]);
  assert.deepEqual(sorted.map((r) => r.label), ['resolved and poor', 'no stays resolved']);
});

test('S3: the per-clinician danger count stays OPD-only, and the code says why', () => {
  // The one S3 judgement call, flagged for V. Folding a 46%-resolvable hop into the leaderboard's
  // PRIMARY SORT KEY would rank a clinician safer for having an ambiguous practitioner id.
  const src = read(BOARD_LIB);
  assert.match(src, /THE PER-CLINICIAN COUNT IS OPD-ONLY, DELIBERATELY/);
  assert.match(src, /rank a clinician safer for having an ambiguous practitioner id/);
  // the inpatient rows still carry a NAME where the hop resolved — visibility without ranking
  assert.match(code(BOARD_LIB), /const resolvedUid = res\?\.reason === 'resolved' \? res\.doctorUid : null/);
});

test('S3: the department roll-up never borrows an inpatient number for an OPD label', () => {
  // F-10 confirmed hard on 29 Aug: only 2 of 14 labels match as exact strings across the two
  // vocabularies. Rolling resolved stays up through a clinician's OPD department would perform the
  // merge by the back door.
  const src = read(BOARD_LIB);
  assert.match(src, /stays NULL by decision, not by omission/);
  const deptFn = src.slice(src.indexOf('export async function fetchDeptBoard'));
  assert.match(deptFn.slice(0, deptFn.indexOf('\n}')), /ipdCvi: null, ipdStays: 0/,
    'the department roll-up must leave the inpatient cell unfilled');
});
