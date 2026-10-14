/**
 * lib/lab-v2/registry.ts — the fifteen round-1 tools and their metadata
 * (LAB-MCP-V2-PRD-v1.0 §8, §8.1).
 *
 * ONE REGISTRY, NOT A FLAT LIST. V1's failure mode was `LAB_TOOLS`: an array of name +
 * description + inputSchema with no permission, no side-effect class and no cost class,
 * so every caller saw every tool and authorisation was whatever each handler remembered
 * to check. Here each tool declares its scopes, its effect and its cost, the endpoint
 * filters `tools/list` by them, and `tools/call` re-checks on every invocation.
 *
 * MCP annotations are GENERATED from `effect` (§3.2.4), never hand-written per tool. They
 * describe a tool to a client; they authorise nothing. Deriving them mechanically is what
 * makes "every tool's effect matches its annotations" a property the test can assert
 * rather than a list someone has to keep in sync.
 */
import type { ZodTypeAny } from 'zod';
import {
  SCOPES, toolSchemas, type Classification, type CostClass, type Effect, type Scope, type ToolName,
} from './contracts';
// Round A2 (§17.2). The nine observation schemas live beside their handlers because the round's
// file contract does not list contracts.ts among the files it may edit.
import { OBSERVATION_SCHEMAS, type ObservationToolName } from './tools/observation';
// Slice B round B1 (§17.4). Same pattern: schemas beside their handlers.
import { COMPARE_SCHEMAS } from './tools/compare';
import { REPLAY_SCHEMAS } from './tools/replay';
// Slice B round B2 (§17.5, decision 49). Same pattern again: schemas beside their handlers.
import { EPISODE_SCHEMAS } from './tools/episode';
// Slice B round B3 (§17.6). Same pattern once more: schemas beside their handlers.
import { COVERAGE_SCHEMAS } from './tools/coverage';
import { DRIFT_SCHEMAS } from './tools/drift';
import { RETRIEVAL_COMPARE_SCHEMAS } from './tools/retrieval-compare';
import { REPAIR_SCHEMAS } from './tools/repair';
// Slice C round C1 (§17.7). Same pattern: schemas beside their handlers.
import { CORPUS_SCHEMAS } from './tools/corpus';
import { RELEASE_SCHEMAS } from './tools/release';
// Slice C round C2 (§17.7, decisions 82, 89, 90). Same pattern: schemas beside their handlers.
import { RULES_SCHEMAS } from './tools/rules';
// Slice C round C3 (§17.7, decisions 96, 97). Same pattern: schemas beside their handlers.
import { CLUSTER_SCHEMAS } from './tools/cluster';
import { QUEUE_SCHEMAS } from './tools/queue';
// Slice D round D3 (§17.11). Same pattern: schemas beside their handlers.
import { CASE_SCHEMAS } from './tools/case';
import { MINIMIZE_SCHEMAS } from './tools/minimize';

export interface ToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }

export interface ToolSpec {
  /** A round-1 name from contracts.ts, or a round-A2 name from tools/observation.ts. */
  name: ToolName | ObservationToolName;
  description: string;
  inputSchema: ZodTypeAny;
  outputSchema: ZodTypeAny;
  scopes: readonly Scope[];
  effect: Effect;
  classification: Classification;
  /**
   * §17.8 DECISION 105 — this tool may be sent an identifier that resolves to a person.
   *
   * ⚠️ IT IS A PROPERTY OF THE TOOL, NOT OF THE ENGINE, and the difference matters. `dataset_create`
   * is the one round-1 tool that takes a body, so it is the one that can carry a `dedup_key` or an
   * `episodeKey`; `run_status` on a readmission run carries none and stays open to every principal
   * that can read research. Marking the engine would have closed tools that never see an id.
   *
   * ⚠️ AND ABSENT MEANS FALSE, NOT UNKNOWN. Every tool declared before D1 is de-identified input by
   * construction — `freezeRequestCase` refuses an identifying key outright — so the default is the
   * safe one and a new tool has to say so deliberately.
   */
  identifying_input?: boolean;
  /**
   * §17.11 DECISION 146 — EVERY call to this tool carries an identifier, not merely some of them.
   *
   * `dataset_create` is `identifying_input` and the gate in `callTool` narrows it by the ENGINE the
   * call names, because seven of its ten engines take a de-identified body. `case_ask` and
   * `case_timeline` have no such case: their input IS a person. Without this flag the engine test
   * would pass a `case_ask` for one `individual_uid` through to the research key, because
   * `opd_note_audits` declares no identifying request field — the table has no name and no UHID.
   */
  identifying_always?: boolean;
  cost_class: CostClass;
  slice: string;
}

