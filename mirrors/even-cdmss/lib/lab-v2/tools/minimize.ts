/**
 * lib/lab-v2/tools/minimize.ts — `failure_minimize` (§17.11 item 6, decisions 131 and 142).
 *
 * WHAT IT ANSWERS. `failure_cluster` says "these eleven items failed the same way". The next
 * question a person asks is "which of them do I actually need in order to see it again", and until
 * now the only way to answer it was to re-run the whole run and read the wreckage. This tool
 * bisects: it re-runs the group's example cases, keeps halving the set while the failure still
 * reproduces, and reports the smallest set that still does — with the run ids, the steps and the
 * spend, so the answer is checkable rather than asserted.
 *
 * ⚠️ IT MINIMIZES OVER CASES, NOT OVER STAGES. Decision 142 settles that: a stage is not something
 * this platform can switch off per item — an arm prices every stage or the gateway refuses the
 * item by name — so "the smallest input that still fails" is a set of cases. Decision 131's cap is
 * the reason the search is bounded at all: at most 8 cases, every stage of the engine, metered
 * through the arm.
 *
 * ⚠️ "REPRODUCES" IS A NARROW WORD HERE AND IT IS THE WHOLE ANSWER'S MEANING: an item failed with
 * the SAME error category AND the same stage of last model call as the group key. A different
 * category at the same stage is a different fault that happens to live nearby, and counting it
 * would let the bisection converge on a case that never had the problem.
 *
 * ⚠️ THE DATASET IS THE SOURCE RUN'S OWN CASES, RE-USED, NOT RE-FROZEN. Decision 142 says "one
 * dataset from their case keys"; the source run's dataset already holds exactly those cases, with
 * their `member_key`, their `snapshot_policy` and their `replay_exactness`. Re-freezing from a
 * case key is impossible anyway — a Slice D case key is a salted hash of an identifier this
 * platform deliberately did not keep — and re-freezing from production would change the inputs,
 * which is the one thing a minimisation must not do.
 *
 * ⚠️ THE BUDGET CAP IS CHECKED BEFORE EACH STEP AND THE REFUSAL IS THE ANSWER. Decision 131 makes
 * `budget_cap_microusd` required. The estimate is the arm's own declared ceiling — every stage's
 * `max_cost_microusd` summed, times the cases in the step — so a step is refused when the WORST
 * case would breach the cap, never when the average might. A tool that discovered the cap by
 * spending past it would be worse than useless.
 *
 * ⚠️ ZERO MODEL CALLS WHERE THE DATASET REPLAYS. An `ipd_discharge` case frozen by D2c carries its
 * six analyze-family legs, so a step over it prices only the two live stages; an `ipd_episode`
 * case serves every stage from its stored replies and prices nothing. The spend reported is the
 * budget's own movement, not an estimate, so those cases show up as the zero they are.
 */
import { z } from 'zod';
import type { Db } from '../db';
import {
  LabError, RUN_DEADLINE_MS, RUN_STATES, armBodySchema, datasetBodySchema, experimentBodySchema,
  hash, minimizeBodySchema, type MinimizeBody,
} from '../contracts';
import {
  deriveRunState, ensureBudget, getBudget, getObject, getRun, itemsOf, putObject, submitRun,
} from '../store';
import { messageHead } from './cluster';

/** Decision 131 — at most eight cases reach a first step, whatever the group holds. */
export const MAX_MINIMIZE_CASES = 8;

/** A guard on the loop itself: eight cases bisect in at most four halvings plus the first run. */
export const MAX_MINIMIZE_STEPS = 8;

