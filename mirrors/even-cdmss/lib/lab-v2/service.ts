/**
 * lib/lab-v2/service.ts — the fifteen tool handlers (LAB-MCP-V2-PRD-v1.0 §8.1).
 *
 * ONE DISPATCH PATH FOR EVERY TOOL, and it does the same four things in the same order
 * every time: re-check the scope, validate the input, run the handler, validate the
 * output. Nothing is left to a handler's memory.
 *
 * ⚠️ THE SCOPE CHECK IS HERE, NOT ONLY IN `tools/list`. Visibility is a usability feature;
 * authorisation is this line. A principal that guesses the name of a tool it cannot see
 * gets SCOPE_DENIED — explicitly NOT "unknown tool" (§3.2.2), because a truthful denial
 * is a smaller leak than a lie a caller can distinguish by timing anyway.
 *
 * ⚠️ INPUT VALIDATION IS EXPLICIT HERE rather than delegated to the SDK. The MCP SDK is
 * given a JSON Schema through the bridge in lib/mcp-v2/schema-bridge.ts and may or may
 * not enforce it depending on how a client calls; §8's "inputs are validated at dispatch"
 * has to be true regardless, so the Zod schema is applied here where it cannot be skipped.
 */
import { z } from 'zod';
import type { Db } from './db';
import {
  LabError, RUN_DEADLINE_MS, SCOPES_BY_PRINCIPAL, SUPPORTED_ENGINES, ENGINE_SLICE, PROVIDERS, stagesFor,
  armBodySchema, datasetBodySchema, experimentBodySchema, hash, toolSchemas,
  type Principal, type Scope, type ToolName, IDENTIFYING_PRINCIPALS_ENV, ENGINE_IDS, type EngineId,
  DATASET_FREEZE_OPERATION, V1_DEPRECATIONS,
} from './contracts';
// §17.8 decision 105 — the data_scope gate lives beside the keys, not beside the tools.
import { dataScopeFor, identifyingPrincipals, mayUseIdentifyingInput } from '../mcp-v2/auth';
import { createHash } from 'crypto';
// §17.8 decision 109 — the two Slice D freezes, wired into dataset_create.
import { freezeReadmissionFinding } from './sources/readmission';
import { freezeIpdDischargeDocument } from './sources/ipd-discharge';
import { freezePreopEpisode } from './sources/preop';
import { PRICING_VERSION, isSupportedModel, modelsFor } from './pricing';
import { BY_NAME, visibleTools } from './registry';
import {
  appliedMigrations, countItemsByState, deriveRunState, ensureBudget, getBudget, getObject, queueWait, reconcileCall,
  getRun, getWorker, itemsOf, putObject, recordEvent, requestCancel, retryRun, setWorkerPaused, submitRun,
} from './store';
import { opdAdapter } from './adapters/opd';
// Round A3 (decision 37). The multi-engine registry lives in adapters/types.ts because round 1
// put ADAPTERS in adapters/opd.ts and §17.3 leaves that file untouched.
import { ALL_ADAPTERS } from './adapters/types';
import { freezeRequestCase, requestFieldsFor, requiresIdentifyingInput, identifyingKeys} from './sources/requests';
import { OBSERVATION_HANDLERS, OBSERVATION_SCHEMAS } from './tools/observation';
// Slice B round B1 (§17.4).
import { COMPARE_SCHEMAS, experimentCompare, runDiff } from './tools/compare';
import { REPLAY_SCHEMAS, runReplay } from './tools/replay';
// Slice B round B2 (§17.5).
import { EPISODE_SCHEMAS, episodeCheckpointInspect, episodeReplay } from './tools/episode';
import { freezeIpdEpisode } from './adapters/ipd-episode';
import { selectIpdCohort, type FrozenIpdCase } from './sources/ipd';
// Slice B round B3 (§17.6).
import { COVERAGE_SCHEMAS, coverageReport } from './tools/coverage';
import { DRIFT_SCHEMAS, driftReport } from './tools/drift';
import { RETRIEVAL_COMPARE_SCHEMAS, retrievalCompare } from './tools/retrieval-compare';
import { REPAIR_SCHEMAS, reauditExecute, reauditPlan } from './tools/repair';
import { GENERATED_ROUTE_VERSIONS, bakedEngineVersion } from './engine-versions.generated';
// Slice C round C1 (§17.7).
import { CORPUS_SCHEMAS, corpusDiff, corpusStage, corpusValidate } from './tools/corpus';
import { RELEASE_SCHEMAS, RELEASE_HANDLERS } from './tools/release';
// Slice C round C2 (§17.7, decisions 82, 89, 90).
import { RULES_SCHEMAS, rulePropose, ruleSimulate } from './tools/rules';
// Slice C round C3 (§17.7, decisions 96, 97).
import { CLUSTER_SCHEMAS, failureCluster } from './tools/cluster';
import { QUEUE_SCHEMAS, reviewQueue } from './tools/queue';
// Slice D round D3 (§17.11, decisions 141, 142, 146). Schemas beside their handlers, as every
// round since A2 has done.
import { CASE_SCHEMAS, caseAsk, caseTimeline } from './tools/case';
import { MINIMIZE_SCHEMAS, failureMinimize } from './tools/minimize';
import { FREEZE_ARM_HASH, freezeItemKey } from './adapters/dataset-freeze';
import { freezeCohort } from './sources/cohort';
import { freezeOpdCase, validateFrozenCase } from './sources/opd';
import { openrouterConfigured, geminiConfigured } from '../llm';
import { bedrockConfigured } from '../bedrock';

export interface ServiceDeps {
  db: Db;
  principal: Principal;
  protocolVersion: string;
  sdkVersion: string;
}

const DEFAULT_BUDGET_CAP_MICROUSD = 5_000_000;   // $5 per named budget until an operator raises it.

/**
 * Round A2 (§17.2) — one schema table for both rounds. Round 1's schemas live in contracts.ts;
 * the nine observation schemas live beside their handlers, because A2's file contract does not
 * permit editing contracts.ts. Dispatch does not care which side a tool came from.
 */
/**
 * §17.6 item 6 — `report_export`, full.
 *
 * A2's report carried the run, the experiment, the dataset metadata, the arms, the items and the
 * call ledger. B3 adds the four things a reader of a Slice B run actually needs beside them: the
 * comparison the run was for, the replay verdicts that say whether it is reproducible, the
 * coverage and drift slices that put it in context, and — for a repair — the plan it ran and what
 * each case did. Every added section is OPTIONAL and null when it does not apply, so an ordinary
 * Slice A run exports exactly what it exported before plus four nulls.
 */
const REPORT_EXPORT_FULL = {
  input: z.object({
    run_id: z.string().uuid(),
    /** Off by default: a full export runs three more reads and a caller should ask for them. */
    include: z.array(z.enum(['replay', 'coverage', 'drift', 'repair'])).default([]),
  }),
  output: z.object({
    artifact_id: z.string().uuid(),
    run_id: z.string().uuid(),
    caveat: z.string(),
    summary: z.object({
      items: z.number().int(),
      execution_status: z.record(z.number()),
      assessment_status: z.record(z.number()),
      attribution_status: z.record(z.number()),
      calls: z.number().int(),
      replay_exactness: z.string().nullable(),
    }),
    /** What was actually attached, so an empty section is never mistaken for an empty result. */
    sections: z.array(z.string()),
  }),
} as const;