/** Visible to every principal: intersecting the full scope set always succeeds. */
const ANY: readonly Scope[] = SCOPES;

/**
 * §3.2.4 — annotations derived from effect, mechanically.
 * `idempotentHint` is true across round 1 because every writing tool is keyed by an
 * idempotency key or is a set-to-a-value operation (pause, cancel, retry): repeating one
 * converges rather than compounding. `destructiveHint` is false throughout because no
 * round-1 tool deletes or overwrites anything — cancel and retry move state forward and
 * leave the attempt history intact.
 */
export function annotationsFor(effect: Effect): ToolAnnotations {
  return {
    readOnlyHint: effect === 'read',
    destructiveHint: false,
    idempotentHint: true,
  };
}

const t = (
  name: ToolName, description: string, scopes: readonly Scope[], effect: Effect, cost_class: CostClass = 'free',
): ToolSpec => ({
  name,
  description,
  inputSchema: toolSchemas[name].input as unknown as ZodTypeAny,
  outputSchema: toolSchemas[name].output as unknown as ZodTypeAny,
  scopes,
  effect,
  // Slice A stores and returns only de-identified objects (§3.3). The research key can
  // never mint an identifying one, and round 1 has no tool that would return one.
  classification: 'deidentified',
  cost_class,
  slice: 'A-1',
});

/** Round A2's entries (§17.2). Same shape, schemas from the observation module. */
const o = (
  name: ObservationToolName, description: string, scopes: readonly Scope[],
): ToolSpec => ({
  name,
  description,
  inputSchema: OBSERVATION_SCHEMAS[name].input as unknown as ZodTypeAny,
  outputSchema: OBSERVATION_SCHEMAS[name].output as unknown as ZodTypeAny,
  scopes,
  effect: 'read',
  classification: 'deidentified',
  cost_class: 'free',
  slice: 'A-2',
});

/** Slice B round B1 entries. All free: compare and diff read, replay serves stored replies. */
const B1 = { ...COMPARE_SCHEMAS, ...REPLAY_SCHEMAS } as unknown as Record<string, { input: ZodTypeAny; output: ZodTypeAny }>;
const b = (
  name: string, description: string, scopes: readonly Scope[], effect: Effect,
): ToolSpec => ({
  name: name as ToolName,
  description,
  inputSchema: B1[name].input,
  outputSchema: B1[name].output,
  scopes,
  effect,
  classification: 'deidentified',
  cost_class: 'free',
  slice: 'B-1',
});

/** Slice B round B2 entries (§17.5). Both free: inspect reads the v2 store, replay serves steps. */
const B2 = EPISODE_SCHEMAS as unknown as Record<string, { input: ZodTypeAny; output: ZodTypeAny }>;
const b2 = (
  name: string, description: string, scopes: readonly Scope[], effect: Effect,
): ToolSpec => ({
  name: name as ToolName,
  description,
  inputSchema: B2[name].input,
  outputSchema: B2[name].output,
  scopes,
  effect,
  classification: 'deidentified',
  cost_class: 'free',
  slice: 'B-2',
});

/** Slice B round B3 entries (§17.6). Only `reaudit_execute` is metered — it runs an engine. */
const B3 = { ...COVERAGE_SCHEMAS, ...DRIFT_SCHEMAS, ...RETRIEVAL_COMPARE_SCHEMAS, ...REPAIR_SCHEMAS } as unknown as Record<string, { input: ZodTypeAny; output: ZodTypeAny }>;
const b3 = (
  name: string, description: string, scopes: readonly Scope[], effect: Effect, cost_class: CostClass = 'free',
): ToolSpec => ({
  name: name as ToolName,
  description,
  inputSchema: B3[name].input,
  outputSchema: B3[name].output,
  scopes,
  effect,
  classification: 'deidentified',
  cost_class,
  slice: 'B-3',
});

