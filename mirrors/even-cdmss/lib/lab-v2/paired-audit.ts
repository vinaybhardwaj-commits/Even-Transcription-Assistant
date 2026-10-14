/**
 * lib/lab-v2/paired-audit.ts — submit, tick, status and results for a paired OPD audit.
 *
 * Arm A re-audits the signed prescription. Arm B audits the caller-supplied prescription
 * with only the prescription-authored columns replaced. History, labs, specialty, rules
 * and suppressions are fetched once and shared. Both arms call `auditOpdNote`. Neither
 * arm calls `saveOpdAudit` or any other production writer: the run is inside
 * `enterOpdLabWriteFence`, and the model call goes through `governedLabChat` (one
 * attempt, no ladder) under `withLabExecution`.
 *
 * Literature retrieval runs per arm with expansion and the reranker off. That is a fair
 * A/B, and it is not the production retrieval path. The longitudinal / prior-visit pass
 * is not run on either arm.
 *
 * Each model call increments `calls_used` in the database before the network call,
 * and the same statement refuses the call when a spend budget is already exhausted.
 * `paired_audit_results` strips uid, external_ref, clinician_uid, rationale and subject.
 * `pairedAuditResultsIdentifying` returns them for an identifying principal.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from './db';
import { LabError } from '../lab-execution-context';
import { withLabExecution, exitLabExecution } from '../lab-execution-context';
import { enterOpdLabWriteFence, opdLabWriteFenceTripped, OpdLabWriteForbidden } from '../opd-lab-write-guard';
import { auditOpdNote, doctorSpecialtyFor, getLvcRules, opdAuditPerAttemptMs, type OpdLabDependencies } from '../opd-note-audit';
import { fetchOpdNotesByUids, fetchPatientHistoryBundle } from '../metabase';
import { loadActiveSuppressionsOrThrow, loadQuietingConfig } from '../audit-suppression-store';
import { rowToOpdCase } from '../opd-ingest-core';
import { bandFor } from '../opd-complexity-core';
import { retrieve as productionRetrieve, type RetrieveOptions } from '../retrieve';
import { governedLabChat } from '../trace';
import { costMicrousd, isSupportedModel } from './pricing';
import {
  PAIRED_AUDIT_CONCURRENCY_MAX, PAIRED_MAX_ATTEMPTS, applyStructuredOverride, assessOverrideText,
  diffFlags, externalRefJoin, pairedAuditConcurrency,
  flagAgreement, flagKey, hasStructuredContent, opdAuditPromptHash, overrideContentHash,
  overrideUnparsed, pairKeyFor, pairedEngineVersion, pairedLogRecord, parsePairedModel,
  projectAudit, publicAgreement, publicFinding, publicFlag, resolveOverride, sameFlagSet,
  signedContentHash, type FlagAgreement, type InputPath, type PairedHashContext,
  type ProjectedAudit, type ProjectedFinding, type PublicAgreement, type PublicFinding,
  type PublicFlagRef, type StructuredOverride,
} from './paired-audit-core';

export interface PairInput {
  uid: string;
  external_ref: string;
  override_text?: string | null;
  override?: StructuredOverride | null;
}

export interface SubmitInput {
  experiment_label: string;
  idempotency_key: string;
  pairs: PairInput[];
  arms: readonly [string, string];
  signed_repeats: number;
  override_repeats?: number;
  noise_uids: string[];
  max_llm_calls: number;
  max_spend_microusd: number | null;
  model: string;
  /** Text overrides are refused unless the caller sets this. Structured JSON is the contract. */
  debug_text_override?: boolean;
}

export type ResolveResult =
  | { status: 'ok'; row: Record<string, unknown> }
  | { status: 'not_found' }
  | { status: 'ambiguous'; n: number };

export interface AuditOutcome {
  audit: unknown;
  spend_microusd: number | null;
}

export interface PairedAuditDeps {
  resolveNote: (uid: string) => Promise<ResolveResult>;
  loadContext: (row: Record<string, unknown>) => Promise<OpdLabDependencies>;
  /** `charge` throws BUDGET_EXHAUSTED before a model call that would pass the cap. Await it. */
  audit: (
    row: Record<string, unknown>,
    lab: OpdLabDependencies,
    charge: () => void | Promise<void>,
    model: { provider: 'bedrock' | 'openrouter' | 'ollama' | 'vertex'; model: string },
  ) => Promise<AuditOutcome>;
  log?: (record: Record<string, unknown>) => void;
}

interface RunRow {
  id: string;
  owner: string;
  experiment_label: string;
  engine_version: string;
  prompt_hash: string;
  model: string;
  provider: string;
  status: string;
  stop_reason: string | null;
  max_llm_calls: number;
  max_spend_microusd: string | number | null;
  calls_used: number;
  spend_microusd: string | number;
  unpriced: boolean;
  signed_repeats: number;
}

interface ItemRow {
  id: string;
  run_id: string;
  uid: string;
  external_ref: string;
  arm: string;
  repeat_idx: number;
  status: string;
  skip_reason: string | null;
  override_text: string | null;
  override_struct: StructuredOverride | string | null;
  override_hash: string | null;
  input_path: string;
  result_id: string | null;
}

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function log(deps: PairedAuditDeps, event: string, fields: Record<string, unknown>) {
  const record = pairedLogRecord(event, fields);
  (deps.log ?? ((r) => console.log(JSON.stringify(r))))(record);
}

export function reasonCode(e: unknown): string {
  if (e instanceof OpdLabWriteForbidden) return 'production_write_refused';
  const code = (e as { code?: string })?.code;
  if (code === 'BUDGET_EXHAUSTED') return 'budget_exhausted';
  if (code === 'SOURCE_UNAVAILABLE') return 'source_unavailable';
  if (code === 'CASE_NOT_FOUND') return 'uid_not_found';
  if (code === 'OPD_LAB_WRITE_FORBIDDEN') return 'production_write_refused';
  return 'engine_error';
}

/** Exact uid match. More than one row is ambiguous. A transport error is not "not found". */
export async function resolveNoteExact(uid: string): Promise<ResolveResult> {
  let rows: Record<string, unknown>[];
  try {
    rows = await fetchOpdNotesByUids([uid]);
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `db13 unavailable for uid ${uid}: ${(e as Error).message}`);
  }
  const exact = rows.filter((r) => String(r.uid ?? '') === uid);
  if (exact.length === 0) return { status: 'not_found' };
  if (exact.length > 1) return { status: 'ambiguous', n: exact.length };
  return { status: 'ok', row: exact[0] };
}

