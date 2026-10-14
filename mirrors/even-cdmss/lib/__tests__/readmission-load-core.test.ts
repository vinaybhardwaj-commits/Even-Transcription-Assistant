/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-load-core.test.ts
 * R5.1 (CDMSS Readmissions R5.1 PRD v1.0) — the board's load-state decisions: the exact copy, the
 * timeout / slow thresholds, abort classification, and the board wiring (source-read: AbortController
 * at 45 s, slow line at 8 s, error state + Retry, no polling / auto-retry, R5 untouched).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyLoadFailure, isAbortError, loadingLines,
  LOAD_TIMEOUT_MS, SLOW_AFTER_MS, LOADING_COPY, SLOW_LOAD_COPY, LOAD_ERROR_HEADING, LOAD_ERROR_TIMEOUT_DETAIL, LOAD_ERROR_OTHER_DETAIL, RETRY_LABEL, REFRESH_FAILED_COPY,
} from '../readmission-load-core.ts';

const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

test('the normative numbers and copy, verbatim', () => {
  assert.equal(LOAD_TIMEOUT_MS, 45_000);
  assert.equal(SLOW_AFTER_MS, 8_000);
  assert.equal(LOADING_COPY, 'Loading…');
  assert.equal(SLOW_LOAD_COPY, 'Still loading — the record systems are slow right now.');
  assert.equal(LOAD_ERROR_HEADING, 'The case list did not load.');
  assert.equal(LOAD_ERROR_TIMEOUT_DETAIL, 'It took too long. The record systems may be slow.');
  assert.equal(LOAD_ERROR_OTHER_DETAIL, 'Something went wrong on the way to the server.');
  assert.equal(RETRY_LABEL, 'Retry');
});

test('isAbortError / classifyLoadFailure: an AbortError (DOMException or shaped error) → timeout detail; anything else → other detail; never throws', () => {
  const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  assert.equal(isAbortError(abort), true);
  assert.deepEqual(classifyLoadFailure(abort), { kind: 'timeout', heading: LOAD_ERROR_HEADING, detail: LOAD_ERROR_TIMEOUT_DETAIL });
  assert.equal(classifyLoadFailure(Object.assign(new Error('x'), { name: 'TimeoutError' })).kind, 'timeout');
  assert.equal(classifyLoadFailure(new Error('signal is aborted without reason')).kind, 'timeout');
  assert.deepEqual(classifyLoadFailure(new Error('status 502')), { kind: 'other', heading: LOAD_ERROR_HEADING, detail: LOAD_ERROR_OTHER_DETAIL });
  assert.equal(classifyLoadFailure(new TypeError('Failed to fetch')).kind, 'other');
  assert.equal(classifyLoadFailure(null).kind, 'other'); assert.equal(classifyLoadFailure('junk').kind, 'other'); assert.equal(classifyLoadFailure(undefined).kind, 'other');
  assert.equal(isAbortError(null), false); assert.equal(isAbortError({}), false);
});

test('loadingLines: only "Loading…" before 8 s; the slow line joins at and after 8 s', () => {
  assert.deepEqual(loadingLines(0), [LOADING_COPY]);
  assert.deepEqual(loadingLines(7_999), [LOADING_COPY]);
  assert.deepEqual(loadingLines(8_000), [LOADING_COPY, SLOW_LOAD_COPY]);
  assert.deepEqual(loadingLines(44_000), [LOADING_COPY, SLOW_LOAD_COPY]);
});

