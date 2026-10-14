// Concept Coder Phase 1 core (CDMSS-CONCEPT-CODER-PRD v1.0 §9). Pure-core tests only — no DB, no
// model calls. The extraction-call tests use a stub in place of governedChat, so "zero model calls"
// is asserted by counting invocations, not inferred.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeConceptSubject, normalizeSlot, composeConceptId, baseConceptId, computeReviewLane,
  validateExtraction, stampConcepts, pendingSubjects, isCodableFinding, resolveTarget,
  applyCollapseRules, isGuardedBrandToken, isConceptDirection, CONCEPT_DIRECTIONS,
  CLEAN_LANE_MIN_CONTEXT_FREE_SHARE, EMPTY_TARGET_SENTINEL, usesEmptyTargetSentinel,
  deriveConceptState, codedPct, cacheHitPct, rejectedRecent, buildConceptStatus, CONCEPT_CRON_MIN,
  type ConceptAssignment, type TargetResolution, type ConceptTickRow, type ConceptStatusRaw,
} from '../even-concept-core';
import { normalizeSubject } from '../even-lvc-core';
import { computeOpdScore } from '../opd-note-score-core';

const lv = (over: Record<string, unknown> = {}) => ({
  subject: 'unindicated antibiotic prescription', verdict: 'low-value', confidence: 0.8,
  domain: 'appropriateness', rationale: 'r', ...over,
});

// ── normalisation compatibility (load-bearing: the 9,449 seeded norms use the house rule) ──
test('normalizeConceptSubject is byte-identical to the house normalizeSubject', () => {
  const cases = ['  Unindicated  Antibiotic ', 'CBC (Complete Blood Count).', 'x', '', '   ', 'a.b..', 'Montek LC...'];
  for (const c of cases) assert.equal(normalizeConceptSubject(c), normalizeSubject(c), JSON.stringify(c));
  assert.equal(normalizeConceptSubject(null), '');
  assert.equal(normalizeConceptSubject(undefined), '');
});

test('normalizeSlot strips inner colons so a slot can never inject an extra id segment', () => {
  assert.equal(normalizeSlot('rx:antibiotic'), 'rx antibiotic');
  assert.equal(composeConceptId({ direction: 'overuse', action: 'rx:evil', target: 'x' }), 'overuse:rx evil:x');
});

// ── composition ────────────────────────────────────────────────────────────────
test('composeConceptId builds direction:action:target and refuses a bad direction or blank action', () => {
  // NOTE: before the §3.1 sentinel (V ruling, 26 Jul) this test also asserted that a blank TARGET
  // composed to null. That is now the ONE recoverable case — see the §3.1 block above. The other
  // two refusals are unchanged and deliberately re-asserted here so the sentinel cannot widen.
  assert.equal(composeConceptId({ direction: 'overuse', action: 'rx', target: 'antibiotic' }), 'overuse:rx:antibiotic');
  assert.equal(composeConceptId({ direction: 'overuse', action: '', target: 'antibiotic' }), null);
  // a direction outside the closed vocabulary can never compose (PRD §9)
  assert.equal(composeConceptId({ direction: 'exclude_test_note' as never, action: 'rx', target: 'x' }), null);
});

// ── §3.1 the empty-target sentinel (V ruling, 26 Jul) ──────────────────────────
test('§3.1 sentinel: an empty target composes to :regimen with a valid direction + action', () => {
  assert.equal(EMPTY_TARGET_SENTINEL, 'regimen');
  assert.equal(composeConceptId({ direction: 'overuse', action: 'polypharmacy', target: '' }), 'overuse:polypharmacy:regimen');
  assert.equal(composeConceptId({ direction: 'documentation', action: 'rx', target: '   ' }), 'documentation:rx:regimen');
  assert.equal(composeConceptId({ direction: 'overuse', action: 'other', target: 'null' }), 'overuse:other:regimen');
  assert.equal(usesEmptyTargetSentinel('overuse:polypharmacy:regimen'), true);
  assert.equal(usesEmptyTargetSentinel('overuse:rx:antibiotic'), false);
  assert.equal(usesEmptyTargetSentinel('overuse:polypharmacy:regimen:urti'), true);   // folds to base first
});