interface SchemaPair { input: { safeParse: (v: unknown) => unknown }; output: { safeParse: (v: unknown) => unknown } }
const SCHEMAS: Record<string, SchemaPair> = {
  ...(toolSchemas as unknown as Record<string, SchemaPair>),
  ...(OBSERVATION_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(COMPARE_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(REPLAY_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(EPISODE_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(COVERAGE_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(DRIFT_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(RETRIEVAL_COMPARE_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(REPAIR_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(CORPUS_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(RELEASE_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(RULES_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(CLUSTER_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(QUEUE_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(CASE_SCHEMAS as unknown as Record<string, SchemaPair>),
  ...(MINIMIZE_SCHEMAS as unknown as Record<string, SchemaPair>),
  // §17.6 item 6 — report_export goes FULL. Its schema is widened here rather than in
  // tools/observation.ts because §17.6's file contract leaves that file untouched, and this
  // table is where both rounds' schemas already meet. A later spread wins, so this entry
  // replaces A2's narrower pair for dispatch and for output validation alike.
  report_export: REPORT_EXPORT_FULL as unknown as SchemaPair,
};

function scopesOf(principal: Principal): readonly Scope[] { return SCOPES_BY_PRINCIPAL[principal]; }

/**
 * §17.8 DECISION 105 — does THIS CALL carry an identifier, as opposed to could this tool ever.
 *
 * ⚠️ THE TOOL FLAG ALONE WOULD HAVE BEEN FAR TOO BLUNT, and the first run of the suite proved it:
 * `dataset_create` is the one tool that takes a body, so marking it closed `dataset_create` for the
 * research key on every engine — including the seven de-identified ones it exists to serve. That is
 * not what decision 105 says and it is not what decision 101 says either: 101's words are that
 * `requiresIdentifyingInput` is true for the three D engines *"so dataset_create fails closed for a
 * principal without data_scope"*. The engine is the discriminator.
 *
 * ⚠️ AND AN ABSENT OR UNKNOWN ENGINE FAILS CLOSED. A call to a tool that CAN carry an identifier,
 * naming no engine this platform recognises, is refused rather than waved through: the alternative
 * is that a typo becomes a bypass.
 */
export function callCarriesIdentifyingInput(rawArgs: unknown): boolean {
  const engine = (rawArgs && typeof rawArgs === 'object')
    ? String((rawArgs as Record<string, unknown>).engine ?? '') : '';
  if (!engine) return true;
  if (!(ENGINE_IDS as readonly string[]).includes(engine)) return true;
  return requiresIdentifyingInput(engine as EngineId);
}

/** §13 — a tool call carrying a `principal` or `reviewer` field has it IGNORED. */
function stripIdentityFields(args: Record<string, unknown>): Record<string, unknown> {
  const { principal: _p, reviewer: _r, owner: _o, ...rest } = args;
  return rest;
}

/**
 * §17.8 DECISION 109 — `dataset_create` for `readmission` and `preop`.
 *
 * ⚠️ IT EXISTED NOWHERE BEFORE THIS FIX. D1 shipped `freezeReadmissionFinding` and
 * `freezePreopEpisode` and wired neither into the service; `grep readmission lib/lab-v2/service.ts`
 * returned nothing. D1's tests called the freezes DIRECTLY, so they passed while the only path a
 * caller has did not exist. Hence the standing rule this fix carries: every new tool path gets at
 * least one test through service dispatch, not only through its functions.
 *
 * ⚠️ THESE ENGINES DO NOT GO THROUGH `freezeRequestCase`, AND MUST NOT. That function refuses any
 * identifying key in a body — and `dedup_key` and `episodeKey` are both on the denylist after
 * decision 101, deliberately. The identifier is an ARGUMENT here, used to read and never stored:
 * the freeze returns a salted `case_key`, a `member_key` and a body with no id in it.
 *
 * ⚠️ AND `member_key` IS A SIBLING OF `frozen`, NEVER A FIELD INSIDE IT. That is the shape every
 * dataset in this platform already uses (`datasetCaseSchema`), and it is why decision 99's walk can
 * be run over `frozen` alone: the one durable link to a person lives outside the body a replay reads.
 *
 * Both are `replay_exactness: 'frozen'` — a readmission case carries the whole `ThreeSourceInputs`
 * the recon legs read, and a preop case carries all six source fetches, so a replay of either reads
 * nothing live.
 */
/**
 * §17.11 DECISION 144 — `dataset_create ipd_discharge` SUBMITS A RUN AND RETURNS.
 *
 * One item per requested key, each carrying `{engine, source_key_hash, source_key}` and nothing
 * else. The item's `case_key` is a CONTENT HASH of the engine and the key — never the key — because
 * `items.case_key` is read back by every observation tool; the key itself lives in the payload,
 * which is the run's private work, and the freeze adapter erases it the moment the item settles.
 *
 * ⚠️ THE DEDUPLICATION IS `submitRun`'s, NOT A NEW ONE. The same `(owner, 'dataset_freeze',
 * idempotency_key)` returns the prior run with `deduplicated: true`, so a client that retries a
 * timed-out call gets the run it already has rather than a second freeze of twenty documents.
 *
 * ⚠️ NO BUDGET IS SPENT AND ONE IS STILL REQUIRED. `submitRun` takes a budget id because every run
 * has one; a freeze prices no stage and the freeze adapter never touches the gateway, so the
 * ledger records zero against it. Using the caller's default budget keeps the run visible in
 * `run_status`'s money columns rather than inventing a second accounting path.
 */
async function submitIpdDischargeFreeze(deps: ServiceDeps, args: Record<string, unknown>): Promise<unknown> {
  const bodyArg = (args.body ?? {}) as Record<string, unknown>;
  const cohort = args.cohort as { case_keys?: string[] } | undefined;
  const single = bodyArg.documentId;
  const keys = (cohort?.case_keys ?? (single == null ? [] : [String(single)]))
    .map((k) => String(k).trim()).filter((k) => k.length > 0);
  if (!keys.length) {
    throw new LabError('INVALID_INPUT',
      'ipd_discharge takes body.documentId, or cohort.case_keys as discharge document ids');
  }
  const skip = new Set((args.exclusions as string[]) ?? []);
  const wanted = [...new Set(keys.filter((k) => !skip.has(k)))];
  if (!wanted.length) throw new LabError('INVALID_INPUT', 'every requested case is in the exclusion list');

  const budget = await ensureBudget(deps.db, deps.principal, 'default', DEFAULT_BUDGET_CAP_MICROUSD);
  const items = wanted.map((k) => ({
    case_key: freezeItemKey('ipd_discharge', k),
    arm_hash: FREEZE_ARM_HASH,
    repetition: 1,
    payload: { engine: 'ipd_discharge', source_key_hash: freezeItemKey('ipd_discharge', k), source_key: k },
  }));
  const { run, itemCount, deduplicated } = await submitRun(
    deps.db, deps.principal, DATASET_FREEZE_OPERATION, null, budget.id,
    String(args.idempotency_key), hash({ engine: 'ipd_discharge', cases: items.length }),
    RUN_DEADLINE_MS, items,
  );
  return {
    freeze_run_id: run.id,
    state: 'freezing' as const,
    requested: itemCount,
    deduplicated,
    note: 'Each case is frozen by the tick, one per claim, and the last item to settle assembles the '
      + 'dataset object; its item summary in run_result carries dataset_id and hash. A case that '
      + 'cannot be frozen becomes an exclusion naming the cause — including decision 147\'s phase '
      + 'deadlines, which name the phase and the elapsed milliseconds.',
  };
}

async function sliceDDataset(
  deps: ServiceDeps, args: Record<string, unknown>, engine: 'readmission' | 'preop' | 'ipd_discharge',
): Promise<unknown> {
  const isReadmission = engine === 'readmission';
  const isDischarge = engine === 'ipd_discharge';
  const bodyArg = (args.body ?? {}) as Record<string, unknown>;
  const cohort = args.cohort as { case_keys?: string[] } | undefined;

  /**
   * The identifier, in either of the two shapes the tool accepts. §17.9 round D2b adds a third
   * engine on the same path: one DOCUMENT, named by its `documentId` — already declared
   * `identifying: true` at `sources/requests.ts:218`, so the decision 105 gate above already
   * covers it and no `REQUEST_FIELDS` entry had to be added.
   */
  const single = isReadmission ? bodyArg.dedup_key : isDischarge ? bodyArg.documentId : bodyArg.episodeKey;
  const keys = (cohort?.case_keys ?? (single == null ? [] : [String(single)]))
    .map((k) => String(k).trim()).filter((k) => k.length > 0);
  if (!keys.length) {
    throw new LabError('INVALID_INPUT',
      isReadmission
        ? 'readmission takes body.dedup_key, or cohort.case_keys as dedup keys'
        : isDischarge
          ? 'ipd_discharge takes body.documentId, or cohort.case_keys as discharge document ids'
          : 'preop takes body.episodeKey, or cohort.case_keys as episode keys');
  }
  const skip = new Set((args.exclusions as string[]) ?? []);
  const wanted = keys.filter((k) => !skip.has(k));
  if (!wanted.length) throw new LabError('INVALID_INPUT', 'every requested case is in the exclusion list');

  const cases: { case_key: string; member_key: string | null; frozen: Record<string, unknown> }[] = [];
  const excluded: { case_key: string; reason: string }[] = [];
  for (const key of wanted) {
    try {
      const f = isReadmission
        ? await freezeReadmissionFinding(key)
        : isDischarge
          ? await freezeIpdDischargeDocument(key)
          : await freezePreopEpisode(key);
      cases.push({ case_key: f.case_key, member_key: f.member_key, frozen: f.frozen as unknown as Record<string, unknown> });
    } catch (e) {
      const err = e as LabError;
      /**
       * ⚠️ ONE CASE'S FAILURE IS AN EXCLUSION WITH A REASON, exactly as decision 41 rules for an
       * OPD cohort — except `NOT_CONFIGURED`, which is the deployment's problem (no member salt)
       * and would otherwise produce a dataset of N identical exclusions, and
       * `CLASSIFICATION_REQUIRED`, which means an upstream engine stopped de-identifying. Neither
       * is a property of the case, so neither is recorded against it.
       */
      if (err.code === 'NOT_CONFIGURED' || err.code === 'CLASSIFICATION_REQUIRED') throw err;
      /**
       * ⚠️ THE EXCLUSION IS KEYED BY A HASH, NOT BY THE IDENTIFIER THAT FAILED. `excluded` is
       * stored on the dataset object, so writing the raw `dedup_key` of a finding that does not
       * exist would put an identifier in `lab_v2` by the back door — the one thing decision 99
       * forbids, arriving through the error path rather than the happy one.
       */
      excluded.push({
        case_key: `${engine}:${createHash('sha256').update(`excluded|${key}`).digest('hex').slice(0, 32)}`,
        reason: `${err.code ?? 'ERROR'}: ${String(err.message).slice(0, 200)}`,
      });
    }
  }
  if (!cases.length) {
    throw new LabError('SOURCE_UNAVAILABLE',
      `no ${engine} case could be frozen (${excluded.length} excluded); the reasons are on the exclusions list`);
  }

  // ⚠️ DECISION 99, ON WHAT IS ABOUT TO BE STORED. The freezes each refuse an identifying key in
  // their own body; this walks the ASSEMBLED cases one more time, because the assembly is the last
  // thing that touches them before `putObject`.
  for (const c of cases) {
    const hits = identifyingKeys(c.frozen);
    if (hits.length) {
      throw new LabError('CLASSIFICATION_REQUIRED',
        `a frozen ${engine} case carries identifying key(s) ${hits.join(', ')}; refused rather than stored (decision 99)`);
    }
  }

  const body = datasetBodySchema.parse({
    engine,
    cases,
    // A discharge case is one already-extracted DOCUMENT, so its snapshot is the episode the
    // extract was taken from — the same policy preop uses, and for the same reason.
    snapshot_policy: isReadmission ? 'finding_at_creation' : 'episode_at_creation',
    exclusions: (args.exclusions as string[]) ?? [],
    classification: 'deidentified',
    source_versions: {
      frozen_at: new Date().toISOString(),
      origin: isReadmission ? 'readmission_findings'
        : isDischarge ? 'discharge_extracted_cases + db13 via lib/ipd-audit/db13.ts'
        : 'db13 via lib/preop/db13.ts',
      cases: cases.length,
    },
    replay_exactness: 'frozen',
  });
  const { object, deduplicated } = await putObject(deps.db, deps.principal, 'dataset', body, 'deidentified', String(args.idempotency_key));
  return {
    dataset_id: object.id, hash: object.hash, replay_exactness: body.replay_exactness,
    classification: 'deidentified' as const, deduplicated,
    counts: { requested: wanted.length, frozen: cases.length, excluded: excluded.length },
    excluded,
  };
}

export async function callTool(deps: ServiceDeps, name: string, rawArgs: unknown): Promise<unknown> {
  const spec = BY_NAME[name];
  const scopes = scopesOf(deps.principal);
  // Unknown and unauthorised are BOTH denials here. An unknown name is a genuine
  // -32602 at the protocol layer (the SDK never routes it to us), so anything reaching
  // this branch is a hidden tool being probed by name.
  if (!spec || !spec.scopes.some((s) => scopes.includes(s))) {
    throw new LabError('SCOPE_DENIED', `principal '${deps.principal}' may not call '${name}'`);
  }
  /**
   * §17.8 DECISION 105 — BEFORE THE HANDLER, AND BEFORE THE INPUT IS EVEN PARSED.
   *
   * ⚠️ THE ORDER IS THE POINT. Parsing first would mean a refused caller had already had its
   * identifier read into this process and, on a schema error, echoed back inside a validation
   * message. The refusal names the PRINCIPAL and the env list and never the field it was carrying.
   *
   * ⚠️ AND THE ERROR IS `CLASSIFICATION_REQUIRED`, NOT `SCOPE_DENIED`, because the two are
   * different facts and a reader has to be able to tell them apart: the key HAS the scope to call
   * this tool and is missing the data-scope attribute, which is fixed by an env list rather than by
   * a different key.
   */
  /**
   * §17.11 DECISION 146 — `identifying_always`, AND WHY THE ENGINE DISCRIMINATOR IS NOT ENOUGH.
   *
   * `callCarriesIdentifyingInput` asks whether THIS CALL carries an identifier by looking at the
   * engine named in its arguments, which is exactly right for `dataset_create` — seven of its ten
   * engines take a de-identified body. It is wrong for `case_ask`, whose whole input is a person:
   * `requestFieldsFor('opd_note_audit')` declares no identifying field (the table has no name and
   * no UHID), so the engine test would have waved a `case_ask` for one individual straight through
   * to the research key. `case_timeline` names no engine at all and already fails closed.
   *
   * So a tool may declare that EVERY call it receives carries an identifier, and the two D3 case
   * tools do. The engine test still runs for every tool that does not.
   */
  const carriesIdentifier = spec.identifying_always === true || callCarriesIdentifyingInput(rawArgs);
  if (spec.identifying_input && carriesIdentifier && !mayUseIdentifyingInput(deps.principal)) {
    throw new LabError('CLASSIFICATION_REQUIRED',
      `'${name}' for engine '${String((rawArgs as Record<string, unknown> | null)?.engine ?? 'unknown')}' `
      + `is sent an identifier that resolves to a person, and principal '${deps.principal}' has `
      + `data_scope 'deidentified'. It needs production_read and its name in `
      + `${IDENTIFYING_PRINCIPALS_ENV}; 'research' can never be on that list (decision 105).`);
  }
  const args = stripIdentityFields((rawArgs ?? {}) as Record<string, unknown>);
  const parsed = SCHEMAS[spec.name].input.safeParse(args) as unknown as { success: boolean; data?: unknown; error?: { issues: { path: (string | number)[]; message: string }[] } };
  if (!parsed.success) {
    throw new LabError('INVALID_INPUT', `invalid input for '${name}': ${(parsed.error?.issues ?? []).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }

  const out = await ALL_HANDLERS[spec.name](deps, parsed.data as never);

  // Outputs are validated before return (§8): a handler that drifts from its declared
  // contract fails here rather than shipping a shape a client will silently mis-read.
  const validated = SCHEMAS[spec.name].output.safeParse(out) as unknown as { success: boolean; data?: unknown; error?: { issues: { path?: (string | number)[]; message: string }[] } };
  if (!validated.success) {
    /**
     * §17.6 DECISION 72 — `OUTPUT_INVALID`, WITH THE FIELD PATH, AND NEVER `STORE_UNAVAILABLE`.
     *
     * ⚠️ `retrieval_compare` failed here on production with "Expected number, received string" —
     * Postgres hands bigint and numeric back as text — and the caller was told `STORE_UNAVAILABLE`,
     * which names a DIFFERENT failure: the v2 database being unreachable. An operator chasing that
     * would have gone looking at Neon. The store was fine; the handler's own output was wrong, and
     * the error now says so and says WHERE.
     */
    const issues = (validated.error?.issues ?? []).slice(0, 5)
      .map((i) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message}`);
    throw new LabError('OUTPUT_INVALID',
      `'${name}' produced an output that does not match its own schema — ${issues.join('; ')}`,
      { tool: name, issues });
  }
  // §3.2.3 — actor, tool and outcome. NEVER the request body of a tool carrying clinical text.
  await recordEvent(deps.db, deps.principal, name, 'tool_call', { tool: name, request_hash: hash(args), outcome: 'ok' })
    .catch(() => { /* the audit trail must never be the thing that fails the call */ });
  return validated.data;
}

/**
 * The version to report: the live one when the source was readable, the baked one when it was not.
 * A baked value is used ONLY in place of `unavailable`; it can never override a hash the process
 * actually computed, so a stale generated file cannot mask a route that moved.
 */
export function liveOrBakedVersion(engine: string, live: string): string {
  if (!/@unavailable$/.test(live)) return live;
  return bakedEngineVersion(engine) ?? live;
}

export function versionSourceFor(engine: string, live: string): 'source' | 'generated' | 'constant' {
  // decision 39's shape is `<engine>/route@<hash>`; anything else is an engine with its own constant.
  if (!/\/route@/.test(live)) return 'constant';
  if (!/@unavailable$/.test(live)) return 'source';
  return GENERATED_ROUTE_VERSIONS[engine] ? 'generated' : 'source';
}

type Handler = (deps: ServiceDeps, args: Record<string, unknown>) => Promise<unknown>;

const HANDLERS: Record<ToolName, Handler> = {
  // ── capability discovery ──────────────────────────────────────────────────────────
  async system_capabilities(deps) {
    const scopes = scopesOf(deps.principal);
    return {
      principal: deps.principal,
      scopes: [...scopes],
      // §17.8 decision 105 — this principal's data scope, and the whole list beside it. A caller
      // refused CLASSIFICATION_REQUIRED should be able to see, in one call, both that its own
      // scope is 'deidentified' and which principal V actually granted the attribute to.
      data_scope: dataScopeFor(deps.principal),
      identifying_principals: [...identifyingPrincipals()],
      tools: visibleTools(scopes).map((s) => ({
        name: s.name, effect: s.effect, cost_class: s.cost_class, classification: s.classification, slice: s.slice,
        identifying_input: s.identifying_input === true,
      })),
      protocol_version: deps.protocolVersion,
      sdk_version: deps.sdkVersion,
      lab_v2_enabled: process.env.LAB_V2_ENABLED === '1',
      pricing_version: PRICING_VERSION,
      /**
       * §17.11 DECISION 143 — the first retirement this programme has performed, said out loud on
       * the surface a client already calls to find out what exists. A tool removed from a list is
       * indistinguishable from a tool that was never there; a deprecation entry names what replaced
       * it and since when, so a stale client's operator has somewhere to look.
       */
      deprecations: [...V1_DEPRECATIONS],
    };
  },

  async engine_describe(_deps, args) {
    const engine = String(args.engine) as (typeof SUPPORTED_ENGINES)[number];
    const adapter = ALL_ADAPTERS()[engine];
    /**
     * §17.8 DECISION 105 REPLACES DECISION 34's RULE HERE, and the change is deliberate.
     *
     * Under decision 34 an engine that could not run without an identifying field was UNSUPPORTED,
     * whatever its adapter could do — the only tool available then was a blanket refusal. Decision
     * 105 gives the platform a finer instrument: such an engine is supported, and the TOOLS that
     * can be handed its identifier are marked `identifying_input` and gated on `production_read`
     * plus the env list. So `identifyingBlocked` stops deciding support and starts being reported.
     *
     * ⚠️ IT IS STILL REPORTED, PROMINENTLY. A caller that reads `supported: true` and sends a
     * `dedup_key` from the research key gets `CLASSIFICATION_REQUIRED` from `callTool`; telling it
     * up front which engines will do that is the difference between a gate and a trap.
     */
    const identifyingInput = requiresIdentifyingInput(engine);
    const supported = SUPPORTED_ENGINES.includes(engine) && !!adapter;
    return {
      engine,
      supported,
      identifying_input: identifyingInput,
      reason: supported ? null : `not wired yet; arrives in slice ${ENGINE_SLICE[engine] ?? '?'}`,
      slice: ENGINE_SLICE[engine],
      // §35a — listed WITH the conditional mark, so a caller knows what it must price and what
      // may legitimately never fire.
      stages: supported ? stagesFor(engine).map((st) => ({ name: st.name, conditional: st.conditional })) : [],
      // §17.6 item 8 / decision 53. Decision 39 derives five of the seven versions from a route
      // file's git blob hash, read from disk — exact in a tree and in CI, `unavailable` in the
      // Vercel bundle, which ships no `.ts`. The baked table is the fallback, and `engine_version_source`
      // says which one answered rather than leaving a reader to wonder why the hash moved.
      engine_version: supported ? liveOrBakedVersion(engine, adapter.engineVersion()) : null,
      engine_version_source: supported ? versionSourceFor(engine, adapter.engineVersion()) : null,
      frozen_inputs: supported ? [...adapter.frozenInputs] : [],
      request_fields: [...requestFieldsFor(engine)],
      // Slice A never freezes retrieval, so 'frozen' is not offered for any engine yet (§4.2).
      replay_exactness_available: supported ? (['mutable_source'] as const).slice() : [],
    };
  },

  async model_capabilities(deps) {
    // Newest settled call per provider — the whole of decision 28's health signal.
    const rows = await deps.db.query<{ provider: string; newest: string }>(
      `SELECT served->>'provider' AS provider, max(settled_at) AS newest
       FROM lab_v2.calls WHERE state = 'settled' AND served->>'provider' IS NOT NULL
       GROUP BY 1`,
    ).catch(() => []);
    const lastSettled: Record<string, string> = {};
    for (const r of rows) if (r.newest) lastSettled[r.provider] = new Date(String(r.newest)).toISOString();
    const configured: Record<string, boolean> = {
      bedrock: bedrockConfigured(),
      openrouter: openrouterConfigured(),
      vertex: geminiConfigured(),
      ollama: !!process.env.OLLAMA_BASE_URL,
    };
    return {
      pricing_version: PRICING_VERSION,
      providers: PROVIDERS.map((p) => ({
        provider: p,
        configured: configured[p] ?? false,
        // DECISION 28 — DERIVED, NEVER PROBED: the newest `settled` call for this provider in
        // lab_v2.calls, or null. A probe would be a live model call, which would make a
        // capability read cost money and put a call outside any run's ledger. A settled call IS
        // the evidence that the provider answered, and it is evidence we already paid for.
        health_tested_at: lastSettled[p] ?? null,
        models: modelsFor(p),
      })),
    };
  },

  // ── operational health ────────────────────────────────────────────────────────────
  async system_health(deps) {
    const { db } = deps;
    const migrations = await appliedMigrations(db);
    const worker = await getWorker(db);
    const depth = await db.query<{ state: string; c: string }>(`SELECT state, count(*)::text AS c FROM lab_v2.items GROUP BY state`);
    const oldest = await db.query<{ age: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - min(next_at)))::text AS age FROM lab_v2.items WHERE state = 'queued'`);
    const reaped = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM lab_v2.events WHERE kind = 'item_reaped' AND created_at > now() - interval '24 hours'`);
    const calls = await db.query<{ state: string; c: string }>(
      `SELECT state, count(*)::text AS c FROM lab_v2.calls WHERE created_at > now() - interval '24 hours' GROUP BY state`);
    return {
      store_reachable: true,
      migrations_applied: migrations,
      worker_paused: worker.paused,
      queue_depth_by_state: Object.fromEntries(depth.map((r) => [r.state, Number(r.c)])),
      oldest_queued_age_seconds: oldest[0]?.age == null ? null : Number(oldest[0].age),
      reaped_last_24h: Number(reaped[0]?.c ?? 0),
      calls_by_state_last_24h: Object.fromEntries(calls.map((r) => [r.state, Number(r.c)])),
      // DECISION 43 — the measurement that decides worker hosting after a week of it.
      queue_wait_ms: {
        last_24h: await queueWait(db, 24),
        last_7d: await queueWait(db, 24 * 7),
      },
    };
  },

  async worker_status(deps) {
    const w = await getWorker(deps.db);
    return { id: w.id, paused: w.paused, revision: w.revision, heartbeat_at: w.heartbeat_at, active_item: w.active_item };
  },

  async worker_control(deps, args) {
    const w = await setWorkerPaused(deps.db, args.action === 'pause');
    return { id: w.id, paused: w.paused, revision: w.revision };
  },

  // ── datasets ──────────────────────────────────────────────────────────────────────
  async dataset_create(deps, args) {
    const engine = String(args.engine);
    if (!SUPPORTED_ENGINES.includes(engine as never)) {
      throw new LabError('ENGINE_UNSUPPORTED', `engine '${engine}' has no adapter; it arrives in slice ${ENGINE_SLICE[engine as never] ?? '?'}`);
    }
    /**
     * §17.8 DECISION 109 — DECISION 34's BLANKET REFUSAL IS GONE FROM HERE, and this note is what
     * replaces it. Two lines stood here: `if (requiresIdentifyingInput(engine))` and a
     * `CLASSIFICATION_REQUIRED` throw whose message told the caller the engine was not available
     * before Slice D. (The message itself is deliberately NOT quoted here — a test asserts that
     * text appears nowhere in this file, and a comment reproducing it would defeat the test.)
     *
     * It was correct for as long as Slice D did not exist. Decision 105 replaced that blanket
     * with a finer instrument — `production_read` plus a principal on
     * `LAB_V2_IDENTIFYING_PRINCIPALS` — and the gate for it runs in `callTool` BEFORE this handler
     * is reached, so leaving the old line here meant the operator key passed the new gate and was
     * then refused by the old one, with decision 34's text. Measured live on `0332a2a0`.
     *
     * ⚠️ NOTHING IS UNGUARDED BY ITS REMOVAL. `callCarriesIdentifyingInput` fails closed on an
     * absent or unknown engine, and a principal without the attribute never reaches this function
     * for `readmission` or `preop` at all.
     */

    // ── §17.8 D1 fix 2 (decision 109) — the two Slice D engines ─────────────────────
    // §17.9 round D2b decision 117(a) adds the third: one discharge document, frozen from its
    // STORED extract at DOC_EXTRACT_VERSION and never from a fresh PDF read (decision 102).
    /**
     * §17.11 DECISION 144 — `ipd_discharge` LEAVES THIS PATH AND BECOMES A JOB; the other two stay
     * exactly where they were. Neither `readmission` nor `preop` runs an engine at freeze time and
     * neither has ever failed to return, so making them asynchronous would cost every caller a
     * poll for nothing.
     */
    if (engine === 'ipd_discharge') return submitIpdDischargeFreeze(deps, args);
    if (engine === 'readmission' || engine === 'preop') {
      return sliceDDataset(deps, args, engine);
    }

    // ── Slice B round B2: the IPD episode freeze (§17.5, decisions 48 and 50) ───────
    // A frozen episode is a STORED AUDIT ROW, not a live encounter: the freeze reads
    // ipd_episode_audits, its checkpoints and the extraction, strips verbatimSections, and keys
    // the stored judge replies by the request hash the pipeline will actually compute. Every
    // such dataset is `frozen`, because nothing in a replay of it reads anything live.
    if (args.episodes) {
      if (engine !== 'ipd_episode') {
        throw new LabError('ENGINE_UNSUPPORTED', `the 'episodes' selector is ipd_episode only; '${engine}' takes a body or a cohort`);
      }
      const sel = args.episodes as { audit_ids?: string[]; engine_version?: string; limit?: number };
      const excluded: { case_key: string; reason: string }[] = [];
      const skip = new Set((args.exclusions as string[]) ?? []);
      const ids = (sel.audit_ids ?? await selectIpdCohort(String(sel.engine_version), sel.limit ?? 200))
        .filter((id) => !skip.has(id));
      if (!ids.length) throw new LabError('INVALID_INPUT', 'the episode selection resolved to no cases');
      const cases: FrozenIpdCase[] = [];
      for (const id of ids) {
        try {
          cases.push(await freezeIpdEpisode(id));
        } catch (e) {
          const err = e as LabError;
          // One episode's failure is an EXCLUSION with a reason, exactly as decision 41 rules for
          // an OPD cohort — except NOT_CONFIGURED, which is the deployment's problem and would
          // otherwise produce a dataset of 24 identical exclusions.
          if (err.code === 'NOT_CONFIGURED') throw err;
          excluded.push({ case_key: id, reason: `${err.code ?? 'ERROR'}: ${String(err.message).slice(0, 200)}` });
        }
      }
      if (!cases.length) {
        throw new LabError('SOURCE_UNAVAILABLE', `no episode could be frozen (${excluded.length} excluded)`);
      }
      const body = datasetBodySchema.parse({
        engine,
        cases: cases.map((c) => ({ case_key: c.case_key, member_key: c.member_key, frozen: c.frozen })),
        snapshot_policy: 'episode_at_creation',
        exclusions: (args.exclusions as string[]) ?? [],
        classification: 'deidentified',
        source_versions: {
          frozen_at: new Date().toISOString(),
          engine_versions: [...new Set(cases.map((c) => c.frozen.engine_version))],
          stripped: [...new Set(cases.flatMap((c) => c.frozen.stripped))],
        },
        replay_exactness: 'frozen',
      });
      const { object, deduplicated } = await putObject(deps.db, deps.principal, 'dataset', body, 'deidentified', String(args.idempotency_key));
      return {
        dataset_id: object.id, hash: object.hash, replay_exactness: body.replay_exactness,
        classification: 'deidentified', deduplicated,
        counts: { requested: ids.length, frozen: cases.length, excluded: excluded.length },
        excluded,
      };
    }

    // ── Slice B cohort mode (§17.4 item 1) ──────────────────────────────────────────
    // Many cases, each frozen with decision 41's sources and decision 44's member key, so the
    // dataset is `frozen` rather than `mutable_source`. One case's failure is an exclusion with a
    // reason, never the cohort's failure.
    if (args.cohort) {
      if (engine !== 'opd_note_audit') {
        throw new LabError('ENGINE_UNSUPPORTED', `cohort mode is opd_note_audit only in round B1; '${engine}' takes a single body`);
      }
      const cohort = await freezeCohort(args.cohort as never, (args.exclusions as string[]) ?? []);
      const body = datasetBodySchema.parse({
        engine,
        cases: cohort.cases.map((c) => ({ case_key: c.case_key, member_key: c.member_key, frozen: c.frozen })),
        snapshot_policy: 'cohort_at_creation',
        exclusions: (args.exclusions as string[]) ?? [],
        classification: 'deidentified',
        source_versions: { cohort_size: cohort.cases.length, frozen_at: new Date().toISOString() },
        // DECISION 41 — retrieval IS frozen here, so a replay sees the corpus this run saw.
        replay_exactness: 'frozen',
      });
      const { object, deduplicated } = await putObject(deps.db, deps.principal, 'dataset', body, 'deidentified', String(args.idempotency_key));
      return {
        dataset_id: object.id, hash: object.hash, replay_exactness: body.replay_exactness,
        classification: 'deidentified', deduplicated,
        counts: { requested: cohort.requested, frozen: cohort.cases.length, excluded: cohort.excluded.length },
        excluded: cohort.excluded,
      };
    }

    // TWO SHAPES OF SINGLE CASE. opd_note_audit's case is a uid whose inputs live in db13 and
    // Neon, so freezing it is a read. The five round-A3 engines take their whole case in the
    // request body, so freezing one is a validation and a hash.
    const frozen = engine === 'opd_note_audit'
      ? await (async () => {
        if (!args.case_key) throw new LabError('INVALID_INPUT', 'case_key is required for opd_note_audit');
        // Read from production OUTSIDE any lab context. freezeOpdCase throws CASE_NOT_FOUND
        // or SOURCE_UNAVAILABLE and never a partially frozen case.
        return freezeOpdCase(String(args.case_key));
      })()
      : (() => {
        if (!args.body) throw new LabError('INVALID_INPUT', `body is required for engine '${engine}'`);
        // Decision 34's gate lives here: an identifying key anywhere in the body is refused,
        // never stored and marked.
        return freezeRequestCase(engine as never, args.body);
      })();
    const body = datasetBodySchema.parse({
      engine,
      cases: [{ case_key: frozen.case_key, member_key: frozen.member_key, frozen: frozen.frozen }],
      snapshot_policy: 'single_case_at_creation',
      exclusions: [],
      classification: 'deidentified',
      source_versions: frozen.source_versions,
      // ALWAYS 'mutable_source' in Slice A: retrieval is not frozen, so a replay can
      // legitimately differ. Every report says so (§4.2).
      replay_exactness: 'mutable_source',
    });
    const { object, deduplicated } = await putObject(deps.db, deps.principal, 'dataset', body, 'deidentified', String(args.idempotency_key));
    return {
      dataset_id: object.id, hash: object.hash, replay_exactness: body.replay_exactness,
      classification: 'deidentified', deduplicated,
      counts: { requested: 1, frozen: 1, excluded: 0 },
      excluded: [],
    };
  },

  async dataset_preview(deps, args) {
    const obj = await getObject(deps.db, String(args.dataset_id));
    if (!obj || obj.kind !== 'dataset') throw new LabError('NOT_FOUND', `no dataset ${args.dataset_id}`);
    const body = datasetBodySchema.parse(obj.body);
    return {
      dataset_id: obj.id, engine: body.engine, hash: obj.hash, classification: obj.classification,
      replay_exactness: body.replay_exactness, snapshot_policy: body.snapshot_policy,
      exclusions: body.exclusions, source_versions: body.source_versions,
      // Case keys only — NEVER the frozen clinical text (§8.1).
      case_keys: body.cases.map((c) => c.case_key),
      created_at: new Date(obj.created_at).toISOString(),
    };
  },

  async dataset_validate(deps, args) {
    const obj = await getObject(deps.db, String(args.dataset_id));
    if (!obj || obj.kind !== 'dataset') throw new LabError('NOT_FOUND', `no dataset ${args.dataset_id}`);
    const body = datasetBodySchema.parse(obj.body);
    const checked: { case_key: string; field: string; matches: boolean }[] = [];
    for (const c of body.cases) {
      const fields = await validateFrozenCase(c.case_key, c.frozen as never);
      for (const f of fields) checked.push({ case_key: c.case_key, ...f });
    }
    return {
      dataset_id: obj.id,
      matches: checked.every((c) => c.matches),
      checked,
      note: 'replay_exactness is mutable_source: retrieval is not frozen in Slice A, so a matching report does not promise an identical replay.',
    };
  },

  // ── experiments ───────────────────────────────────────────────────────────────────
  async experiment_create(deps, args) {
    const dataset = await getObject(deps.db, String(args.dataset_id));
    if (!dataset || dataset.kind !== 'dataset') throw new LabError('NOT_FOUND', `no dataset ${args.dataset_id}`);
    if (dataset.hash !== String(args.dataset_hash)) {
      throw new LabError('DATASET_HASH_MISMATCH', `dataset ${dataset.id} hashes to ${dataset.hash}, not ${args.dataset_hash}`);
    }
    const datasetBody = datasetBodySchema.parse(dataset.body);

    const rawArms = [args.baseline_arm as Record<string, unknown>, ...((args.arms as Record<string, unknown>[]) ?? [])];
    const armIds: string[] = [];
    for (const raw of rawArms) {
      const arm = armBodySchema.parse({ engine_version: opdAdapter.engineVersion(), ...raw });
      if (arm.engine !== datasetBody.engine) {
        throw new LabError('INVALID_INPUT', `arm engine '${arm.engine}' does not match dataset engine '${datasetBody.engine}'`);
      }
      const stageNames = Object.keys(arm.stages);
      if (!stageNames.length) throw new LabError('BUDGET_UNBOUNDED', 'an arm must price at least one stage');
      // Decision 11 — a stage the engine does not list can never be billed, so an arm that
      // names one has reserved budget against work that will never run and declared a
      // variable the experiment cannot actually vary. Refuse it here, before anything is
      // queued, rather than let the run complete and quietly mean less than it claims.
      // Per engine (decision 35). A conditional stage is still listed and still must be priced
      // (35a); it simply may not fire, in which case there is no call and no charge.
      const known = new Set<string>(stagesFor(arm.engine).map((st) => st.name));
      for (const stage of stageNames) {
        if (!known.has(stage)) {
          throw new LabError('STAGE_UNKNOWN', `engine '${arm.engine}' has no stage '${stage}'; it lists ${[...known].join(', ')}`);
        }
      }
      for (const [stage, spec] of Object.entries(arm.stages)) {
        // §4.2 — an unpriced stage is refused BEFORE anything is queued, not discovered
        // when the first call tries to reserve against a cap that was never set.
        if (typeof spec.max_cost_microusd !== 'number') {
          throw new LabError('BUDGET_UNBOUNDED', `stage '${stage}' has no max_cost_microusd`);
        }
        if (!isSupportedModel(spec.provider, spec.model)) {
          throw new LabError('MODEL_UNSUPPORTED', `stage '${stage}': (${spec.provider}, ${spec.model}) is not supported or not priced`);
        }
      }
      const { object } = await putObject(deps.db, deps.principal, 'arm', arm, 'deidentified', null);
      armIds.push(object.id);
    }

    const budget = await ensureBudget(deps.db, deps.principal, String(args.budget_name ?? 'default'),
      Number(args.budget_cap_microusd ?? DEFAULT_BUDGET_CAP_MICROUSD));

    const body = experimentBodySchema.parse({
      hypothesis: args.hypothesis,
      dataset_id: dataset.id,
      dataset_hash: dataset.hash,
      baseline_arm_id: armIds[0],
      arm_ids: armIds,
      repeats: Number(args.repeats ?? 1),
      endpoints: args.endpoints ?? [],
      budget_name: String(args.budget_name ?? 'default'),
      purpose: String(args.purpose ?? 'research'),
    });
    const { object, deduplicated } = await putObject(deps.db, deps.principal, 'experiment', body, 'deidentified', String(args.idempotency_key));
    return { experiment_id: object.id, hash: object.hash, baseline_arm_id: armIds[0], arm_ids: armIds, budget_id: budget.id, deduplicated };
  },

  async experiment_run(deps, args) {
    const experiment = await getObject(deps.db, String(args.experiment_id));
    if (!experiment || experiment.kind !== 'experiment') throw new LabError('NOT_FOUND', `no experiment ${args.experiment_id}`);
    if (experiment.owner !== deps.principal) throw new LabError('OWNER_ONLY', 'an experiment may only be run by the principal that created it');
    const body = experimentBodySchema.parse(experiment.body);
    const dataset = await getObject(deps.db, body.dataset_id);
    if (!dataset) throw new LabError('NOT_FOUND', `experiment ${experiment.id} references a dataset that is gone`);
    const datasetBody = datasetBodySchema.parse(dataset.body);
    const budget = await ensureBudget(deps.db, deps.principal, body.budget_name, DEFAULT_BUDGET_CAP_MICROUSD);

    // One item per (case, arm, repetition). Each carries EVERYTHING the worker needs, so
    // the worker never re-reads an object and can therefore never observe a different one.
    const items = [];
    for (const arm_id of body.arm_ids) {
      const armObj = await getObject(deps.db, arm_id);
      if (!armObj) throw new LabError('NOT_FOUND', `experiment ${experiment.id} references arm ${arm_id}, which is gone`);
      for (const c of datasetBody.cases) {
        for (let r = 1; r <= body.repeats; r += 1) {
          items.push({
            case_key: c.case_key,
            arm_hash: armObj.hash,
            repetition: r,
            payload: { engine: datasetBody.engine, frozen: c.frozen, arm: armObj.body, budget_id: budget.id, arm_id },
          });
        }
      }
    }
    const { run, itemCount, deduplicated } = await submitRun(
      deps.db, deps.principal, 'experiment_run', experiment.id, budget.id,
      String(args.idempotency_key), hash({ experiment: experiment.id, items: items.length }),
      RUN_DEADLINE_MS, items,
    );
    return { run_id: run.id, item_count: itemCount, deduplicated };
  },

  // ── job lifecycle ─────────────────────────────────────────────────────────────────
  async run_status(deps, args) {
    const run = await getRun(deps.db, String(args.run_id));
    if (!run) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
    const state = await deriveRunState(deps.db, run.id);
    const counts = await countItemsByState(deps.db, run.id);
    const items = await itemsOf(deps.db, run.id);
    const tally = (field: 'execution_status' | 'assessment_status' | 'attribution_status') => {
      const out: Record<string, number> = {};
      for (const i of items) { const k = i[field] ?? 'not_set'; out[k] = (out[k] ?? 0) + 1; }
      return out;
    };
    const budget = await getBudget(deps.db, run.budget_id);
    return {
      run_id: run.id, state,
      created_at: new Date(run.created_at).toISOString(),
      deadline_at: new Date(run.deadline_at).toISOString(),
      items_by_state: counts,
      execution_status: tally('execution_status'),
      assessment_status: tally('assessment_status'),
      attribution_status: tally('attribution_status'),
      reserved_microusd: Number(budget?.reserved_microusd ?? 0),
      spent_microusd: Number(budget?.spent_microusd ?? 0),
      unknown_microusd: Number(budget?.unknown_microusd ?? 0),
    };
  },

  async run_result(deps, args) {
    const run = await getRun(deps.db, String(args.run_id));
    if (!run) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
    const limit = Number(args.limit ?? 20);
    const offset = Number(args.offset ?? 0);
    const all = await countItemsByState(deps.db, run.id);
    const total = Object.values(all).reduce((a, b) => a + b, 0);
    const items = await itemsOf(deps.db, run.id, limit, offset);
    return {
      run_id: run.id,
      total,
      items: items.map((i) => {
        const stored = (i.result ?? null) as { summary?: Record<string, unknown>; artifact_id?: string } | null;
        return {
          item_id: i.id, case_key: i.case_key, arm_hash: i.arm_hash, repetition: i.repetition,
          state: i.state,
          execution_status: i.execution_status as never,
          assessment_status: i.assessment_status as never,
          attribution_status: i.attribution_status as never,
          attempts: i.attempts,
          summary: stored?.summary ?? null,
          error: i.error,
          // Large bodies are returned as a resource, not inline (§8).
          artifact: stored?.artifact_id ? `lab://artifacts/${stored.artifact_id}` : null,
        };
      }),
    };
  },

  async run_cancel(deps, args) {
    const run = await getRun(deps.db, String(args.run_id));
    if (!run) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
    if (run.owner !== deps.principal) throw new LabError('OWNER_ONLY', 'a run may only be cancelled by its owner');
    const cancelled = await requestCancel(deps.db, run.id);
    const state = await deriveRunState(deps.db, run.id);
    return { run_id: run.id, state, cancelled_items: cancelled };
  },

  async budget_reconcile(deps, args) {
    // DECISION 42 — the reason is required by the schema, so a reconcile always carries an
    // account of itself. reconcileCall refuses a call that is not in `unknown`, so this cannot be
    // used to re-settle a settled call at a different number.
    const out = await reconcileCall(deps.db, String(args.call_id), Number(args.actual_microusd), String(args.reason), deps.principal);
    return { ...out, reason: String(args.reason) };
  },

  async run_retry(deps, args) {
    const run = await getRun(deps.db, String(args.run_id));
    if (!run) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
    if (run.owner !== deps.principal) throw new LabError('OWNER_ONLY', 'a run may only be retried by its owner');
    const requeued = await retryRun(deps.db, run.id);
    return { run_id: run.id, requeued };
  },
};

/**
 * Round A2 — the dispatch table both rounds share. The observation handlers take the same
 * (deps, args) shape, and `ServiceDeps` already carries the `db` and `principal` they need.
 */
/** Slice B round B1 (§17.4). Same shape; their schemas live beside them in tools/. */
const B1_HANDLERS: Record<string, Handler> = {
  async run_diff(deps, args) {
    return runDiff({ db: deps.db, principal: deps.principal }, args as never);
  },
  async experiment_compare(deps, args) {
    return experimentCompare({ db: deps.db, principal: deps.principal }, args as never);
  },
  async run_replay(deps, args) {
    return runReplay({ db: deps.db, principal: deps.principal }, args as never);
  },
};

/** Slice B round B2 (§17.5, decision 49). */
const B2_HANDLERS: Record<string, Handler> = {
  async episode_checkpoint_inspect(deps, args) {
    return episodeCheckpointInspect({ db: deps.db, principal: deps.principal }, args as never);
  },
  async episode_replay(deps, args) {
    return episodeReplay({ db: deps.db, principal: deps.principal }, args as never);
  },
};

/** Slice B round B3 (§17.6, decisions 58, 65, 67, 68). */
const B3_HANDLERS: Record<string, Handler> = {
  async coverage_report(_deps, args) {
    return coverageReport(args as never);
  },
  async drift_report(_deps, args) {
    return driftReport(args as never);
  },
  async retrieval_compare(_deps, args) {
    return retrievalCompare(args as never);
  },
  async reaudit_plan(deps, args) {
    return reauditPlan({ db: deps.db, principal: deps.principal }, args as never);
  },
  async reaudit_execute(deps, args) {
    return reauditExecute({ db: deps.db, principal: deps.principal }, args as never);
  },
  /**
   * §17.6 item 6 — report_export, full. It DELEGATES to A2's handler for everything A2 already
   * exported (that file is untouched this round), then attaches the B3 sections and rewrites the
   * artifact. The `include` list is explicit because coverage and drift are production reads and a
   * report should not make them behind the caller's back.
   */
  async report_export(deps, args) {
    const base = await (OBSERVATION_HANDLERS as unknown as Record<string, Handler>)
      .report_export(deps, { run_id: args.run_id }) as { artifact_id: string; run_id: string; caveat: string; summary: Record<string, unknown> };
    const include = new Set((args.include as string[] | undefined) ?? []);
    const artifact = await getObject(deps.db, base.artifact_id);
    const body = { ...(artifact?.body as Record<string, unknown> ?? {}) };
    const sections: string[] = ['run', 'experiment', 'dataset', 'arms', 'items', 'calls'];

    const run = await getRun(deps.db, String(args.run_id));
    const items = await itemsOf(deps.db, String(args.run_id), 1000, 0);

    // Replay verdicts — read off the items this run already carries, never by replaying again.
    if (include.has('replay')) {
      body.replay = items.map((i) => ({
        item_id: i.id, case_key: i.case_key, arm_hash: i.arm_hash, repetition: i.repetition,
        attribution_status: i.attribution_status,
        result_hash: (i.result as { result_hash?: string } | null)?.result_hash ?? null,
        replayed_from: (i.payload as { replay_from?: string })?.replay_from ?? null,
        equal: (i.result as { summary?: { equal?: boolean } } | null)?.summary?.equal ?? null,
      }));
      sections.push('replay');
    }
    // The plan and the per-case outcomes for a repair run.
    if (include.has('repair') && run?.operation === 'reaudit') {
      const planId = (items[0]?.payload as { plan_id?: string })?.plan_id ?? null;
      const plan = planId ? await getObject(deps.db, planId) : null;
      body.repair = {
        plan_id: planId,
        plan: plan?.body ?? null,
        cases: items.map((i) => ({
          case_key: i.case_key, state: i.state,
          outcome: (i.result as { summary?: { repair?: unknown } } | null)?.summary?.repair ?? null,
          error: i.error,
        })),
      };
      sections.push('repair');
    }
    const engine = ((items[0]?.payload as { engine?: string })?.engine ?? null) as 'ipd_episode' | 'opd_note_audit' | null;
    if (include.has('coverage') && (engine === 'ipd_episode' || engine === 'opd_note_audit')) {
      body.coverage = await coverageReport({ engine, days: 30 });
      sections.push('coverage');
    }
    if (include.has('drift') && (engine === 'ipd_episode' || engine === 'opd_note_audit')) {
      body.drift = await driftReport({ engine, weeks: 8 });
      sections.push('drift');
    }
    // §17.7 C3 item 3 — observation.ts adds these two to the body when they exist; `sections` must
    // name what the body actually carries or it is a list that lies about its own document.
    if (body.releases !== undefined) sections.push('releases');
    if (body.reviews !== undefined) sections.push('reviews');
    body.sections = sections;

    const { object } = await putObject(deps.db, deps.principal, 'report', body, 'deidentified', null);
    return { ...base, artifact_id: object.id, sections };
  },
};

/** Slice C round C1 (§17.7, decisions 77-83). */
const C1_HANDLERS: Record<string, Handler> = {
  async corpus_stage(deps, args) {
    return corpusStage(deps.db, deps.principal, args as never);
  },
  async corpus_validate(deps, args) {
    return corpusValidate(deps.db, args as never);
  },
  async corpus_diff(deps, args) {
    return corpusDiff(deps.db, args as never);
  },
  ...Object.fromEntries(Object.entries(RELEASE_HANDLERS).map(([name, fn]) => [
    name,
    ((deps: ServiceDeps, args: Record<string, unknown>) =>
      (fn as (d: { db: Db; principal: string }, a: Record<string, unknown>) => Promise<unknown>)(
        { db: deps.db, principal: deps.principal }, args,
      )) as Handler,
  ])),
};

/** Slice C round C2 (§17.7, decisions 82, 89, 90). */
const C2_HANDLERS: Record<string, Handler> = {
  async rule_propose(deps, args) {
    return rulePropose(deps.db, deps.principal, args as never);
  },
  async rule_simulate(deps, args) {
    return ruleSimulate(deps.db, deps.principal, args as never);
  },
};

/** Slice C round C3 (§17.7, decisions 96, 97). */
const C3_HANDLERS: Record<string, Handler> = {
  async failure_cluster(deps, args) {
    return failureCluster(deps.db, args as never);
  },
  async review_queue(deps, args) {
    return reviewQueue(deps.db, deps.principal, args as never);
  },
};

/**
 * Slice D round D3 (§17.11, decisions 141, 142, 146). The two case tools read PRODUCTION through
 * narrow statements and store nothing; `failure_minimize` is the only one of the three that runs
 * anything, and it runs the engine the failed run already ran, at that run's own arm.
 */
const D3_HANDLERS: Record<string, Handler> = {
  async case_ask(deps, args) {
    return caseAsk({ db: deps.db, principal: deps.principal }, args as never);
  },
  async case_timeline(deps, args) {
    return caseTimeline({ db: deps.db, principal: deps.principal }, args as never);
  },
  async failure_minimize(deps, args) {
    return failureMinimize({ db: deps.db, principal: deps.principal }, args as never);
  },
};

const ALL_HANDLERS: Record<string, Handler> = {
  ...HANDLERS,
  ...(OBSERVATION_HANDLERS as unknown as Record<string, Handler>),
  ...B1_HANDLERS,
  ...B2_HANDLERS,
  ...B3_HANDLERS,
  ...C1_HANDLERS,
  ...C2_HANDLERS,
  ...C3_HANDLERS,
  ...D3_HANDLERS,
};
