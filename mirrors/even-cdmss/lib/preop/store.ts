/**
 * lib/preop/store.ts — persist + read pre-op findings (Neon `preop_findings` and
 * `preop_finding_versions`, created by /api/admin/migrate-preop).
 * Mirrors lib/readmission/store.ts: a pure DB layer — no LLM calls, no db13 reads, no
 * arithmetic; everything parameterised.
 *
 * IDEMPOTENCY IS THE POINT OF THIS FILE. The live row is keyed on
 * (episode_key, engine_version). `saveSnapshot` reads the stored fingerprint first and
 * takes ONE of three paths:
 *
 *   · no row              -> INSERT, version 1, no version row (nothing was destroyed)
 *   · same fingerprint    -> 'unchanged': ZERO statements are written. Not "an UPDATE
 *                            that happens to change nothing" — no write at all. That is
 *                            what makes the B2 double-tick gate provable by row counts
 *                            rather than by argument.
 *   · new fingerprint     -> snapshot the OLD reading into preop_finding_versions with
 *                            capture_reason 'overwrite', then UPDATE the live row and
 *                            bump version_no. Exactly one version row per real change.
 *
 * needs_review is refreshed on the 'unchanged' path too — it is a BOARD PREDICATE that
 * decays with the calendar (unreviewed RED/CRITICAL with surgery within 7 days), not a
 * fact about the snapshot, so it is deliberately outside the fingerprint. It is the one
 * column an unchanged tick may touch, and only when its value actually differs, so
 * "second tick writes nothing" still holds for a steady-state board.
 *
 * PHI: the row carries individual_uid / uhid as LINK-BACK keys and patient_name for the
 * board's own card header (this is a clinician-facing Managed Care surface, not an
 * analytics export). Nothing here reaches a model — B1 and B2 have no model at all.
 *
 * Fail-safe: every reader returns []/null and every writer returns 'skipped' on a DB
 * error (e.g. the migration has not run yet). The worker reports; it never 500s.
 *
 * ⚠️ INFERRED SQL throughout: this sandbox has no live Neon. Every statement is
 * validated against production by running the migration and the worker (B2 gates).
 */

import { sql } from '../db';
import type { PreopSnapshot } from '../preop-assemble-core';
import {
  buildOverwriteSnapshot, needsOverwriteSnapshot, nextVersionNo,
  PREOP_CAPTURE_REASONS, type PreopCaptureReason, type PreopVersionSnapshot,
} from '../preop-versions-core';
import { within7d } from '../preop-tier-core';

/**
 * The engine version. A bump is the A/B boundary and is FORWARD-ONLY: the next sweep
 * writes a parallel row set at the new version, the surface reads the new version only,
 * and the old rows are orphaned in place rather than migrated (the readmissions 0.1->0.2
 * mechanics, PRD §6).
 */
export const PREOP_ENGINE_VERSION = 'preop-risk/0.1';

export type SaveOutcome = 'inserted' | 'updated' | 'unchanged' | 'skipped';

export interface SaveResult {
  outcome: SaveOutcome;
  versionNo: number | null;
  /** true when this save minted a preop_finding_versions row */
  snapshotted: boolean;
  error?: string;
}

interface LiveRow {
  episode_key: string;
  engine_version: string;
  version_no: number | null;
  tier: string | null;
  snapshot: unknown;
  snapshot_fingerprint: string | null;
  computed_at: string | null;
  trace_id: string | null;
  needs_review: boolean | null;
  reviewed_version: number | null;
  pac_workflow_status: string | null;
  pac_workflow_logged_at: string | null;
}

/** jsonb tolerance — Neon usually parses, a TEXT round trip does not. */
function asObject(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, unknown>; } catch { return null; } }
  return null;
}

/** Insert ONE version row. THROWS on failure — a history table that fails quietly is
 *  worse than no history table (the R8.1 O2 asymmetry, kept). */
