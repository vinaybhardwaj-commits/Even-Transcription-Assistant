/**
 * lib/lab-v2/sources/readmission.ts — freeze ONE readmission finding as a case
 * (LAB-MCP-V2-PRD-v1.0 §17.8 round D1, decisions 99, 101 and 104).
 *
 * ⚠️ THE IDENTIFIER IS USED AND NEVER STORED, and that sentence is the whole file.
 *
 * Decision 99: Lab v2 never retains identifying data. A readmission finding is keyed by
 * `dedup_key`, which names an index/readmit encounter pair and therefore one member — so the
 * caller sends it, this function READS with it, and what comes back carries a salted hash and no
 * id column at all. There is no retention policy because nothing is retained.
 *
 * ⚠️ THE FREEZE RUNS OUTSIDE THE FENCE, DELIBERATELY AND EXPLICITLY. `assembleForRow`
 * (`lib/readmission/run.ts:314`) reads `discharge_extracted_cases` through `sql` and db13 through
 * `metabaseQuery`, and both throw `LAB_IO_FORBIDDEN` inside a lab execution context. That is §7
 * working, not an obstacle: `dataset_create` runs outside any context, and `exitLabExecution`
 * makes that a property of THIS function rather than an assumption about its caller — exactly as
 * B1 froze retrieval. A run then executes against the frozen bytes and reads nothing live.
 *
 * ⚠️ AND `identity` IS DROPPED, NOT SCRUBBED. `AssembledPair.identity` carries the names and UHIDs
 * the de-identification scrub matched on; `run.ts:258` says in as many words that it is never
 * persisted. The narrative leg is the only consumer and decision 104 puts it out of scope for D1,
 * so this file does not carry it forward at all. Dropping beats scrubbing: a scrub can miss.
 *
 * ⚠️ ROUND D2a, DECISION 114(a): THE FREEZE NOW ALSO RECORDS `steps`. The finding's `trace_id`
 * names the trace production's own audit opened, and `trace_events` holds that audit's model
 * replies verbatim (`lib/trace.ts:684`). The freeze reads them, runs `runReconSequence` ONCE with
 * a recording `PassFn` that answers each leg from the stored reply and files it under
 * `dependencyHash(params)` — the exact key `adapters/readmission.ts` will ask for at replay — and
 * a later run then reproduces production's verdict with zero model calls. A rebuilt prompt that
 * misses its stored hash is `REPLAY_DIVERGED` in the adapter: a MEASUREMENT of db13 drift since
 * the audit, reported and never smoothed.
 */
import { createHash } from 'crypto';
import { exitLabExecution } from '../../lab-execution-context';
import { LabError } from '../contracts';
import { dependencyHash } from '../gateway';
import { identifyingKeys } from './requests';
import { memberKeyOf, memberSalt } from './opd';
import { sql } from '../../db';
import { assembleForRow, runReconSequence } from '../../readmission/run';
import { parsePassClaims } from '../../readmission-prompts';
import type { ThreeSourceInputs } from '../../readmission/assemble';
import type { PendingRow } from '../../readmission/store';

/**
 * THE ONE READ. INFERRED — no live database was available to the builder — and modelled column
 * for column on `pendingFindings` (`lib/readmission/store.ts:315`), which is production's own
 * selection for exactly these rows. The differences from it are deliberate and are only these:
 * one `dedup_key` instead of a lane/day window, and no `audit_status` filter in the STATEMENT,
 * because the statement is also the golden A/B's read; decision 114's step recording applies the
 * `audited` requirement in code, where it can say why.
 *
 * ⚠️ D2a ADDS TWO COLUMNS, AND ONLY ONE OF THEM IS IN THE KICKOFF'S ITEM 1.
 *   · `trace_id`   — item 1. The handle on production's stored replies (`store.ts:197`).
 *   · `promoted_to_full` — FLAGGED DEVIATION. Item 2's leg-count table is "lane `other` and
 *     `promoted_to_full` false ⇒ 1 leg; true ⇒ 3", and that flag lives nowhere but this row
 *     (`store.ts:197`, `:364`). Without it the expected count for lane `other` cannot be formed
 *     at all, so the column item 2 requires is added by the statement item 1 names.
 * Neither is carried into the frozen body: `FROZEN_ROW_FIELDS` is unchanged, so a field nothing
 * consumes still cannot leak.
 */