test('§3.1 the named case: overuse:polypharmacy: ⇒ overuse:polypharmacy:regimen', () => {
  const parts = 'overuse:polypharmacy:'.split(':');
  assert.equal(composeConceptId({ direction: parts[0] as never, action: parts[1], target: parts[2] }), 'overuse:polypharmacy:regimen');
});

test('§3.1 the sentinel is NOT a catch-all: exclude_test_note is still rejected, never routed to it', () => {
  assert.equal(composeConceptId({ direction: 'exclude_test_note' as never, action: 'documentation', target: '' }), null);
  assert.equal(composeConceptId({ direction: 'exclude_test_note' as never, action: 'other', target: 'test' }), null);
  const r = validateExtraction('{"direction":"exclude_test_note","action":"rx","target":""}');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'bad_direction');   // NOT missing_slot, NOT a sentinel stamp
});

test('§3.1 the sentinel is NOT a catch-all: an out-of-vocabulary direction is still rejected', () => {
  for (const d of ['misuse', 'OVERUSE', '', 'overuse ', 'unknown']) {
    assert.equal(composeConceptId({ direction: d as never, action: 'rx', target: '' }), null, d);
  }
  const r = validateExtraction('{"direction":"misuse","action":"rx","target":""}');
  assert.equal((r as { reason: string }).reason, 'bad_direction');
});

test('§3.1 the sentinel recovers ONLY an empty target — a blank ACTION is still a reject', () => {
  assert.equal(composeConceptId({ direction: 'overuse', action: '', target: '' }), null);
  assert.equal(composeConceptId({ direction: 'overuse', action: '   ', target: 'antibiotic' }), null);
  const r = validateExtraction('{"direction":"overuse","action":"","target":""}');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'missing_slot');
});

test('§3.1 an extraction with an empty target validates to the sentinel, slots and id agreeing', () => {
  const r = validateExtraction('{"direction":"overuse","action":"polypharmacy","target":"","context":"urti"}');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.conceptId, 'overuse:polypharmacy:regimen');
  assert.equal(r.slots.target, 'regimen');       // slots must not disagree with the composed id
  assert.equal(r.slots.context, 'urti');
});

test('§3.1 review_lane computes normally for a sentinel concept', () => {
  // A sentinel concept is an ordinary concept for lane purposes — the empty slot is the TARGET, and
  // a row can carry a blank target AND a context ("overuse:polypharmacy::urti"). Measured on the
  // shipped seed, overuse:polypharmacy:regimen lands in the CONTEXT lane, which is the useful
  // outcome: the reviewer rules "is this prescription over-loaded for URTI?", not in the abstract.
  assert.equal(computeReviewLane(33, 10), 'context');
  assert.equal(computeReviewLane(33, 33), 'clean');     // and would be clean if none carried a context
});

test('baseConceptId folds a context-qualified id onto its base', () => {
  assert.equal(baseConceptId('overuse:rx:antibiotic:viral urti'), 'overuse:rx:antibiotic');
  assert.equal(baseConceptId('overuse:rx:antibiotic'), 'overuse:rx:antibiotic');
});

test('the direction vocabulary is closed to exactly the four structural values', () => {
  assert.deepEqual([...CONCEPT_DIRECTIONS], ['overuse', 'underuse', 'documentation', 'process']);
  for (const d of CONCEPT_DIRECTIONS) assert.equal(isConceptDirection(d), true);
  for (const d of ['exclude_test_note', 'OVERUSE', 'misuse', '', null]) assert.equal(isConceptDirection(d), false, String(d));
});

// ── §7 formulary guard + stage order ───────────────────────────────────────────
test('§7 formulary guard: a "cbc" brand-TOKEN match does not resolve to pralidoxime', () => {
  const hostile = (t: string): TargetResolution | null =>
    t === 'cbc' ? { target: 'pralidoxime', tier: 'brand-token' } : null;
  assert.equal(resolveTarget('cbc', hostile), 'cbc');                       // guard holds the literal
  assert.equal(isGuardedBrandToken('cbc', 'brand-token'), true);
  for (const w of ['anti', 'skin', 'calcium']) assert.equal(isGuardedBrandToken(w, 'brand-token'), true, w);
  // the guard is specific to the brand-TOKEN tier — a brand-EXACT match is untouched
  assert.equal(isGuardedBrandToken('cbc', 'brand-exact'), false);
  const exact = (): TargetResolution => ({ target: 'amoxicillin', tier: 'brand-exact' });
  assert.equal(resolveTarget('mox 500', exact), 'amoxicillin');
});

