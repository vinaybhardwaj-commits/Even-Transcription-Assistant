/**
 *   node --test --import tsx lib/__tests__/backfill-skip-rule.test.ts
 *
 * BACKFILL-SKIP-RULE PRD v1.0 (2 Aug 2026, V ruled DEC-1/DEC-2) — the mini backfill skips a note
 * already audited anywhere in the CURRENT ENGINE LINE, not at the exact version string running now.
 *
 * THE DEFECT: an exact-string match meant every change to the engine version made a whole day look
 * untouched, so the worker started the day over. Three strings changed across 1–2 August
 * (0.81.19 → 0.81.20 → 0.81.20-mini). MEASURED on 1 August's 412 notes: 13 notes audited FOUR
 * times, 306 never audited at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { engineLineOf, isInCurrentEngineLine } from '../opd-audit-store.ts';
import { OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT } from '../opd-note-audit-core.ts';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The six cases the kickoff names
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the five membership cases from the kickoff, exactly', () => {
  assert.equal(isInCurrentEngineLine('opd-note-audit/0.81.20'), true, 'plain current version is in the line');
  assert.equal(isInCurrentEngineLine('opd-note-audit/0.81.20-mini'), true, 'the -mini tag is stripped');
  assert.equal(isInCurrentEngineLine('opd-note-audit/0.81.20-verify'), true, 'ANY tag is stripped, not just -mini (DEC-4)');
  assert.equal(isInCurrentEngineLine('opd-note-audit/0.5'), false, 'a pre-family version is NOT in the line');
  assert.equal(isInCurrentEngineLine('opd-note-audit/0.82.0'), false, 'a future version is NOT in the line — it must be added to the family list first');
});

test('a future version does not sneak in via its tag either', () => {
  // The 2 Aug reset in its next form: bump to 0.82.0, forget the family list, tag the run.
  assert.equal(isInCurrentEngineLine('opd-note-audit/0.82.0-mini'), false,
    'THE STANDING CONSEQUENCE: a bump that skips OPD_ENGINE_VERSIONS_CURRENT resets the day again');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The stripping rule itself — "the first hyphen that FOLLOWS the version number"
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the engine NAME keeps its own hyphens — a naive split on "-" would be wrong', () => {
  // 'opd-note-audit' contains two hyphens BEFORE the version. Neither may be treated as a tag.
  assert.equal(engineLineOf('opd-note-audit/0.81.20'), 'opd-note-audit/0.81.20');
  assert.equal(engineLineOf('opd-note-audit/0.81.20-mini'), 'opd-note-audit/0.81.20');
  assert.equal(engineLineOf('opd-note-audit/0.81.20-verify'), 'opd-note-audit/0.81.20');
});

test('stripping takes the FIRST hyphen after the version, however many follow', () => {
  assert.equal(engineLineOf('opd-note-audit/0.81.20-r1-extra'), 'opd-note-audit/0.81.20');
  assert.equal(engineLineOf('opd-note-audit/0.81.20-mini2'), 'opd-note-audit/0.81.20');
  // opdMiniEngine() accepts an arbitrary tag of up to 24 chars, including digits and hyphens.
  assert.equal(engineLineOf('opd-note-audit/0.81.20-a1-b2-c3'), 'opd-note-audit/0.81.20');
});

test('an untagged string is returned unchanged, and the helper is total', () => {
  assert.equal(engineLineOf('opd-note-audit/0.81.3'), 'opd-note-audit/0.81.3');
  assert.equal(engineLineOf('ipd-discharge-audit/0.2'), 'ipd-discharge-audit/0.2');
  // never throws, whatever it is handed
  for (const junk of [undefined, null, '', 'nonsense', 'no-slash-here', 42]) {
    assert.doesNotThrow(() => engineLineOf(junk as unknown));
    assert.equal(typeof engineLineOf(junk as unknown), 'string');
  }
  assert.equal(isInCurrentEngineLine(undefined), false, 'unknown ranks as NOT audited — it must be worked, not skipped');
});

test('EVERY member of the family list is in its own line, tagged or not', () => {
  for (const v of OPD_ENGINE_VERSIONS_CURRENT) {
    assert.equal(isInCurrentEngineLine(v), true, `${v} must be in the line`);
    assert.equal(isInCurrentEngineLine(`${v}-mini`), true, `${v}-mini must be in the line`);
  }
  // and the version the engine writes RIGHT NOW is in the line — if this fails, a bump forgot the list
  assert.equal(isInCurrentEngineLine(OPD_ENGINE_VERSION), true,
    'OPD_ENGINE_VERSION is outside OPD_ENGINE_VERSIONS_CURRENT — the backfill will reset every day');
  assert.equal(isInCurrentEngineLine(`${OPD_ENGINE_VERSION}-mini`), true);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · What must NOT have changed
// ═════════════════════════════════════════════════════════════════════════════════════════════

const STORE = readFileSync('lib/opd-audit-store.ts', 'utf8');

test('auditedUidsForDay is UNCHANGED — still the exact-version, unfiltered read (DEC-3)', () => {
  // lib/__tests__/opd-invalid-marking.test.ts:126 asserts this too, and must keep passing untouched.
  assert.ok(STORE.includes(`export async function auditedUidsForDay(day: string, engineVersion: string): Promise<string[]> {
  const rows = (await sql(
    \`SELECT uid FROM opd_note_audits
     WHERE engine_version = $1 AND (note_date AT TIME ZONE 'Asia/Kolkata')::date = $2::date\`,
    [engineVersion, day],
  )) as Array<{ uid: string }>;`), 'the exact-match function must be byte-identical — a new one was ADDED, not this one edited');
});

test('the day filter on the new read is byte-identical to auditedUidsForDay', () => {
  assert.ok(STORE.includes(`export async function auditedUidsForDayInLine(day: string): Promise<string[]> {
  const rows = (await sql(
    \`SELECT uid, engine_version FROM opd_note_audits
     WHERE (note_date AT TIME ZONE 'Asia/Kolkata')::date = $1::date\`,`),
    'same IST day predicate, only the version test differs');
});

test('the new read does NOT swallow its own errors — an empty skip list would re-audit everything', () => {
  const fn = STORE.slice(STORE.indexOf('export async function auditedUidsForDayInLine'),
                         STORE.indexOf('export async function cloudAuditedUidsForDay'));
  assert.ok(!/\.catch\(/.test(fn), 'no .catch — a query failure must abort the batch, not clear the skip set');
  assert.ok(!/try\s*\{/.test(fn), 'no try/catch either, for the same reason');
});

test('the four mini-backfill call sites use the line rule; the Gemini worker is untouched', () => {
  const route = readFileSync('app/api/admin/opd-audit-mini-backfill/route.ts', 'utf8');
  const mcp = readFileSync('lib/mcp-tools.ts', 'utf8');
  const worker = readFileSync('app/api/opd-audit/worker/route.ts', 'utf8');
  // ⚠️ 3 → 1 on 7 Aug 2026 (Bedrock S2). The route had three call sites — processBatch, the
  // day-advance scan and the manual probe — because the autopilot had to FIND its own next day. A
  // run carries its day range, so there is one place left that asks the question. The rule being
  // asserted (the LINE, never the exact version) is unchanged and now has a single reader.
  assert.equal((route.match(/auditedUidsForDayInLine\(/g) || []).length, 1, 'the runner asks once, in processRunBatch');
  assert.equal((mcp.match(/auditedUidsForDayInLine\(/g) || []).length, 1, 'backfill_control run_day');
  assert.ok(!/auditedUidsForDay\(/.test(route.replace(/auditedUidsForDayInLine\(/g, '')), 'no exact-match call left in the route');
  assert.ok(!/auditedUidsForDay\(/.test(mcp.replace(/auditedUidsForDayInLine\(/g, '')), 'no exact-match call left in mcp-tools');
  // the Gemini worker keeps its own, already-correct rule
  assert.ok(worker.includes('auditedUidsForDayAnyVersion(day)'), 'the worker is untouched and still version-agnostic');
  assert.ok(!worker.includes('auditedUidsForDayInLine'), 'this change must not reach the Gemini worker');
});

test('the work selection and the day-complete decision use the SAME rule', () => {
  // ⚠️ REWRITTEN 7 Aug 2026 (Bedrock S2), same hazard. This used to compare the autopilot's
  // day-advance SCAN against its work selection: if they disagreed the cursor moved off a day that
  // still had work, or stuck on one with none. The scan is gone — a run knows its range — but the
  // hazard survives in a new shape: the cursor marches on `dayComplete`, so the count that decides
  // "complete" must be the same count that decided what to work. One query, used for both.
  const route = readFileSync('app/api/admin/opd-audit-mini-backfill/route.ts', 'utf8');
  assert.ok(route.includes('const already = await auditedUidsForDayInLine(day);'), 'the one work-selection read');
  assert.ok(route.includes('const audited = already.length + processed;'), 'completeness is derived from that same read');
  assert.ok(route.includes('dayComplete: total === 0 || audited + skippedCloud >= total,'), 'and it is what marches the cursor');
});
