/**
 * lib/readmission-versions-core.ts — PURE logic for R8.1 finding versions
 * (CDMSS-READMISSIONS-R8.1-FINDING-VERSIONS PRD v1.0, 20 Aug 2026; V1/V2, O1–O5).
 * No database calls, no fetch, no clock — validation, the capture-reason set, the
 * snapshot shapes, and the two decisions the write paths run:
 *
 *   · needsOverwriteSnapshot — should saveAuditResult snapshot before its UPDATE?
 *     Only when a row exists AND audit_status = 'audited' (there is something worth
 *     keeping), and NOT when the stored reading IS the incoming one (same trace_id
 *     on both sides) — that keeps saveAuditResult idempotent: a second identical
 *     save re-runs the UPDATE and writes no second snapshot of the same reading.
 *     A null trace on EITHER side snapshots anyway: a duplicate snapshot is
 *     recoverable, a silent history gap is the thing this table exists to prevent.
 *   · buildReplaySnapshot — the version row for one deliberate stability run (O5:
 *     the snapshot is the NEW reading; the live row is never touched).
 *
 * The DDL lives in migrations/0035_readmission_finding_versions.sql (reference) and
 * app/api/admin/migrate-readmission-versions/route.ts (executable).
 */

import type { ReadmissionFinding } from './readmission-reconcile-core';
import { NARRATIVE_MODEL, NARRATIVE_MODEL_ID } from './readmission-narrative-core';

/** The closed capture-reason set (PRD data model): exactly these two, no others. */
export const CAPTURE_REASONS = ['overwrite', 'replay'] as const;
export type CaptureReason = (typeof CAPTURE_REASONS)[number];

export const VERSIONS_RULE_VERSION = 'readmit-versions/1';

/** Replay is a manual research tool, not a rail: 1 to 3 runs per request, never more. */
export const REPLAY_MAX_RUNS = 3;

/** O3: replay runs on the model named in the request, defaulting to Opus 4.6 on Bedrock. */
export const REPLAY_DEFAULT_MODEL = NARRATIVE_MODEL;

/** The honesty line the replay response must carry (PRD "The replay action"). */
export const REPLAY_EVIDENCE_NOTE =
  'evidence for this replay was re-fetched from db13 and may differ from the evidence the live row saw — compare template_coverage on each snapshot against the live row before reading two verdicts as one stability pair';

/** The refresh route's dedup-key shape, copied not referenced (it is not exported there). */
export function isDedupKeyShape(s: string): boolean {
  return s.length >= 3 && s.length <= 200 && /^[A-Za-z0-9/_:|.-]+$/.test(s);
}

/** `runs` 1..3, integer; absent defaults to 1; 0 and anything above 3 are refused (400). */
export function validateRuns(v: unknown): { ok: true; runs: number } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, runs: 1 };
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isInteger(n) || n < 1 || n > REPLAY_MAX_RUNS) {
    return { ok: false, error: `runs must be an integer 1..${REPLAY_MAX_RUNS} — got ${JSON.stringify(v)} (a replay is a manual research tool, not a rail)` };
  }
  return { ok: true, runs: n };
}

/**
 * O3: the model named in the request. Bedrock only — the original Gemini path is not on
 * the Bedrock rails; a non-bedrock name is refused, never downgraded. Absent → Opus 4.6.
 */
export function parseReplayModel(v: unknown): { ok: true; model: string; modelId: string } | { ok: false; error: string } {
  if (v === undefined || v === null || v === '') return { ok: true, model: REPLAY_DEFAULT_MODEL, modelId: NARRATIVE_MODEL_ID };
  const m = typeof v === 'string' ? v.trim() : '';
  const id = m.toLowerCase().startsWith('bedrock:') ? m.slice('bedrock:'.length).trim() : '';
  if (!id || id.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(id)) {
    return { ok: false, error: `replay model must be 'bedrock:<model-id>' (default ${REPLAY_DEFAULT_MODEL}) — got '${String(v)}' (O3: stability is measured per model, on the Bedrock rails only)` };
  }
  return { ok: true, model: `bedrock:${id}`, modelId: id };
}