test('§7 stage order: the collapse rule runs AFTER formulary resolution', () => {
  // "montek lc" resolving to bare montelukast then collapsing yields montelukast_containing; collapsing
  // FIRST would have nothing to collapse and would leave the brand. Order is load-bearing (PRD §7).
  const formulary = (t: string): TargetResolution | null =>
    t === 'montek lc' ? { target: 'montelukast+levocetirizine', tier: 'brand-exact' } : null;
  assert.equal(resolveTarget('montek lc', formulary), 'montelukast_containing');
  assert.equal(applyCollapseRules('montelukast'), 'montelukast_containing');
  assert.equal(applyCollapseRules('levocetirizine+montelukast'), 'montelukast_containing');
  assert.equal(applyCollapseRules('amoxicillin'), 'amoxicillin');
});

test('a resolver that throws never loses the literal target', () => {
  assert.equal(resolveTarget('antibiotic', () => { throw new Error('boom'); }), 'antibiotic');
  assert.equal(resolveTarget('antibiotic', null), 'antibiotic');
});

// ── §9 known-answer ────────────────────────────────────────────────────────────
test('§9 known-answer: every montelukast-bearing string resolves to overuse:rx:montelukast_containing', () => {
  // The seed's montelukast family, as written by the Research Team (brand, combination and generic
  // spellings). MEASURED against the shipped seed: the concept carries 175 strings, not the 118 the
  // PRD's §9 text states — see the build report. The INVARIANT under test is that they all agree.
  const strings = [
    'levocetirizine+montelukast', 'montelukast+levocetirizine', 'unindicated montelukast',
    'montelukast for acute urti', 'montek lc for common cold', 'fixed dose combination of montelukast',
  ];
  const formulary = (t: string): TargetResolution | null =>
    t.startsWith('montek') ? { target: 'montelukast+levocetirizine', tier: 'brand-exact' } : null;
  const ids = new Set(strings.map((s) => {
    const target = resolveTarget(s.includes('montek') ? 'montek lc' : 'montelukast', formulary);
    return composeConceptId({ direction: 'overuse', action: 'rx', target });
  }));
  assert.deepEqual([...ids], ['overuse:rx:montelukast_containing']);
});

// ── §4 review lanes ────────────────────────────────────────────────────────────
test('§9 review_lane: clean for montelukast (0 contexts), context for antibiotic (163 contexts)', () => {
  // Volumes are the shipped seed's, measured: montelukast 302 findings all context-free; antibiotic
  // 976 findings of which 38.3% are context-free (163 distinct contexts).
  assert.equal(computeReviewLane(302, 302), 'clean');
  assert.equal(computeReviewLane(976, 374), 'context');
  // and the two other concepts the PRD names in §4
  assert.equal(computeReviewLane(773, 518), 'context');   // investigation, 67.0% context-free
  assert.equal(computeReviewLane(508, 494), 'clean');     // diagnosis-complaint concordance, 97.2%
});

test('review_lane is a deterministic threshold on the context-free VOLUME share', () => {
  assert.equal(CLEAN_LANE_MIN_CONTEXT_FREE_SHARE, 0.80);
  assert.equal(computeReviewLane(100, 80), 'clean');      // exactly at the threshold
  assert.equal(computeReviewLane(100, 79), 'context');
  assert.equal(computeReviewLane(0, 0), 'clean');         // no volume ⇒ nothing to drill into
  assert.equal(computeReviewLane(-5, 3), 'clean');        // never throws on nonsense
});

// ── §9 extraction validation ───────────────────────────────────────────────────
test('§9: a valid extraction composes; context is optional and normalised', () => {
  const r = validateExtraction('{"direction":"overuse","action":"RX","target":"Antibiotic","context":"Viral URTI"}');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.conceptId, 'overuse:rx:antibiotic');
  assert.equal(r.slots.context, 'viral urti');
  const noCtx = validateExtraction('{"direction":"underuse","action":"rx","target":"levothyroxine","context":""}');
  assert.equal(noCtx.ok && noCtx.slots.context, null);
});

