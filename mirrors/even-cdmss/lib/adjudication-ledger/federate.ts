// lib/adjudication-ledger/federate.ts — Adjudication Ledger (#3): the read-time federation layer.
//
// Queries each HUMAN adjudication store (FEDERATED_STORES) and normalizes to LedgerRow[]. This is a
// READ-time federation — NO storage migration, the live per-surface stores are untouched (each read
// is a plain SELECT + join for engine_version / finding subject; latest-row-wins per finding).
//
// HUMAN GROUND-TRUTH ONLY. The four SELECTs below hit exactly the four human stores; this file
// references NONE of the machine/judge verdict tables (EXCLUDED_MACHINE_STORES) — a source test
// asserts it. Best-effort: each store's read is isolated in try/catch, so a missing table / outage
// on one surface degrades to an empty contribution, never breaks the ledger.
//
// De-identified: only finding + audit link-back keys, verdicts, notes, and the "who" where the store
// captures it. No patient identifiers.

import { sql } from '../db';
import {
  FEDERATED_STORES, normalizeVerdict, type LedgerRow, type FederatedStore,
} from './core';

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

// The IPD engine the consensus gold measures (gold adjudication carries no engine column of its own;
// the K=5 findings it adjudicates were produced by this engine). Local const — avoids a value-import
// edge into the ipd-audit subsystem.
const IPD_GOLD_ENGINE_VERSION = 'ipd-discharge-audit/0.1';

const s = (v: unknown): string => (v == null ? '' : String(v));
const orNull = (v: unknown): string | null => { const t = s(v).trim(); return t === '' ? null : t; };
const iso = (v: unknown): string => { const t = s(v); return t ? new Date(t).toISOString() : ''; };

function meta(store: string): FederatedStore {
  return FEDERATED_STORES.find((f) => f.store === store)!;
}

/** ipd_audit_feedback — S3.2 finding-triage (true_positive/nitpick/false/contested). Finding-level
 *  rows only (whole-audit agree/disagree reactions have finding_ref NULL and are excluded). */
async function fromIpdAuditFeedback(): Promise<LedgerRow[]> {
  const m = meta('ipd_audit_feedback');
  try {
    const rows = await run(
      `SELECT DISTINCT ON (f.audit_id, f.finding_ref)
              f.audit_id, f.finding_ref, f.verdict, f.note, f.created_at, a.engine_version
         FROM ipd_audit_feedback f
         JOIN ipd_discharge_audits a ON a.id = f.audit_id
        WHERE f.app_source = $1 AND f.finding_ref IS NOT NULL
        ORDER BY f.audit_id, f.finding_ref, f.created_at DESC`,
      [APP],
    );
    return rows.flatMap((r) => {
      const canonical = normalizeVerdict('finding', s(r.verdict));
      if (!canonical) return [];   // drops needs_action / bare comments
      const auditId = s(r.audit_id);
      return [{
        surface: m.surface, store: m.store, engine_version: s(r.engine_version) || IPD_GOLD_ENGINE_VERSION,
        audit_ref: auditId, finding_ref: orNull(r.finding_ref), finding_subject: orNull(r.finding_ref),
        engine_verdict: null, human_verdict: s(r.verdict), verdict_family: 'finding', canonical_verdict: canonical,
        note: orNull(r.note), adjudicated_at: iso(r.created_at), reviewer: null,
        link: `/admin/ipd-audit/${auditId}`,
      } as LedgerRow];
    });
  } catch { return []; }
}

/** opd_audit_feedback — scope='finding' rows (same OPD-grade vocab); `author` is the "who". */
async function fromOpdAuditFeedback(): Promise<LedgerRow[]> {
  const m = meta('opd_audit_feedback');
  try {
    const rows = await run(
      `SELECT DISTINCT ON (f.audit_id, f.finding_ref)
              f.audit_id, f.finding_ref, f.verdict, f.comment, f.author, f.created_at, a.engine_version
         FROM opd_audit_feedback f
         JOIN opd_note_audits a ON a.id = f.audit_id
        WHERE f.app_source = $1 AND f.scope = 'finding' AND f.finding_ref IS NOT NULL
          AND f.study IS NOT DISTINCT FROM $2
        ORDER BY f.audit_id, f.finding_ref, f.created_at DESC`,
      [APP, null],
    );
    return rows.flatMap((r) => {
      const canonical = normalizeVerdict('finding', s(r.verdict));
      if (!canonical) return [];
      const auditId = s(r.audit_id);
      return [{
        surface: m.surface, store: m.store, engine_version: s(r.engine_version) || 'opd-note-audit/0.1',
        audit_ref: auditId, finding_ref: orNull(r.finding_ref), finding_subject: orNull(r.finding_ref),
        engine_verdict: null, human_verdict: s(r.verdict), verdict_family: 'finding', canonical_verdict: canonical,
        note: orNull(r.comment), adjudicated_at: iso(r.created_at), reviewer: orNull(r.author),
        link: `/admin/opd-audit/${auditId}`,
      } as LedgerRow];
    });
  } catch { return []; }
}

