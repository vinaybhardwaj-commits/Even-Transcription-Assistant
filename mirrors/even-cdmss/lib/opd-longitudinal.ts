// lib/opd-longitudinal.ts — Stage 3 Longitudinal OPD Audit WIRED layer (opd-longitudinal/0.1).
//
// The two-pass shape (PRD §5, D1): the base `auditOpdNote` completes and is PERSISTED unchanged; THEN
// this runs — resolve the member → reconstruct MemberState AS OF the visit date via the additive frozen
// sibling `getMemberSnapshotAsOf` → deterministic L1–L3 (pure core) → one focused LLM pass (L4–L6) →
// stamp + apply suppressions → store into the additive `longitudinal` jsonb column. It NEVER blocks or
// mutates the base audit; every failure degrades per the PRD §7 table (never a 500, never a lost base row).
//
// SQL honesty: member/lab reads go EXCLUSIVELY through `getMemberSnapshotAsOf` (the frozen db13 SQL). The
// ONLY SQL here is the additive own-DB `longitudinal`-column UPDATE (the migration adds the column).
// Dark unless OPD_LONGITUDINAL_ENABLED=1 (the store hook) — replay drives it explicitly regardless.

import { sql } from './db';
import { individualUidForPresc, getMemberSnapshotAsOf } from './member-state/member-state';
import { presentMemberState } from './member-state/present-core';
import { loadActiveSuppressions } from './audit-suppression-store';
import { applySuppressions } from './audit-suppression-core';
import { startTrace, governedChat, finishTrace, logEvent } from './trace';
import { geminiModelFor, geminiUtilityModel, TEXT_MODEL } from './llm';
import type { OpdNoteAudit } from './opd-note-audit';
import {
  OPD_LONGITUDINAL_VERSION, runDeterministicBattery, serializeContextBlock, buildLongitudinalUser,
  parseLongitudinalLlm, stampLongitudinal, emptyLongitudinalBlock, confidenceFor,
  LONGITUDINAL_LLM_SYSTEM,
  type LongitudinalNoteInput, type LongitudinalBlock, type LongitudinalExcludedReason,
} from './opd-longitudinal-core';

/** One focused LLM call for the judged dimensions (L4–L6). Utility tier (Gemini Flash when on, local
 *  TEXT_MODEL otherwise) — NO new model/provider/dep. Returns raw text; empty on any failure. */
async function judgeContinuity(system: string, user: string, traceId?: string): Promise<string> {
  const geminiModel = geminiModelFor('opd_longitudinal') ?? geminiUtilityModel();
  const params = {
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    max_tokens: 1400,
  };
  // Governed envelope (Stage 4). No promptRef: LONGITUDINAL_LLM_SYSTEM is array-joined, not a
  // registry-extractable template-literal const (registering it is a Stage-0 rule change).
  const r = await governedChat(traceId, 'opd_longitudinal_judge', params, { gemini: geminiModel });
  return r?.choices?.[0]?.message?.content || '';
}

/**
 * Compute the longitudinal block for one audited note. NEVER throws — every failure returns an honest
 * empty/degraded block per the PRD §7 table. `existingTraceId` reuses the base audit's trace when present.
 */