export async function insertVersion(s: PreopVersionSnapshot): Promise<string> {
  if (!PREOP_CAPTURE_REASONS.includes(s.captureReason)) {
    throw new Error(`capture_reason must be one of ${PREOP_CAPTURE_REASONS.join(' | ')} — got '${String(s.captureReason)}'`);
  }
  if (!s.episodeKey || !s.engineVersion) throw new Error('version row requires episode_key and engine_version');
  const rows = (await sql(
    `INSERT INTO preop_finding_versions
       (capture_reason, episode_key, engine_version, version_no, tier,
        rcri_lo, rcri_hi, mfi_lo, mfi_hi, cci_lo, cci_hi,
        snapshot_fingerprint, capture_note, computed_at, row_snapshot, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)
     RETURNING id`,
    [
      s.captureReason, s.episodeKey, s.engineVersion, s.versionNo, s.tier,
      s.rcriLo, s.rcriHi, s.mfiLo, s.mfiHi, s.cciLo, s.cciHi,
      s.snapshotFingerprint, s.captureNote, s.computedAt, JSON.stringify(s.rowSnapshot), s.traceId,
    ],
  )) as Array<{ id: string }>;
  if (!rows.length || !rows[0]?.id) throw new Error('version insert returned no row');
  return rows[0].id;
}

/**
 * The write path. See the file header for the three branches. `traceId` is carried for
 * born-instrumented provenance (PRD §6) even though B1/B2 make no model call.
 */