/** The production context readers, called once per uid and reused by both arms. */
export async function loadSharedOpdContext(row: Record<string, unknown>): Promise<OpdLabDependencies> {
  const { keys } = rowToOpdCase(row);
  const uid = keys.uid ?? '';
  let specialty: string | null;
  try {
    specialty = await doctorSpecialtyFor(keys.doctorUid);
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `doctor_directory unavailable: ${(e as Error).message}`);
  }
  const rules = await getLvcRules();
  if (rules.length === 0) {
    throw new LabError('SOURCE_UNAVAILABLE', 'lvc_recommendations returned no active rules');
  }
  let complexity: OpdLabDependencies['complexity'];
  try {
    const inputs = await fetchPatientHistoryBundle(uid, keys.noteDate ? String(keys.noteDate) : undefined);
    complexity = inputs ? { band: bandFor(inputs), inputs } : { band: null, inputs: null };
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `patient-history bundle unavailable: ${(e as Error).message}`);
  }
  let suppressions: OpdLabDependencies['suppressions'];
  let quietingConfig: OpdLabDependencies['quietingConfig'];
  try {
    suppressions = (await loadActiveSuppressionsOrThrow()) as unknown as OpdLabDependencies['suppressions'];
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `audit_suppression unavailable: ${(e as Error).message}`);
  }
  try {
    quietingConfig = (await loadQuietingConfig()) as unknown as OpdLabDependencies['quietingConfig'];
  } catch (e) {
    throw new LabError('SOURCE_UNAVAILABLE', `quieting config unavailable: ${(e as Error).message}`);
  }
  return {
    lvcRules: rules.map((r) => ({ id: r.id, keywords: r.keywords, category: r.category })),
    specialty,
    complexity,
    suppressions,
    quietingConfig,
  };
}

function spendOf(completion: unknown, provider: 'bedrock' | 'openrouter' | 'ollama' | 'vertex', model: string): number | null {
  const usage = (completion as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage) return null;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return costMicrousd(provider, model, input, output);
}

/**
 * Production `auditOpdNote`, with the model call counted against the run budget and
 * production writers sealed. `auditOpdNote` swallows a thrown model error into a
 * deterministic-only audit; a budget refusal is rethrown afterwards so that partial
 * is not stored as a success.
 *
 * Retrieval is `skipExpand` and `useReranker: false` on every arm. The longitudinal
 * pass is not requested.
 */
export type PairedEngine = (
  row: Record<string, unknown>,
  opts: { labDependencies: OpdLabDependencies; trace?: boolean },
) => Promise<unknown>;

export async function auditPairedArm(
  row: Record<string, unknown>,
  lab: OpdLabDependencies,
  charge: () => void | Promise<void>,
  model: { provider: 'bedrock' | 'openrouter' | 'ollama' | 'vertex'; model: string },
  noteSpend: (microusd: number | null) => void,
  engine: PairedEngine = auditOpdNote,
): Promise<AuditOutcome> {
  let budgetHit = false;
  let spend = 0;
  let sawUnpriced = false;
  const audit = await enterOpdLabWriteFence(async () => {
    const result = await withLabExecution({
      chat: async (_label, params, signal) => {
        try {
          await charge();
        } catch (e) {
          budgetHit = true;
          throw e;
        }
        const completion = await governedLabChat(model.provider, model.model, params, opdAuditPerAttemptMs(), signal);
        const part = spendOf(completion, model.provider, model.model);
        if (part == null) sawUnpriced = true;
        else spend += part;
        return completion;
      },
      retrieve: async (query, opts) => exitLabExecution(() => productionRetrieve(
        query,
        { ...((opts ?? {}) as RetrieveOptions), skipExpand: true, useReranker: false },
      )),
      event: () => {},
    }, () => engine(row, { labDependencies: lab, trace: false }));
    // The engine catch turns a refused write into llmLegFailed. The fence bit is the signal.
    const tripped = opdLabWriteFenceTripped();
    if (tripped) throw tripped;
    return result;
  });
  noteSpend(sawUnpriced ? null : spend);
  if (budgetHit) throw new LabError('BUDGET_EXHAUSTED', 'paired audit stopped: call budget reached');
  return { audit, spend_microusd: sawUnpriced ? null : spend };
}

export function defaultPairedDeps(extra: Partial<PairedAuditDeps> & { engine?: PairedEngine } = {}): PairedAuditDeps {
  const { engine, ...rest } = extra;
  const runEngine = engine ?? auditOpdNote;
  return {
    resolveNote: resolveNoteExact,
    loadContext: loadSharedOpdContext,
    audit: async (row, lab, charge, model) => {
      let recorded: number | null = 0;
      const out = await auditPairedArm(row, lab, charge, model, (spent) => { recorded = spent; }, runEngine);
      return { audit: out.audit, spend_microusd: recorded };
    },
    ...rest,
  };
}

function overrideArm(arms: readonly [string, string]): string {
  return arms[0] === 'signed' ? arms[1] : arms[0];
}