export const MINIMIZE_SCHEMAS = {
  failure_minimize: {
    input: z.object({
      /** `failure_cluster`'s own group key, verbatim. */
      group_key: z.object({
        engine: z.string().nullable(),
        stage: z.string().nullable(),
        category: z.string().nullable(),
        message_head: z.string().nullable(),
      }),
      run_id: z.string().uuid(),
      /** Decision 131 — required, never defaulted. */
      budget_cap_microusd: z.number().int().positive(),
      idempotency_key: z.string().min(1),
    }),
    /**
     * §17.11 decision 150 — TWO SHAPES, because a resumable search has two things to say. While a
     * step is on the queue the answer is a pointer; when the search ends it is the full report.
     * A union rather than one schema with everything nullable: a caller can tell which it has by
     * reading `state`, and cannot mistake an empty `minimal_case_keys` for "nothing reproduced".
     */
    output: z.union([z.object({
      minimize_id: z.string().uuid(),
      state: z.literal('running'),
      step: z.number().int().positive(),
      run_id: z.string().uuid().nullable(),
      run_state: z.string(),
      case_keys: z.array(z.string()),
      spend_microusd: z.number().int(),
      note: z.string(),
    }), z.object({
      minimize_id: z.string().uuid(),
      state: z.enum(['done', 'stopped']),
      source_run_id: z.string().uuid(),
      group_key: z.object({
        engine: z.string().nullable(), stage: z.string().nullable(),
        category: z.string().nullable(), message_head: z.string().nullable(),
      }),
      /** What the group offered in this run, before decision 131's cap. */
      candidates: z.number().int(),
      /** The case keys the first step ran over — at most eight. */
      started_with: z.array(z.string()),
      /** The smallest set that still reproduced the group. Empty when nothing did. */
      minimal_case_keys: z.array(z.string()),
      reproducing_run_ids: z.array(z.string().uuid()),
      steps: z.array(z.object({
        step: z.number().int(),
        case_keys: z.array(z.string()),
        run_id: z.string().uuid().nullable(),
        run_state: z.enum([...RUN_STATES, 'refused'] as [string, ...string[]]),
        reproduced: z.boolean(),
        matching_items: z.number().int(),
        estimated_microusd: z.number().int(),
        spent_microusd: z.number().int(),
        note: z.string().nullable(),
      })),
      spend_microusd: z.number().int(),
      budget_cap_microusd: z.number().int(),
      /** Why the search ended: 'minimal', 'not_reproduced', 'budget_cap' or 'step_cap'. */
      stopped: z.enum(['minimal', 'not_reproduced', 'budget_cap', 'step_cap']),
      caveat: z.string(),
    })]),
  },
} as const;

export const MINIMIZE_CAVEAT =
  'A minimal set is the smallest of the sets this search actually ran, not the smallest that '
  + 'exists: the bisection halves and never re-combines, so two cases that fail only together are '
  + 'reported as the pair they are and a third that would also do it is not searched for. '
  + 'Reproduction means the same error category at the same stage of last model call — the group '
  + 'key, not the message.';

/**
 * ⚠️ NO TRANSPORT AND NO ADAPTER SEAM ANY MORE — decision 150 removed both, and their absence is
 * the point. This tool no longer executes anything: it submits a run and reads what the tick did.
 * A caller that needs a step to finish turns the worker, exactly as every other queued operation
 * on this platform does.
 */
export interface MinimizeDeps {
  db: Db;
  principal: string;
}

interface Candidate { case_key: string; last_stage: string | null; category: string | null; head: string | null }

/** The stage of an item's last model call — `failure_cluster`'s own definition, one item at a time. */
const LAST_STAGE_SQL = `SELECT c.stage FROM lab_v2.calls c WHERE c.item_id = $1
 ORDER BY c.created_at DESC, c.lease_token DESC LIMIT 1`;

/**
 * What one step's run actually cost, attributed to THAT RUN rather than to the budget.
 *
 * ⚠️ THIS REPLACES A BUDGET DELTA AND IT HAD TO. The inline version measured spend as the budget's
 * own movement between the start and the end of the call, which was exact while the whole search
 * lived inside one request and nothing else could touch the budget meanwhile. A resumable search
 * has minutes between its calls, the budget is shared by name, and any other tool spending against
 * it in that gap would be billed to this minimisation. Summing the run's own settled calls is the
 * same money, attributed to the thing that spent it.
 *
 * `reserved_microusd` covers a call that has left but not yet settled, which is the same
 * conservative direction the budget's own invariant takes.
 */
const STEP_SPEND_SQL = `SELECT COALESCE(SUM(COALESCE(c.actual_microusd, c.reserved_microusd)), 0)::text AS spent
 FROM lab_v2.calls c JOIN lab_v2.items i ON i.id = c.item_id WHERE i.run_id = $1`;