export async function saveSnapshot(
  snap: PreopSnapshot,
  traceId: string | null = null,
  engineVersion: string = PREOP_ENGINE_VERSION,
): Promise<SaveResult> {
  if (!snap.episodeKey) return { outcome: 'skipped', versionNo: null, snapshotted: false, error: 'no episode_key' };
  try {
    const current = (await sql(
      `SELECT episode_key, engine_version, version_no, tier, snapshot, snapshot_fingerprint,
              to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS computed_at,
              trace_id, needs_review, reviewed_version, pac_workflow_status,
              to_char(pac_workflow_logged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS pac_workflow_logged_at
         FROM preop_findings
        WHERE episode_key = $1 AND engine_version = $2`,
      [snap.episodeKey, engineVersion],
    )) as LiveRow[];
    const row = current[0] ?? null;

    // A stored review only stands for the version it was given for (mockup note 7: a new
    // snapshot version re-opens review). Recomputed here so the predicate cannot drift.
    const reviewedStands = row != null && row.reviewed_version != null && row.reviewed_version === (row.version_no ?? 0);
    const needsReview = !reviewedStands
      && (snap.tier.tier === 'RED' || snap.tier.tier === 'CRITICAL')
      && within7d(snap.context.daysToSurgery);

    if (!row) {
      await sql(
        `INSERT INTO preop_findings
           (episode_key, engine_version, individual_uid, uhid, patient_name, age, sex,
            procedure, hospital, department, surgeon, surgery_date,
            tier, rcri_lo, rcri_hi, mfi_lo, mfi_hi, cci_lo, cci_hi,
            needs_review, booking_only, pac_on_file, pac_status, pac_report_uid,
            pac_finalized_at, pac_verdict, why_line, missing_line, situation_line,
            snapshot, snapshot_fingerprint, version_no, computed_at, trace_id,
            pac_workflow_status, pac_workflow_logged_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                 $22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb,$31,1,$32,$33,$34,$35)`,
        [
          snap.episodeKey, engineVersion, snap.episode.individualUid, snap.episode.uhid,
          snap.episode.patientName, snap.episode.age, snap.episode.sex,
          snap.episode.procedure, snap.episode.hospital, snap.episode.department,
          snap.episode.surgeon, snap.episode.surgeryDate,
          snap.tier.tier, snap.rcri.lo, snap.rcri.hi, snap.mfi5.lo, snap.mfi5.hi,
          snap.charlson.lo, snap.charlson.hi,
          needsReview, snap.bookingOnly, snap.pac.onFile, snap.pac.status, snap.pac.reportUid,
          snap.pac.finalizedAt, snap.pac.verdict,
          snap.lines.why, snap.lines.missing, snap.lines.situation,
          JSON.stringify(snap), snap.fingerprint, snap.computedAt, traceId,
          snap.pac.workflowStatus, snap.pac.workflowLoggedAt,
        ],
      );
      return { outcome: 'inserted', versionNo: 1, snapshotted: false };
    }

    const willSnapshot = needsOverwriteSnapshot(row, snap.fingerprint);
    if (!willSnapshot) {
      // Same READING. Two live-row facts are deliberately outside the fingerprint and may
      // still be refreshed here: needs_review, a board predicate that decays with the
      // calendar, and the PAC booking-workflow status, which is operational rather than
      // clinical (A1-3). Both are written ONLY when they actually moved, so a steady-state
      // board still writes nothing at all and the double-tick gate still holds.
      const workflowMoved = (row.pac_workflow_status ?? null) !== (snap.pac.workflowStatus ?? null)
        || (row.pac_workflow_logged_at ?? null) !== (snap.pac.workflowLoggedAt ?? null);
      if ((row.needs_review ?? false) !== needsReview || workflowMoved) {
        await sql(
          `UPDATE preop_findings SET needs_review = $3, pac_workflow_status = $4, pac_workflow_logged_at = $5
            WHERE episode_key = $1 AND engine_version = $2`,
          [snap.episodeKey, engineVersion, needsReview, snap.pac.workflowStatus, snap.pac.workflowLoggedAt],
        );
      }
      return { outcome: 'unchanged', versionNo: row.version_no ?? 1, snapshotted: false };
    }

    // ── WHY did this version mint? (B8b) ────────────────────────────────────────
    // A sweep overwriting itself and a clinician deciding something are different events,
    // and the timeline must not call them both 'overwrite'. The set of HUMAN-sourced inputs
    // is compared old-vs-new: if it moved, a person is the reason, and the version says so.
    // Computed HERE rather than passed in, because the store is the only place that holds
    // both readings at once.
    const humanIds = (o: unknown): string => {
      const inputs = (asObject(o)?.inputs as Array<{ inputId: string; source: string | null }> | undefined) ?? [];
      return inputs.filter((i) => i.source === 'HUMAN').map((i) => i.inputId).sort().join(',');
    };
    const captureReason: PreopCaptureReason =
      humanIds(row.snapshot) !== humanIds(snap) ? 'confirm' : 'overwrite';

    // A real change: keep the reading we are about to destroy, THEN overwrite.
    await insertVersion({ ...buildOverwriteSnapshot({
      episodeKey: row.episode_key,
      engineVersion: row.engine_version,
      versionNo: row.version_no,
      tier: row.tier,
      snapshot: asObject(row.snapshot),
      snapshotFingerprint: row.snapshot_fingerprint,
      computedAt: row.computed_at,
      traceId: row.trace_id,
    }), captureReason });

    const versionNo = nextVersionNo(row, true);
    await sql(
      `UPDATE preop_findings SET
         individual_uid = $3, uhid = $4, patient_name = $5, age = $6, sex = $7,
         procedure = $8, hospital = $9, department = $10, surgeon = $11, surgery_date = $12,
         tier = $13, rcri_lo = $14, rcri_hi = $15, mfi_lo = $16, mfi_hi = $17,
         cci_lo = $18, cci_hi = $19, needs_review = $20, booking_only = $21,
         pac_on_file = $22, pac_status = $23, pac_report_uid = $24, pac_finalized_at = $25,
         pac_verdict = $26, why_line = $27, missing_line = $28, situation_line = $29,
         snapshot = $30::jsonb, snapshot_fingerprint = $31, version_no = $32,
         computed_at = $33, trace_id = $34, updated_at = NOW(),
         pac_workflow_status = $35, pac_workflow_logged_at = $36
       WHERE episode_key = $1 AND engine_version = $2`,
      [
        snap.episodeKey, engineVersion, snap.episode.individualUid, snap.episode.uhid,
        snap.episode.patientName, snap.episode.age, snap.episode.sex,
        snap.episode.procedure, snap.episode.hospital, snap.episode.department,
        snap.episode.surgeon, snap.episode.surgeryDate,
        snap.tier.tier, snap.rcri.lo, snap.rcri.hi, snap.mfi5.lo, snap.mfi5.hi,
        snap.charlson.lo, snap.charlson.hi,
        needsReview, snap.bookingOnly, snap.pac.onFile, snap.pac.status, snap.pac.reportUid,
        snap.pac.finalizedAt, snap.pac.verdict,
        snap.lines.why, snap.lines.missing, snap.lines.situation,
        JSON.stringify(snap), snap.fingerprint, versionNo, snap.computedAt, traceId,
        snap.pac.workflowStatus, snap.pac.workflowLoggedAt,
      ],
    );
    return { outcome: 'updated', versionNo, snapshotted: true };
  } catch (e) {
    return { outcome: 'skipped', versionNo: null, snapshotted: false, error: String((e as Error).message).slice(0, 300) };
  }
}

// ── reads (all fail-safe) ───────────────────────────────────────────────────────