/**
 * The overwrite decision (PRD "Change to the write path" steps 1–4 + the idempotency
 * trap). True ⇔ a row exists, it is audited, and the incoming write is NOT the same
 * reading (same non-null trace_id on both sides = the same analysis being re-saved).
 */
export function needsOverwriteSnapshot(
  row: { audit_status?: unknown; trace_id?: unknown } | null | undefined,
  incomingTraceId: string | null,
): boolean {
  if (!row || row.audit_status !== 'audited') return false;   // nothing audited to keep
  const stored = typeof row.trace_id === 'string' && row.trace_id.length > 0 ? row.trace_id : null;
  if (stored !== null && incomingTraceId !== null && stored === incomingTraceId) return false;
  return true;
}

/** One row of readmission_finding_versions, as the store inserts it (column order there). */
export interface VersionSnapshot {
  captureReason: CaptureReason;
  dedupKey: string;
  engineVersion: string;
  avoidable: string | null;
  planned: string | null;
  sameCondition: string | null;
  preventableInjury: string | null;
  /** NULL on a replay: the reading was never a stored row, so it has no stored status. */
  auditStatus: string | null;
  model: string | null;
  provider: string | null;
  /** NULL on a replay — captured_at is the reading's time; there is no stored audited_at. */
  auditedAt: string | null;
  templateCoverage: unknown;
  rowSnapshot: Record<string, unknown>;
  traceId: string | null;
}

export interface ReplayReadingInput {
  dedupKey: string;
  engineVersion: string;
  /** The NEW reading the recon legs just produced (never persisted to readmission_findings — O5). */
  finding: ReadmissionFinding;
  /** deriveJudgements(finding) — computed by the caller with the untouched rules. */
  preventableInjury: string | null;
  negligence: string | null;
  judgementRuleVersion: string;
  /** Who actually answered, off the trace (DEC-2 posture) — the truth the model column carries. */
  model: string | null;
  provider: string | null;
  traceId: string | null;
  /** What the request asked for; disagreement with `model` is recorded, not hidden. */
  requestedModel: string;
  modelMismatch: boolean;
  runIndex: number;
  runsTotal: number;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  promoted: boolean;
}

/**
 * The replay version row (capture_reason 'replay'). The scalar columns are copies of
 * what sits inside row_snapshot (O1); template_coverage is lifted out because it is the
 * direct answer to "did the evidence differ between these two readings".
 */
export function buildReplaySnapshot(r: ReplayReadingInput): VersionSnapshot {
  const planned = r.finding.planned?.verdict ?? null;
  const sameCondition = r.finding.sameCondition?.verdict ?? null;
  const avoidable = r.finding.avoidable?.verdict ?? null;
  return {
    captureReason: 'replay',
    dedupKey: r.dedupKey,
    engineVersion: r.engineVersion,
    avoidable,
    planned,
    sameCondition,
    preventableInjury: r.preventableInjury,
    auditStatus: null,
    model: r.model,
    provider: r.provider,
    auditedAt: null,
    templateCoverage: r.finding.templateCoverage ?? null,
    rowSnapshot: {
      versions_rule_version: VERSIONS_RULE_VERSION,
      capture_reason: 'replay',
      dedup_key: r.dedupKey,
      engine_version: r.engineVersion,
      planned,
      same_condition: sameCondition,
      avoidable,
      preventable_injury: r.preventableInjury,
      negligence: r.negligence,
      judgement_rule_version: r.judgementRuleVersion,
      n_omissions: r.finding.omissions?.length ?? 0,
      promoted_to_full: r.promoted,
      model: r.model,
      provider: r.provider,
      trace_id: r.traceId,
      finding: r.finding,
      replay: {
        requested_model: r.requestedModel,
        model_mismatch: r.modelMismatch,
        run_index: r.runIndex,
        runs_total: r.runsTotal,
        ms: r.ms,
        tokens_in: r.tokensIn,
        tokens_out: r.tokensOut,
        usd: r.usd,
      },
    },
    traceId: r.traceId,
  };
}