export async function submitPairedAudit(db: Db, owner: string, input: SubmitInput): Promise<{
  run_id: string;
  deduplicated: boolean;
  experiment_label: string;
  engine_version: string;
  prompt_hash: string;
  model: string;
  status: string;
  counts: { pairs: number; items: number; queued: number };
}> {
  const parsed = parsePairedModel(input.model);
  if (!parsed || !isSupportedModel(parsed.provider, parsed.model)) {
    throw new LabError('MODEL_UNSUPPORTED', `model '${input.model}' is not a priced lab model`);
  }
  const engine_version = pairedEngineVersion();
  const prompt_hash = opdAuditPromptHash();
  const existing = await db.query<{ id: string; experiment_label: string; engine_version: string; prompt_hash: string; model: string; status: string }>(
    `SELECT id, experiment_label, engine_version, prompt_hash, model, status
       FROM lab_v2.paired_audit_runs WHERE owner = $1 AND idempotency_key = $2`,
    [owner, input.idempotency_key],
  );
  if (existing[0]) {
    const counts = await itemCounts(db, existing[0].id);
    const pairRows = await db.query<{ n: string }>(
      `SELECT count(DISTINCT uid)::text AS n FROM lab_v2.paired_audit_items WHERE run_id = $1`,
      [existing[0].id],
    );
    return {
      run_id: existing[0].id,
      deduplicated: true,
      experiment_label: existing[0].experiment_label,
      engine_version: existing[0].engine_version,
      prompt_hash: existing[0].prompt_hash,
      model: existing[0].model,
      status: existing[0].status,
      counts: { pairs: Number(pairRows[0]?.n ?? 0), items: counts.total, queued: counts.queued },
    };
  }

  const runId = randomUUID();
  const noise = new Set(input.noise_uids);
  const other = overrideArm(input.arms);
  const overrideRepeats = input.override_repeats ?? 1;
  const items: Array<{
    uid: string;
    external_ref: string;
    arm: string;
    repeat_idx: number;
    override_text: string | null;
    override_struct: StructuredOverride | null;
    override_hash: string | null;
    input_path: InputPath;
  }> = [];
  const debugText = input.debug_text_override === true;
  for (const pair of input.pairs) {
    if (pair.override && overrideUnparsed(pair.override)) {
      throw new LabError('INVALID_INPUT', 'override_unparsed');
    }
    if (!debugText) {
      if (pair.override_text) throw new LabError('INVALID_INPUT', 'override_text requires debug_text_override');
      if (!hasStructuredContent(pair.override)) throw new LabError('INVALID_INPUT', 'a pair needs a structured override');
    } else if (!pair.override_text && !hasStructuredContent(pair.override)) {
      throw new LabError('INVALID_INPUT', 'a pair needs a structured override or debug override_text');
    }
    const resolved = resolveOverride({ override: pair.override, override_text: pair.override_text });
    const signedN = noise.has(pair.uid) ? input.signed_repeats : 1;
    const overrideN = noise.has(pair.uid) ? overrideRepeats : 1;
    for (let repeat = 0; repeat < signedN; repeat++) {
      items.push({
        uid: pair.uid, external_ref: pair.external_ref, arm: 'signed', repeat_idx: repeat,
        override_text: null, override_struct: null, override_hash: null, input_path: 'signed',
      });
    }
    for (let repeat = 0; repeat < overrideN; repeat++) {
      items.push({
        uid: pair.uid, external_ref: pair.external_ref, arm: other, repeat_idx: repeat,
        override_text: resolved.text, override_struct: resolved.structured,
        override_hash: resolved.hash, input_path: resolved.path,
      });
    }
  }

  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO lab_v2.paired_audit_runs
        (id, owner, experiment_label, idempotency_key, engine_version, prompt_hash, model, provider,
         status, max_llm_calls, max_spend_microusd, signed_repeats, override_repeats)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12)`,
      [runId, owner, input.experiment_label, input.idempotency_key, engine_version, prompt_hash,
        input.model, parsed.provider, input.max_llm_calls, input.max_spend_microusd,
        input.signed_repeats, overrideRepeats],
    );
    for (const item of items) {
      await tx.query(
        `INSERT INTO lab_v2.paired_audit_items
          (id, run_id, uid, external_ref, arm, repeat_idx, status, override_text, override_struct, override_hash, input_path)
         VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8::jsonb,$9,$10)`,
        [randomUUID(), runId, item.uid, item.external_ref, item.arm, item.repeat_idx,
          item.override_text, item.override_struct ? JSON.stringify(item.override_struct) : null,
          item.override_hash, item.input_path],
      );
    }
  });
  return {
    run_id: runId,
    deduplicated: false,
    experiment_label: input.experiment_label,
    engine_version,
    prompt_hash,
    model: input.model,
    status: 'queued',
    counts: { pairs: input.pairs.length, items: items.length, queued: items.length },
  };
}

async function itemCounts(db: Db, runId: string): Promise<Record<string, number> & { total: number }> {
  const rows = await db.query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM lab_v2.paired_audit_items WHERE run_id = $1 GROUP BY status`,
    [runId],
  );
  const out: Record<string, number> & { total: number } = { total: 0, queued: 0, running: 0, succeeded: 0, deduped: 0, skipped: 0, failed: 0, stopped: 0 };
  for (const row of rows) {
    const n = Number(row.n);
    out[row.status] = n;
    out.total += n;
  }
  return out;
}

interface Ledger {
  calls_used: number;
  spend_microusd: number;
  unpriced: boolean;
  max_llm_calls: number;
  max_spend_microusd: number | null;
}

function budgetBlocked(ledger: Ledger): 'budget_exhausted' | null {
  if (ledger.calls_used >= ledger.max_llm_calls) return 'budget_exhausted';
  if (ledger.max_spend_microusd != null && ledger.unpriced) return 'budget_exhausted';
  if (ledger.max_spend_microusd != null && ledger.spend_microusd >= ledger.max_spend_microusd) return 'budget_exhausted';
  return null;
}

/** Spend only. Call counts are incremented by `chargeCall` and must not be written back absolutely. */
async function persistSpend(db: Db, runId: string, spent: number | null) {
  if (spent == null) {
    await db.query(
      `UPDATE lab_v2.paired_audit_runs SET unpriced = true WHERE id = $1`,
      [runId],
    );
    return;
  }
  if (spent === 0) return;
  await db.query(
    `UPDATE lab_v2.paired_audit_runs SET spend_microusd = spend_microusd + $2 WHERE id = $1`,
    [runId, spent],
  );
}

async function chargeCall(db: Db, runId: string): Promise<number> {
  const rows = await db.query<{ calls_used: number }>(
    `UPDATE lab_v2.paired_audit_runs
        SET calls_used = calls_used + 1
      WHERE id = $1
        AND calls_used < max_llm_calls
        AND (
          max_spend_microusd IS NULL
          OR (unpriced = false AND spend_microusd < max_spend_microusd)
        )
      RETURNING calls_used`,
    [runId],
  );
  if (!rows[0]) throw new LabError('BUDGET_EXHAUSTED', 'paired audit call budget exhausted');
  return num(rows[0].calls_used);
}

async function readLedger(db: Db, run: RunRow): Promise<Ledger> {
  const [fresh] = await db.query<{ calls_used: number; spend_microusd: string | number; unpriced: boolean }>(
    `SELECT calls_used, spend_microusd, unpriced FROM lab_v2.paired_audit_runs WHERE id = $1`,
    [run.id],
  );
  return {
    calls_used: num(fresh?.calls_used ?? run.calls_used),
    spend_microusd: num(fresh?.spend_microusd ?? run.spend_microusd),
    unpriced: (fresh?.unpriced ?? run.unpriced) === true,
    max_llm_calls: num(run.max_llm_calls),
    max_spend_microusd: run.max_spend_microusd == null ? null : num(run.max_spend_microusd),
  };
}

