/**
 * lib/lab-v2/tools/repair.ts — `reaudit_plan` and `reaudit_execute`
 * (LAB-MCP-V2-PRD-v1.0 §17.6 items 1 and 2, decisions 67 and 68).
 *
 * ⚠️ THIS IS THE ONLY PART OF THE LAB THAT WRITES A PRODUCTION ROW, and everything about its shape
 * is an answer to that.
 *
 * DECISION 67 — THE WRITE IS PRODUCTION'S, NOT A SECOND ONE. A repair does not build a row and
 * insert it. It runs the engine and hands the result to the engine's OWN store writer:
 * `lib/ipd-episode/store.ts`'s `saveEpisodeAudit`, which demotes the current row and inserts a new
 * one at the named version, and `lib/opd-audit-store.ts`'s `saveOpdAudit`, the same function
 * `app/api/opd-audit/worker/route.ts:158` calls every night. **There is no SQL in this file at
 * all** — not one statement — and that is checkable by reading it. A repair that wrote its own
 * INSERT would be a second write path with its own bugs, its own column list and its own idea of
 * what `is_current` means, and the first time the two disagreed nobody would know which row was
 * true.
 *
 * DECISION 68 — IT STOPS. `reaudit_execute` runs the first N cases (default 5, max 20) and stops,
 * whatever the plan holds. Continuing needs a SECOND call carrying `review_passed: true` and a
 * non-empty reason, and that reason is stored as an event before anything runs. A repair is the one
 * operation here that changes what a clinician reads, so a human saying "I looked at the five" is a
 * required input, not a courtesy.
 *
 * ⚠️ AND A STALE PLAN IS REFUSED. `reaudit_plan` records a `source_snapshot_hash` over the exact
 * rows it planned against. If those rows moved — a nightly sweep re-audited one, someone else
 * repaired it — the plan describes a world that no longer exists and `reaudit_execute` raises
 * `PLAN_STALE` rather than repairing against stale assumptions.
 *
 * ⚠️ IT IS NEVER SYNCHRONOUS. `reaudit_execute` submits a run with `operation: 'reaudit'` and
 * returns. The cron's tick claims the items, and `worker.ts` selects the writing adapters from that
 * operation string alone — which is the whole authorisation argument: `operation` is not a
 * caller-supplied field anywhere in this platform, and only this file ever writes 'reaudit'.
 */
import { z } from 'zod';
import { LabError, hash } from '../contracts';
import { ensureBudget, getObject, itemsOf, putObject, recordEvent, submitRun } from '../store';
import { auditFilterSchema, searchAudits, type AuditFilter } from '../sources/audits';
import { freezeOpdCase } from '../sources/opd';
import { resolveEpisodesForRepair, resolveOpdForRepair, selectIpdCohort, type EpisodeRef } from '../sources/ipd';
import type { Db } from '../db';

/** Decision 68 — the canary, and its ceiling. */
export const CANARY_DEFAULT = 5;
export const CANARY_MAX = 20;

export const REPAIR_ENGINES = ['ipd_episode', 'opd_note_audit'] as const;
export type RepairEngine = (typeof REPAIR_ENGINES)[number];

/** Decision 67 — the writer each engine's repair goes through, named so the report can quote it. */
export const REPAIR_WRITERS: Record<RepairEngine, string> = {
  ipd_episode: 'lib/ipd-episode/store.ts saveEpisodeAudit (demote is_current, then INSERT)',
  opd_note_audit: 'lib/opd-audit-store.ts saveOpdAudit (ON CONFLICT (uid, engine_version); a new version inserts, the same version is a no-op)',
};

const caseOutcome = z.object({
  case_key: z.string(),
  outcome: z.enum(['written', 'failed', 'skipped_stale', 'skipped_exists', 'queued']),
  /** The row the engine's writer landed. Null on anything but `written`. */
  new_row_id: z.string().nullable(),
  detail: z.string().nullable(),
});