export interface FindingRow extends Record<string, unknown> {
  episode_key: string;
  individual_uid: string | null;
  uhid: string | null;
  patient_name: string | null;
  age: number | null;
  sex: string | null;
  procedure: string | null;
  hospital: string | null;
  surgery_date: string | null;
  tier: string | null;
  rcri_lo: number | null; rcri_hi: number | null;
  mfi_lo: number | null; mfi_hi: number | null;
  cci_lo: number | null; cci_hi: number | null;
  needs_review: boolean | null;
  booking_only: boolean | null;
  pac_on_file: boolean | null;
  pac_status: string | null;
  pac_verdict: string | null;
  why_line: string | null;
  missing_line: string | null;
  situation_line: string | null;
  version_no: number | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  reviewed_version: number | null;
  computed_at: string | null;
  /** the whole stored snapshot — the read routes build their card rows from THIS, so the
   *  board renders exactly what the sweep computed and cannot drift from it */
  snapshot?: unknown;
  pac_finalized_at?: string | null;
  pac_workflow_status?: string | null;
  pac_workflow_logged_at?: string | null;
  /** B5/B6: the two rails' stored artefacts. Both live in their own columns, both are
   *  OUTSIDE the snapshot fingerprint, and neither is ever written by saveSnapshot. */
  extraction?: unknown;
  extraction_fingerprint?: string | null;
  narrative?: unknown;
  narrative_fingerprint?: string | null;
  snapshot_fingerprint?: string | null;
}

const LIST_LIMIT = 500;