async function markItem(db: Db, id: string, status: string, reason: string | null, resultId: string | null): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE lab_v2.paired_audit_items
        SET status = $2, skip_reason = $3, result_id = COALESCE($4, result_id), finished_at = now()
      WHERE id = $1 AND status = 'running'
      RETURNING id`,
    [id, status, reason, resultId],
  );
  return rows.length > 0;
}

async function markUnparsed(db: Db, id: string, linesTotal: number | null, linesParsed: number | null): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `UPDATE lab_v2.paired_audit_items
        SET status = 'skipped', skip_reason = 'override_unparsed',
            parse_lines_total = $2, parse_lines_parsed = $3, finished_at = now()
      WHERE id = $1 AND status = 'running'
      RETURNING id`,
    [id, linesTotal, linesParsed],
  );
  return rows.length > 0;
}

/** A claim that the deadline stopped before the model call is not an attempt. */
async function releaseUnstarted(db: Db, id: string) {
  await db.query(
    `UPDATE lab_v2.paired_audit_items
        SET status = 'queued', claimed_at = NULL, attempts = GREATEST(attempts - 1, 0)
      WHERE id = $1 AND status = 'running' AND result_id IS NULL`,
    [id],
  );
}

function hashContext(lab: OpdLabDependencies): PairedHashContext {
  const complexity = lab.complexity;
  return {
    specialty: lab.specialty,
    complexityBand: complexity?.band ?? null,
    complexityInputs: complexity?.inputs ?? null,
    lvcRuleIds: lab.lvcRules.map((rule) => rule.id).sort(),
    suppressionIds: lab.suppressions.map((rule) => rule.id).filter((id): id is string => Boolean(id)).sort(),
    quietingGen: lab.quietingConfig?.gen ?? 0,
  };
}

async function stopRemaining(db: Db, runId: string, reason: string): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `UPDATE lab_v2.paired_audit_items
        SET status = 'stopped', skip_reason = $2, finished_at = now()
      WHERE run_id = $1 AND status IN ('queued', 'running')
      RETURNING id`,
    [runId, reason],
  );
  await db.query(
    `UPDATE lab_v2.paired_audit_runs
        SET status = 'stopped', stop_reason = $2, finished_at = now()
      WHERE id = $1`,
    [runId, reason],
  );
  return rows.length;
}

async function closeRunIfDrained(db: Db, runId: string) {
  const counts = await itemCounts(db, runId);
  if ((counts.queued ?? 0) > 0 || (counts.running ?? 0) > 0) return;
  const [run] = await db.query<{ stop_reason: string | null; status: string }>(
    `SELECT stop_reason, status FROM lab_v2.paired_audit_runs WHERE id = $1`, [runId]);
  if (!run || run.status === 'stopped' || run.status === 'failed' || run.status === 'degraded') return;
  const succeeded = counts.succeeded ?? 0;
  const deduped = counts.deduped ?? 0;
  const failed = counts.failed ?? 0;
  const stopped = counts.stopped ?? 0;
  const skipped = counts.skipped ?? 0;
  const status = failed > 0 && succeeded === 0 && deduped === 0
    ? 'failed'
    : succeeded === 0 && deduped === 0 && failed === 0 && stopped === 0 && skipped > 0
      ? 'degraded'
      : 'succeeded';
  await db.query(
    `UPDATE lab_v2.paired_audit_runs SET status = $2, finished_at = now() WHERE id = $1 AND status IN ('queued','running')`,
    [runId, status],
  );
}

const ITEM_RETURNING = `i.id, i.run_id, i.uid, i.external_ref, i.arm, i.repeat_idx, i.status,
                i.skip_reason, i.override_text, i.override_struct, i.override_hash, i.input_path, i.result_id`;

/**
 * Claim up to `want` queued items of one run.
 *
 * The active-run lock is taken in id order, so two ticks cannot both count `running`
 * as zero and then both win. `FOR UPDATE SKIP LOCKED` on the items means a row another
 * tick already holds is skipped rather than claimed twice. The limit is the smaller of
 * the caller's want, the global in-flight ceiling, and the calls still unreserved
 * (`max_llm_calls - calls_used - rows already running for this run`).
 */
export async function claimItems(db: Db, runId: string, want: number, concurrency: number): Promise<ItemRow[]> {
  if (want <= 0 || concurrency <= 0) return [];
  return db.query<ItemRow>(
    `WITH locked AS (
       SELECT id, max_llm_calls, calls_used
         FROM lab_v2.paired_audit_runs
        WHERE status IN ('queued', 'running')
        ORDER BY id
        FOR UPDATE
     ),
     budget AS (
       SELECT GREATEST(0, LEAST(
         $3::int - (SELECT count(*)::int FROM lab_v2.paired_audit_items WHERE status = 'running'),
         COALESCE((SELECT max_llm_calls - calls_used FROM locked WHERE id = $1), 0)
           - (SELECT count(*)::int FROM lab_v2.paired_audit_items WHERE run_id = $1 AND status = 'running')
       ))::int AS n
     ),
     picked AS (
       SELECT i.id
         FROM lab_v2.paired_audit_items i
        WHERE i.run_id = $1
          AND i.status = 'queued'
          AND EXISTS (SELECT 1 FROM locked WHERE locked.id = i.run_id)
          AND (SELECT n FROM budget) > 0
        ORDER BY i.uid, i.repeat_idx, i.arm
        LIMIT (SELECT LEAST($2::int, n) FROM budget)
        FOR UPDATE SKIP LOCKED
     )
     UPDATE lab_v2.paired_audit_items i
        SET status = 'running', claimed_at = now(), attempts = attempts + 1
       FROM picked
      WHERE i.id = picked.id AND i.status = 'queued'
      RETURNING ${ITEM_RETURNING}`,
    [runId, want, concurrency],
  );
}

async function countStatus(db: Db, runId: string, status: string): Promise<number> {
  const [row] = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM lab_v2.paired_audit_items WHERE run_id = $1 AND status = $2`,
    [runId, status],
  );
  return Number(row?.n ?? 0);
}

async function reclaimStaleClaims(db: Db, olderThan: string): Promise<void> {
  await db.query(
    `UPDATE lab_v2.paired_audit_items i
        SET status = 'failed', skip_reason = 'attempt_cap', claimed_at = NULL, finished_at = now()
       FROM lab_v2.paired_audit_runs r
      WHERE i.run_id = r.id
        AND r.status IN ('queued', 'running')
        AND i.status = 'running'
        AND i.result_id IS NULL
        AND i.claimed_at IS NOT NULL
        AND i.attempts >= $2
        AND i.claimed_at < now() - $1::interval`,
    [olderThan, PAIRED_MAX_ATTEMPTS],
  );
  await db.query(
    `UPDATE lab_v2.paired_audit_items i
        SET status = 'queued', claimed_at = NULL
       FROM lab_v2.paired_audit_runs r
      WHERE i.run_id = r.id
        AND r.status IN ('queued', 'running')
        AND i.status = 'running'
        AND i.result_id IS NULL
        AND i.claimed_at IS NOT NULL
        AND i.attempts < $2
        AND i.claimed_at < now() - $1::interval`,
    [olderThan, PAIRED_MAX_ATTEMPTS],
  );
}

export interface TickReport {
  runs: number;
  groups: number;
  audited: number;
  deduped: number;
  skipped: number;
  failed: number;
  stopped: number;
}