function sameGroup(c: Candidate, k: { engine: string | null; stage: string | null; category: string | null; message_head: string | null }): boolean {
  return c.last_stage === k.stage && c.category === k.category && c.head === k.message_head;
}

/** Version N of a search is one object, addressed by the caller's key plus that N. */
const minimizeIdemKey = (idempotencyKey: string, version: number) => `${idempotencyKey}:minimize:${version}`;

/**
 * The newest version of a search, or null if it has never run.
 *
 * One query over every key a search could ever have written — the step cap bounds it at
 * `MAX_MINIMIZE_STEPS + 1` versions — rather than an ORDER BY on `created_at`, because several
 * versions can be written inside one transaction and `now()` does not move inside one.
 */
async function loadNewest(db: Db, owner: string, idempotencyKey: string):
Promise<{ id: string; version: number; body: MinimizeBody } | null> {
  const keys: string[] = [];
  for (let v = 1; v <= MAX_MINIMIZE_STEPS + 1; v += 1) keys.push(minimizeIdemKey(idempotencyKey, v));
  const rows = await db.query<{ id: string; body: Record<string, unknown>; idempotency_key: string }>(
    `SELECT id, body, idempotency_key FROM lab_v2.objects
     WHERE owner = $1 AND kind = 'minimize' AND idempotency_key = ANY($2::text[])`,
    [owner, keys],
  );
  if (!rows.length) return null;
  let best: { id: string; version: number; body: MinimizeBody } | null = null;
  for (const r of rows) {
    const version = Number(String(r.idempotency_key).split(':').pop());
    if (!Number.isFinite(version)) continue;
    if (!best || version > best.version) best = { id: r.id, version, body: minimizeBodySchema.parse(r.body) };
  }
  return best;
}

/**
 * THE BISECTION, AS A PURE FUNCTION OF THE STEPS ALREADY SETTLED.
 *
 * ⚠️ WHY A REDUCER RATHER THAN A CURSOR IN THE BODY. The old loop held `current` in a local
 * variable, which a resumable search cannot do. It could have been stored, but then the object
 * would carry a claim about where the search is that nothing checks — and a wrong cursor would
 * silently minimise to the wrong set. Replaying the halving from the recorded steps makes the
 * position a CONSEQUENCE of the record instead of a second copy of it: if the steps say what they
 * say, there is exactly one place the search can be. The halving is character-for-character the
 * one the inline version ran, so the path over a given group is unchanged.
 */
export function nextMove(started: string[], steps: { case_keys: string[]; reproduced: boolean }[]):
{ kind: 'run'; case_keys: string[] } | { kind: 'end'; minimal: string[]; reason: 'minimal' | 'not_reproduced' | 'step_cap' } {
  if (!steps.length) return { kind: 'run', case_keys: started };
  if (!steps[0].reproduced) return { kind: 'end', minimal: [], reason: 'not_reproduced' };

  let current = started;
  let i = 1;
  const ask = (caseKeys: string[]): { kind: 'run'; case_keys: string[] } | { kind: 'end'; minimal: string[]; reason: 'step_cap' } | null => {
    if (i >= steps.length) {
      if (steps.length >= MAX_MINIMIZE_STEPS) return { kind: 'end', minimal: current, reason: 'step_cap' };
      return { kind: 'run', case_keys: caseKeys };
    }
    return null;
  };

  while (current.length > 1) {
    const mid = Math.ceil(current.length / 2);
    const left = current.slice(0, mid);
    const right = current.slice(mid);

    const needLeft = ask(left);
    if (needLeft) return needLeft;
    const l = steps[i]; i += 1;
    if (l.reproduced) { current = left; continue; }

    const needRight = ask(right);
    if (needRight) return needRight;
    const r = steps[i]; i += 1;
    if (r.reproduced) { current = right; continue; }

    // Neither half alone does it: the current set is minimal for this search. See the caveat.
    break;
  }
  return { kind: 'end', minimal: current, reason: 'minimal' };
}

/** Everything the source run fixes about a search, re-read on every call because objects are immutable. */
interface SourceFacts {
  source: Awaited<ReturnType<typeof getRun>> & object;
  candidates: Candidate[];
  started: string[];
  armHash: string;
  armId: string;
  armBody: Record<string, unknown>;
  perCase: number;
  sourceDataset: ReturnType<typeof datasetBodySchema.parse>;
  datasetObjId: string;
  budgetName: string;
  budgetId: string;
}

