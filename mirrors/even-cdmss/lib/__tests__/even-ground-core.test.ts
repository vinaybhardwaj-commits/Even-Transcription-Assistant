// lib/__tests__/even-ground-core.test.ts — PURE core of the Even-LVC grounding worker
// (CDMSS-EVEN-LVC-GROUNDING-WORKER-PRD-v1.0). Fixtures only (no DB / no LLM). Covers the 7 groups in
// PRD §Tests + the score-invariance assertion (only citation_ids + sources are ever touched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findingKey, subjectHash, isNoteStale, stripRetiredEvenCitations,
  deriveGroundState, drainPct, drainEtaMinutes, buildGroundStatus,
  formatAgo, nextTickInSec,
  type CitedFinding, type CitedSource, type GroundStatusRaw,
} from '../even-ground-core.ts';

// ── (1) finding_key determinism / stability + subject sensitivity ───────────────
test('findingKey is deterministic + stable across normalized subject variants; distinct on real change', () => {
  const a = findingKey('note-1', 'ref-9', 'Azithromycin for viral URI');
  const b = findingKey('note-1', 'ref-9', '  azithromycin   for  viral uri. ');   // normalizes to the same
  assert.equal(a, b, 'casing/whitespace/trailing-period variants share a key');
  assert.match(a, /^[0-9a-f]{64}$/, 'sha256 hex');
  assert.notEqual(a, findingKey('note-2', 'ref-9', 'Azithromycin for viral URI'), 'different uid ⇒ different key');
  assert.notEqual(a, findingKey('note-1', 'ref-8', 'Azithromycin for viral URI'), 'different ref ⇒ different key');
  assert.notEqual(a, findingKey('note-1', 'ref-9', 'MRI for low back pain'), 'different subject ⇒ different key');
  // ref-or-index: a numeric index is accepted and stable
  assert.equal(findingKey('n', 0, 'x'), findingKey('n', '0', 'x'), 'index 0 ≡ "0"');
});

test('subjectHash is subject-sensitive (cache miss on a re-worded finding)', () => {
  assert.equal(subjectHash('Vitamin D for fatigue'), subjectHash(' vitamin d for fatigue '));
  assert.notEqual(subjectHash('Vitamin D for fatigue'), subjectHash('Vitamin B12 for fatigue'));
});

// ── (2) epoch compare ───────────────────────────────────────────────────────────
test('isNoteStale: no watermark OR watermark < epoch ⇒ stale', () => {
  assert.equal(isNoteStale(null, 3), true, 'never grounded ⇒ stale');
  assert.equal(isNoteStale(undefined, 3), true);
  assert.equal(isNoteStale(2, 3), true, 'watermark behind epoch ⇒ stale');
  assert.equal(isNoteStale(3, 3), false, 'grounded at current epoch ⇒ fresh');
  assert.equal(isNoteStale(4, 3), false, 'ahead ⇒ fresh');
});

// ── (3) stripRetiredEvenCitations — removes ONLY retired even-lvc, renumbers, leaves the rest ──
test('stripRetiredEvenCitations drops retired even-lvc citations, renumbers refs, keeps CW/guideline/other intact', () => {
  const sources: CitedSource[] = [
    { n: 1, source: 'choosing-wisely', item_number: 'cwus-aafp-002' },
    { n: 2, source: 'even-lvc', item_number: 'elv-antibiotic-001' },   // RETIRED → removed
    { n: 3, source: 'lab:guidelines-icmr-amr-2019', item_number: 'icmr#p45' },
    { n: 4, source: 'even-lvc', item_number: 'elv-imaging-002' },       // active → kept
  ];
  const findings: CitedFinding[] = [
    { citation_ids: [1, 2, 3] },   // 2 (retired) dropped; 1→1, 3→ renumber to 2
    { citation_ids: [2, 4] },      // 2 dropped; 4→ renumber to 3
    { citation_ids: [] },
    { /* no citation_ids */ },
  ];
  const out = stripRetiredEvenCitations(findings, sources, ['elv-antibiotic-001']);
  assert.deepEqual(out.sources.map((s) => [s.n, s.source, s.item_number]), [
    [1, 'choosing-wisely', 'cwus-aafp-002'],
    [2, 'lab:guidelines-icmr-amr-2019', 'icmr#p45'],
    [3, 'even-lvc', 'elv-imaging-002'],
  ], 'retired even-lvc removed; survivors renumbered 1..3 (active even-lvc kept)');
  assert.deepEqual(out.findings[0].citation_ids, [1, 2], 'CW stays 1, guideline 3→2, retired 2 dropped');
  assert.deepEqual(out.findings[1].citation_ids, [3], 'retired 2 dropped, active even-lvc 4→3');
  assert.deepEqual(out.findings[2].citation_ids, []);
});