/**
 * Slice C round C1 entries (§17.7). All free: staging goes through v1's own ingest, the two reads
 * are reads, and an activation is an UPDATE — none of them calls a model.
 *
 * ⚠️ `release_apply` AND `release_rollback` ARE THE FIRST TOOLS IN THIS PLATFORM THAT CHANGE WHAT A
 * CLINICIAN'S RETRIEVAL RETURNS. They carry effect `release`, not `production_write`, because §3.2's
 * scope table gives the release key `release` alone — the separation from `production_write` is
 * what stops the operator key from shipping a corpus.
 */
const C1 = { ...CORPUS_SCHEMAS, ...RELEASE_SCHEMAS } as unknown as Record<string, { input: ZodTypeAny; output: ZodTypeAny }>;
const c1 = (
  name: string, description: string, scopes: readonly Scope[], effect: Effect,
): ToolSpec => ({
  name: name as ToolName,
  description,
  inputSchema: C1[name].input,
  outputSchema: C1[name].output,
  scopes,
  effect,
  classification: 'deidentified',
  cost_class: 'free',
  slice: 'C-1',
});

/**
 * Slice C round C2 entries (§17.7, decisions 82, 89, 90). Both free, and `rule_simulate` is free in
 * the strong sense: decision 82 measured that LVC rules never reach the model, so a simulation is an
 * exact replay against stored replies with the live transport wired to throw. `rule_propose` is
 * `research_write` and not `release` — it stages a row in `lvc_recommendation_proposals` and cannot
 * touch `lvc_recommendations`, which only `release_apply` reaches, holding the `release` scope.
 */
const C2 = { ...RULES_SCHEMAS } as unknown as Record<string, { input: ZodTypeAny; output: ZodTypeAny }>;
const c2 = (
  name: string, description: string, scopes: readonly Scope[], effect: Effect,
): ToolSpec => ({
  name: name as ToolName,
  description,
  inputSchema: C2[name].input,
  outputSchema: C2[name].output,
  scopes,
  effect,
  classification: 'deidentified',
  cost_class: 'free',
  slice: 'C-2',
});

/**
 * Slice C round C3 entries (§17.7, decisions 96 and 97). Both read `lab_v2` and nothing else — no
 * production table, no model — so both are `read` and both are free.
 *
 * ⚠️ THE SCOPES DIFFER AND THAT IS THE POINT. `failure_cluster` is `research_read`: it describes the
 * platform's own failures and every principal that can read research can see them. `review_queue` is
 * `review` ALONE — it is the reviewer key's work list, and putting it behind that scope is what stops
 * it from becoming a second, wider window onto what is pending.
 */
const C3 = { ...CLUSTER_SCHEMAS, ...QUEUE_SCHEMAS } as unknown as Record<string, { input: ZodTypeAny; output: ZodTypeAny }>;
const c3 = (
  name: string, description: string, scopes: readonly Scope[],
): ToolSpec => ({
  name: name as ToolName,
  description,
  inputSchema: C3[name].input,
  outputSchema: C3[name].output,
  scopes,
  effect: 'read',
  classification: 'deidentified',
  cost_class: 'free',
  slice: 'C-3',
});

/**
 * Slice D round D3 entries (§17.11, decisions 141, 142, 143, 146).
 *
 * ⚠️ ALL THREE ARE `research_write`-SCOPED AND THAT IS WHAT DECIDES WHO SEES THEM. `research_write`
 * is held by exactly `research` and `operator` (`contracts.ts:51-56`), which is the visibility
 * §17.11 pins: research 42, operator 45, reviewer 32, release 13. Scoping the two READS on
 * `production_read` instead would have shown them to the reviewer and the release keys as well —
 * two principals with no business resolving a person — because both hold that scope for
 * `system_health`.
 *
 * ⚠️ AND VISIBILITY IS NOT PERMISSION. Decision 146 requires `production_read` AND `data_scope:
 * identifying` to actually USE either case tool, and that gate is `mayUseIdentifyingInput`
 * (`lib/mcp-v2/auth.ts:114-115`) in `callTool`, not this list. The research key SEES `case_ask` and
 * is refused `CLASSIFICATION_REQUIRED` by name the moment it calls it — which is the honest
 * ordering: a caller should be able to discover a tool exists and be told why it may not use it.
 */