export async function runLongitudinalAudit(input: LongitudinalNoteInput, opts: { traceId?: string } = {}): Promise<LongitudinalBlock> {
  const computedAt = new Date().toISOString();     // wired layer stamps the clock (frozen cores never do)
  const asOf = input.noteDate;

  // (1) resolve the member from the audited presc uid.
  const individualUid = await individualUidForPresc(input.uid).catch(() => null);
  if (!individualUid) return emptyLongitudinalBlock(asOf, 0, 'none', 'member_unresolved');

  // (2) reconstruct MemberState AS OF the visit (frozen SQL + folds, D2 cut, self-exclusion). A thrown
  //     error = a real fetch/build failure → context_fetch_failed; null = resolved-but-no-prior-history.
  let snap;
  try {
    snap = await getMemberSnapshotAsOf(individualUid, asOf, computedAt, input.uid);
  } catch {
    return emptyLongitudinalBlock(asOf, 0, 'none', 'context_fetch_failed');
  }
  if (!snap) return emptyLongitudinalBlock(asOf, 0, 'none', 'no_prior_history');

  const encounters = snap.sourceEncounterRefs.length;
  const confidence = confidenceFor(encounters);
  const view = presentMemberState(snap);

  // (3) deterministic L1–L3 (cite hard artifacts; run whenever history exists).
  const det = runDeterministicBattery(input, snap, view);

  // (4) judged L4–L6 — one call, grounded-or-dropped. Excluded on low picture-confidence (deterministic
  //     still stands); on an LLM failure the deterministic findings survive (llm_failed).
  let llm = [] as ReturnType<typeof parseLongitudinalLlm>;
  let excluded: LongitudinalExcludedReason = null;
  if (confidence !== 'established') {
    excluded = 'low_confidence_state';
  } else {
    try {
      const ctx = serializeContextBlock(snap, view);
      const raw = await judgeContinuity(LONGITUDINAL_LLM_SYSTEM, buildLongitudinalUser(ctx, input), opts.traceId);
      llm = parseLongitudinalLlm(raw, ctx.validMonths);
    } catch {
      excluded = 'llm_failed';
    }
  }

  // (5) stamp identity + apply suppressions (same machinery as base findings).
  const stamped = stampLongitudinal([...det, ...llm]);
  const supps = await loadActiveSuppressions().catch(() => []);
  const findings = applySuppressions(stamped, input.doctorUid, supps).findings;

  if (opts.traceId) {
    await logEvent(opts.traceId, 'opd_longitudinal', 'expanding', {
      asOf: snap.asOf, encounters, confidence, excluded, deterministic: det.length, judged: llm.length, findings: findings.length,
    }).catch(() => {});
  }

  return { version: OPD_LONGITUDINAL_VERSION, asOf: snap.asOf.slice(0, 10), contextMeta: { encounters, confidence, excluded_reason: excluded }, findings };
}

/** Persist ONLY the additive `longitudinal` column for one note (own DB). Keyed by (uid, engine_version)
 *  so it targets the exact base row the audit was written to; base columns are never touched. */
export async function persistLongitudinal(uid: string, engineVersion: string, block: LongitudinalBlock): Promise<'updated' | 'skipped'> {
  if (!uid) return 'skipped';
  const rows = (await sql(
    `UPDATE opd_note_audits SET longitudinal = $3::jsonb WHERE uid = $1 AND engine_version = $2 RETURNING id`,
    [uid, engineVersion, JSON.stringify(block)],
  )) as Array<{ id: string }>;
  return rows.length ? 'updated' : 'skipped';
}

/**
 * The post-persistence hook (PRD §5). Called AFTER `saveOpdAudit`'s INSERT, flag-gated + fail-open, so it
 * can never affect the base row or the persist path. Dark unless OPD_LONGITUDINAL_ENABLED=1.
 */
export async function runLongitudinalPass(audit: OpdNoteAudit): Promise<void> {
  if (process.env.OPD_LONGITUDINAL_ENABLED !== '1') return;
  const input = audit.longitudinalInput;
  if (!input || !input.uid) return;
  try {
    const block = await runLongitudinalAudit(input, { traceId: audit.traceId });
    await persistLongitudinal(input.uid, input.engineVersion, block);
  } catch {
    // fail-open — the base audit is already persisted; the longitudinal column simply stays null.
  }
}

/** Replay entry (admin/cron): recompute + store the longitudinal block for ONE already-audited note, from
 *  its rebuilt input. Explicit (flag-independent). Starts its own trace so the judged pass is observable. */
export async function replayLongitudinal(input: LongitudinalNoteInput): Promise<{ uid: string; status: 'updated' | 'skipped'; excluded_reason: LongitudinalExcludedReason; findings: number }> {
  const traceId = await startTrace('opd_longitudinal_replay', { uid: input.uid, noteDate: input.noteDate }).catch(() => undefined);
  const block = await runLongitudinalAudit(input, { traceId });
  const status = await persistLongitudinal(input.uid, input.engineVersion, block);
  if (traceId) await finishTrace(traceId, 'success').catch(() => {});
  return { uid: input.uid, status, excluded_reason: block.contextMeta.excluded_reason, findings: block.findings.length };
}