async function readSource(db: Db, principal: string, args: {
  group_key: { engine: string | null; stage: string | null; category: string | null; message_head: string | null };
  run_id: string; budget_cap_microusd: number;
}): Promise<SourceFacts> {
  const key = args.group_key;
  const source = await getRun(db, args.run_id);
  if (!source) throw new LabError('NOT_FOUND', `no run ${args.run_id}`);
  if (source.owner !== principal) throw new LabError('OWNER_ONLY', 'a run may only be minimised by its owner');

  const sourceItems = await itemsOf(db, source.id, 1000, 0);
  if (!sourceItems.length) throw new LabError('INVALID_INPUT', `run ${source.id} has no items`);

  // ── which of this run's items belong to the group ────────────────────────────────
  const candidates: Candidate[] = [];
  for (const i of sourceItems) {
    const failed = i.execution_status === 'failed' || i.assessment_status === 'unassessable' || i.attribution_status === 'invalid';
    if (!failed) continue;
    const engine = (i.payload as { engine?: string })?.engine ?? null;
    if (key.engine != null && engine !== key.engine) continue;
    const err = (i.error ?? null) as { category?: unknown; message?: unknown } | null;
    const stageRows = await db.query<{ stage: string }>(LAST_STAGE_SQL, [i.id]).catch(() => []);
    const c: Candidate = {
      case_key: i.case_key,
      last_stage: stageRows[0]?.stage ?? null,
      category: err?.category == null ? null : String(err.category),
      head: messageHead(err?.message),
    };
    if (sameGroup(c, key)) candidates.push(c);
  }
  if (!candidates.length) {
    throw new LabError('NOT_FOUND',
      `run ${source.id} holds no failed item in that group (engine ${key.engine ?? 'any'}, stage `
      + `${key.stage ?? 'none'}, category ${key.category ?? 'none'}). A group key and a run id have `
      + 'to come from the same failure_cluster report.');
  }

  // ── the arm and the dataset the source run used ──────────────────────────────────
  const armHash = sourceItems[0].arm_hash;
  const armRows = await db.query<{ id: string; body: Record<string, unknown> }>(
    `SELECT id, body FROM lab_v2.objects WHERE kind = 'arm' AND hash = $1 LIMIT 1`, [armHash],
  );
  if (!armRows.length) {
    throw new LabError('NOT_FOUND',
      `the arm this run was executed with (hash ${String(armHash).slice(0, 12)}…) is no longer in the `
      + 'store, so its failure cannot be reproduced at the same model. Decision 142 minimises with '
      + "the FAILED RUN'S arm and will not substitute another.");
  }
  const arm = armBodySchema.parse(armRows[0].body);

  const experimentObj = source.experiment_id ? await getObject(db, source.experiment_id) : null;
  if (!experimentObj || experimentObj.kind !== 'experiment') {
    throw new LabError('INVALID_INPUT',
      `run ${source.id} was not an experiment run, so it has no dataset to take cases from`);
  }
  const sourceExperiment = experimentBodySchema.parse(experimentObj.body);
  const datasetObj = await getObject(db, sourceExperiment.dataset_id);
  if (!datasetObj) throw new LabError('NOT_FOUND', `experiment ${experimentObj.id} references a dataset that is gone`);
  const sourceDataset = datasetBodySchema.parse(datasetObj.body);
  const caseByKey = new Map(sourceDataset.cases.map((c) => [c.case_key, c]));

  // Decision 131's cap, applied to the group's own cases in the order the run holds them.
  const started = candidates.map((c) => c.case_key).filter((k) => caseByKey.has(k)).slice(0, MAX_MINIMIZE_CASES);
  if (!started.length) {
    throw new LabError('INVALID_INPUT',
      "the group's failed cases are not in this run's dataset any more, so there is nothing to re-run");
  }

  /**
   * The worst-case cost of one step, from the arm's OWN declared ceilings. Every stage is priced
   * (`experiment_create` refuses an arm that leaves one unbounded), so this is an upper bound the
   * gateway itself enforces per call, not an estimate of what a model usually charges.
   */
  const perCase = Object.values(arm.stages).reduce((sum, st) => sum + Number(st.max_cost_microusd ?? 0), 0);
  const budget = await ensureBudget(db, principal, sourceExperiment.budget_name, args.budget_cap_microusd);

  return {
    source: source as SourceFacts['source'],
    candidates,
    started,
    armHash: String(armHash),
    armId: armRows[0].id,
    armBody: armRows[0].body,
    perCase,
    sourceDataset,
    datasetObjId: datasetObj.id,
    budgetName: sourceExperiment.budget_name,
    budgetId: budget.id,
  };
}