test('stripRetiredEvenCitations is a byte-identical no-op when nothing is retired / no retired source present', () => {
  const sources: CitedSource[] = [{ n: 5, source: 'even-lvc', item_number: 'elv-x-1' }, { n: 6, source: 'choosing-wisely', item_number: 'cw' }];
  const findings: CitedFinding[] = [{ citation_ids: [5, 6] }];
  // empty retired set ⇒ SAME references returned (no renumbering)
  const a = stripRetiredEvenCitations(findings, sources, []);
  assert.equal(a.sources, sources, 'same sources array reference');
  assert.equal(a.findings, findings, 'same findings array reference');
  // a retired id that isn't present ⇒ still a no-op
  const b = stripRetiredEvenCitations(findings, sources, ['elv-not-here']);
  assert.equal(b.sources, sources);
  assert.equal(b.findings, findings);
});

test('stripRetiredEvenCitations never touches non-even citations even if their id collides numerically', () => {
  const sources: CitedSource[] = [{ n: 1, source: 'even-lvc', item_number: 'RET' }, { n: 2, source: 'pubmed', item_number: 'RET' }];
  const out = stripRetiredEvenCitations([{ citation_ids: [1, 2] }], sources, ['RET']);
  assert.deepEqual(out.sources.map((s) => s.source), ['pubmed'], 'only even-lvc#RET removed; pubmed#RET kept');
  assert.deepEqual(out.findings[0].citation_ids, [1], 'pubmed renumbered 2→1');
});

// ── (4) batch/status reducers ────────────────────────────────────────────────────
test('deriveGroundState precedence: disabled > paused > draining > idle', () => {
  assert.equal(deriveGroundState({ enabled: false, paused: false, groundedAtEpoch: 0, totalLvNotes: 10 }), 'disabled');
  assert.equal(deriveGroundState({ enabled: true, paused: true, groundedAtEpoch: 0, totalLvNotes: 10 }), 'paused');
  assert.equal(deriveGroundState({ enabled: true, paused: false, groundedAtEpoch: 4, totalLvNotes: 10 }), 'draining');
  assert.equal(deriveGroundState({ enabled: true, paused: false, groundedAtEpoch: 10, totalLvNotes: 10 }), 'idle');
  assert.equal(deriveGroundState({ enabled: true, paused: false, groundedAtEpoch: null, totalLvNotes: 0 }), 'idle', 'zero total ⇒ idle');
});

test('drainPct + drainEtaMinutes', () => {
  assert.equal(drainPct(5, 10), 50);
  assert.equal(drainPct(0, 0), null, 'unknown/zero total ⇒ null');
  assert.equal(drainPct(999, 10), 100, 'clamped to 100');
  assert.equal(drainEtaMinutes(0, 200, 10), 0, 'nothing remaining ⇒ 0');
  assert.equal(drainEtaMinutes(500, 200, 10), 30, 'ceil(500/200)=3 ticks × 10 min');
  assert.equal(drainEtaMinutes(500, 0, 10), null, 'zero rate ⇒ null');
});

