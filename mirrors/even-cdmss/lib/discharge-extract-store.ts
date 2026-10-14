/**
 * lib/discharge-extract-store.ts — the SHARED de-identified extracted-case store
 * (Phase 1.5 substrate addendum §5, decision 7.1).
 *
 * ONE extraction, two readers. The IPD discharge audit reads every filed discharge
 * PDF on its cron and now writes the de-identified `ExtractedCase` here (an additive,
 * best-effort persistence write — lib/ipd-audit/run.ts). The readmission agent reads
 * from here first and only extracts a document itself when the store has no row,
 * writing it back. That is the whole point of 7.1: no duplicate Gemini reads, and one
 * extraction shared across both features.
 *
 * PHI POSTURE (§5a, V-approved). The row holds the de-identified `ExtractedCase` —
 * clinical content the extractor produced from a de-identified read, with patient name
 * and UHID already stripped (the extractor never emits them; `rawNotes` is
 * de-identified by construction). `document_id`/`ip_uid`/`member_id` are LINK-BACK
 * keys — re-identification metadata, never sent to a model — the same posture as the
 * `ipd_discharge_audits` row. This is a DELIBERATE expansion of what the IPD audit
 * persists (today it keeps the audit report, not the raw extract) and it is approved.
 * Content sits in Neon under the existing BAA + Tokyo residency posture.
 *
 * FAIL-SAFE, ABSOLUTELY. Every writer returns 'skipped' and every reader returns null
 * on any DB fault (including "the migration has not run yet"). Nothing here throws.
 * The IPD audit calls the writer from inside its own success path, so a store fault
 * must never be able to turn an audit that already ran into a failure.
 */

import { sql } from './db';
import type { ExtractedCase } from './doc-audit-core';

/**
 * The shared extraction version. Bump ONLY when the extractor's output shape or the
 * extract prompt changes in a way that makes an old row unusable — the upsert key is
 * (document_id, extraction_version), so a bump re-extracts rather than overwriting,
 * and both readers move together.
 *
 * doc-extract/1 → doc-extract/2 (R10-A, 28 Aug 2026; PRD R10-D2). `verbatim_sections` was added
 * to the extract contract, so a doc-extract/1 row is not merely thinner — it CANNOT answer the
 * question R10 asks of it ("does this document print an operative block?"). Reading one as if it
 * could would reproduce the exact defect R10 fixes: silence read as absence.
 *
 * ⚠️ THE BUMP COSTS BOTH READERS, ON PURPOSE. The store is shared with the IPD discharge audit
 * (lib/ipd-audit/run.ts), so its next read of any document also finds no row at doc-extract/2 and
 * re-extracts. That is the price of one shared extraction and it is the same price the store's own
 * doc comment names; the readmission backfill (POST /api/admin/readmission-reextract) pays it up
 * front for the ~190 documents the readmission cohort actually needs, and every other document is
 * re-read lazily, once, by whichever reader gets there first.
 */
export const DOC_EXTRACT_VERSION = 'doc-extract/2';

export interface StoredExtractedCase {
  documentId: string;
  extractionVersion: string;
  ipUid: string | null;
  memberId: string | null;
  extracted: ExtractedCase;
  extractedAt: string | null;
  traceId: string | null;
}

export interface UpsertExtractedCaseInput {
  documentId: string;
  ipUid?: string | null;
  memberId?: string | null;
  /** The DE-IDENTIFIED ExtractedCase exactly as lib/doc-audit's extractCase returned it. */
  extracted: ExtractedCase;
  traceId?: string | null;
  extractionVersion?: string;
}

/**
 * Upsert one extracted case. Idempotent on (document_id, extraction_version): a re-read
 * of the same document at the same version overwrites its own row rather than growing
 * the table. NEVER THROWS — returns 'skipped' on any fault.
 */