test('board wiring (source-read): AbortController aborted at LOAD_TIMEOUT_MS, slow line at SLOW_AFTER_MS, error state with heading + detail + Retry re-running the same load, no setInterval / auto-retry; R5 filter wiring and the Suspense wrapper untouched', () => {
  const b = code('components/care/ReadmissionsBoard.tsx');
  assert.match(b, /new AbortController\(\)/);
  assert.match(b, /setTimeout\(\(\) => ctrl\.abort\(\), LOAD_TIMEOUT_MS\)/);
  assert.match(b, /fetch\('\/api\/care\/readmissions\/list', \{ signal: ctrl\.signal \}\)/);
  assert.match(b, /setTimeout\(\(\) => setSlow\(true\), SLOW_AFTER_MS\)/);
  assert.match(b, /classifyLoadFailure\(e\)/);
  assert.match(b, /\{loadError\.heading\}/); assert.match(b, /\{loadError\.detail\}/); assert.match(b, /\{RETRY_LABEL\}/);
  assert.match(b, /onClick=\{\(\) => void load\(\)\}[^\n]*\{RETRY_LABEL\}/);
  assert.ok(!/setInterval/.test(b), 'nothing polls');
  assert.equal((b.match(/void load\(\)/g) ?? []).length, 4, 'exactly: mount effect, Refresh, first-load Retry, refresh Retry (R6.1) — no automatic retry');
  // R5 untouched (R6.1: the board applies the EFFECTIVE filters — unknown fac dropped)
  assert.match(b, /applyFilters\(eligible, applied\)/); assert.match(b, /showingLine\(visible\.length, eligible\.length\)/);
  assert.match(b, /router\.replace\(/);
});

// ── R6.1 ─────────────────────────────────────────────────────────────────────────────────

test('R6.1 (R61-1): a failed refresh keeps the cards — inline "Refresh did not work." + Retry by the control, slow line inline during a slow refresh; the control re-enables; first-load error state unchanged', () => {
  const b = code('components/care/ReadmissionsBoard.tsx');
  assert.equal(REFRESH_FAILED_COPY, 'Refresh did not work.');
  assert.match(b, /\{data && !loading && refreshFailed && \(/);
  assert.match(b, /\{REFRESH_FAILED_COPY\}\{' '\}\s*\n?\s*<button type="button" onClick=\{\(\) => void load\(\)\}[^\n]*\{RETRY_LABEL\}/);
  assert.match(b, /\{data && loading && slow && <p[^\n]*\{SLOW_LOAD_COPY\}/);
  assert.match(b, /setRefreshFailed\(true\)/); assert.match(b, /setRefreshFailed\(false\)/);
  // the loaded view is never discarded on a failed refresh: setData is called only on success
  assert.equal((b.match(/setData\(/g) ?? []).length, 1);
  assert.match(b, /<button onClick=\{\(\) => void load\(\)\} disabled=\{loading\}[\s\S]{0,300}\/>Refresh\s*\n?\s*<\/button>/);
  // first-load state intact
  assert.match(b, /\{!loading && !data && loadError && \(/);
  assert.equal((b.match(/void load\(\)/g) ?? []).length, 4, 'mount, Refresh, first-load Retry, refresh Retry — still no automatic retry');
  assert.ok(!/setInterval/.test(b));
});

test('R6.1 (R61-2): the Suspense wrapper is gone — the board hydrates with the root, so the mount effect (the fetch) runs even in a hidden tab; useSearchParams stays (force-dynamic page, no boundary needed)', () => {
  const b = code('components/care/ReadmissionsBoard.tsx');
  assert.ok(!/<Suspense/.test(b), 'no Suspense boundary around the board');
  assert.ok(!/from 'react'[^\n]*Suspense|Suspense[^\n]*from 'react'/.test(b));
  assert.match(b, /useSearchParams\(\)/);
  assert.match(b, /export default function ReadmissionsBoard\(\)/);
  assert.match(b, /useEffect\(\(\) => \{ void load\(\); \}, \[load\]\);/);
  assert.match(code('app/care/readmissions/page.tsx'), /export const dynamic = 'force-dynamic';/);
});

test('R6.1 (R61-3): the case page header shows the hospital verbatim from the list overlay (the same value the card shows); nothing when unknown; the case route is untouched (no new SQL)', () => {
  const page = code('components/care/ReadmissionCasePage.tsx');
  assert.match(page, /facility: card\.facility \?\? data\.row\.facility \?\? null/);
  assert.match(page, /\{row\.facility && <span[^>]*>· \{row\.facility\}<\/span>\}/);
  const route = code('app/api/care/readmissions/case/route.ts');
  assert.ok(!/facility/.test(route), 'the case route was not extended — the facility rides the list overlay the page already fetches');
});