function asStruct(value: StructuredOverride | string | null): StructuredOverride {
  if (value == null) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) as StructuredOverride; } catch { return {}; }
  }
  return value;
}

interface ReadyItem {
  item: ItemRow;
  row: Record<string, unknown>;
  lab: OpdLabDependencies;
  ctx: PairedHashContext;
}

/**
 * Drain queued paired-audit work until the deadline, the call budget, or `maxGroups` claims.
 * Items already claimed run together, up to `concurrency` (default 4, max 6). A run with
 * a spend cap stays one-at-a-time so the charge sees the previous call's spend.
 * `deadlineAt` is an absolute timestamp. When the caller omits it, the bound is
 * `maxElapsedMs` from this function's start, which tests use.
 */
export async function pairedAuditTick(
  db: Db,
  deps: PairedAuditDeps = defaultPairedDeps(),
  opts: {
    maxGroups?: number;
    maxElapsedMs?: number;
    deadlineAt?: number;
    now?: () => number;
    concurrency?: number;
    reclaimAfter?: string;
  } = {},
): Promise<TickReport> {
  const maxGroups = opts.maxGroups ?? 1_000;
  const concurrency = Math.min(
    PAIRED_AUDIT_CONCURRENCY_MAX,
    Math.max(1, Math.floor(opts.concurrency ?? pairedAuditConcurrency())),
  );
  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = opts.deadlineAt ?? (started + (opts.maxElapsedMs ?? 240_000));
  const report: TickReport = { runs: 0, groups: 0, audited: 0, deduped: 0, skipped: 0, failed: 0, stopped: 0 };
  const seen = new Set<string>();
  const jobs: Promise<void>[] = [];
  let halt: { run: RunRow; reason: string } | null = null;
  let outOfTime = false;
  await reclaimStaleClaims(db, opts.reclaimAfter ?? '20 minutes');

  function track(work: Promise<void>): void {
    const tracked = work.finally(() => {
      const at = jobs.indexOf(tracked);
      if (at >= 0) jobs.splice(at, 1);
    });
    jobs.push(tracked);
  }

  async function drainJobs(): Promise<void> {
    if (jobs.length === 0) return;
    await Promise.all([...jobs]);
  }

  async function settleHalt(): Promise<void> {
    if (!halt) return;
    const stopped = halt;
    halt = null;
    await drainJobs();
    const latest = await readLedger(db, stopped.run);
    report.stopped += await stopRemaining(db, stopped.run.id, stopped.reason);
    log(deps, 'paired_audit_stop', {
      run_id: stopped.run.id, reason: stopped.reason, calls: latest.calls_used, path: 'paired_audit_tick',
    });
  }

  while (report.groups < maxGroups && now() < deadline && !outOfTime) {
    if (halt) {
      await settleHalt();
      continue;
    }
    const [run] = await db.query<RunRow>(
      `SELECT id, owner, experiment_label, engine_version, prompt_hash, model, provider, status,
              stop_reason, max_llm_calls, max_spend_microusd, calls_used, spend_microusd, unpriced, signed_repeats
         FROM lab_v2.paired_audit_runs
        WHERE status IN ('queued', 'running')
        ORDER BY created_at
        LIMIT 1`,
    );
    if (!run) break;
    if (!seen.has(run.id)) {
      seen.add(run.id);
      report.runs += 1;
    }
    await db.query(`UPDATE lab_v2.paired_audit_runs SET status = 'running' WHERE id = $1 AND status = 'queued'`, [run.id]);
    const model = parsePairedModel(run.model);
    if (!model) {
      report.stopped += await stopRemaining(db, run.id, 'model_unsupported');
      log(deps, 'paired_audit_stop', { run_id: run.id, reason: 'model_unsupported', path: 'paired_audit_tick' });
      continue;
    }
    if (run.engine_version !== pairedEngineVersion() || run.prompt_hash !== opdAuditPromptHash()) {
      report.stopped += await stopRemaining(db, run.id, 'engine_drift');
      log(deps, 'paired_audit_stop', { run_id: run.id, reason: 'engine_drift', path: 'paired_audit_tick' });
      continue;
    }
    const width = run.max_spend_microusd != null ? 1 : concurrency;
    if (jobs.length >= width) {
      await Promise.race(jobs);
      continue;
    }
    const ledgerNow = await readLedger(db, run);
    if (budgetBlocked(ledgerNow)) {
      if (jobs.length > 0) {
        await Promise.race(jobs);
        continue;
      }
      halt = { run, reason: 'budget_exhausted' };
      continue;
    }
    const callRoom = num(run.max_llm_calls) - ledgerNow.calls_used - jobs.length;
    if (callRoom <= 0) {
      if (jobs.length === 0) {
        halt = { run, reason: 'budget_exhausted' };
        continue;
      }
      await Promise.race(jobs);
      continue;
    }
    const items = await claimItems(db, run.id, Math.min(width - jobs.length, callRoom), concurrency);
    if (items.length === 0) {
      const queued = await countStatus(db, run.id, 'queued');
      if (queued === 0) {
        if (jobs.length === 0) {
          await closeRunIfDrained(db, run.id);
          if (await countStatus(db, run.id, 'running') > 0) break;
          continue;
        }
        await Promise.race(jobs);
        continue;
      }
      if (jobs.length === 0) break;
      await Promise.race(jobs);
      continue;
    }
    if (now() >= deadline) {
      for (const item of items) await releaseUnstarted(db, item.id);
      outOfTime = true;
      break;
    }
    report.groups += 1;

    const ready: ReadyItem[] = [];
    const byUid = new Map<string, ItemRow[]>();
    for (const item of items) {
      const list = byUid.get(item.uid);
      if (list) list.push(item);
      else byUid.set(item.uid, [item]);
    }
    for (const [uid, group] of byUid) {
      let resolved: ResolveResult;
      try {
        resolved = await enterOpdLabWriteFence(() => deps.resolveNote(uid));
      } catch (e) {
        const reason = reasonCode(e);
        for (const item of group) await markItem(db, item.id, 'failed', reason, null);
        report.failed += group.length;
        log(deps, 'paired_audit_uid', { run_id: run.id, uid, status: 'failed', reason, path: 'paired_audit_tick' });
        continue;
      }
      if (resolved.status !== 'ok') {
        const reason = resolved.status === 'not_found' ? 'uid_not_found' : 'uid_ambiguous';
        for (const item of group) await markItem(db, item.id, 'skipped', reason, null);
        report.skipped += group.length;
        log(deps, 'paired_audit_uid', { run_id: run.id, uid, status: 'skipped', reason, path: 'paired_audit_tick' });
        continue;
      }
      const join = externalRefJoin(resolved.row, group[0].external_ref);
      if (!join.matches || group.some((item) => !externalRefJoin(resolved.row, item.external_ref).matches)) {
        for (const item of group) await markItem(db, item.id, 'skipped', 'external_ref_mismatch', null);
        report.skipped += group.length;
        log(deps, 'paired_audit_uid', { run_id: run.id, uid, status: 'skipped', reason: 'external_ref_mismatch', path: 'paired_audit_tick' });
        continue;
      }
      if (join.neitherKey) {
        await db.query(
          `UPDATE lab_v2.paired_audit_runs
              SET external_ref_unkeyed = external_ref_unkeyed + 1
            WHERE id = $1
              AND NOT EXISTS (
                SELECT 1 FROM lab_v2.paired_audit_items
                 WHERE run_id = $1 AND uid = $2 AND status NOT IN ('queued', 'running')
              )`,
          [run.id, uid],
        );
      }
      let lab: OpdLabDependencies;
      try {
        lab = await enterOpdLabWriteFence(() => deps.loadContext(resolved.row));
      } catch (e) {
        const reason = reasonCode(e);
        for (const item of group) await markItem(db, item.id, 'failed', reason, null);
        report.failed += group.length;
        log(deps, 'paired_audit_uid', { run_id: run.id, uid, status: 'failed', reason, path: 'paired_audit_tick' });
        continue;
      }
      const ctx = hashContext(lab);
      for (const item of group) ready.push({ item, row: resolved.row, lab, ctx });
    }

    for (const work of ready) {
      if (now() >= deadline) {
        await releaseUnstarted(db, work.item.id);
        outOfTime = true;
        continue;
      }
      track(auditClaimed(db, deps, run, model, work, report, (reason) => {
        halt = { run, reason };
      }));
    }
  }
  await drainJobs();
  if (halt) await settleHalt();
  return report;
}