const D3 = { ...CASE_SCHEMAS, ...MINIMIZE_SCHEMAS } as unknown as Record<string, { input: ZodTypeAny; output: ZodTypeAny }>;
const d3 = (
  name: string, description: string, effect: Effect, cost_class: CostClass = 'free',
): ToolSpec => ({
  name: name as ToolName,
  description,
  inputSchema: D3[name].input,
  outputSchema: D3[name].output,
  scopes: ['research_write'],
  effect,
  classification: 'deidentified',
  cost_class,
  slice: 'D-3',
});

export const REGISTRY: readonly ToolSpec[] = [
  // ── capability discovery ──────────────────────────────────────────────────────────
  t('system_capabilities', 'List the tools this principal can see, the negotiated MCP protocol version, the SDK version, whether LAB_V2_ENABLED is set, and the pricing table version.', ANY, 'read'),
  t('engine_describe', 'Describe one engine: whether it is supported in this round, its stages, its engine version on main, its frozen inputs, and the replay exactness available for it.', ANY, 'read'),
  t('model_capabilities', 'Per provider: whether it is configured, when it was last health-tested, and which models are priced and supported. There is no fallback ladder in v2.', ANY, 'read'),
  // ── operational health ────────────────────────────────────────────────────────────
  t('system_health', 'v2 store reachability, migrations applied, worker pause state, queue depth by state, oldest queued age, reaps in the last 24h and calls by state in the last 24h.', ['production_read'], 'read'),
  t('worker_status', 'The worker row, its active item and its last heartbeat.', ['production_read'], 'read'),
  t('worker_control', 'Pause or resume the tick worker. Pausing stops new claims; items already running finish.', ['production_write'], 'production_write'),
  // ── datasets ──────────────────────────────────────────────────────────────────────
  {
    /**
     * §17.8 DECISION 105 — the one round-1 tool that takes a request body, and therefore the one
     * that can be handed an identifier. Marked here rather than in `t()` because it is the only
     * entry that needs it, and a fourth parameter on `t()` used once would be a parameter every
     * future reader has to check the value of on fifteen calls.
     */
    ...t('dataset_create', 'Freeze one case and its inputs into an immutable, hashed, de-identified dataset object. For the Slice D engines the identifying input (a dedup_key, an episodeKey) is used to READ the case and is never stored: the object carries a salted member_key and no id column (decisions 99 and 104), and the tool is open only to a principal with data_scope identifying.', ['research_write'], 'research_write'),
    identifying_input: true,
  },
  t('dataset_preview', 'Dataset metadata and case keys. Never the frozen clinical text.', ['research_read'], 'read'),
  t('dataset_validate', 'Re-read each case from its live source and report whether the frozen inputs still match.', ['research_read'], 'read'),
  // ── experiments ───────────────────────────────────────────────────────────────────
  t('experiment_create', 'Store the arm objects and the experiment object. Refuses an unsupported (provider, model), a stage with no max_cost_microusd, and a dataset_hash that does not match.', ['research_write'], 'research_write'),
  t('experiment_run', 'Submit an experiment. Persists the run and its items, then returns a run id before any model work begins.', ['research_write'], 'research_write', 'metered'),
  // ── job lifecycle ─────────────────────────────────────────────────────────────────
  t('run_status', 'Run state, item counts by state and by each of the three result statuses, and the run budget in microusd.', ['research_read'], 'read'),
  t('run_result', 'Paginated items with bounded result summaries. The full result of each item is addressable as an artifact resource.', ['research_read'], 'read'),
  t('run_cancel', 'Request cancellation. Queued items cancel at once; a running item is signalled at its next heartbeat. Owner only.', ['research_write'], 'research_write'),
  t('run_retry', 'Re-queue the failed and expired items of a run as new attempts on the same item ids. Never re-runs a succeeded item. Owner only.', ['research_write'], 'research_write', 'metered'),

  // ── round A2: observation (§17.2). All nine are read-only and free. ────────────────
  o('source_freshness', 'For each source the platform reads — the db13 OPD note table, opd_note_audits, ipd_episode_audits, mksap_chunks and the v2 call ledger — the newest row time and the row count in the last 24 hours. Each source fails independently.', ['production_read']),
  o('audit_search', 'Search opd_note_audits by a filter schema, never SQL: engine version, doctor uid, band, note date range, LVC category, verdict and a minimum finding count. Returns scores and finding subjects. Never note text.', ['research_read']),
  o('audit_aggregate', 'Aggregate the same filter by engine_version, doctor_uid, band, lvc_category or note_month, over count, average note-quality index, average completeness, summed findings or summed low-value findings. Metrics are computed per audit.', ['research_read']),
  o('case_snapshot', 'For one OPD note uid: its current audit row, the v2 datasets that froze that uid, and the runs that consumed them.', ['research_read']),
  o('audit_explain', 'For one OPD uid and one finding index: the finding with its rule reference, LVC category, signal type and source, and every citation id resolved against the corpus. Unresolvable ids are listed, never dropped.', ['research_read']),
  o('retrieval_inspect', 'Run the production retrieval CANDIDATE stage for a query — embedding and lexical, never the reranker and never query expansion, so the tool makes no chat model call. Returns the candidates with scores and the pool sizes.', ['research_read']),
  o('citation_check', 'Structural citation check: for each citation id, whether the chunk exists, whether it is active, and whether it appears in the sources of the named run or audit. No model.', ['research_read']),
  o('corpus_search', 'Lexical search over the corpus by text, optionally narrowed by book, source or active state. Returns bounded previews and the quarantine prefix where one applies.', ['research_read']),
  o('report_export', 'Write one evidence-pack artifact for a run: the experiment, dataset metadata without frozen text, the arms, every item with its three statuses, the call ledger, the replay exactness, and a fixed caveat about single-run sampling.', ['research_read']),

  // ── Slice B round B1 (§17.4) ──────────────────────────────────────────────────────
  b('run_diff', 'Compare two runs case by case: the three statuses on each side, finding subjects added and removed, note-quality index and band before and after, and whether the result hashes match.', ['research_read'], 'read'),
  b('experiment_compare', 'Compare each arm against the baseline on paired cases: differences in findings, low-value findings, note-quality index and subject overlap, with member-clustered bootstrap intervals. Every denominator is counted separately and the metric denominator is named.', ['research_read'], 'read'),
  b('run_replay', 'Re-run a run against its stored model replies and report, per item, whether the result hash is unchanged. Zero model calls and zero cost; a stage whose request no longer matches is refused as REPLAY_DIVERGED.', ['research_write'], 'research_write'),
  {
    // Its schema lives in contracts.ts with round 1's, but it is a Slice B tool and says so.
    name: 'budget_reconcile',
    description: 'Move one call from unknown to settled at a stated amount, with a required reason. The only way money leaves the unknown bucket; nothing moves on its own.',
    inputSchema: toolSchemas.budget_reconcile.input as unknown as ZodTypeAny,
    outputSchema: toolSchemas.budget_reconcile.output as unknown as ZodTypeAny,
    scopes: ['production_write'],
    effect: 'production_write',
    classification: 'deidentified',
    cost_class: 'free',
    slice: 'B-1',
  },

  // ── Slice B round B2 (§17.5, decision 49) ─────────────────────────────────────────
  b2('episode_checkpoint_inspect', 'For one IPD episode case or one replayed item: per checkpoint, the blinded input and its cut-off, what was expected by section and how much of it was cited, the events that fell inside the window by type, the retrieval that grounded it, the caps that could have bitten, and the arithmetic. Reads the v2 store only — never db13.', ['research_read'], 'read'),
  b2('episode_replay', 'run_replay for an ipd_episode run: re-runs each episode through lib/ipd-episode/compute.ts against its frozen course and its stored judge replies, and reports per item whether the result hash is unchanged. Zero model calls. Refuses a run of any other engine.', ['research_write'], 'research_write'),

  // ── Slice B round B3 (§17.6, decisions 58, 65, 67, 68) ────────────────────────────
  b3('coverage_report', 'Per engine, per day for up to 90 days: examined, qualifying, audited and skipped, with the skip breakdown by reason and THE QUALIFYING DEFINITION IN WORDS. Reads ipd_episode_audits, ipd_episode_skips and opd_note_audits.', ['production_read'], 'read'),
  b3('drift_report', 'Per engine version, per week: distributions of n_findings and the score, the band histogram, the IPD retrieval_offtopic rate, and a week-over-week delta against the same version. Carries a caveat that a delta is a reason to look, never a result.', ['production_read'], 'read'),
  b3('retrieval_compare', 'Two candidate configurations (k, bm25 on or off, embedding on or off) or two corpus snapshots (by maximum chunk id) over the same queries: overlap at k, Spearman rank correlation and timings. No reranker, no chat model, one embedding per query shared by both sides.', ['research_read'], 'read'),
  b3('reaudit_plan', 'Plan a repair: the exact case keys, each one\u2019s current engine version and why it qualifies, the expected writes, an estimated budget, the writer the repair will call, and a source_snapshot_hash that makes the plan refusable once its rows move.', ['production_read'], 'read'),
  b3('reaudit_execute', 'Run the first N cases of a plan (default 5, max 20) through the engine and write each result with the ENGINE\u2019S OWN store writer \u2014 a new row, never an UPDATE. Stops at N; continuing needs review_passed with a reason, stored as an event. Refuses PLAN_STALE. Submits a job and returns; the cron does the work.', ['production_write'], 'production_write', 'metered'),

  // ── Slice C round C1 (§17.7, decisions 77-83) ─────────────────────────────────────
  c1('corpus_stage', 'Pin a quarantined corpus batch as a staged set: optionally add new text through v1\u2019s own corpus_add path, then record the exact chunk ids under labq:<label> at this moment. The staged set is what a release is prepared against, and the id list is what makes the later activation checkable.', ['research_write'], 'research_write'),
  c1('corpus_validate', 'Check a staged batch before anyone reviews it: every chunk parses and is long enough, has an embedding and a tsvector, carries book, chapter and source, and is still quarantined. The near-duplicate check needs pg_trgm; where the extension is absent it reports SKIPPED with the reason and never passed.', ['research_read'], 'read'),
  c1('corpus_diff', 'The staged batch against the servable corpus: counts, book and chapter overlap, and an impact estimate \u2014 production\u2019s own candidate legs run twice over the same pinned max_chunk_id, once without the batch and once with it admitted through retrieval\u2019s named-quarantine seam, on a frozen cohort\u2019s freeze queries. Zero model calls.', ['research_read'], 'read'),
  c1('release_prepare', 'Produce the immutable, hashed release artifact: the target, the label, the exact chunk ids, the predecessor state and its hash, an impact reference, and the revision the target was at. Says in words what apply will do and what a rollback would undo.', ['release'], 'release'),
  c1('review_submit', 'Approve or reject a release. The approval binds the decision, the reviewer PRINCIPAL, the artifact hash and the release id, and expires after seven days. A rationale is required. The preparer principal may not review its own release.', ['review'], 'review'),
  c1('release_apply', 'Apply an approved release: check the approval is present, unexpired, on this exact artifact hash and not from the preparer; re-read the staged ids and refuse if they moved; compare-and-swap the target revision; then call v1\u2019s own activation and verify it moved exactly the reviewed set. Idempotent \u2014 a second apply returns the first receipt.', ['release'], 'release'),
  c1('release_status', 'Per target: the revision in force, its artifact, and its predecessor. Plus the last receipts and every prepared release that has not been applied, each with WHY it is still waiting \u2014 unreviewed, rejected, expired, or bound to a superseded hash.', ['production_read'], 'read'),
  c1('release_rollback', 'Return exactly the chunk ids the apply receipt recorded to quarantine and record a new activation with the predecessor as the artifact in force. It does not delete audits, rewrite findings or revoke human actions, and the receipt says so.', ['release'], 'release'),

  // ── Slice C round C2 (§17.7, decisions 82, 89, 90) ────────────────────────────────
  c2('rule_propose', 'Stage an LVC rule through v1\u2019s own lvc_propose path \u2014 its citation gate and its mandatory duplicate check, refusals passed through in v1\u2019s words \u2014 and record the proposal id and a hash over the statement and its citation as the staged set a release is prepared against. lvc_recommendations is never touched.', ['research_write'], 'research_write'),
  c2('rule_simulate', 'Replay a frozen OPD cohort\u2019s baseline run against its stored model replies with the proposed rule added to the frozen lvc_rules, and report per case which findings\u2019 rule_ref or lvc_category moved. Zero model calls: decision 82 measured that a rule cannot reach the prompt, so this is the same computation, not an approximation. Names its denominator and says in words that it measures stamps and never a score.', ['research_read'], 'read'),

  // ── Slice C round C3 (§17.7, decisions 96, 97) ────────────────────────────────────
  c3('failure_cluster', 'Group the window\u2019s failed, unassessable and unattributable items by engine, the stage of their last model call, their error category and the first line of their error message. Reports item and run counts, first and last seen, three examples per group, and counts the items that carry NO error object rather than dropping them. Reads lab_v2 only; zero model calls.', ['research_read']),
  // ── Slice D round D3 (§17.11, decisions 141, 142, 146) ───────────────────────────
  {
    ...d3('case_ask', 'For one person, named by a uhid, a member_id or an individual_uid: what one engine\u2019s newest stored audit concluded \u2014 its engine version, when it was audited, its finding subjects with verdicts and citation ids, and its scores. Every column is named; no free-text column is selected and no identifier is returned, only a salted member_key. Makes NO model call: a `question` is refused INVALID_INPUT in D3.', 'read'),
    identifying_input: true,
    identifying_always: true,
  },
  {
    ...d3('case_timeline', 'Every stored audit this platform holds for one person, sorted newest first: readmission and preop for a uhid, IPD discharge audits plus their episode_states projections for a member_id, OPD note audits for an individual_uid. An episode_state contributes its fact count and day span, computed inside the row \u2014 never its verbatim course summary. Keyed by member_key; no identifier is returned. Zero model calls.', 'read'),
    identifying_input: true,
    identifying_always: true,
  },
  d3('failure_minimize', 'Bisect a failure_cluster group down to the smallest set of cases that still reproduces it: at most eight of the group\u2019s cases from the failed run\u2019s own dataset, re-run at that run\u2019s own arm, halved while the same error category at the same last stage keeps appearing. Reports the minimal case keys, every step with its run id, and the spend. budget_cap_microusd is required and a step is refused BEFORE it runs when the arm\u2019s own declared ceilings would breach it.', 'research_write', 'metered'),

  c3('review_queue', 'The reviewer\u2019s two lists: releases prepared and not applied, each with its impact reference and release_status\u2019s own word for why it waits; and the cases whose band moved in a stored experiment_compare, with both arm hashes. The band rows are re-derived from the run items each compare was computed over and each compare reports whether that matched its stored count. Cases are listed, never scored.', ['review']),
];

export const BY_NAME: Record<string, ToolSpec> = Object.fromEntries(REGISTRY.map((s) => [s.name, s]));

/** §3.2.1 — a tool is visible when its scopes intersect the principal's. */
export function visibleTools(principalScopes: readonly Scope[]): ToolSpec[] {
  return REGISTRY.filter((spec) => spec.scopes.some((s) => principalScopes.includes(s)));
}

export function isVisible(spec: ToolSpec, principalScopes: readonly Scope[]): boolean {
  return spec.scopes.some((s) => principalScopes.includes(s));
}