/** Upcoming episodes (surgery today or later), newest-surgery-last. Fail-safe. */
export async function listUpcoming(
  engineVersion: string = PREOP_ENGINE_VERSION,
): Promise<{ rows: FindingRow[]; error: string | null }> {
  try {
    const rows = (await sql(
      `SELECT episode_key, individual_uid, uhid, patient_name, age, sex, procedure, hospital,
              department, surgeon, to_char(surgery_date, 'YYYY-MM-DD') AS surgery_date,
              tier, rcri_lo, rcri_hi, mfi_lo, mfi_hi, cci_lo, cci_hi,
              needs_review, booking_only, pac_on_file, pac_status, pac_verdict,
              why_line, missing_line, situation_line, version_no, snapshot,
              pac_finalized_at::text AS pac_finalized_at,
              pac_workflow_status,
              to_char(pac_workflow_logged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS pac_workflow_logged_at,
              to_char(reviewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS reviewed_at,
              reviewed_by, reviewed_version,
              to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS computed_at
         FROM preop_findings
        WHERE engine_version = $1
          AND surgery_date IS NOT NULL
          AND surgery_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        ORDER BY surgery_date ASC, episode_key ASC
        LIMIT ${LIST_LIMIT}`,
      [engineVersion],
    )) as FindingRow[];
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: `preop list unavailable: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/** The board's tiles + the chooser badge, from ONE predicate set. Fail-safe. */
export async function boardCounts(
  engineVersion: string = PREOP_ENGINE_VERSION,
): Promise<{ upcoming: number; needsReview: number; noPac: number; bookingOnly: number; byTier: Record<string, number>; error: string | null }> {
  const empty = { upcoming: 0, needsReview: 0, noPac: 0, bookingOnly: 0, byTier: {} as Record<string, number> };
  try {
    const rows = (await sql(
      `SELECT tier,
              count(*)::int AS n,
              sum(CASE WHEN needs_review THEN 1 ELSE 0 END)::int AS needs_review,
              sum(CASE WHEN NOT COALESCE(pac_on_file, false) THEN 1 ELSE 0 END)::int AS no_pac,
              sum(CASE WHEN COALESCE(booking_only, false) THEN 1 ELSE 0 END)::int AS booking_only
         FROM preop_findings
        WHERE engine_version = $1
          AND surgery_date IS NOT NULL
          AND surgery_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        GROUP BY tier`,
      [engineVersion],
    )) as Array<{ tier: string | null; n: number; needs_review: number; no_pac: number; booking_only: number }>;
    const out = { ...empty, byTier: {} as Record<string, number> };
    for (const r of rows) {
      out.upcoming += Number(r.n ?? 0);
      out.needsReview += Number(r.needs_review ?? 0);
      out.noPac += Number(r.no_pac ?? 0);
      out.bookingOnly += Number(r.booking_only ?? 0);
      out.byTier[r.tier ?? 'unknown'] = Number(r.n ?? 0);
    }
    return { ...out, error: null };
  } catch (e) {
    return { ...empty, error: `preop counts unavailable: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/** One episode's live row. Fail-safe (null on any error). */
export async function getFinding(
  episodeKey: string,
  engineVersion: string = PREOP_ENGINE_VERSION,
): Promise<{ row: (FindingRow & { snapshot: unknown }) | null; error: string | null }> {
  try {
    const rows = (await sql(
      `SELECT *, to_char(surgery_date, 'YYYY-MM-DD') AS surgery_date
         FROM preop_findings WHERE episode_key = $1 AND engine_version = $2`,
      [episodeKey, engineVersion],
    )) as Array<FindingRow & { snapshot: unknown }>;
    return { row: rows[0] ?? null, error: null };
  } catch (e) {
    return { row: null, error: `preop case unavailable: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/** The case page's timeline. Oldest first — the story reads forward. Fail-safe. */
export async function listVersionsForEpisode(
  episodeKey: string,
  engineVersion: string = PREOP_ENGINE_VERSION,
): Promise<{ rows: Array<Record<string, unknown>>; error: string | null }> {
  try {
    const rows = (await sql(
      `SELECT id,
              to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at,
              capture_reason, episode_key, engine_version, version_no, tier,
              rcri_lo, rcri_hi, mfi_lo, mfi_hi, cci_lo, cci_hi,
              snapshot_fingerprint, capture_note,
              to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS computed_at,
              row_snapshot, trace_id
         FROM preop_finding_versions
        WHERE episode_key = $1 AND engine_version = $2
        ORDER BY captured_at ASC
        LIMIT 200`,
      [episodeKey, engineVersion],
    )) as Array<Record<string, unknown>>;
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: `preop versions unavailable: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/** Slice 1's only workflow verb: mark THIS version reviewed. Fail-safe. */
export async function markReviewed(
  episodeKey: string,
  versionNo: number,
  by: string,
  engineVersion: string = PREOP_ENGINE_VERSION,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const rows = (await sql(
      `UPDATE preop_findings
          SET reviewed_at = NOW(), reviewed_by = $4, reviewed_version = $3, needs_review = FALSE
        WHERE episode_key = $1 AND engine_version = $2 AND version_no = $3
        RETURNING episode_key`,
      [episodeKey, engineVersion, versionNo, by],
    )) as Array<{ episode_key: string }>;
    return { ok: rows.length > 0, error: rows.length ? null : 'no row at that episode + version (a new snapshot may have re-opened review)' };
  } catch (e) {
    return { ok: false, error: String((e as Error).message).slice(0, 300) };
  }
}

// ── the two rails' artefacts (B5 / B6) ──────────────────────────────────────────
//
// Both rails write to their OWN columns on the live row and NEVER through saveSnapshot.
// Three properties follow, and all three are load-bearing:
//
//   · the snapshot fingerprint does not move when an extraction or a narrative is written,
//     so neither rail can mint a version by existing;
//   · the extraction is READ BACK before the next snapshot is composed, which is what makes
//     "unchanged source text ⇒ no model call ⇒ no re-mint" true across ticks rather than
//     only within one;
//   · a narrative carries the fingerprint it was written for, so a stale one is detectable
//     rather than merely old.
//
// Fail-safe like every other reader/writer here: a fault returns empty/false and the sweep
// reports it. The rails are enrichment; nothing about the deterministic engine depends on
// either of them succeeding.

export interface StoredRails {
  extraction: Record<string, unknown> | null;
  extractionFingerprint: string | null;
  narrative: Record<string, unknown> | null;
  narrativeFingerprint: string | null;
  snapshotFingerprint: string | null;
}

/** Every stored rail artefact for the episodes about to be swept, in ONE round trip. */
export async function readRails(
  episodeKeys: string[],
  engineVersion: string = PREOP_ENGINE_VERSION,
): Promise<{ byKey: Map<string, StoredRails>; error: string | null }> {
  const byKey = new Map<string, StoredRails>();
  if (!episodeKeys.length) return { byKey, error: null };
  try {
    const rows = (await sql(
      `SELECT episode_key, extraction, extraction_fingerprint, narrative, narrative_fingerprint,
              snapshot_fingerprint
         FROM preop_findings
        WHERE engine_version = $1 AND episode_key = ANY($2::text[])`,
      [engineVersion, episodeKeys],
    )) as Array<Record<string, unknown>>;
    for (const r of rows) {
      byKey.set(String(r.episode_key), {
        extraction: asObject(r.extraction),
        extractionFingerprint: (r.extraction_fingerprint as string | null) ?? null,
        narrative: asObject(r.narrative),
        narrativeFingerprint: (r.narrative_fingerprint as string | null) ?? null,
        snapshotFingerprint: (r.snapshot_fingerprint as string | null) ?? null,
      });
    }
    return { byKey, error: null };
  } catch (e) {
    return { byKey, error: `preop rails unavailable: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/** Write one episode's extraction record. The model/provider columns are copies of the
 *  DERIVED labels inside the blob, kept as columns only so the pack can group on them. */
export async function saveExtraction(
  episodeKey: string,
  rec: { sourceFingerprint: string; model: string | null; provider: string | null; extractedAt: string },
  blob: unknown,
  engineVersion: string = PREOP_ENGINE_VERSION,
): Promise<boolean> {
  try {
    const rows = (await sql(
      `UPDATE preop_findings
          SET extraction = $3::jsonb, extraction_fingerprint = $4,
              extraction_model = $5, extraction_provider = $6, extracted_at = $7
        WHERE episode_key = $1 AND engine_version = $2
        RETURNING episode_key`,
      [episodeKey, engineVersion, JSON.stringify(blob), rec.sourceFingerprint,
       rec.model, rec.provider, rec.extractedAt],
    )) as Array<{ episode_key: string }>;
    return rows.length > 0;
  } catch { return false; }
}

/** Write one episode's narrative. Stored whether or not it is valid (R4-4: kept for
 *  review, never rendered); `narrative_valid` is the column the pack counts on. */
export async function saveNarrative(
  episodeKey: string,
  rec: { snapshotFingerprint: string; model: string | null; provider: string | null; generatedAt: string; valid: boolean },
  blob: unknown,
  engineVersion: string = PREOP_ENGINE_VERSION,
): Promise<boolean> {
  try {
    const rows = (await sql(
      `UPDATE preop_findings
          SET narrative = $3::jsonb, narrative_fingerprint = $4, narrative_model = $5,
              narrative_provider = $6, narrative_at = $7, narrative_valid = $8
        WHERE episode_key = $1 AND engine_version = $2
        RETURNING episode_key`,
      [episodeKey, engineVersion, JSON.stringify(blob), rec.snapshotFingerprint,
       rec.model, rec.provider, rec.generatedAt, rec.valid],
    )) as Array<{ episode_key: string }>;
    return rows.length > 0;
  } catch { return false; }
}

// ── B8b · suggestion decisions: the only path from a suggestion to a score ──────
//
// Every Confirm and every Dismiss lands here, and this table is two things at once.
// Operationally it is what makes a confirmation durable across sweeps: the sweep re-reads it
// and turns each confirm into a HUMAN observation. Evidentially it is the gold-label store
// the B8d promotion gate reads — a field class earns `score` mode by accumulating decisions
// here with measured precision, not by anyone's confidence in the model.
//
// Append-only by convention and by index: a later decision on the same (episode, input,
// fingerprint) supersedes an earlier one at read time rather than overwriting it, so the
// record of somebody changing their mind survives.

export interface DecisionRow {
  episode_key: string;
  input_id: string;
  status: string;
  span: string | null;
  field: string | null;
  decision: string;
  decided_by: string;
  decided_at: string;
  source_fingerprint: string;
}

/** Write one decision. Never fail-safe-silent: the caller reports the failure to the user,
 *  because a Confirm that vanished is worse than a Confirm that was refused. */
export async function recordDecision(d: {
  episodeKey: string; inputId: string; status: string; span: string | null; field: string | null;
  decision: string; decidedBy: string; sourceFingerprint: string;
}, engineVersion: string = PREOP_ENGINE_VERSION): Promise<{ ok: boolean; error: string | null }> {
  try {
    await sql(
      `INSERT INTO preop_suggestion_decisions
         (episode_key, engine_version, input_id, status, span, field, decision, decided_by, source_fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [d.episodeKey, engineVersion, d.inputId, d.status, d.span, d.field, d.decision, d.decidedBy, d.sourceFingerprint],
    );
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: String((e as Error).message).slice(0, 300) };
  }
}

/** The latest decision per (episode, input, fingerprint) for a set of episodes. Fail-safe. */
export async function readDecisions(
  episodeKeys: string[],
  engineVersion: string = PREOP_ENGINE_VERSION,
): Promise<{ byKey: Map<string, DecisionRow[]>; error: string | null }> {
  const byKey = new Map<string, DecisionRow[]>();
  if (!episodeKeys.length) return { byKey, error: null };
  try {
    const rows = (await sql(
      `SELECT DISTINCT ON (episode_key, input_id, source_fingerprint)
              episode_key, input_id, status, span, field, decision, decided_by,
              source_fingerprint,
              to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS decided_at
         FROM preop_suggestion_decisions
        WHERE engine_version = $1 AND episode_key = ANY($2::text[])
        ORDER BY episode_key, input_id, source_fingerprint, decided_at DESC`,
      [engineVersion, episodeKeys],
    )) as DecisionRow[];
    for (const r of rows) {
      const list = byKey.get(r.episode_key) ?? [];
      list.push(r);
      byKey.set(r.episode_key, list);
    }
    return { byKey, error: null };
  } catch (e) {
    return { byKey, error: `preop decisions unavailable: ${String((e as Error).message).slice(0, 300)}` };
  }
}

/** Every decision on the board, for the B8d evidence table. Fail-safe. */
export async function decisionRollup(
  engineVersion: string = PREOP_ENGINE_VERSION,
): Promise<{ rows: Array<{ input_id: string; decision: string; n: number }>; error: string | null }> {
  try {
    const rows = (await sql(
      `SELECT input_id, decision, count(*)::int AS n
         FROM preop_suggestion_decisions WHERE engine_version = $1
        GROUP BY input_id, decision ORDER BY input_id, decision`,
      [engineVersion],
    )) as Array<{ input_id: string; decision: string; n: number }>;
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: String((e as Error).message).slice(0, 300) };
  }
}

// ── the sweep heartbeat ─────────────────────────────────────────────────────────

export interface SweepRecord {
  engineVersion: string;
  episodes: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  byTier: Record<string, number>;
  pacLinked: number;
  ms: number;
  /** sources that FAULTED this tick — the board renders a strip when this is non-empty */
  degradedSources?: string[];
  notes?: string | null;
}

/**
 * One row per tick. The mockup's "last sweep 14:00 IST" stamp needs a heartbeat that is
 * written even when no finding changed — and putting that stamp on the finding rows
 * would destroy the "second tick writes nothing" guarantee this store exists to keep.
 * ⚠️ A THIRD table, beyond the two the Build Plan names — flagged for V.
 * Fail-safe: a failed heartbeat never fails a sweep.
 */
export async function recordSweep(r: SweepRecord): Promise<boolean> {
  try {
    await sql(
      `INSERT INTO preop_sweeps
         (engine_version, episodes, inserted, updated, unchanged, skipped, by_tier, pac_linked, ms, notes, degraded_sources)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)`,
      [r.engineVersion, r.episodes, r.inserted, r.updated, r.unchanged, r.skipped,
       JSON.stringify(r.byTier), r.pacLinked, r.ms, r.notes ?? null,
       JSON.stringify(r.degradedSources ?? [])],
    );
    return true;
  } catch {
    return false;
  }
}

/** The board's "last sweep" stamp. Fail-safe. */
export async function lastSweep(
  engineVersion: string = PREOP_ENGINE_VERSION,
): Promise<{ at: string | null; episodes: number | null; degradedSources: string[]; error: string | null }> {
  try {
    const rows = (await sql(
      `SELECT to_char(ran_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ran_at, episodes, degraded_sources
         FROM preop_sweeps WHERE engine_version = $1 ORDER BY ran_at DESC LIMIT 1`,
      [engineVersion],
    )) as Array<{ ran_at: string; episodes: number; degraded_sources: unknown }>;
    const raw = rows[0]?.degraded_sources;
    const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
    return {
      at: rows[0]?.ran_at ?? null,
      episodes: rows[0]?.episodes ?? null,
      degradedSources: Array.isArray(parsed) ? (parsed as unknown[]).map(String) : [],
      error: null,
    };
  } catch (e) {
    return { at: null, episodes: null, degradedSources: [], error: String((e as Error).message).slice(0, 300) };
  }
}
