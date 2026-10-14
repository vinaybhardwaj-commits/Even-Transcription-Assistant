/**
 *   npm test   (this file imports lib/db, so it runs under the tsx suite rather than
 *               the bare `node --experimental-strip-types --test` command the pure
 *               cores use — extensionless imports do not resolve there.)
 *
 * The SHARED de-identified extracted-case store (Readmission Phase 1.5 addendum §5,
 * decision 7.1). What matters here is the FAIL-SAFE contract, not the SQL: the IPD
 * discharge audit calls the writer from inside its own success path, so a store fault —
 * including the migration simply not having run yet — must degrade quietly and can
 * never turn an audit that already ran into a failure.
 *
 * There is no database in this sandbox, which IS the fault condition under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  upsertExtractedCase, fetchExtractedCase, rowToStoredCase, DOC_EXTRACT_VERSION,
} from '../discharge-extract-store';
import type { ExtractedCase } from '../doc-audit-core';

const extracted = {
  docType: 'discharge_summary', detectedDocType: 'discharge_summary', confidence: 0.9,
  patient: { age: 61, sex: 'M' },
  diagnosis: 'Acute kidney injury', indication: null, procedure: null,
  investigations: ['Creatinine 3.1 (0.6-1.2)'], treatments: ['IV fluids'], medications: ['Furosemide 40mg'],
  courseSummary: 'Improved with fluids.', disposition: 'Stable at discharge', followUp: 'OPD in 1 week',
  rawNotes: 'de-identified notes',
} as unknown as ExtractedCase;

test('a write degrades to "skipped" and a read to null — never a throw', async () => {
  assert.equal(await upsertExtractedCase({ documentId: '', extracted }), 'skipped');
  assert.equal(await upsertExtractedCase({ documentId: 'doc-1', extracted }), 'skipped');
  assert.equal(await fetchExtractedCase('doc-1'), null);
  assert.equal(await fetchExtractedCase(''), null);
});

test('absent and unreachable are the same answer to the reader: extract it yourself', async () => {
  // The readmission assemble branches on null alone, so the store must never make the
  // caller distinguish "no row" from "no database".
  assert.equal(await fetchExtractedCase('doc-that-does-not-exist'), null);
});

test('rowToStoredCase round-trips a stored row', () => {
  const row = {
    document_id: 'doc-1', extraction_version: DOC_EXTRACT_VERSION, ip_uid: 'IP-1250',
    member_id: 'mem-1', extracted_json: extracted,
    extracted_at: '2026-08-05T10:00:00+05:30', trace_id: 'tr-1',
  };
  const parsed = rowToStoredCase(row);
  assert.equal(parsed?.documentId, 'doc-1');
  assert.equal(parsed?.extractionVersion, DOC_EXTRACT_VERSION);
  assert.equal(parsed?.ipUid, 'IP-1250');
  assert.equal(parsed?.memberId, 'mem-1');
  assert.equal(parsed?.traceId, 'tr-1');
  assert.equal(parsed?.extracted.diagnosis, 'Acute kidney injury');
  assert.deepEqual(parsed?.extracted.investigations, ['Creatinine 3.1 (0.6-1.2)']);
});

test('a jsonb column handed back as TEXT is tolerated; unusable payloads are refused, not guessed', () => {
  const row = {
    document_id: 'doc-1', extraction_version: DOC_EXTRACT_VERSION,
    ip_uid: null, member_id: null, extracted_json: JSON.stringify(extracted),
    extracted_at: null, trace_id: null,
  };
  assert.equal(rowToStoredCase(row)?.extracted.diagnosis, 'Acute kidney injury');
  assert.equal(rowToStoredCase(row)?.ipUid, null);
  assert.equal(rowToStoredCase({ ...row, extracted_json: 'not json at all' }), null);
  assert.equal(rowToStoredCase({ ...row, extracted_json: null }), null);
  assert.equal(rowToStoredCase({ ...row, document_id: null }), null);
  assert.equal(rowToStoredCase(undefined), null);
  assert.equal(rowToStoredCase(null), null);
});

test('the extraction version is a shared constant both readers move on together', () => {
  // R10-A (28 Aug 2026): doc-extract/1 → doc-extract/2 for `verbatim_sections`. This pin is
  // deliberately a LITERAL and not a reference — it is the line that makes a version bump a
  // decision someone had to type, rather than a side effect of editing the extractor.
  assert.equal(DOC_EXTRACT_VERSION, 'doc-extract/2');
  // The default must be the constant, not a literal restated at a call site.
  assert.equal(rowToStoredCase({ document_id: 'd', extracted_json: {} })?.extractionVersion, DOC_EXTRACT_VERSION);
});