export async function upsertExtractedCase(input: UpsertExtractedCaseInput): Promise<'inserted' | 'updated' | 'skipped'> {
  if (!input.documentId || !input.extracted) return 'skipped';
  const version = input.extractionVersion || DOC_EXTRACT_VERSION;
  try {
    const rows = (await sql(
      `INSERT INTO discharge_extracted_cases
        (document_id, extraction_version, ip_uid, member_id, extracted_json, trace_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (document_id, extraction_version) DO UPDATE SET
         ip_uid = COALESCE(EXCLUDED.ip_uid, discharge_extracted_cases.ip_uid),
         member_id = COALESCE(EXCLUDED.member_id, discharge_extracted_cases.member_id),
         extracted_json = EXCLUDED.extracted_json,
         extracted_at = NOW(),
         trace_id = COALESCE(EXCLUDED.trace_id, discharge_extracted_cases.trace_id)
       RETURNING (xmax = 0) AS inserted`,
      [
        input.documentId, version, input.ipUid ?? null, input.memberId ?? null,
        JSON.stringify(input.extracted), input.traceId ?? null,
      ],
    )) as Array<{ inserted: boolean }>;
    return rows.length ? (rows[0].inserted ? 'inserted' : 'updated') : 'skipped';
  } catch {
    return 'skipped';   // migration not run / DB fault — the caller must be unaffected
  }
}

/** Parse one DB row into a StoredExtractedCase. Null when the payload is unusable. */
export function rowToStoredCase(row: Record<string, unknown> | undefined | null): StoredExtractedCase | null {
  if (!row) return null;
  const documentId = row.document_id == null ? null : String(row.document_id);
  if (!documentId) return null;
  const raw = row.extracted_json;
  let extracted: unknown = raw;
  // Neon returns jsonb as a parsed object; a text column (or a driver that does not
  // parse) would hand back a string. Tolerate both rather than lose the row.
  if (typeof raw === 'string') {
    try { extracted = JSON.parse(raw); } catch { return null; }
  }
  if (!extracted || typeof extracted !== 'object') return null;
  const s = (v: unknown) => (v == null || v === '' ? null : String(v));
  return {
    documentId,
    extractionVersion: String(row.extraction_version ?? DOC_EXTRACT_VERSION),
    ipUid: s(row.ip_uid),
    memberId: s(row.member_id),
    extracted: extracted as ExtractedCase,
    extractedAt: s(row.extracted_at),
    traceId: s(row.trace_id),
  };
}

/** Read one extracted case by document id. Null = absent (the caller extracts + writes). */
export async function fetchExtractedCase(documentId: string, extractionVersion: string = DOC_EXTRACT_VERSION): Promise<StoredExtractedCase | null> {
  if (!documentId) return null;
  try {
    const rows = (await sql(
      `SELECT document_id, extraction_version, ip_uid, member_id, extracted_json,
              to_char(extracted_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS extracted_at, trace_id
         FROM discharge_extracted_cases
        WHERE document_id = $1 AND extraction_version = $2
        LIMIT 1`,
      [documentId, extractionVersion],
    )) as Array<Record<string, unknown>>;
    return rowToStoredCase(rows[0]);
  } catch {
    return null;   // absent and unreachable are the same answer to the caller: extract it
  }
}

/**
 * H4 (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026) — a read that can tell ABSENT from
 * UNREACHABLE, across a caller-supplied list of acceptable extraction versions.
 *
 * WHY THIS EXISTS, MEASURED ON PRODUCTION 29 AUG. `fetchExtractedCase` deliberately collapses
 * "no row" and "the database faulted" into `null`, and for its original caller that is right: the
 * readmission agent's answer to both is "extract it myself". The stay library's answer to both is
 * NOT the same. It cannot extract anything — it has no model — so it writes a `not_auditable` row,
 * and that row OVERWRITES the discharge document's existing row in place, because a discharge
 * absence is keyed on the document id rather than on an `absent:` sentinel. A fault therefore
 * degraded a healthy stored discharge to "no stored extract exists", silently, and with
 * MEMBERSTATE_IPD_FOLD on that took the member's discharge-sourced medications off the spine.
 *
 * THE SECOND HALF IS THE VERSION LIST, and it is the actual defect that fired. R10-A (`9b3862a`,
 * 28 Aug) bumped `DOC_EXTRACT_VERSION` to `doc-extract/2` because R10 needs `verbatim_sections`.
 * The stay library does not: it reads diagnosis, procedure, medications, `rawNotes` and
 * `courseSummary`, every one of which a `doc-extract/1` row carries in full. But the library asked
 * for the DEFAULT version, so on 29 Aug every stay whose discharge had only a `/1` row — 560 of the
 * 843 rows in this store — read as "no document". A version bump made for one reader must not
 * blind another reader that never needed the new field.
 *
 * PURELY ADDITIVE: nothing above this line changed, and `fetchExtractedCase`'s contract is exactly
 * what it was. A test asserts that.
 */
