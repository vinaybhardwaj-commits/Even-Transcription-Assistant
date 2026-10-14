/**
 *   node --test --import tsx lib/__tests__/grader-provenance.test.ts
 *
 * GRADER-PROVENANCE PRD v1.0 (2 Aug 2026) — a local 14B model must never outrank the cloud.
 *
 * THE DEFECT: the mini backfill's prod mode wrote `qwen2.5:14b` audits under the PLAIN production
 * engine label. No `-mini` suffix, so the engine-family filter passed them into the ranking, where
 * their newer engine version beat the real Gemini rows outright. Measured 1 Aug: 4 of 4 sampled
 * notes scored LOWER on qwen and dropped a band, with the disagreeing cloud judgment one row away.
 *
 * D2: the grader tier now ranks FIRST — cloud before local, regardless of engine version.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canonicalByUid, CANONICAL_RANK_SQL, isLocalGrader, isReferenceModel, REFERENCE_MODELS,
} from '../audit-canonical.ts';

interface Row { uid: string | null; engine_version: string; audited_at: string; id: string; model?: string }

// ═════════════════════════════════════════════════════════════════════════════════════════════
// GATE TEST 2 — cloud at 0.81.17 + mini at 0.81.20 for one uid ⇒ CLOUD is canonical
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('GATE: a cloud row at 0.81.17 beats a qwen row at 0.81.20 — the exact live shape', () => {
  const rows: Row[] = [
    { uid: 'n1', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-07-20T10:00:00Z', id: 'cloud', model: 'google/gemini-2.5-pro' },
    // the contaminated row: PLAIN prod label, no -mini suffix, newer version, written later
    { uid: 'n1', engine_version: 'opd-note-audit/0.81.20', audited_at: '2026-08-01T19:16:00Z', id: 'qwen', model: 'qwen2.5:14b' },
  ];
  const out = canonicalByUid(rows) as Row[];
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'cloud', 'the local 14B model must NOT win on a newer engine version');
  // …and input order cannot change the answer.
  assert.equal((canonicalByUid([...rows].reverse()) as Row[])[0].id, 'cloud');
});

test('GATE: two cloud rows at different versions ⇒ the HIGHER version still wins', () => {
  const rows: Row[] = [
    { uid: 'n2', engine_version: 'opd-note-audit/0.81.17', audited_at: '2026-08-01T10:00:00Z', id: 'older-ver', model: 'gemini-2.5-pro' },
    { uid: 'n2', engine_version: 'opd-note-audit/0.81.20', audited_at: '2026-07-01T10:00:00Z', id: 'newer-ver', model: 'google/gemini-2.5-pro' },
  ];
  const out = canonicalByUid(rows) as Row[];
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'newer-ver', 'the tier must not flatten cloud-vs-cloud version ranking');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The predicate, and why it is NOT REFERENCE_MODELS
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('isLocalGrader catches BOTH signals: the qwen model and the -mini suffix', () => {
  assert.equal(isLocalGrader('qwen2.5:14b', 'opd-note-audit/0.81.20'), true, 'the prod-labelled contamination');
  assert.equal(isLocalGrader('qwen3.5-flash', 'opd-note-audit/0.81.20'), true, 'any qwen spelling');
  assert.equal(isLocalGrader(undefined, 'opd-note-audit/0.81.14-mini'), true, 'suffix alone, unknown model');
  assert.equal(isLocalGrader('google/gemini-2.5-pro', 'opd-note-audit/0.81.20'), false);
  assert.equal(isLocalGrader('gemini-2.5-pro', 'opd-note-audit/0.81.17'), false);
  assert.equal(isLocalGrader(null, 'opd-note-audit/0.81.17'), false, 'unknown model on a prod label is treated as cloud');
});

test('the grader tier is a SEPARATE question from REFERENCE_MODELS — neither list is overloaded', () => {
  // A cloud model absent from REFERENCE_MODELS is still CLOUD: it loses the reference tiebreak but
  // must not be demoted to the local tier. Conflating the two would do exactly that.
  assert.equal(isReferenceModel('claude-opus-5'), false, 'not a reference model');
  assert.equal(isLocalGrader('claude-opus-5', 'opd-note-audit/0.81.20'), false, '…but not local either');
  const src = readFileSync('lib/audit-canonical.ts', 'utf8');
  assert.ok(/export function isLocalGrader/.test(src), 'the cloud/local predicate is its own named export');
  assert.ok(REFERENCE_MODELS.length >= 2 && !(REFERENCE_MODELS as readonly string[]).some((m) => /qwen/i.test(m)),
    'REFERENCE_MODELS must not have been repurposed to carry the local-model list');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The SQL twin carries the same four keys, in the same order
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('CANONICAL_RANK_SQL leads with the grader tier, then version, then reference, then audited_at', () => {
  assert.equal(CANONICAL_RANK_SQL,
    `CASE WHEN model LIKE 'qwen%' OR engine_version LIKE '%-mini' THEN 1 ELSE 0 END, `
    + `string_to_array(split_part(engine_version, '/', 2), '.')::int[] DESC, `
    + `CASE WHEN model IN (${REFERENCE_MODELS.map((m) => `'${m}'`).join(', ')}) THEN 0 ELSE 1 END, `
    + 'audited_at DESC');
  // the grader tier must PRECEDE the version key — the whole point of D2
  assert.ok(CANONICAL_RANK_SQL.indexOf("LIKE 'qwen%'") < CANONICAL_RANK_SQL.indexOf('::int[] DESC'),
    'a newer engine version must not be able to promote a local-model row');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// D1 — prod mode is gone, and cannot come back by accident
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('D1: prodTag and the mini_backfill_prod settings keys are DELETED repo-wide', () => {
  const audit = readFileSync('lib/opd-note-audit.ts', 'utf8');
  const route = readFileSync('app/api/admin/opd-audit-mini-backfill/route.ts', 'utf8');
  const state = readFileSync('lib/mini-backfill.ts', 'utf8');
  assert.ok(!audit.includes('prodTag'), 'the audit option is gone');
  assert.ok(!route.includes('prodTag'), 'the backfill no longer passes it');
  assert.ok(!state.includes("'mini_backfill_prod'"), 'the settings key is gone');
  assert.ok(!state.includes("'mini_backfill_prod_version'"), 'the upgrade-pivot key is gone');
  // the mini engine label is now unconditional
  assert.ok(audit.includes('? opdMiniEngine(opts.engineTag)'), 'a mini run always writes -<tag>');
  // ⚠️ REPLACED 7 Aug 2026 (Bedrock S2). There is no autoTick engine branch to check any more:
  // the mini autopilot is gone and the route is a Bedrock run queue whose rows carry the PLAIN prod
  // engine version. D1's PROPERTY still holds and is asserted the only way it now can be — no
  // route path can produce a prod-labelled LOCAL-model row, because the route no longer runs a
  // local model at all (bedrock-only run models, enforced by planRunCreate).
  assert.ok(!route.includes('opdMiniEngine('), 'the mini engine label is not written by this route any more');
  // ⚠️ SHARPENED 8 Aug 2026 (S2b C2). This read `!route.includes('MINI_MODEL,')`, which the route's
  // own IMPORT LIST now trips — MINI_MODEL is still imported, to be handed to resolveProvider as the
  // fallback for an unprefixed string that this route then refuses anyway. The PROPERTY was never
  // about the import: it is that no ROW is stamped with the local model, so that is what is asserted.
  assert.ok(!/saveOpdAudit\([\s\S]{0,200}MINI_MODEL/.test(route), 'and no row is stamped with the local model');
  assert.ok(route.includes('resolves to ${r.provider}, and backfill runs accept ${RUN_MODEL_PREFIXES.join'), 'a local run model is refused outright');
});

test('the trap comment no longer claims a guard is unnecessary', () => {
  const src = readFileSync('lib/audit-canonical.ts', 'utf8');
  assert.ok(!src.includes('So there is no guard here.'), 'the false assumption must not survive');
  assert.ok(/THE GUARD NOW EXISTS AND IS THE GRADER TIER/.test(src), 'and the comment says what replaced it');
});