export const READMISSION_FINDING_SQL = `SELECT dedup_key, finding_class, index_encounter_id, readmit_encounter_id,
       form_uid, uhid, lane, gap_days, index_department, readmit_department, index_doctor, readmit_doctor,
       to_char(index_discharge_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS index_discharge_at,
       to_char(readmit_admit_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS readmit_admit_at,
       cm_note, form_is_planned, form_same_condition, audit_status, engine_version,
       promoted_to_full, trace_id
  FROM readmission_findings
 WHERE dedup_key = $1
 LIMIT 1`;

/**
 * The audited verdict production already recorded, for the golden A/B (item 9). A READ, and the
 * only thing this platform ever wants out of the audited half of the table.
 */
export const READMISSION_VERDICT_SQL = `SELECT dedup_key, audit_status, engine_version,
       finding->'avoidable'->>'verdict' AS verdict, model, provider
  FROM readmission_findings
 WHERE dedup_key = $1
 LIMIT 1`;

/**
 * The columns of `PendingRow` that `runReconSequence` actually reads, measured at
 * `lib/readmission/run.ts:442-500`: `finding_class`, `lane`, `gap_days`, `readmit_admit_at`,
 * `form_is_planned`, `form_same_condition`. `index_discharge_at` rides beside them because the
 * sequence takes it as its own argument.
 *
 * ⚠️ EVERYTHING ELSE IS DROPPED, INCLUDING THE THINGS DECISION 100 WOULD HAVE ALLOWED.
 * `index_doctor` and `readmit_doctor` are clinician names, which decision 100 rules are not
 * identifying — and they are dropped anyway, because the engine does not read them. A frozen case
 * carrying a field nothing consumes is a field that can only ever leak.
 */
export const FROZEN_ROW_FIELDS = [
  'finding_class', 'lane', 'gap_days', 'readmit_admit_at', 'index_discharge_at',
  'form_is_planned', 'form_same_condition',
] as const;

/**
 * ⚠️⚠️ DECISION 114(a) — THE SECOND READ, AND IT IS INFERRED (decision 87).
 *
 * Production stores the WHOLE reply: `payload.content` on the `llm_response` event
 * (`lib/trace.ts:684`, `r.choices[0].message.content`), untruncated — the only `slice` calls on
 * the trace path are on error text (`:203`, `:672`). One `llm_request` and one `llm_response` per
 * leg, because `runReconSequence` calls each label at most once and each audit opens its own trace
 * (`lib/readmission/run.ts:451, :464, :484, :487, :519`).
 *
 * The predicate is `servedReadmitCall`'s own (`run.ts:119-135`) — `trace_id` + `kind` +
 * a `readmit_%` stage — with two differences it needs and that one does not:
 *   · `stage <> 'readmit_narrative'`, because R4's narrative leg shares the audit's `trace_id`
 *     (`lib/readmission/narrative.ts:114`) and is not a recon leg. Decision 104 leaves it out of
 *     the lab entirely, and a step keyed off it would answer a question no replay asks.
 *   · `ORDER BY seq` ascending rather than `DESC LIMIT 1`: this wants every leg, not the last one.
 *
 * ⚠️ TWO PROJECTIONS BEYOND THE KICKOFF'S QUOTED STATEMENT, AND THEY ARE FLAGGED. The kickoff
 * quotes `SELECT stage, seq, payload->>'content' AS content`, and its very next sentence requires
 * `served: { model, provider } from the llm_response payload`. Both cannot hold of the same row,
 * so `payload->>'model'` and `payload->>'provider'` are added — the same two fields
 * `servedReadmitCall` reads out of the same payload (`run.ts:121`), on rows this statement is
 * already fetching. No extra row, no extra read, and the report carries both statements.
 *
 * ⚠️ AND IT IS STILL A READ. Nothing in this file writes to `trace_events` or to any other
 * production table; the decision 79 grep over `lib/lab-v2/sources` and `adapters` proves it.
 */
export const READMISSION_TRACE_SQL = `SELECT stage, seq,
       payload->>'content'  AS content,
       payload->>'model'    AS model,
       payload->>'provider' AS provider
  FROM trace_events
 WHERE trace_id = $1 AND kind = 'llm_response' AND stage LIKE 'readmit_%'
   AND stage <> 'readmit_narrative'
 ORDER BY seq`;