test('§9: unparseable extraction ⇒ reject, no stamp', () => {
  for (const bad of ['', '   ', 'not json at all', '[1,2,3]', 'null', '{"direction":']) {
    const r = validateExtraction(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal((validateExtraction('not json') as { reason: string }).reason, 'not_json');
  assert.equal((validateExtraction('[1]') as { reason: string }).reason, 'not_object');
});

test('§9: a direction outside the closed vocabulary is rejected, never coerced', () => {
  const r = validateExtraction('{"direction":"exclude_test_note","action":"rx","target":"x"}');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'bad_direction');
  const r2 = validateExtraction('{"direction":"misuse","action":"rx","target":"x"}');
  assert.equal((r2 as { reason: string }).reason, 'bad_direction');
});

test('a missing ACTION is a reject, not a partial stamp; a missing TARGET takes the §3.1 sentinel', () => {
  // Before the §3.1 sentinel both slots rejected. A blank action still does — it is the slot that
  // carries what was actually done, and there is no defensible default for it.
  assert.equal((validateExtraction('{"direction":"overuse","action":"","target":"x"}') as { reason: string }).reason, 'missing_slot');
  // A missing target key (not merely empty) is the polypharmacy shape and now composes.
  const r = validateExtraction('{"direction":"overuse","action":"rx"}');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.conceptId, 'overuse:rx:regimen');
});

test('a ```json fence is tolerated; nothing else is repaired', () => {
  const r = validateExtraction('```json\n{"direction":"process","action":"followup","target":"referral"}\n```');
  assert.equal(r.ok && r.conceptId, 'process:followup:referral');
});

// ── stamping ───────────────────────────────────────────────────────────────────
const LOOKUP = (m: Record<string, ConceptAssignment>) => (n: string) => m[n] ?? null;

test('§9 exact-lookup hit stamps the seeded concept with ZERO model calls', () => {
  let calls = 0;
  const lookup = (n: string) => { calls++; return n === 'unindicated antibiotic prescription' ? { concept_id: 'overuse:rx:antibiotic', context: null } : null; };
  const { findings, stamped } = stampConcepts([lv()], lookup);
  assert.equal(stamped, 1);
  assert.equal((findings[0] as Record<string, unknown>).concept_id, 'overuse:rx:antibiotic');
  assert.equal((findings[0] as Record<string, unknown>).concept_context, null);
  assert.equal(calls, 1);   // one cache probe, no extraction
});

test('a lookup miss leaves the finding byte-identical (PRD §7 fail-safe)', () => {
  const f = lv();
  const { findings, stamped } = stampConcepts([f], () => null);
  assert.equal(stamped, 0);
  assert.equal(findings[0], f);                    // the SAME object — untouched
  assert.equal((findings[0] as Record<string, unknown>).concept_id, undefined);
});

test('an already-coded finding is never re-stamped (a string is extracted once, ever)', () => {
  const f = lv({ concept_id: 'overuse:rx:antibiotic', concept_context: 'viral urti' });
  const { findings, stamped } = stampConcepts([f], () => ({ concept_id: 'overuse:rx:OTHER', context: null }));
  assert.equal(stamped, 0);
  assert.equal(findings[0], f);
});

test('only low-value, non-informational findings are codable', () => {
  assert.equal(isCodableFinding(lv()), true);
  assert.equal(isCodableFinding(lv({ verdict: 'high-value' })), false);
  assert.equal(isCodableFinding(lv({ informational: true })), false);
  assert.equal(isCodableFinding(lv({ subject: '   ' })), false);
  const mixed = [lv(), lv({ verdict: 'high-value', subject: 'good' }), lv({ informational: true, subject: 'info' })];
  const { stamped } = stampConcepts(mixed, () => ({ concept_id: 'overuse:rx:x', context: null }));
  assert.equal(stamped, 1);
});

test('a throwing lookup never throws out of stampConcepts', () => {
  const { findings, stamped } = stampConcepts([lv()], () => { throw new Error('db down'); });
  assert.equal(stamped, 0);
  assert.equal((findings[0] as Record<string, unknown>).concept_id, undefined);
});

