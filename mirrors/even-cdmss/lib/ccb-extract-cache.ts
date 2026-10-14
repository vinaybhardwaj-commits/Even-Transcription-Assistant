/**
 * ⚠️ RETIRED SURFACE — DO NOT DELETE. The mechanics here are LIVE.
 *
 * Care Conversation Briefs was retired as a care-manager product on 30 Jul 2026 — non-use, not
 * malfunction. The nav card is gone and the batch cron is paused, so this code is now invisible,
 * unused-looking and untraced: exactly the profile a tech-debt sweep deletes. It must not be.
 *
 * These mechanics are the best working example of ClinicalState, MemberState and the longitudinal
 * spine in the system, and they are RE-EXPOSED as a microservice behind /api/v1/patient-summary,
 * which feeds the physician's pre-encounter Patient Summary in Pulse (the OPD HIS). Deleting or
 * "cleaning up" anything here breaks that API.
 *
 * See: CDMSS-CCB-REPURPOSE-PRD-v0.1-30-JUL-2026 and the Patient Summary API kickoff (30 Jul 2026),
 * and the entry in CDMSS-OPEN-ISSUE-REGISTER-23-JUL-2026.md.
 *
 * ⚠️ HAZARD — CCB_ENABLED IS NOT A CCB FLAG. It gates ALL EIGHT /care pages: /care, /care/briefs,
 * /care/m/[uid], /care/[uid], /care/triage, /care/review, /care/lvc, /care/concepts. Setting it to
 * 0 does NOT disable CCB — it 404s the entire care-manager surface and takes down OPD Audit
 * Triage, LVC adjudication, Concept Coder and Review Mode with it. The flag keeps its name by
 * decision; this warning is the mitigation.
 */
/**
 * lib/ccb-extract-cache.ts — CCB v2 P1: per-document extract cache, WIRED half.
 *
 * A finalized result PDF never changes, so its de-identified extract is immutable and has no TTL.
 * Caching it turns a `fresh=1` regenerate from N multimodal PDF reads into 0–N (only new docs).
 *
 * Keyed by `docSha(url)` — the hash, not the URL. The stored value is the already-de-identified
 * `ExtractedReport` (the extractor strips name/uhid/mobile); same PHI posture as the envelope.
 *
 * FAIL-SAFE: a read error is a MISS (regenerate), a write error is a skipped persist. Never throws.
 */

import { sql } from './db';
import { docSha } from './ccb-extract-cache-core';
import { isEmptyExtract } from './doc-transport-core';
import type { ExtractedReport } from './ccb-brief-core';

/** Cached extract for this exact URL, or null on miss / corrupt row / read error. */
export async function getExtract(url: string): Promise<ExtractedReport | null> {
  try {
    const rows = (await sql(
      `SELECT extract FROM ccb_doc_extract WHERE doc_sha = $1`,
      [docSha(url)],
    )) as Array<{ extract: unknown }>;

    let v = rows[0]?.extract;
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch { return null; }
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as ExtractedReport;
  } catch {
    return null;
  }
}

/** Persist an extract. Immutable: first write wins (`ON CONFLICT DO NOTHING`). Never throws.
 *
 *  §2.2 (30 Jul): REFUSES an empty extract. Because this store is immutable by design, a silent
 *  empty read from a scanned report was cached FOREVER for that URL — it never self-healed, and
 *  every later brief inherited it. An empty result is a failure, not a value, and a failure must
 *  never enter an immutable store. The guard is here, at the write, so no caller can bypass it. */
export async function putExtract(url: string, extract: ExtractedReport, model?: string | null): Promise<void> {
  if (isEmptyExtract(extract)) return;
  try {
    await sql(
      `INSERT INTO ccb_doc_extract (doc_sha, extract, model)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (doc_sha) DO NOTHING`,
      [docSha(url), JSON.stringify(extract), model ?? null],
    );
  } catch {
    // Cache persist is best-effort; the brief has already been read successfully.
  }
}