/** One recorded leg: the reply production got, under the hash a replay will ask for. */
export interface ReadmissionStep {
  /** The leg label, which is also the trace stage — `tracedChat(traceId, label, …)`. */
  stage: string;
  /** `dependencyHash` of the exact params object `adapters/readmission.ts:94-101` builds. */
  request_hash: string;
  /** The stored `llm_response.content`, whole. */
  text: string;
  /** The POST-fallback identity on the stored reply. Evidence, never part of the hash. */
  served: { model: string | null; provider: string | null } | null;
}

/**
 * ⚠️ THE LEG COUNT IS LANE-DEPENDENT, AND "FOUR" IS NEVER THE ANSWER.
 *
 * `adapters/ipd-episode.ts:560-563` can assert exactly 2 because an IPD episode always takes two
 * judge passes. A readmission finding takes one, two or three, and which is decided by the same
 * two expressions `runReconSequence` itself branches on (`lib/readmission/run.ts:444-445`) —
 * restated here from the ENGINE'S predicates rather than from a lane table, so the expectation
 * cannot drift from the sequence it is an expectation about.
 *
 * ⚠️ FLAGGED: the kickoff phrases this "by lane", and `finding_class` is what run.ts:444 tests for
 * the out-of-network branch. On every row production writes the two agree; where they could not,
 * the engine's own expression is the one that decides how many legs actually fire.
 */
export function expectedLegStages(row: {
  finding_class?: unknown; lane?: unknown; promoted_to_full?: unknown;
}): readonly string[] {
  if (row.finding_class === 'out_of_network') return ['readmit_oon'];
  if (row.lane === 'other') {
    return row.promoted_to_full === true
      ? ['readmit_condition', 'readmit_recon_a', 'readmit_recon_b']
      : ['readmit_condition'];
  }
  return ['readmit_recon_a', 'readmit_recon_b'];
}

export interface FrozenReadmissionCase {
  case_key: string;
  member_key: string | null;
  frozen: {
    engine: 'readmission';
    /** The `PendingRow` subset above, and nothing else. */
    row: Record<string, unknown>;
    /** `ThreeSourceInputs`, de-identified upstream by `assembleForRow`. */
    inputs: unknown;
    index_discharge_at: string | null;
    /** Decision 114(a) — production's stored replies, keyed by the request hash. */
    steps: Record<string, ReadmissionStep>;
  };
  source_versions: Record<string, unknown>;
}