test('pendingSubjects dedupes, skips coded/uncodable, and honours the known-set', () => {
  const fs = [lv(), lv(), lv({ subject: 'Unindicated  Antibiotic Prescription' }), lv({ subject: 'other string' }),
    lv({ concept_id: 'x:y:z', subject: 'already coded' }), lv({ verdict: 'high-value', subject: 'hv' })];
  assert.deepEqual(pendingSubjects(fs, () => false), ['unindicated antibiotic prescription', 'other string']);
  assert.deepEqual(pendingSubjects(fs, (n) => n === 'other string'), ['unindicated antibiotic prescription']);
});

test('§9 cache miss → extract once → cached; a repeated string makes NO second call', () => {
  // Reproduces the tick's dedup contract with the pure pieces it is built from: the tick collects
  // pendingSubjects across the whole batch into a Set, filters by the cache, and extracts only the
  // residue. 40 findings carrying the same string must cost exactly ONE extraction, and re-running
  // the tick after the cache is populated must cost ZERO.
  const batch = Array.from({ length: 40 }, (_, i) => lv({ subject: i % 2 ? 'Unindicated antibiotic prescription' : 'unindicated  antibiotic   prescription' }));
  batch.push(lv({ subject: 'a second distinct string' }));

  const cache = new Map<string, ConceptAssignment>();
  let extractions = 0;
  const runTick = () => {
    const norms = new Set(pendingSubjects(batch as never, () => false));
    const misses = [...norms].filter((n) => !cache.has(n));
    for (const n of misses) { extractions++; cache.set(n, { concept_id: 'overuse:rx:antibiotic', context: null }); }
    return stampConcepts(batch as never, (n) => cache.get(n) ?? null);
  };

  const first = runTick();
  assert.equal(extractions, 2, '41 findings over 2 distinct strings must cost exactly 2 extractions');
  assert.equal(first.stamped, 41);

  const second = runTick();
  assert.equal(extractions, 2, 'a second tick over cached strings must make no further call');
  assert.equal(second.stamped, 41);
});

// ── worker-page status shaping ─────────────────────────────────────────────────
const tick = (over: Partial<ConceptTickRow> = {}): ConceptTickRow => ({
  ts: '2026-07-26T12:00:00', status: 'ok', processed: 200, stamped: 180, extracted: 12, rejected: 0,
  epoch: 1, note: 'cron', ...over,
});
const rawStatus = (over: Partial<ConceptStatusRaw> = {}): ConceptStatusRaw => ({
  enabled: true, paused: false, epoch: 1, coded: 500, candidates: 2000, notYetCoded: 1400,
  stringsExtracted7d: 40, concepts: 3070, stringsSeed: 9444, lastTick: tick(), recentTicks: [tick()], ...over,
});

test('CONCEPT_CRON_MIN matches the schedule in vercel.json (the panel renders this number)', () => {
  // The cadence was hardcoded at two use sites in the panel and silently went stale when the cron
  // moved 10 → 2, so the page would have shown a wrong countdown and claimed the wrong interval.
  // One constant, asserted against the actual deployment config.
  const cfg = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as
    { crons?: { path: string; schedule: string }[] };
  const entry = (cfg.crons ?? []).find((c) => c.path.startsWith('/api/care/concept/code'));
  assert.ok(entry, 'the Concept Coder cron entry must exist in vercel.json');
  const m = entry.schedule.match(/^\*\/(\d+) \* \* \* \*$/);
  assert.ok(m, `expected a */N minute schedule, got "${entry.schedule}"`);
  assert.equal(Number(m[1]), CONCEPT_CRON_MIN,
    `vercel.json says every ${m[1]}min but CONCEPT_CRON_MIN is ${CONCEPT_CRON_MIN} — the panel would misreport`);
});

test('deriveConceptState: disabled outranks paused outranks pending work', () => {
  assert.equal(deriveConceptState({ enabled: false, paused: false, notYetCoded: 100 }), 'disabled');
  assert.equal(deriveConceptState({ enabled: false, paused: true, notYetCoded: 0 }), 'disabled');
  assert.equal(deriveConceptState({ enabled: true, paused: true, notYetCoded: 100 }), 'paused');
  assert.equal(deriveConceptState({ enabled: true, paused: false, notYetCoded: 100 }), 'draining');
  assert.equal(deriveConceptState({ enabled: true, paused: false, notYetCoded: 0 }), 'idle');
  assert.equal(deriveConceptState({ enabled: true, paused: false, notYetCoded: null }), 'idle');
});