/** Submit one step's run, or refuse it before it exists. Never drives the queue: the tick does. */
async function submitStep(
  db: Db, principal: string, facts: SourceFacts, idempotencyKey: string, capMicrousd: number,
  stepNo: number, caseKeys: string[],
): Promise<{ runId: string | null; estimate: number; note: string | null }> {
  const estimate = facts.perCase * caseKeys.length;

  // Decision 131 — checked BEFORE the step, against the worst case the arm itself declares.
  const now = await getBudget(db, facts.budgetId);
  const spentNow = Number(now?.spent_microusd ?? 0) + Number(now?.unknown_microusd ?? 0) + Number(now?.reserved_microusd ?? 0);
  if (spentNow + estimate > capMicrousd) {
    return {
      runId: null,
      estimate,
      note: `refused before the step: ${spentNow} microusd already committed plus this step's worst `
        + `case ${estimate} would exceed the cap of ${capMicrousd}`,
    };
  }

  const caseByKey = new Map(facts.sourceDataset.cases.map((c) => [c.case_key, c]));
  const body = datasetBodySchema.parse({
    ...facts.sourceDataset,
    cases: caseKeys.map((k) => caseByKey.get(k)!),
    source_versions: {
      ...facts.sourceDataset.source_versions,
      minimized_from_dataset: facts.datasetObjId,
      minimized_from_run: facts.source.id,
      step: stepNo,
    },
  });
  const { object: dataset } = await putObject(db, principal, 'dataset', body, 'deidentified',
    `${idempotencyKey}:dataset:${stepNo}`);

  const experimentBody = experimentBodySchema.parse({
    hypothesis: `failure_minimize step ${stepNo} over ${caseKeys.length} case(s) from run ${facts.source.id}`,
    dataset_id: dataset.id,
    dataset_hash: dataset.hash,
    baseline_arm_id: facts.armId,
    arm_ids: [facts.armId],
    repeats: 1,
    endpoints: [],
    budget_name: facts.budgetName,
    purpose: 'failure_minimize',
  });
  const { object: experiment } = await putObject(db, principal, 'experiment', experimentBody, 'deidentified',
    `${idempotencyKey}:experiment:${stepNo}`);

  const items = caseKeys.map((k) => ({
    case_key: k,
    arm_hash: facts.armHash,
    repetition: 1,
    payload: { engine: facts.sourceDataset.engine, frozen: caseByKey.get(k)!.frozen, arm: facts.armBody, budget_id: facts.budgetId, arm_id: facts.armId },
  }));
  const { run } = await submitRun(
    db, principal, 'failure_minimize', experiment.id, facts.budgetId,
    `${idempotencyKey}:run:${stepNo}`, hash({ step: stepNo, cases: caseKeys }),
    RUN_DEADLINE_MS, items,
  );
  return { runId: run.id, estimate, note: null };
}

/** How many of a settled run's items failed the SAME way the group key describes. */
async function matchingItems(db: Db, runId: string, key: {
  engine: string | null; stage: string | null; category: string | null; message_head: string | null;
}): Promise<number> {
  const after = await itemsOf(db, runId, 1000, 0);
  let matching = 0;
  for (const i of after) {
    const failed = i.execution_status === 'failed' || i.assessment_status === 'unassessable' || i.attribution_status === 'invalid';
    if (!failed) continue;
    const err = (i.error ?? null) as { category?: unknown; message?: unknown } | null;
    const stageRows = await db.query<{ stage: string }>(LAST_STAGE_SQL, [i.id]).catch(() => []);
    if (sameGroup({
      case_key: i.case_key,
      last_stage: stageRows[0]?.stage ?? null,
      category: err?.category == null ? null : String(err.category),
      head: messageHead(err?.message),
    }, key)) matching += 1;
  }
  return matching;
}