export interface RecordReadmissionStepsArgs {
  /** The RAW row: `audit_status`, `trace_id`, `lane`, `finding_class`, `promoted_to_full`. */
  row: Record<string, unknown>;
  /** The FROZEN row — the subset a replay will hand `runReconSequence`, and no other. */
  frozenRow: Record<string, unknown>;
  inputs: ThreeSourceInputs;
  indexDischargeAt: string | null;
  run: (statement: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
}

export interface ReadmissionSourceDeps {
  run?: (statement: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
  assemble?: typeof assembleForRow;
  salt?: string;
  /**
   * DECISION 114(a)'s recording pass, injectable exactly as `sources/ipd.ts:641` injects
   * `recordSteps` — with one difference that is forced and is flagged. IPD can gate on the dep's
   * PRESENCE because its production wrapper (`adapters/ipd-episode.ts:568`) supplies it; the only
   * caller readmission has is `service.ts:216`, which calls `freezeReadmissionFinding(key)` with
   * no deps and which this round's file contract puts out of bounds. So the real recorder is the
   * DEFAULT and this seam is an override, not a switch: a production freeze always records.
   */
  recordSteps?: (a: RecordReadmissionStepsArgs) => Promise<Record<string, ReadmissionStep>>;
}

const liveRun = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * ⚠️ THE LAST GATE, AND IT RUNS ON WHAT IS ABOUT TO BE STORED RATHER THAN ON WHAT WAS PLANNED.
 * `assembleForRow` de-identifies its own inputs, and this asserts that it did. Decision 99's test
 * walks the stored object; this refuses to create one, which is a round earlier and cheaper.
 * A hit is a REFUSAL, never a scrub: silently removing a key would hide a change in an upstream
 * engine that this platform would then be the last to notice.
 */
export function refuseIdentifying(body: unknown, what: string): void {
  const hits = identifyingKeys(body);
  if (hits.length) {
    throw new LabError('CLASSIFICATION_REQUIRED',
      `${what} carries identifying key(s) ${hits.join(', ')} after de-identification. `
      + 'Decision 99: nothing identifying is written to lab_v2, so this case is refused rather than scrubbed — '
      + 'a scrub would hide a change in the upstream engine.');
  }
}

/**
 * ⚠️⚠️ DECISION 111 — THE TWO KEYS THAT REACHED PRODUCTION, DROPPED AT THE SOURCE.
 *
 * `LabSourceProvenance` (`lib/readmission-reconcile-core.ts:392-393`) carries `indexDocumentId` and
 * `readmitDocumentId`: the Firestore ids of the two discharge documents, each of which resolves to a
 * person. They rode inside `inputs.labSourceProvenance`, three levels down, and decision 101's
 * pattern matched `documentId` as a WHOLE key and not as a suffix — so decision 99's walk passed
 * and dataset `87b4986e` was stored with both. V found them in the Neon console.
 *
 * ⚠️ DROPPED, AND THE REST OF THE OBJECT KEPT. `labSourceProvenance` is how a reader knows whether
 * a finding's labs were structured or scraped, which window was read and whether its start was
 * inferred — all of that is evidence about the AUDIT and none of it names anyone. Dropping the whole
 * object to be safe would have cost the round its provenance; dropping two keys costs nothing.
 *
 * ⚠️ AND NOTHING READS THEM DOWNSTREAM. `runReconSequence` passes `labSourceProvenance` to
 * `reconcileFinding`, which reads `tier` and the counts. The two ids exist for the production
 * worker's own trace, which a lab run does not write.
 */
export const DROPPED_PROVENANCE_KEYS = ['indexDocumentId', 'readmitDocumentId'] as const;

export function stripProvenanceIds<T>(inputs: T): T {
  const i = inputs as unknown as { labSourceProvenance?: Record<string, unknown> | null };
  if (!i || typeof i !== 'object' || !i.labSourceProvenance || typeof i.labSourceProvenance !== 'object') return inputs;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(i.labSourceProvenance)) {
    if ((DROPPED_PROVENANCE_KEYS as readonly string[]).includes(k)) continue;
    kept[k] = v;
  }
  return { ...(inputs as object), labSourceProvenance: kept } as T;
}

/**
 * ⚠️⚠️ DECISION 114(a) — THE RECORDING PASS, AND WHY IT RUNS THE SEQUENCE INSTEAD OF GUESSING.
 *
 * The steps must be keyed by "the request hash the gateway would compute", and nobody can know
 * that without BUILDING the request: the four prompt builders assemble the evidence catalog, the
 * lab profile and the lane facts into a system/user pair, and only `runReconSequence` decides
 * which of them fire. So this runs the production sequence ONCE over the FROZEN row — the same
 * seven fields a replay gets, never the wider raw row — with a `PassFn` that answers each leg from
 * production's stored reply and records `dependencyHash(params)` on the way past. The keys are
 * therefore the hashes a replay will actually produce, and the shape is `recordIpdSteps`'
 * (`adapters/ipd-episode.ts:509-565`) exactly.
 *
 * ⚠️ THE PARAMS OBJECT IS THE ADAPTER'S, FIELD FOR FIELD. `dependencyHash` is `sha256` of the
 * canonical JSON of the object the adapter hands the gateway (`gateway.ts:56-68`) — messages,
 * temperature, token caps, provider and model deliberately EXCLUDED. If this built a different
 * object, every replay would diverge and the divergence would say nothing about the engine. The
 * literal below is `adapters/readmission.ts:94-101`, and a test asserts the two agree.
 *
 * ⚠️ AND EVERY FAILURE HERE IS `SOURCE_UNAVAILABLE`. A finding that cannot be recorded is not
 * frozen at all: `dataset_create` records it as an exclusion with a reason (`service.ts:234`) and
 * the operator sees the shortfall at freeze time. A frozen case with no `steps` would silently run
 * FRESH, which is the one outcome this round exists to make impossible to arrive at by accident.
 */
export async function recordReadmissionSteps(
  a: RecordReadmissionStepsArgs,
): Promise<Record<string, ReadmissionStep>> {
  const row = a.row;
  const lane = row.lane == null ? 'unknown' : String(row.lane);
  const auditStatus = row.audit_status == null ? null : String(row.audit_status);
  const traceId = row.trace_id == null ? '' : String(row.trace_id);

  // Only an AUDITED finding has a trace. A row at `detected` has none, and one at
  // `not_auditable` never ran a leg — neither is a replay, and neither is smoothed into one.
  if (auditStatus !== 'audited') {
    throw new LabError('SOURCE_UNAVAILABLE',
      `an exact readmission replay needs production's stored replies, and this finding is `
      + `audit_status '${auditStatus ?? 'null'}' rather than 'audited', so it has no trace to read`);
  }
  if (!traceId) {
    throw new LabError('SOURCE_UNAVAILABLE',
      'this finding is audited but carries no trace_id, so production\'s stored replies cannot be found');
  }

  const expected = expectedLegStages(row);

  let rows: Record<string, unknown>[];
  try {
    rows = await a.run(READMISSION_TRACE_SQL, [traceId]);
  } catch (e) {
    // FAIL-SAFE. A read fault is never a frozen case without steps.
    throw new LabError('SOURCE_UNAVAILABLE',
      `the trace_events read for this finding failed: ${String((e as Error).message).slice(0, 200)}`);
  }

  /**
   * Newest `seq` wins, which is `servedReadmitCall`'s own posture (`run.ts:119-135`,
   * `ORDER BY seq DESC LIMIT 1`). `(trace_id, stage)` is unique per leg on every path the survey
   * measured, so this only decides a case that should not arise — and if one ever does, the reply
   * that produced the stored finding is the last one, not the first.
   */
  const byStage = new Map<string, ReadmissionStep>();
  for (const r of rows) {
    const stage = r.stage == null ? '' : String(r.stage);
    if (!stage) continue;
    byStage.set(stage, {
      stage,
      request_hash: '',
      text: r.content == null ? '' : String(r.content),
      served: {
        model: r.model == null ? null : String(r.model),
        provider: r.provider == null ? null : String(r.provider),
      },
    });
  }

  // ⚠️ COUNTED BY DISTINCT STAGE, AGAINST THE LANE'S OWN EXPECTATION. Never against four.
  if (byStage.size < expected.length) {
    throw new LabError('SOURCE_UNAVAILABLE',
      `lane '${lane}' fires ${expected.length} recon leg(s) (${expected.join(', ')}) and this `
      + `finding's trace carries stored replies for ${byStage.size} of them `
      + `(found: ${[...byStage.keys()].sort().join(', ') || 'none'}); an exact replay needs all of them`);
  }

  const steps: Record<string, ReadmissionStep> = {};
  const missing: string[] = [];
  const pass = async (label: string, prompt: { system: string; user: string }) => {
    // The adapter's object, field for field — see the header.
    const params = {
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      temperature: 0.1,
      max_tokens: 3000,
    };
    const request_hash = dependencyHash(params);
    const stored = byStage.get(label);
    if (!stored) {
      missing.push(label);
      throw new LabError('SOURCE_UNAVAILABLE',
        `the recon sequence asked for leg '${label}' and this finding's trace carries no stored `
        + `llm_response at that stage (it carries: ${[...byStage.keys()].sort().join(', ') || 'none'})`);
    }
    steps[request_hash] = { ...stored, request_hash };
    return parsePassClaims(stored.text);
  };

  try {
    await runReconSequence({
      row: a.frozenRow as unknown as PendingRow,
      inputs: a.inputs,
      indexDischargeAt: a.indexDischargeAt,
      pass,
    });
  } catch (e) {
    if (e instanceof LabError) throw e;
    // `runReconSequence` throws a plain Error on an unparseable leg. A stored reply production
    // itself parsed that this cannot parse is a real finding about the engine, and it refuses.
    throw new LabError('SOURCE_UNAVAILABLE',
      `replaying this finding's stored replies through the recon sequence failed: `
      + `${String((e as Error).message).slice(0, 200)}`
      + (missing.length ? ` (no stored reply at: ${missing.join(', ')})` : ''));
  }

  if (!Object.keys(steps).length) {
    throw new LabError('SOURCE_UNAVAILABLE',
      `the recording pass over lane '${lane}' reached no leg at all, so this finding cannot be replayed exactly`);
  }
  return steps;
}

export async function freezeReadmissionFinding(
  dedupKey: string, deps: ReadmissionSourceDeps = {},
): Promise<FrozenReadmissionCase> {
  const key = String(dedupKey ?? '').trim();
  if (!key) throw new LabError('INVALID_INPUT', 'a readmission case is one finding, named by its dedup_key');
  const run = deps.run ?? liveRun;
  const assemble = deps.assemble ?? assembleForRow;
  const recordSteps = deps.recordSteps ?? recordReadmissionSteps;

  // ⚠️ OUTSIDE THE FENCE. See the header: both reads below throw inside a lab context by design.
  return exitLabExecution(async () => {
    const rows = await run(READMISSION_FINDING_SQL, [key]);
    const row = rows[0] as PendingRow | undefined;
    if (!row) throw new LabError('CASE_NOT_FOUND', `no readmission_findings row for that dedup_key`);

    const assembled = await assemble(row);
    if ('notAuditable' in assembled) {
      // Tier 3 and its siblings are a real answer about the finding, not a failure to read it —
      // but they are not a CASE, because there is nothing for the recon legs to reconcile.
      throw new LabError('CASE_NOT_FOUND',
        `that finding is not auditable: ${String(assembled.notAuditable)}. Production would write not_auditable and stop, and so does this.`);
    }

    const frozenRow: Record<string, unknown> = {};
    for (const f of FROZEN_ROW_FIELDS) frozenRow[f] = (row as Record<string, unknown>)[f] ?? null;

    const frozen = {
      engine: 'readmission' as const,
      row: frozenRow,
      // `identity` is NOT carried forward — see the header.
      inputs: stripProvenanceIds(assembled.inputs),
      index_discharge_at: assembled.indexDischargeAt ?? null,
      steps: {} as Record<string, ReadmissionStep>,
    };
    refuseIdentifying(frozen, 'the frozen readmission case');

    /**
     * ⚠️ DECISION 114(a) — AFTER THE WALK, AND WALKED AGAIN AFTERWARDS.
     *
     * The first walk guards `inputs` before this spends a second production read. The second one
     * covers what the read brought back: a step's `text` is engine REPLY text — the model's own
     * JSON claims, built by `parsePassClaims`' contract out of the evidence catalog, which
     * `assembleForRow` has already de-identified — so it carries no identifier by construction.
     * Decision 99's walk runs over it anyway, because "by construction" is the sentence every
     * leak in this programme has been filed under.
     */
    frozen.steps = await recordSteps({
      row: row as unknown as Record<string, unknown>,
      frozenRow,
      inputs: assembled.inputs,
      indexDischargeAt: assembled.indexDischargeAt ?? null,
      run,
    });
    refuseIdentifying(frozen, 'the frozen readmission case (with decision 114 steps)');

    const salt = deps.salt ?? memberSalt();
    return {
      /**
       * ⚠️ THE CASE KEY IS A HASH OF THE dedup_key, NEVER THE dedup_key. Decision 101 makes
       * `dedup_key` an identifying field, and a case key is stored on the dataset, on every item
       * and in every report. Hashing it keeps two runs of the same finding comparable — which is
       * all a case key is for — without the platform holding the pair.
       */
      case_key: `readmit:${createHash('sha256').update(`${salt}|${key}`).digest('hex').slice(0, 32)}`,
      // Decision 104. `uhid` is the member identifier on this row; absent it, no key rather than a
      // hash of the empty string, which would collide across every member that lacks one.
      member_key: row.uhid ? memberKeyOf(String(row.uhid), salt) : null,
      frozen,
      source_versions: {
        origin: 'readmission_findings',
        audit_status: row.audit_status ?? null,
        engine_version: row.engine_version ?? null,
        // Decision 114 — how many legs this case can replay, beside the freeze that recorded them.
        // The trace_id itself is NOT stored: it is a handle on a production audit of one member.
        recorded_steps: Object.keys(frozen.steps).length,
        frozen_at: new Date().toISOString(),
      },
    };
  });
}

/** The verdict production recorded for this finding — the golden A/B's B side. */
export async function auditedVerdict(
  dedupKey: string, deps: ReadmissionSourceDeps = {},
): Promise<{ verdict: string | null; audit_status: string | null; engine_version: string | null; model: string | null } | null> {
  const run = deps.run ?? liveRun;
  return exitLabExecution(async () => {
    const rows = await run(READMISSION_VERDICT_SQL, [String(dedupKey)]);
    const r = rows[0];
    if (!r) return null;
    return {
      verdict: r.verdict == null ? null : String(r.verdict),
      audit_status: r.audit_status == null ? null : String(r.audit_status),
      engine_version: r.engine_version == null ? null : String(r.engine_version),
      model: r.model == null ? null : String(r.model),
    };
  });
}