test('codedPct is a clamped percentage, null when the denominator is unknown or zero', () => {
  assert.equal(codedPct(500, 2000), 25);
  assert.equal(codedPct(0, 2000), 0);
  assert.equal(codedPct(2000, 2000), 100);
  assert.equal(codedPct(null, 2000), null);
  assert.equal(codedPct(5, null), null);
  assert.equal(codedPct(5, 0), null);        // zero-state must not divide by zero
  assert.equal(codedPct(9999, 100), 100);    // clamped, never >100
});

test('cacheHitPct is the share of stamps needing no model call; null before anything is stamped', () => {
  assert.equal(cacheHitPct([tick({ stamped: 100, extracted: 10 })]), 90);
  assert.equal(cacheHitPct([tick({ stamped: 50, extracted: 0 })]), 100);
  assert.equal(cacheHitPct([tick({ stamped: 100, extracted: 10 }), tick({ stamped: 100, extracted: 30 })]), 80);
  // ZERO-STATE: nothing stamped yet must be null (unknown), NOT 0% — 0% would read as "the cache is
  // useless" on a page that has simply never run.
  assert.equal(cacheHitPct([]), null);
  assert.equal(cacheHitPct([tick({ stamped: 0, extracted: 0 })]), null);
  // a tick may extract strings whose findings land later ⇒ clamp rather than emit a negative
  assert.equal(cacheHitPct([tick({ stamped: 5, extracted: 40 })]), 0);
});

test('rejectedRecent sums across ticks and is 0 (never null) so the tile always renders a number', () => {
  assert.equal(rejectedRecent([]), 0);
  assert.equal(rejectedRecent([tick({ rejected: 3 }), tick({ rejected: 4 })]), 7);
  assert.equal(rejectedRecent([tick({ rejected: 0 })]), 0);
});

test('buildConceptStatus shapes the payload and carries all four per-tick counts through', () => {
  const s = buildConceptStatus(rawStatus({ recentTicks: [tick({ stamped: 100, extracted: 10, rejected: 2 })] }));
  assert.equal(s.state, 'draining');
  assert.equal(s.coded_pct, 25);
  assert.equal(s.cache_hit_pct, 90);
  assert.equal(s.rejected_recent, 2);
  assert.equal(s.not_yet_coded, 1400);
  assert.equal(s.concepts, 3070);
  assert.equal(s.strings_seed, 9444);
  const t = s.recent_ticks[0];
  for (const k of ['processed', 'stamped', 'extracted', 'rejected']) {
    assert.ok(typeof (t as unknown as Record<string, unknown>)[k] === 'number', `tick.${k} must survive`);
  }
});

test('ZERO-STATE renders honestly: seed loaded, no ticks, nothing stamped', () => {
  // Exactly the state this ships in. Every field must be a value the panel can render without
  // looking broken: no NaN, no negative, no divide-by-zero, and "unknown" distinguishable from zero.
  const s = buildConceptStatus({
    enabled: true, paused: false, epoch: 1,
    coded: 0, candidates: 20000, notYetCoded: 20000,
    stringsExtracted7d: 0, concepts: 3070, stringsSeed: 9444,
    lastTick: null, recentTicks: [],
  });
  assert.equal(s.state, 'draining');            // work pending, worker on — not 'idle', not an error
  assert.equal(s.coded_pct, 0);                 // a real 0%, bar renders empty
  assert.equal(s.cache_hit_pct, null);          // UNKNOWN, not 0 — nothing has been stamped
  assert.equal(s.rejected_recent, 0);           // a number, so the tile shows "0" not "—"
  assert.equal(s.not_yet_coded, 20000);
  assert.equal(s.strings_extracted_7d, 0);
  assert.equal(s.concepts, 3070);               // the seeded vocabulary is visible immediately
  assert.equal(s.strings_seed, 9444);
  assert.deepEqual(s.recent_ticks, []);
  assert.equal(s.last_tick, null);
  for (const v of [s.coded_pct, s.rejected_recent]) assert.ok(Number.isFinite(v as number));
});

test('a fully-degraded payload (every aggregate null) still shapes without throwing', () => {
  const s = buildConceptStatus({
    enabled: true, paused: false, epoch: 1, coded: null, candidates: null, notYetCoded: null,
    stringsExtracted7d: null, concepts: null, stringsSeed: null, lastTick: null, recentTicks: [],
  });
  assert.equal(s.state, 'idle');
  assert.equal(s.coded_pct, null);
  assert.equal(s.cache_hit_pct, null);
  assert.equal(s.rejected_recent, 0);
});