export const REPAIR_SCHEMAS = {
  reaudit_plan: {
    input: z.object({
      engine: z.enum(REPAIR_ENGINES),
      /** The version the repair will WRITE at. A case already current at it is reported as such. */
      engine_version: z.string().min(1).max(128),
      /** `audit_search`'s filter for OPD; the IPD selectors for ipd_episode. Never SQL. */
      filter: z.record(z.unknown()).default({}),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    output: z.object({
      plan_id: z.string().uuid(),
      engine: z.enum(REPAIR_ENGINES),
      engine_version: z.string(),
      /** Decision 68's staleness key. `reaudit_execute` recomputes it and refuses on a difference. */
      source_snapshot_hash: z.string(),
      /** Decision 67, in words: the exact function this plan's repair will call. */
      writer: z.string(),
      cases: z.array(z.object({
        case_key: z.string(),
        current_engine_version: z.string().nullable(),
        qualifies: z.boolean(),
        reason: z.string(),
      })),
      expected_writes: z.number().int(),
      estimated_budget_microusd: z.number().int(),
      /** What a first `reaudit_execute` will actually do, before any review. */
      canary: z.object({ n: z.number().int(), max: z.number().int() }),
    }),
  },
  reaudit_execute: {
    input: z.object({
      plan_id: z.string().uuid(),
      n: z.number().int().min(1).max(CANARY_MAX).default(CANARY_DEFAULT),
      idempotency_key: z.string().min(1),
      /** Decision 68 — required to go past the canary, and never on the first call. */
      review_passed: z.boolean().default(false),
      /** Required whenever `review_passed` is true. Stored as an event before anything runs. */
      review_reason: z.string().min(1).max(2000).optional(),
      budget_name: z.string().min(1).max(64).default('repair'),
    }),
    output: z.object({
      plan_id: z.string().uuid(),
      run_id: z.string().uuid(),
      engine: z.enum(REPAIR_ENGINES),
      engine_version: z.string(),
      deduplicated: z.boolean(),
      /** Which slice of the plan this call submitted. */
      window: z.object({ from: z.number().int(), to: z.number().int(), of: z.number().int() }),
      review_passed: z.boolean(),
      writer: z.string(),
      /** Queued at submission; filled in by `run_status` / `report_export` as the cron works. */
      cases: z.array(caseOutcome),
      /** How many of the plan's cases remain after this window. */
      remaining: z.number().int(),
    }),
  },
} as const;

export interface RepairDeps {
  db: Db;
  principal: string;
  /** Injection seams (repo idiom). Production passes none of them. */
  searchOpd?: (f: AuditFilter, limit: number, offset: number) => Promise<{ uid: string; engine_version?: string | null }[]>;
  selectIpd?: (engineVersion: string, limit: number) => Promise<string[]>;
  /** §17.6 decision 74/75 — resolve an audit row to its real episode and ask if it qualifies. */
  resolveIpd?: (auditIds: readonly string[], targetVersion: string) => Promise<EpisodeRef[]>;
  resolveOpd?: (uids: readonly string[], targetVersion: string) => Promise<Map<string, { current_engine_version: string | null; already_at_version: boolean }>>;
  freezeOpd?: (caseKey: string) => Promise<{ case_key: string; member_key: string | null; frozen: unknown }>;
}

/**
 * The plan's staleness key. It is a hash of the (case_key, current version) pairs the plan was
 * built from — the smallest thing that changes when a repair's premise changes. Deliberately NOT
 * a hash of the whole plan object: the plan carries a uuid and a timestamp, and a key that moved
 * on its own would make PLAN_STALE fire on every second call.
 */
export function snapshotHash(cases: { case_key: string; current_engine_version: string | null }[]): string {
  return hash([...cases]
    .map((c) => [c.case_key, c.current_engine_version])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/**
 * A rough ceiling, from the pricing table's own units rather than from a guess.
 *
 * ⚠️ IT IS AN ESTIMATE AND THE FIELD NAME SAYS SO. A repair's real cost depends on how many
 * checkpoints an episode has and how long its notes are, neither of which is knowable before the
 * run. This is the number an operator needs to decide whether to look closer, and the run's own
 * budget is what actually bounds the spend.
 */
export const ESTIMATED_MICROUSD_PER_CASE: Record<RepairEngine, number> = {
  // IPD: up to six Haiku checkpoints plus two Opus judge passes, at the observed prompt sizes.
  ipd_episode: 120_000,
  // OPD: one governed analysis leg.
  opd_note_audit: 15_000,
};

export async function reauditPlan(deps: RepairDeps, args: { engine: RepairEngine; engine_version: string; filter?: Record<string, unknown>; limit?: number }) {
  const { db, principal } = deps;
  const engine = args.engine;
  const targetVersion = args.engine_version;
  const limit = Math.floor(args.limit ?? 50);

  const cases: { case_key: string; current_engine_version: string | null; qualifies: boolean; reason: string }[] = [];

  if (engine === 'opd_note_audit') {
    const parsed = auditFilterSchema.safeParse(args.filter ?? {});
    if (!parsed.success) {
      throw new LabError('INVALID_INPUT', `filter: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    const rows = await (deps.searchOpd ?? searchAudits)(parsed.data as AuditFilter, limit, 0);
    const uids = [...new Set(rows.map((r) => String(r.uid)))];
    // DECISION 74 — asked of the UID, not of the row this filter happened to return.
    const qualified = uids.length
      ? await (deps.resolveOpd ?? resolveOpdForRepair)(uids, targetVersion)
      : new Map<string, { current_engine_version: string | null; already_at_version: boolean }>();
    for (const uid of uids) {
      const q = qualified.get(uid);
      const current = q?.current_engine_version ?? (rows.find((r) => String(r.uid) === uid)?.engine_version ?? null);
      const already = q?.already_at_version === true;
      cases.push({
        case_key: uid,
        current_engine_version: current == null ? null : String(current),
        qualifies: !already,
        // ⚠️ NOT A FAILURE, AND NOT SILENT. saveOpdAudit's conflict clause refuses to overwrite a
        // successful row at the same version, so repairing one is a no-op — which is decision 67's
        // "never an UPDATE" holding, not an error. The plan says so before anything runs.
        reason: already
          ? `already_at_version: this uid already carries a row at ${targetVersion}; saveOpdAudit would return 'exists' and write nothing`
          : `current at ${current ?? 'no version'}, repair writes ${targetVersion}`,
      });
    }
  } else {
    const filter = (args.filter ?? {}) as { engine_version?: string; audit_ids?: string[] };
    const sourceVersion = filter.engine_version ?? null;
    const ids = filter.audit_ids?.length
      ? filter.audit_ids.map(String)
      : await (deps.selectIpd ?? selectIpdCohort)(sourceVersion ?? targetVersion, limit);
    /**
     * ⚠️ DECISION 74 — QUALIFICATION IS A PROPERTY OF THE EPISODE, NOT OF THE ROW.
     *
     * Round B3 asked "is this audit row at the target version?" and repaired a 0.1 row whose
     * encounter ALREADY had a current 0.2 row beside it. The episode had nothing to repair; the
     * ROW did, and the row is not the unit. The subquery in EPISODE_QUALIFY_SQL is keyed on
     * `encounter_id`, so an encounter with any current row at the target does not qualify.
     */
    const refs = ids.length
      ? await (deps.resolveIpd ?? resolveEpisodesForRepair)(ids, targetVersion)
      : [];
    const byId = new Map(refs.map((r) => [r.audit_id, r]));
    for (const id of ids) {
      const ref = byId.get(id);
      if (!ref) {
        cases.push({ case_key: id, current_engine_version: null, qualifies: false, reason: 'no such ipd_episode_audits row' });
        continue;
      }
      cases.push({
        case_key: id,
        current_engine_version: ref.current_engine_version,
        qualifies: !ref.already_at_version,
        reason: ref.already_at_version
          ? `already_at_version: this episode already carries a current row at ${targetVersion}`
          : `current at ${ref.current_engine_version ?? 'no version'}; repair runs the episode fresh and writes ${targetVersion}`,
      });
    }
  }

  if (!cases.length) throw new LabError('INVALID_INPUT', 'the plan resolved to no cases');

  const expected = cases.filter((c) => c.qualifies).length;
  const body = {
    kind: 'reaudit_plan',
    engine,
    engine_version: targetVersion,
    filter: args.filter ?? {},
    cases,
    source_snapshot_hash: snapshotHash(cases),
    writer: REPAIR_WRITERS[engine],
    expected_writes: expected,
    estimated_budget_microusd: expected * ESTIMATED_MICROUSD_PER_CASE[engine],
    canary: { n: CANARY_DEFAULT, max: CANARY_MAX },
    planned_at: new Date().toISOString(),
  };
  const { object } = await putObject(db, principal, 'operation_plan', body, 'deidentified', null);

  return {
    plan_id: object.id,
    engine,
    engine_version: targetVersion,
    source_snapshot_hash: body.source_snapshot_hash,
    writer: body.writer,
    cases,
    expected_writes: expected,
    estimated_budget_microusd: body.estimated_budget_microusd,
    canary: body.canary,
  };
}

interface PlanBody {
  kind?: string;
  engine?: RepairEngine;
  engine_version?: string;
  cases?: { case_key: string; current_engine_version: string | null; qualifies: boolean; reason: string }[];
  source_snapshot_hash?: string;
  filter?: Record<string, unknown>;
}

export async function reauditExecute(deps: RepairDeps, args: {
  plan_id: string; n?: number; idempotency_key: string; review_passed?: boolean; review_reason?: string; budget_name?: string;
}) {
  const { db, principal } = deps;
  const plan = await getObject(db, args.plan_id);
  if (!plan) throw new LabError('NOT_FOUND', `no plan ${args.plan_id}`);
  const body = (plan.body ?? {}) as PlanBody;
  if (body.kind !== 'reaudit_plan' || !body.engine || !body.cases) {
    throw new LabError('INVALID_INPUT', `object ${args.plan_id} is not a reaudit plan`);
  }
  const engine = body.engine;
  const targetVersion = String(body.engine_version);
  const all = body.cases;
  const qualifying = all.filter((c) => c.qualifies);
  const n = Math.min(Math.max(1, Math.floor(args.n ?? CANARY_DEFAULT)), CANARY_MAX);
  const reviewPassed = args.review_passed === true;

  // ── decision 68, in order: the review gate, then staleness, then the window ────────────
  if (reviewPassed) {
    const reason = String(args.review_reason ?? '').trim();
    if (!reason) {
      throw new LabError('INVALID_INPUT', 'review_passed requires review_reason: a continuation past the canary is a human decision and the record must say who decided what');
    }
    // Written BEFORE anything runs, so a repair that then fails still leaves the authorisation on
    // the record. An event nobody can find afterwards is not an audit trail.
    await recordEvent(db, principal, plan.id, 'reaudit_review', {
      plan_id: plan.id, engine, engine_version: targetVersion, reason: reason.slice(0, 2000),
    });
  }

  // Recomputed from the SAME source the plan read, so a nightly sweep between plan and execute is
  // caught. The recomputation is over the plan's own case list, so it asks exactly one question:
  // are these rows still at the versions the plan saw?
  const fresh = await currentVersionsFor(deps, engine, all.map((c) => c.case_key), body.filter ?? {});
  const nowHash = snapshotHash(all.map((c) => ({ case_key: c.case_key, current_engine_version: fresh.get(c.case_key) ?? c.current_engine_version })));
  if (body.source_snapshot_hash && nowHash !== body.source_snapshot_hash) {
    throw new LabError('PLAN_STALE',
      `the rows this plan was built from have changed since it was made (snapshot ${String(body.source_snapshot_hash).slice(0, 12)} is now ${nowHash.slice(0, 12)}); re-run reaudit_plan`);
  }

  // The canary is the FIRST window; a review moves it along. `already` counts what previous calls
  // submitted, so a second call continues rather than repeating.
  //
  // ⚠️ COUNTED UNCONDITIONALLY, and the first draft did not. Computing it only when the review flag
  // was set made `from` zero on an unreviewed second call, so the gate below never fired and the
  // call quietly RE-RAN the canary — decision 68's stop turned into a loop nobody would notice.
  const already = await submittedCount(db, plan.id);
  if (already > 0 && !reviewPassed) {
    throw new LabError('INVALID_INPUT',
      `this plan has already run its canary (${already} case(s) submitted); a continuation needs review_passed: true and a review_reason`);
  }
  const from = already;
  const to = Math.min(from + n, qualifying.length);
  const window = qualifying.slice(from, to);
  if (!window.length) {
    throw new LabError('INVALID_INPUT', from >= qualifying.length
      ? `every qualifying case in plan ${plan.id} has already been submitted`
      : `plan ${plan.id} has no qualifying cases`);
  }

  // ── freeze, then submit. The RUN is what does the work; this call never waits for it. ──
  const budget = await ensureBudget(db, principal, String(args.budget_name ?? 'repair'),
    Math.max(1, window.length) * ESTIMATED_MICROUSD_PER_CASE[engine] * 2);
  const items: { case_key: string; arm_hash: string; repetition: number; payload: Record<string, unknown> }[] = [];
  const cases: { case_key: string; outcome: 'written' | 'failed' | 'skipped_stale' | 'skipped_exists' | 'queued'; new_row_id: string | null; detail: string | null }[] = [];
  const armHash = hash({ engine, engine_version: targetVersion, plan_id: plan.id });
  const arm = { engine, engine_version: targetVersion, stages: stagesForRepair(engine), plan_id: plan.id };

  /**
   * ⚠️ DECISION 75 — THIS LOOP IS WHERE ROUND B3 WENT WRONG, AND IT NO LONGER FREEZES ANYTHING.
   *
   * It called `freezeIpdEpisode`, which is B2's REPLAY freeze: the case came back carrying `steps`
   * and a synthetic `EPFROZEN…` handle, the adapter took frozen mode by its own rule, and a
   * production row landed under an encounter that does not exist, stamped with the SOURCE row's
   * engine version and 81 findings replayed from stored judge replies.
   *
   * A repair case is now a POINTER: the audit row id, and the REAL encounter id resolved from it.
   * Nothing is frozen, so there is nothing for the adapter to replay, and the repair adapter
   * refuses `REPAIR_FROZEN_CASE` on any object carrying a replay fingerprint anyway. Two
   * independent guards, because one of them was already trusted once.
   */
  const ipdRefs = engine === 'ipd_episode' && window.length
    ? new Map((await (deps.resolveIpd ?? resolveEpisodesForRepair)(window.map((c) => c.case_key), targetVersion))
      .map((r) => [r.audit_id, r]))
    : new Map<string, EpisodeRef>();

  for (const c of window) {
    try {
      if (engine === 'ipd_episode') {
        const ref = ipdRefs.get(c.case_key);
        if (!ref) throw new LabError('CASE_NOT_FOUND', `no ipd_episode_audits row ${c.case_key}`);
        // Re-checked HERE as well as in the plan: a sweep between plan and execute could have
        // brought the episode to the target version, and PLAN_STALE only catches a change to the
        // rows the plan named.
        if (ref.already_at_version) {
          cases.push({ case_key: c.case_key, outcome: 'skipped_exists', new_row_id: null, detail: `already_at_version ${targetVersion}` });
          continue;
        }
        items.push({
          case_key: c.case_key, arm_hash: armHash, repetition: 1,
          payload: {
            engine,
            // The POINTER. No steps, no real_course, no synthetic ref — see the header.
            frozen: { audit_id: ref.audit_id, encounter_id: ref.encounter_id, source_engine_version: ref.current_engine_version },
            arm, budget_id: '', plan_id: plan.id,
          },
        });
      } else {
        // ⚠️ `withSources: false`. A repair reads the corpus LIVE, because it must be what the
        // nightly worker would have written; a frozen source list would make it a replay.
        const frozen = await (deps.freezeOpd ?? ((k: string) => freezeOpdCase(k, { withSources: false, withMemberKey: false })))(c.case_key);
        items.push({
          case_key: c.case_key, arm_hash: armHash, repetition: 1,
          payload: { engine, frozen: frozen.frozen, arm, budget_id: '', plan_id: plan.id },
        });
      }
      cases.push({ case_key: c.case_key, outcome: 'queued', new_row_id: null, detail: null });
    } catch (e) {
      const err = e as LabError;
      cases.push({
        case_key: c.case_key, outcome: 'failed', new_row_id: null,
        detail: `${err.code ?? 'ERROR'}: ${String(err.message).slice(0, 200)}`,
      });
    }
  }
  if (!items.length) {
    const skipped = cases.filter((c) => c.outcome === 'skipped_exists').length;
    throw new LabError(skipped ? 'INVALID_INPUT' : 'SOURCE_UNAVAILABLE',
      skipped
        ? `every case in this window is already at ${targetVersion} (${skipped} skipped_exists); re-run reaudit_plan`
        : `no case in this window could be prepared (${cases.length} failed)`);
  }
  for (const it of items) (it.payload as { budget_id: string }).budget_id = budget.id;

  const { run, deduplicated } = await submitRun(
    db, principal, 'reaudit', null, budget.id, args.idempotency_key,
    hash({ plan: plan.id, from, to }), 24 * 60 * 60 * 1000, items,
  );

  return {
    plan_id: plan.id,
    run_id: run.id,
    engine,
    engine_version: targetVersion,
    deduplicated,
    window: { from, to, of: qualifying.length },
    review_passed: reviewPassed,
    writer: REPAIR_WRITERS[engine],
    cases,
    remaining: Math.max(0, qualifying.length - to),
  };
}

/** The stages a repair prices. Deliberately the engine's own, from the same table an arm uses. */
function stagesForRepair(engine: RepairEngine): Record<string, { provider: string; model: string; max_cost_microusd: number }> {
  return engine === 'ipd_episode'
    ? {
      checkpoint: { provider: 'bedrock', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', max_cost_microusd: 40_000 },
      divergence: { provider: 'bedrock', model: 'global.anthropic.claude-opus-4-6-v1', max_cost_microusd: 60_000 },
      fidelity: { provider: 'bedrock', model: 'global.anthropic.claude-opus-4-6-v1', max_cost_microusd: 60_000 },
    }
    : { analysis: { provider: 'bedrock', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', max_cost_microusd: 30_000 } };
}

/** How many of this plan's cases previous calls already submitted, across every run it made. */
async function submittedCount(db: Db, planId: string): Promise<number> {
  const runs = await db.query<{ id: string }>(
    `SELECT id FROM lab_v2.runs WHERE operation = 'reaudit' AND request_hash IS NOT NULL ORDER BY created_at`, []);
  let n = 0;
  for (const r of runs) {
    const items = await itemsOf(db, r.id, 1000, 0);
    if (items.some((i) => (i.payload as { plan_id?: string })?.plan_id === planId)) {
      n += items.filter((i) => (i.payload as { plan_id?: string })?.plan_id === planId).length;
    }
  }
  return n;
}

/** The CURRENT engine version of each planned case, read the same way the plan read it. */
async function currentVersionsFor(
  deps: RepairDeps, engine: RepairEngine, caseKeys: string[], filter: Record<string, unknown>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (engine === 'opd_note_audit') {
    const parsed = auditFilterSchema.safeParse(filter);
    const rows = parsed.success
      ? await (deps.searchOpd ?? searchAudits)(parsed.data as AuditFilter, Math.max(caseKeys.length, 1), 0)
      : [];
    for (const r of rows) out.set(String(r.uid), r.engine_version == null ? null : String(r.engine_version));
  } else {
    // The IPD plan pins audit ROW ids, which are immutable: a row cannot change its version. What
    // CAN change is which row is current, and the plan's own version field records what it saw.
    const f = filter as { engine_version?: string };
    for (const k of caseKeys) out.set(k, f.engine_version ?? null);
  }
  return out;
}