const SETTLED: ReadonlySet<string> = new Set(['succeeded', 'failed', 'partial', 'expired', 'cancelled']);

/** Write the next version of a search. Immutable objects: an advance is a new row, never an edit. */
async function writeVersion(db: Db, owner: string, idempotencyKey: string, version: number, body: MinimizeBody) {
  const { object } = await putObject(db, owner, 'minimize', minimizeBodySchema.parse(body), 'deidentified',
    minimizeIdemKey(idempotencyKey, version));
  return object;
}

/** While the search is running, the caller gets a pointer and a state — never a half-built report. */
function runningView(minimizeId: string, body: MinimizeBody, spend: number) {
  const last = body.steps[body.steps.length - 1];
  return {
    minimize_id: minimizeId,
    state: 'running' as const,
    step: last.step,
    run_id: last.run_id,
    run_state: last.state,
    case_keys: [...last.case_keys],
    spend_microusd: spend,
    note: 'The step is running on the queue. Call failure_minimize again with the SAME '
      + 'idempotency_key to advance the search; nothing is re-submitted while a step is unsettled.',
  };
}

/** The finished answer — today's shape, plus the id and the state the search ended in. */
function report(minimizeId: string, body: MinimizeBody, perCase: number) {
  return {
    minimize_id: minimizeId,
    state: body.state,
    source_run_id: body.source_run_id,
    group_key: body.group_key,
    candidates: body.candidates,
    started_with: body.steps.length ? [...body.steps[0].case_keys] : [],
    minimal_case_keys: [...body.minimal_case_keys],
    reproducing_run_ids: body.steps.filter((s) => s.reproduced && s.run_id).map((s) => s.run_id as string),
    steps: body.steps.map((s) => ({
      step: s.step,
      case_keys: [...s.case_keys],
      run_id: s.run_id,
      run_state: s.state,
      reproduced: s.reproduced,
      matching_items: s.matching_items,
      estimated_microusd: perCase * s.case_keys.length,
      spent_microusd: s.spent_microusd,
      note: s.note,
    })),
    spend_microusd: body.spend_microusd,
    budget_cap_microusd: body.budget_cap_microusd,
    stopped: body.stopped_reason as 'minimal' | 'not_reproduced' | 'budget_cap' | 'step_cap',
    caveat: MINIMIZE_CAVEAT,
  };
}

/**
 * §17.11 DECISION 150 — one call advances the search by as much as has settled, and no more.
 *
 * FIRST CALL (a new idempotency key): validate the source, apply decision 131's cap to step 1, and
 * either refuse before anything exists or submit step 1's run and return a pointer.
 *
 * REPEAT CALL (the same key): load the newest version. If the current step's run has not settled,
 * say so and change nothing — a repeat is free and re-submits nothing. If it has settled, score it
 * against the group key, record it, and either submit the next step or finish.
 *
 * ⚠️ THE RUN IS SUBMITTED BEFORE ITS VERSION IS WRITTEN, which looks backwards and is not: an
 * object is immutable, so a version naming a run has to know the run's id, and `submitRun` is
 * idempotent per step. A crash between the two leaves a queued run that the next call re-derives
 * and adopts by its key rather than a version pointing at a run that was never created.
 */
