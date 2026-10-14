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
 * lib/ccb-store.ts — persist + read Care Conversation Briefs (Neon `ccb_briefs`).
 *
 * Maps a de-identified CcbEnvelope → one presc_uid-keyed row. Idempotent insert
 * (ON CONFLICT (presc_uid, engine_version) DO NOTHING) — the table is its own watermark.
 * The re-identification keys (presc_uid/individual_uid/uhid/kx_encounter_id) live here only
 * for join-back + the P5 conversion funnel; they are never in the stored envelope's model path.
 */

import { sql } from './db';
import type { CcbEnvelope } from './ccb-brief-core';
import type { EpisodeKeys } from './ccb-fetch-core';

export interface SaveBriefMeta { model?: string | null; latencyMs?: number | null }

/** Insert one brief. Returns 'inserted' | 'exists' (already generated at this engine version) | 'skipped'. */
export async function saveBrief(env: CcbEnvelope, keys: EpisodeKeys, meta: SaveBriefMeta = {}): Promise<'inserted' | 'exists' | 'skipped'> {
  if (!keys.prescUid) return 'skipped';
  const gs = env.grounding_summary;
  const rows = (await sql(
    `INSERT INTO ccb_briefs
       (presc_uid, individual_uid, uhid, kx_encounter_id, note_date, coverage,
        engine_version, priority, pitch_allowed,
        n_findings, n_cited, citation_coverage_pct, distinct_sources,
        envelope, model, trace_id, latency_ms, doctor_uid, doctor_speciality)
     VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9, $10,$11,$12,$13, $14::jsonb,$15,$16,$17, $18,$19)
     ON CONFLICT (presc_uid, engine_version) DO NOTHING
     RETURNING id`,
    [
      keys.prescUid, keys.individualUid, keys.kxUhid, keys.kxEncounterId, keys.noteDate, env.episode.coverage,
      env.engine_version, env.commercial.priority, env.commercial.pitch_allowed,
      gs.findings, gs.corpus_cited, gs.citation_coverage_pct, gs.distinct_sources,
      JSON.stringify(env), meta.model ?? null, env.trace_id ?? null, meta.latencyMs ?? null,
      keys.doctorUid, keys.doctorSpeciality,
    ],
  )) as Array<{ id: string }>;
  return rows.length ? 'inserted' : 'exists';
}

/** Latest stored envelope for a prescription at an engine version (P1 read-through cache). */
export async function getBriefByUid(prescUid: string, engineVersion: string): Promise<CcbEnvelope | null> {
  const rows = (await sql(
    `SELECT envelope FROM ccb_briefs WHERE presc_uid = $1 AND engine_version = $2 ORDER BY created_at DESC LIMIT 1`,
    [prescUid, engineVersion],
  )) as Array<{ envelope: CcbEnvelope }>;
  return rows[0]?.envelope ?? null;
}

/** Which of `uids` already have a brief at this engine version — the batch watermark (uid-set
 *  based, so it's immune to note_date timezone edge-cases; never re-charges an already-briefed note). */
export async function briefedUidsForSet(uids: string[], engineVersion: string): Promise<Set<string>> {
  const clean = Array.from(new Set((uids || []).filter((u) => /^[A-Za-z0-9_-]{6,64}$/.test(u))));
  if (!clean.length) return new Set();
  const rows = (await sql(
    `SELECT presc_uid FROM ccb_briefs WHERE engine_version = $1 AND presc_uid = ANY($2)`,
    [engineVersion, clean],
  )) as Array<{ presc_uid: string }>;
  return new Set(rows.map((r) => r.presc_uid));
}

/** Earliest IST day that has any brief — the floor for the gap-fill sweep (never reach before
 *  the system launched). Null if nothing briefed yet. Approximate floor; exactness not required. */
export async function earliestBriefedDay(): Promise<string | null> {
  const rows = (await sql(
    `SELECT to_char(min((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') AS d FROM ccb_briefs`,
  )) as Array<{ d: string | null }>;
  return rows[0]?.d ?? null;
}