/** ipd_gold_adjudication — the consensus-gold union verdicts (single-validator V). Joins candidates
 *  for the finding text; latest verdict per candidate wins. */
async function fromIpdGoldAdjudication(): Promise<LedgerRow[]> {
  const m = meta('ipd_gold_adjudication');
  try {
    const rows = await run(
      `SELECT DISTINCT ON (g.candidate_id)
              g.candidate_id, g.case_id, g.verdict, g.note, g.created_at,
              c.finding_text, c.in_gold, c.k5_count
         FROM ipd_gold_adjudication g
         LEFT JOIN ipd_gold_union_candidates c ON c.id = g.candidate_id
        WHERE g.app_source = $1
        ORDER BY g.candidate_id, g.created_at DESC`,
      [APP],
    );
    return rows.flatMap((r) => {
      const canonical = normalizeVerdict('finding', s(r.verdict));
      if (!canonical) return [];
      return [{
        surface: m.surface, store: m.store, engine_version: IPD_GOLD_ENGINE_VERSION,
        audit_ref: s(r.case_id), finding_ref: orNull(r.candidate_id), finding_subject: orNull(r.finding_text),
        engine_verdict: r.k5_count != null ? `k5=${s(r.k5_count)}/5${r.in_gold ? ' · in-gold' : ''}` : null,
        human_verdict: s(r.verdict), verdict_family: 'finding', canonical_verdict: canonical,
        note: orNull(r.note), adjudicated_at: iso(r.created_at), reviewer: 'V',
        link: `/admin/ipd-gold-queue`,
      } as LedgerRow];
    });
  } catch { return []; }
}

/** episode_recon_ratings — the FIDELITY family (V). Latest rating per (document, version, phase,
 *  fact) wins. Kept separate; never feeds precision. */
async function fromEpisodeRecon(): Promise<LedgerRow[]> {
  const m = meta('episode_recon_ratings');
  try {
    const rows = await run(
      `SELECT DISTINCT ON (document_id, version, phase, fact_ref)
              document_id, version, phase, fact_ref, verdict, note, created_at
         FROM episode_recon_ratings
        WHERE app_source = $1
        ORDER BY document_id, version, phase, fact_ref, created_at DESC`,
      [APP],
    );
    return rows.flatMap((r) => {
      const canonical = normalizeVerdict('fidelity', s(r.verdict));
      if (!canonical) return [];
      const phase = s(r.phase);
      const factRef = orNull(r.fact_ref);
      return [{
        surface: m.surface, store: m.store, engine_version: s(r.version) || 'episode-state/0.2',
        audit_ref: s(r.document_id), finding_ref: factRef,
        finding_subject: factRef ? `${phase} · ${factRef}` : `${phase} (phase-level)`,
        engine_verdict: null, human_verdict: s(r.verdict), verdict_family: 'fidelity', canonical_verdict: canonical,
        note: orNull(r.note), adjudicated_at: iso(r.created_at), reviewer: 'V',
        link: `/admin/episode-recon-queue`,
      } as LedgerRow];
    });
  } catch { return []; }
}

/** Federate every human store into one normalized stream (each read best-effort). Sorted newest
 *  first. NO machine/judge store is read here — human ground-truth only. */
export async function federateAdjudications(): Promise<LedgerRow[]> {
  const parts = await Promise.all([
    fromIpdAuditFeedback(),
    fromOpdAuditFeedback(),
    fromIpdGoldAdjudication(),
    fromEpisodeRecon(),
  ]);
  return parts.flat().sort((a, b) => (a.adjudicated_at < b.adjudicated_at ? 1 : a.adjudicated_at > b.adjudicated_at ? -1 : 0));
}