export async function failureMinimize(deps: MinimizeDeps, args: {
  group_key: { engine: string | null; stage: string | null; category: string | null; message_head: string | null };
  run_id: string; budget_cap_microusd: number; idempotency_key: string;
}) {
  const { db, principal } = deps;
  const key = args.group_key;
  const facts = await readSource(db, principal, args);
  const existing = await loadNewest(db, principal, args.idempotency_key);

  // ── the finished search answers a repeat with the same report, and runs nothing ──
  if (existing && existing.body.state !== 'running') {
    return report(existing.id, existing.body, facts.perCase);
  }

  // ── first call: step 1, or the refusal that stops it before anything is created ──
  if (!existing) {
    const first = await submitStep(db, principal, facts, args.idempotency_key, args.budget_cap_microusd, 1, facts.started);
    const step = {
      step: 1,
      case_keys: [...facts.started],
      run_id: first.runId,
      state: first.runId ? 'queued' : 'refused',
      reproduced: false,
      matching_items: 0,
      spent_microusd: 0,
      note: first.note,
    };
    const body: MinimizeBody = minimizeBodySchema.parse({
      group_key: key,
      source_run_id: facts.source.id,
      owner: principal,
      budget_cap_microusd: args.budget_cap_microusd,
      candidates: facts.candidates.length,
      steps: [step],
      state: first.runId ? 'running' : 'stopped',
      stopped_reason: first.runId ? null : 'budget_cap',
      minimal_case_keys: [],
      spend_microusd: 0,
    });
    const object = await writeVersion(db, principal, args.idempotency_key, 1, body);
    return first.runId ? runningView(object.id, body, 0) : report(object.id, body, facts.perCase);
  }

  // ── repeat call: has the step this version is waiting on settled? ────────────────
  const body = existing.body;
  const pending = body.steps[body.steps.length - 1];
  if (!pending.run_id) {
    // Only a refusal has no run, and a refusal is terminal — so this cannot happen while running.
    throw new LabError('INVALID_INPUT', `minimize ${existing.id} is running with no step to wait on`);
  }
  const state = await deriveRunState(db, pending.run_id);
  if (!SETTLED.has(state)) {
    return runningView(existing.id, {
      ...body, steps: [...body.steps.slice(0, -1), { ...pending, state }],
    }, body.spend_microusd);
  }

  // ── it settled: score it, record it, and decide what comes next ──────────────────
  const matching = await matchingItems(db, pending.run_id, key);
  const spentRows = await db.query<{ spent: string }>(STEP_SPEND_SQL, [pending.run_id]);
  const spent = Number(spentRows[0]?.spent ?? 0);
  const settledStep = {
    ...pending, state, reproduced: matching > 0, matching_items: matching, spent_microusd: spent,
  };
  const steps = [...body.steps.slice(0, -1), settledStep];
  const spend = steps.reduce((sum, st) => sum + st.spent_microusd, 0);

  const move = nextMove([...steps[0].case_keys], steps.map((st) => ({ case_keys: st.case_keys, reproduced: st.reproduced })));

  if (move.kind === 'end') {
    const done: MinimizeBody = minimizeBodySchema.parse({
      ...body, steps, spend_microusd: spend,
      state: move.reason === 'step_cap' ? 'stopped' : 'done',
      stopped_reason: move.reason,
      minimal_case_keys: move.minimal,
    });
    const object = await writeVersion(db, principal, args.idempotency_key, existing.version + 1, done);
    return report(object.id, done, facts.perCase);
  }

  // The next step, with decision 131's cap checked before it is submitted.
  const stepNo = steps.length + 1;
  const next = await submitStep(db, principal, facts, args.idempotency_key, args.budget_cap_microusd, stepNo, move.case_keys);
  if (!next.runId) {
    const stoppedBody: MinimizeBody = minimizeBodySchema.parse({
      ...body,
      steps: [...steps, {
        step: stepNo, case_keys: [...move.case_keys], run_id: null, state: 'refused',
        reproduced: false, matching_items: 0, spent_microusd: 0, note: next.note,
      }],
      spend_microusd: spend,
      state: 'stopped',
      stopped_reason: 'budget_cap',
      // What the search had narrowed to when the money ran out — an honest partial answer.
      minimal_case_keys: [...steps.filter((st) => st.reproduced).slice(-1).flatMap((st) => st.case_keys)],
    });
    const object = await writeVersion(db, principal, args.idempotency_key, existing.version + 1, stoppedBody);
    return report(object.id, stoppedBody, facts.perCase);
  }

  const advanced: MinimizeBody = minimizeBodySchema.parse({
    ...body,
    steps: [...steps, {
      step: stepNo, case_keys: [...move.case_keys], run_id: next.runId, state: 'queued',
      reproduced: false, matching_items: 0, spent_microusd: 0, note: null,
    }],
    spend_microusd: spend,
    state: 'running',
    stopped_reason: null,
    minimal_case_keys: [],
  });
  const object = await writeVersion(db, principal, args.idempotency_key, existing.version + 1, advanced);
  return runningView(object.id, advanced, spend);
}