type ClaimedModel = { provider: 'bedrock' | 'openrouter' | 'ollama' | 'vertex'; model: string };

async function auditClaimed(
  db: Db,
  deps: PairedAuditDeps,
  run: RunRow,
  model: ClaimedModel,
  work: ReadyItem,
  report: TickReport,
  onHalt: (reason: string) => void,
): Promise<void> {
  const item = work.item;
  let ledger = await readLedger(db, run);
  const blocked = budgetBlocked(ledger);
  if (blocked) {
    if (await markItem(db, item.id, 'stopped', blocked, null)) report.stopped += 1;
    onHalt(blocked);
    return;
  }
  if (item.arm !== 'signed') {
    const structured = asStruct(item.override_struct);
    const coverage = item.input_path === 'text' ? assessOverrideText(item.override_text ?? '') : null;
    const bad = coverage ? !coverage.ok : overrideUnparsed(structured);
    if (bad) {
      if (await markUnparsed(db, item.id, coverage?.linesTotal ?? null, coverage?.linesParsed ?? null)) {
        report.skipped += 1;
      }
      log(deps, 'paired_audit_item', {
        run_id: run.id, uid: item.uid, arm: item.arm, repeat_idx: item.repeat_idx,
        status: 'skipped', reason: 'override_unparsed', path: 'paired_audit_tick',
      });
      return;
    }
  }
  const contentHash = item.arm === 'signed'
    ? signedContentHash(work.row, work.ctx)
    : overrideContentHash(
      item.input_path === 'text' ? 'text' : 'structured',
      asStruct(item.override_struct),
      item.input_path === 'text' ? item.override_text : null,
      work.row,
      work.ctx,
    );
  const prior = await db.query<{ id: string }>(
    `SELECT id FROM lab_v2.paired_audit_results
      WHERE uid = $1 AND arm = $2 AND engine_version = $3 AND prompt_hash = $4
        AND model = $5 AND override_hash = $6 AND repeat_idx = $7`,
    [item.uid, item.arm, run.engine_version, run.prompt_hash, run.model, contentHash, item.repeat_idx],
  );
  if (prior[0]) {
    if (await markItem(db, item.id, 'deduped', null, prior[0].id)) report.deduped += 1;
    log(deps, 'paired_audit_item', { run_id: run.id, uid: item.uid, arm: item.arm, repeat_idx: item.repeat_idx, status: 'deduped', path: 'paired_audit_tick' });
    return;
  }
  const row = item.arm === 'signed'
    ? work.row
    : applyStructuredOverride(work.row, asStruct(item.override_struct));
  let chargedHere = 0;
  try {
    const outcome = await deps.audit(row, work.lab, async () => {
      await chargeCall(db, run.id);
      chargedHere += 1;
    }, model);
    await persistSpend(db, run.id, outcome.spend_microusd);
    ledger = await readLedger(db, run);
    const projected = projectAudit(outcome.audit, item.arm);
    if (projected.llm_leg_failed) {
      // A swallowed model error is not a result. Leaving it out of the dedupe table
      // is what lets a later submit retry it. The calls already counted stay counted.
      if (await markItem(db, item.id, 'failed', 'engine_error', null)) report.failed += 1;
      log(deps, 'paired_audit_item', {
        run_id: run.id, uid: item.uid, arm: item.arm, repeat_idx: item.repeat_idx,
        status: 'failed', reason: 'engine_error', calls: ledger.calls_used, path: 'paired_audit_tick',
      });
    } else {
      const clinician = item.arm === 'signed'
        ? (rowToOpdCase(work.row).keys.doctorUid ?? null)
        : null;
      const resultId = randomUUID();
      const inputPath = item.arm === 'signed' ? 'signed' : item.input_path;
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO lab_v2.paired_audit_results
          (id, uid, arm, engine_version, prompt_hash, model, override_hash, input_path,
           repeat_idx, clinician_uid, result, calls, spend_microusd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
         ON CONFLICT (uid, arm, engine_version, prompt_hash, model, override_hash, repeat_idx) DO NOTHING
         RETURNING id`,
        [resultId, item.uid, item.arm, run.engine_version, run.prompt_hash, run.model, contentHash,
          inputPath, item.repeat_idx, clinician, JSON.stringify(projected),
          chargedHere, outcome.spend_microusd ?? 0],
      );
      const storedId = inserted[0]?.id ?? (await db.query<{ id: string }>(
        `SELECT id FROM lab_v2.paired_audit_results
          WHERE uid = $1 AND arm = $2 AND engine_version = $3 AND prompt_hash = $4
            AND model = $5 AND override_hash = $6 AND repeat_idx = $7`,
        [item.uid, item.arm, run.engine_version, run.prompt_hash, run.model, contentHash, item.repeat_idx],
      ))[0]?.id;
      const status = inserted[0] ? 'succeeded' : 'deduped';
      if (await markItem(db, item.id, status, null, storedId ?? null)) {
        if (inserted[0]) report.audited += 1;
        else report.deduped += 1;
      }
      log(deps, 'paired_audit_item', {
        run_id: run.id, uid: item.uid, arm: item.arm, repeat_idx: item.repeat_idx,
        status, calls: ledger.calls_used, path: 'paired_audit_tick',
      });
    }
    if (budgetBlocked(ledger)) onHalt('budget_exhausted');
  } catch (e) {
    const reason = reasonCode(e);
    const status = reason === 'budget_exhausted' || reason === 'production_write_refused' ? 'stopped' : 'failed';
    if (await markItem(db, item.id, status, reason, null)) {
      if (status === 'stopped') report.stopped += 1;
      else report.failed += 1;
    }
    log(deps, 'paired_audit_item', { run_id: run.id, uid: item.uid, arm: item.arm, repeat_idx: item.repeat_idx, status, reason, path: 'paired_audit_tick' });
    if (reason === 'budget_exhausted' || reason === 'production_write_refused') onHalt(reason);
  }
}

export async function pairedAuditStatus(db: Db, runId: string): Promise<{
  run_id: string;
  status: string;
  stop_reason: string | null;
  experiment_label: string;
  engine_version: string;
  prompt_hash: string;
  model: string;
  calls_used: number;
  spend_microusd: number;
  max_llm_calls: number;
  max_spend_microusd: number | null;
  external_ref_unkeyed: number;
  counts: { queued: number; running: number; succeeded: number; deduped: number; skipped: number; failed: number; stopped: number };
}> {
  const [run] = await db.query<RunRow & { experiment_label: string; external_ref_unkeyed: number }>(
    `SELECT id, experiment_label, engine_version, prompt_hash, model, status, stop_reason,
            max_llm_calls, max_spend_microusd, calls_used, spend_microusd, external_ref_unkeyed
       FROM lab_v2.paired_audit_runs WHERE id = $1`,
    [runId],
  );
  if (!run) throw new LabError('NOT_FOUND', `no paired audit run ${runId}`);
  const counts = await itemCounts(db, runId);
  return {
    run_id: run.id,
    status: run.status,
    stop_reason: run.stop_reason,
    experiment_label: run.experiment_label,
    engine_version: run.engine_version,
    prompt_hash: run.prompt_hash,
    model: run.model,
    calls_used: num(run.calls_used),
    spend_microusd: num(run.spend_microusd),
    max_llm_calls: num(run.max_llm_calls),
    max_spend_microusd: run.max_spend_microusd == null ? null : num(run.max_spend_microusd),
    external_ref_unkeyed: num(run.external_ref_unkeyed),
    counts: {
      queued: counts.queued ?? 0,
      running: counts.running ?? 0,
      succeeded: counts.succeeded ?? 0,
      deduped: counts.deduped ?? 0,
      skipped: counts.skipped ?? 0,
      failed: counts.failed ?? 0,
      stopped: counts.stopped ?? 0,
    },
  };
}

interface ResultJoin {
  uid: string;
  external_ref: string;
  arm: string;
  repeat_idx: number;
  status: string;
  skip_reason: string | null;
  input_path: string;
  clinician_uid: string | null;
  result: ProjectedAudit | string | null;
  engine_version: string;
  prompt_hash: string;
}

function asProjected(result: ProjectedAudit | string | null, arm: string): ProjectedAudit | null {
  if (result == null) return null;
  const value = typeof result === 'string' ? JSON.parse(result) as ProjectedAudit : result;
  return value?.findings ? value : projectAudit(value, arm);
}

interface LoadedResults {
  runId: string;
  engine_version: string;
  prompt_hash: string;
  total: number;
  page: ResultJoin[];
  diffs: Array<{ uid: string; external_ref: string; only_a: ReturnType<typeof diffFlags>['only_a']; only_b: ReturnType<typeof diffFlags>['only_b']; both: ReturnType<typeof diffFlags>['both'] }>;
  repeats: Array<{ uid: string; arm: string; repeats: number; identical_flag_sets: boolean; flag_agreement: FlagAgreement[] }>;
}

async function loadResults(db: Db, runId: string, limit: number, offset: number): Promise<LoadedResults> {
  const [run] = await db.query<{ id: string; engine_version: string; prompt_hash: string }>(
    `SELECT id, engine_version, prompt_hash FROM lab_v2.paired_audit_runs WHERE id = $1`, [runId]);
  if (!run) throw new LabError('NOT_FOUND', `no paired audit run ${runId}`);
  const totalRow = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM lab_v2.paired_audit_items WHERE run_id = $1`, [runId]);
  const total = Number(totalRow[0]?.n ?? 0);
  const page = await db.query<ResultJoin>(
    `SELECT i.uid, i.external_ref, i.arm, i.repeat_idx, i.status, i.skip_reason, i.input_path,
            r.clinician_uid, r.result, $2::text AS engine_version, $3::text AS prompt_hash
       FROM lab_v2.paired_audit_items i
       LEFT JOIN lab_v2.paired_audit_results r ON r.id = i.result_id
      WHERE i.run_id = $1
      ORDER BY i.uid, i.arm, i.repeat_idx
      LIMIT $4 OFFSET $5`,
    [runId, run.engine_version, run.prompt_hash, limit, offset],
  );
  const all = await db.query<ResultJoin>(
    `SELECT i.uid, i.external_ref, i.arm, i.repeat_idx, i.status, i.skip_reason, i.input_path,
            r.clinician_uid, r.result, $2::text AS engine_version, $3::text AS prompt_hash
       FROM lab_v2.paired_audit_items i
       LEFT JOIN lab_v2.paired_audit_results r ON r.id = i.result_id
      WHERE i.run_id = $1 AND i.status IN ('succeeded', 'deduped')`,
    [runId, run.engine_version, run.prompt_hash],
  );
  const byUid = new Map<string, ResultJoin[]>();
  for (const row of all) {
    const list = byUid.get(row.uid) ?? [];
    list.push(row);
    byUid.set(row.uid, list);
  }
  const diffs = [];
  const repeats = [];
  for (const [uid, rows] of byUid) {
    const signed = rows.find((r) => r.arm === 'signed' && Number(r.repeat_idx) === 0);
    const other = rows.find((r) => r.arm !== 'signed' && Number(r.repeat_idx) === 0);
    if (signed && other) {
      const a = asProjected(signed.result, signed.arm);
      const b = asProjected(other.result, other.arm);
      const diff = diffFlags(a?.findings ?? [], b?.findings ?? []);
      diffs.push({ uid, external_ref: signed.external_ref, only_a: diff.only_a, only_b: diff.only_b, both: diff.both });
    }
    const arms = [...new Set(rows.map((r) => r.arm))];
    for (const arm of arms) {
      const group = rows.filter((r) => r.arm === arm).sort((x, y) => Number(x.repeat_idx) - Number(y.repeat_idx));
      if (group.length <= 1) continue;
      const findings = group.map((r) => asProjected(r.result, arm)?.findings ?? []);
      repeats.push({
        uid,
        arm,
        repeats: group.length,
        identical_flag_sets: sameFlagSet(findings),
        flag_agreement: flagAgreement(findings),
      });
    }
  }
  return { runId, engine_version: run.engine_version, prompt_hash: run.prompt_hash, total, page, diffs, repeats };
}

function baseItem(row: ResultJoin, run: { engine_version: string; prompt_hash: string }) {
  const projected = asProjected(row.result, row.arm);
  return {
    arm: row.arm,
    repeat_idx: Number(row.repeat_idx),
    status: row.status,
    skip_reason: row.skip_reason,
    input_path: row.input_path,
    engine_version: run.engine_version,
    prompt_hash: run.prompt_hash,
    band: projected?.band ?? null,
    note_quality_index: projected?.note_quality_index ?? null,
    llm_leg_failed: projected ? projected.llm_leg_failed : null,
    projected,
  };
}

/** Research read. No uid, external_ref, clinician uid, or rationale. Arms join on pair_key. */
export async function pairedAuditResults(db: Db, runId: string, limit: number, offset: number): Promise<{
  run_id: string;
  items: Array<{
    pair_key: string;
    arm: string;
    repeat_idx: number;
    status: string;
    skip_reason: string | null;
    input_path: string;
    engine_version: string;
    prompt_hash: string;
    band: string | null;
    note_quality_index: number | null;
    llm_leg_failed: boolean | null;
    findings: PublicFinding[];
  }>;
  diffs: Array<{
    pair_key: string;
    only_a: PublicFlagRef[];
    only_b: PublicFlagRef[];
    both: PublicFlagRef[];
  }>;
  signed_repeats: Array<{ pair_key: string; repeats: number; identical_flag_sets: boolean; flag_agreement: PublicAgreement[] }>;
  override_repeats: Array<{ pair_key: string; arm: string; repeats: number; identical_flag_sets: boolean; flag_agreement: PublicAgreement[] }>;
  limit: number;
  offset: number;
  total: number;
}> {
  const loaded = await loadResults(db, runId, limit, offset);
  const key = (uid: string) => pairKeyFor(loaded.runId, uid);
  return {
    run_id: loaded.runId,
    items: loaded.page.map((row) => {
      const base = baseItem(row, loaded);
      return {
        pair_key: key(row.uid),
        arm: base.arm,
        repeat_idx: base.repeat_idx,
        status: base.status,
        skip_reason: base.skip_reason,
        input_path: base.input_path,
        engine_version: base.engine_version,
        prompt_hash: base.prompt_hash,
        band: base.band,
        note_quality_index: base.note_quality_index,
        llm_leg_failed: base.llm_leg_failed,
        findings: (base.projected?.findings ?? []).map(publicFinding),
      };
    }),
    diffs: loaded.diffs.map((d) => ({
      pair_key: key(d.uid),
      only_a: d.only_a.map(publicFlag),
      only_b: d.only_b.map(publicFlag),
      both: d.both.map(publicFlag),
    })),
    signed_repeats: loaded.repeats.filter((r) => r.arm === 'signed').map((r) => ({
      pair_key: key(r.uid), repeats: r.repeats, identical_flag_sets: r.identical_flag_sets,
      flag_agreement: r.flag_agreement.map(publicAgreement),
    })),
    override_repeats: loaded.repeats.filter((r) => r.arm !== 'signed').map((r) => ({
      pair_key: key(r.uid), arm: r.arm, repeats: r.repeats, identical_flag_sets: r.identical_flag_sets,
      flag_agreement: r.flag_agreement.map(publicAgreement),
    })),
    limit,
    offset,
    total: loaded.total,
  };
}

/** Identifying read. Uid, external_ref, clinician uid and rationale stay in this payload. */
export async function pairedAuditResultsIdentifying(db: Db, runId: string, limit: number, offset: number): Promise<{
  run_id: string;
  items: Array<{
    uid: string;
    external_ref: string;
    arm: string;
    repeat_idx: number;
    status: string;
    skip_reason: string | null;
    input_path: string;
    clinician_uid: string | null;
    engine_version: string;
    prompt_hash: string;
    band: string | null;
    note_quality_index: number | null;
    llm_leg_failed: boolean | null;
    findings: ProjectedFinding[];
  }>;
  diffs: Array<{
    uid: string;
    external_ref: string;
    only_a: ReturnType<typeof diffFlags>['only_a'];
    only_b: ReturnType<typeof diffFlags>['only_b'];
    both: ReturnType<typeof diffFlags>['both'];
  }>;
  signed_repeats: Array<{ uid: string; repeats: number; identical_flag_sets: boolean; flag_agreement: FlagAgreement[] }>;
  override_repeats: Array<{ uid: string; arm: string; repeats: number; identical_flag_sets: boolean; flag_agreement: FlagAgreement[] }>;
  limit: number;
  offset: number;
  total: number;
}> {
  const loaded = await loadResults(db, runId, limit, offset);
  return {
    run_id: loaded.runId,
    items: loaded.page.map((row) => {
      const base = baseItem(row, loaded);
      return {
        uid: row.uid,
        external_ref: row.external_ref,
        arm: base.arm,
        repeat_idx: base.repeat_idx,
        status: base.status,
        skip_reason: base.skip_reason,
        input_path: base.input_path,
        clinician_uid: row.arm === 'signed' ? row.clinician_uid : null,
        engine_version: base.engine_version,
        prompt_hash: base.prompt_hash,
        band: base.band,
        note_quality_index: base.note_quality_index,
        llm_leg_failed: base.llm_leg_failed,
        findings: base.projected?.findings ?? [],
      };
    }),
    diffs: loaded.diffs.map((d) => ({
      uid: d.uid, external_ref: d.external_ref, only_a: d.only_a, only_b: d.only_b, both: d.both,
    })),
    signed_repeats: loaded.repeats.filter((r) => r.arm === 'signed').map((r) => ({
      uid: r.uid, repeats: r.repeats, identical_flag_sets: r.identical_flag_sets, flag_agreement: r.flag_agreement,
    })),
    override_repeats: loaded.repeats.filter((r) => r.arm !== 'signed').map((r) => ({
      uid: r.uid, arm: r.arm, repeats: r.repeats, identical_flag_sets: r.identical_flag_sets, flag_agreement: r.flag_agreement,
    })),
    limit,
    offset,
    total: loaded.total,
  };
}

/** Used by the flag-set helper so a test can import the key without reaching the runner. */
export { flagKey };