export type ExtractReadOutcome =
  | { outcome: 'found'; stored: StoredExtractedCase; version: string }
  | { outcome: 'absent' }
  | { outcome: 'fetch_failed'; error: string };

export async function readExtractedCaseAcrossVersions(
  documentId: string,
  versions: readonly string[],
): Promise<ExtractReadOutcome> {
  if (!documentId) return { outcome: 'absent' };
  const wanted = [...new Set(versions.filter((v) => typeof v === 'string' && v))];
  if (!wanted.length) return { outcome: 'absent' };
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await sql(
      `SELECT document_id, extraction_version, ip_uid, member_id, extracted_json,
              to_char(extracted_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS extracted_at, trace_id
         FROM discharge_extracted_cases
        WHERE document_id = $1 AND extraction_version = ANY($2::text[])`,
      [documentId, wanted],
    )) as Array<Record<string, unknown>>;
  } catch (e) {
    // A FAULT IS NOT AN ABSENCE. The caller must be able to refuse to act on it.
    return { outcome: 'fetch_failed', error: String((e as Error).message).slice(0, 300) };
  }
  // Caller precedence: the FIRST version it named that actually came back. The list is ordered
  // best-first, so a document holding both versions yields the newer one.
  for (const v of wanted) {
    const row = rows.find((r) => String(r.extraction_version ?? '') === v);
    const stored = rowToStoredCase(row);
    if (stored) return { outcome: 'found', stored, version: v };
  }
  // Rows may exist and still be unusable (an unparseable payload). `rowToStoredCase` already
  // returned null for those, and "we have nothing we can read" is the honest answer either way.
  return { outcome: 'absent' };
}

/**
 * R1 batch variant (CDMSS-READMISSIONS-R1-PRD v1.1 §6): the extracted cases for MANY
 * document ids in ONE query, keyed by document id. Empty map on any DB fault, on an empty
 * input, and for every id with no row at this version — the caller (the /care/readmissions
 * list route) renders a thinner card, never a 500 and never invented data.
 *
 * ⚠️ INFERRED SQL:
 *   SELECT document_id, extraction_version, ip_uid, member_id, extracted_json,
 *          to_char(extracted_at, ...) AS extracted_at, trace_id
 *     FROM discharge_extracted_cases
 *    WHERE document_id = ANY($1::text[]) AND extraction_version = $2
 */
export async function fetchExtractedCases(documentIds: string[], extractionVersion: string = DOC_EXTRACT_VERSION): Promise<Map<string, StoredExtractedCase>> {
  const out = new Map<string, StoredExtractedCase>();
  const ids = [...new Set((documentIds ?? []).filter((d): d is string => typeof d === 'string' && d.length > 0))];
  if (!ids.length) return out;
  try {
    const rows = (await sql(
      `SELECT document_id, extraction_version, ip_uid, member_id, extracted_json,
              to_char(extracted_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS extracted_at, trace_id
         FROM discharge_extracted_cases
        WHERE document_id = ANY($1::text[]) AND extraction_version = $2`,
      [ids, extractionVersion],
    )) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const c = rowToStoredCase(r);
      if (c && !out.has(c.documentId)) out.set(c.documentId, c);
    }
    return out;
  } catch {
    return new Map();   // unreachable store = no extract for anyone; the card degrades, the page does not
  }
}

/** Store coverage for the admin/migration response. Zeroes on any fault. */
export async function extractStoreCounts(extractionVersion: string = DOC_EXTRACT_VERSION): Promise<{ total: number; atVersion: number }> {
  try {
    const rows = (await sql(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE extraction_version = $1)::int AS at_version
         FROM discharge_extracted_cases`,
      [extractionVersion],
    )) as Array<{ total: number; at_version: number }>;
    return { total: Number(rows[0]?.total ?? 0), atVersion: Number(rows[0]?.at_version ?? 0) };
  } catch {
    return { total: 0, atVersion: 0 };
  }
}