test('buildGroundStatus shapes the payload + derives state/drain_pct', () => {
  const raw: GroundStatusRaw = {
    enabled: true, paused: false, epoch: 2, activeAssertions: 25, totalLvNotes: 100, groundedAtEpoch: 40,
    citationsAddedTotal: 88, lastTick: { ts: '2026-07-23T10:00:00', status: 'ok', processed: 200, citations_added: 12, epoch: 2, note: 'cron' },
    recentTicks: [{ ts: '2026-07-23T10:00:00', status: 'ok', processed: 200, citations_added: 12, epoch: 2, note: 'cron' }],
  };
  const s = buildGroundStatus(raw);
  assert.equal(s.state, 'draining');
  assert.equal(s.drain_pct, 40);
  assert.equal(s.active_assertions, 25);
  assert.equal(s.total_lv_notes, 100);
  assert.equal(s.grounded_at_epoch, 40);
  assert.equal(s.citations_added_total, 88);
  assert.equal(s.last_tick?.citations_added, 12);
});

// ── (6) live-heartbeat time helpers (Phase 2.2) ─────────────────────────────────
test('formatAgo: seconds / minutes / hours / days; UTC-assumed; malformed ⇒ —', () => {
  const now = Date.parse('2026-07-23T12:00:00Z');
  assert.equal(formatAgo('2026-07-23T11:59:55', now), '5s ago', 'bare ISO treated as UTC');
  assert.equal(formatAgo('2026-07-23T11:59:55Z', now), '5s ago', 'explicit Z same');
  assert.equal(formatAgo('2026-07-23T11:57:00Z', now), '3m ago');
  assert.equal(formatAgo('2026-07-23T09:00:00Z', now), '3h ago');
  assert.equal(formatAgo('2026-07-21T12:00:00Z', now), '2d ago');
  assert.equal(formatAgo('2026-07-23T12:00:30Z', now), '0s ago', 'future clamps to 0s');
  assert.equal(formatAgo('not-a-date', now), '—');
  assert.equal(formatAgo(null, now), '—');
  assert.equal(formatAgo('', now), '—');
});

test('nextTickInSec: (0, everyMin*60]; wraps at the boundary', () => {
  const at = (iso: string) => nextTickInSec(Date.parse(iso), 10);
  assert.equal(at('2026-07-23T12:00:00Z'), 600, 'exactly on a 10-min boundary ⇒ full period (just fired)');
  assert.equal(at('2026-07-23T12:09:59Z'), 1, '1s before the next boundary');
  assert.equal(at('2026-07-23T12:05:00Z'), 300, 'halfway');
  const v = at('2026-07-23T12:03:21Z');
  assert.ok(v > 0 && v <= 600, `in range (0,600], got ${v}`);
  assert.equal(nextTickInSec(Date.parse('2026-07-23T12:05:00Z'), 5), 300, 'period respects everyMin=5');
});

// ── (5) SCORE-INVARIANCE: the display filter touches ONLY citation_ids + sources ──
test('score-invariance: stripRetiredEvenCitations preserves every non-citation finding field', () => {
  const findings = [
    { verdict: 'low-value', confidence: 0.8, domain: 'appropriateness', lvc_category: 'antibiotic', subject: 'x', citation_ids: [1, 2] },
    { verdict: 'high-value', confidence: 0.9, domain: 'prescribing_safety', citation_ids: [2] },
  ];
  const sources: CitedSource[] = [{ n: 1, source: 'choosing-wisely', item_number: 'cw' }, { n: 2, source: 'even-lvc', item_number: 'R' }];
  const out = stripRetiredEvenCitations(findings, sources, ['R']);
  for (let i = 0; i < findings.length; i++) {
    for (const k of ['verdict', 'confidence', 'domain', 'lvc_category', 'subject']) {
      assert.deepEqual((out.findings[i] as Record<string, unknown>)[k], (findings[i] as Record<string, unknown>)[k], `${k} unchanged on finding ${i}`);
    }
  }
  assert.deepEqual(out.findings[0].citation_ids, [1], 'only citation_ids changed');
  assert.deepEqual(out.findings[1].citation_ids, [], 'retired-only finding loses its citation');
});