test('the disabled state is reachable and keeps its counts (the panel explains itself)', () => {
  const s = buildConceptStatus(rawStatus({ enabled: false }));
  assert.equal(s.state, 'disabled');
  assert.equal(s.concepts, 3070);   // vocabulary still shown — "off", not "empty"
  assert.equal(s.strings_seed, 9444);
});

// ── §9 SCORE-INVARIANCE — the hard invariant (PRD §3, §6 Phase 1 gate) ─────────
test('§9 score-invariance: stamping 240 audits changes no headline, band, domain score or confidence', () => {
  const N = 240;
  const before: ReturnType<typeof computeOpdScore>[] = [];
  const after: ReturnType<typeof computeOpdScore>[] = [];
  let totalStamped = 0;

  for (let i = 0; i < N; i++) {
    // A varied but deterministic audit: different finding mixes, coverage, PDQI and continuity, so the
    // assertion spans real score range rather than one repeated fixture.
    const nLow = i % 5, nHigh = i % 3;
    const findings: Record<string, unknown>[] = [];
    for (let k = 0; k < nLow; k++) findings.push(lv({ subject: `low ${k} of ${i}`, confidence: 0.5 + (k % 5) / 10 }));
    for (let k = 0; k < nHigh; k++) findings.push(lv({ subject: `high ${k}`, verdict: 'high-value', domain: 'prescribing_safety' }));
    findings.push(lv({ subject: `info ${i}`, informational: true }));

    const scoreInput = (fs: Record<string, unknown>[]) => ({
      findings: fs.filter((f) => !f.informational).map((f) => ({ verdict: f.verdict as never, confidence: f.confidence as number, domain: f.domain as never })),
      completenessCoverage: (i % 6) / 5,
      pdqi9: { thorough: 1 + (i % 5), accurate: 1 + ((i + 2) % 5), useful: 3 } as never,
      patientCentred: { present: i % 3, total: 2 },
    });

    before.push(computeOpdScore(scoreInput(findings)));
    // stamp every codable finding — a hit for all of them, the maximum-mutation case
    const res = stampConcepts(findings as never, (n) => ({ concept_id: 'overuse:rx:antibiotic', context: n.includes('low') ? 'viral urti' : null }));
    totalStamped += res.stamped;
    after.push(computeOpdScore(scoreInput(res.findings as never)));
  }

  assert.ok(totalStamped >= 200, `expected ≥200 stamps across the corpus, got ${totalStamped}`);
  for (let i = 0; i < N; i++) {
    assert.equal(after[i].headline, before[i].headline, `note_quality_index moved on audit ${i}`);
    assert.equal(after[i].band, before[i].band, `band moved on audit ${i}`);
    assert.equal(after[i].confidence, before[i].confidence, `confidence moved on audit ${i}`);
    assert.deepEqual(after[i].domains, before[i].domains, `a domain score moved on audit ${i}`);
    assert.deepEqual(after[i].pdqi9, before[i].pdqi9, `pdqi9 moved on audit ${i}`);
    assert.deepEqual(after[i].flags, before[i].flags, `flags moved on audit ${i}`);
  }
});

test('§3 score-invariance, structurally: stamping adds exactly two keys and mutates nothing else', () => {
  const f = lv({ finding_ref: 'abc', signal_type: 'appropriateness_low_value', lvc_category: 'antibiotic', citation_ids: [1, 2] });
  const { findings } = stampConcepts([f], () => ({ concept_id: 'overuse:rx:antibiotic', context: 'viral urti' }));
  const out = findings[0] as Record<string, unknown>;
  const added = Object.keys(out).filter((k) => !(k in (f as Record<string, unknown>)));
  assert.deepEqual(added.sort(), ['concept_context', 'concept_id']);
  for (const k of Object.keys(f as Record<string, unknown>)) {
    assert.deepEqual(out[k], (f as Record<string, unknown>)[k], `field ${k} was mutated`);
  }
  assert.notEqual(out, f);   // and the original object is not mutated in place
  assert.equal((f as Record<string, unknown>).concept_id, undefined);
});
