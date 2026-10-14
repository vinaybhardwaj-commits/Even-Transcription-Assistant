/**
 * lib/lab-v2/adapters/dataset-freeze.ts — the `dataset_freeze` operation (§17.11 items 1 and 2,
 * decisions 138, 144 and 147).
 *
 * WHY A DATASET CREATION BECAME A JOB. `dataset_create ipd_discharge` used to freeze every
 * requested document inside the tool call. After D2c each freeze also RUNS THE ENGINE once — six
 * legs answered from `trace_events`, three or four corpus reads outside the fence — and two of the
 * twenty documents V froze on 06 Sep never returned (decision 139). A route with `maxDuration = 60`
 * cannot host that, and a caller holding a connection open for it learns nothing when it dies.
 *
 * So decision 138: for `ipd_discharge`, `dataset_create` SUBMITS A RUN and returns
 * `{freeze_run_id, state: 'freezing', requested}` at once. The tick claims one case per item, with
 * a lease and a heartbeat and every safety property the experiment queue already has, and the
 * dataset object is assembled by the LAST ITEM TO SETTLE. `readmission` and `preop` stay
 * synchronous: neither runs an engine at freeze time and neither has ever timed out.
 *
 * ⚠️ THE SOURCE KEY LIVES IN THE ITEM PAYLOAD AND IS DELETED WHEN THE ITEM SETTLES. A `documentId`
 * resolves to a person (`sources/requests.ts:218`). The run's items are the run's private working
 * memory — the same place an experiment item already holds a frozen clinical body — and the key is
 * removed from the payload the moment the item is done with it, on the failure path as well as the
 * success one. It never reaches `items.case_key` (that is a content hash), never reaches the
 * dataset object, and never reaches an exclusion, which is keyed by the same hash decision 99's own
 * exclusion path already uses.
 *
 * ⚠️ THE ADAPTER DOES NOT THROW ON A FAILED CASE, AND THAT IS DELIBERATE. A throw would fail the
 * item before the assembly ran, so the LAST case to fail could silently take the dataset with it.
 * Instead every outcome — frozen or refused — is returned as a result with an `execution_status`,
 * and the assembly runs either way. Decision 147's deadline breach is therefore an EXCLUSION with
 * the phase and the elapsed milliseconds in its reason, exactly as the ruling asks.
 *
 * ⚠️ IT IS NOT IN `ALL_ADAPTERS`. Like the repair adapters (decision 67), the only way an item
 * reaches this code is by being claimed from a run whose `operation` is `dataset_freeze`, and that
 * string is written by `dataset_create` and by nothing a caller controls.
 */
import { createHash } from 'crypto';
import type { Db } from '../db';
import { LabError, datasetBodySchema, hash } from '../contracts';
import { getObject, getRun, itemsOf, putObject, recordEvent } from '../store';
import { identifyingKeys } from '../sources/requests';
import { freezeIpdDischargeDocument, type IpdDischargeSourceDeps } from '../sources/ipd-discharge';
import type { Adapter, AdapterContext, AdapterOutcome } from './types';

/** Decision 144 — the operation literal, and the engine it applies to. */
export const DATASET_FREEZE_ENGINES = ['ipd_discharge'] as const;

/** Every freeze item carries this, and `arm_hash` is a label rather than an arm: a freeze has none. */
export const FREEZE_ARM_HASH = 'dataset_freeze';

/**
 * The item's own key, and it is a CONTENT HASH of the engine and the source key rather than the
 * salted case key the freeze will mint. Two reasons: `items.case_key` is stored and read back by
 * every observation tool, so it may not be an identifier under any salt; and the item must be
 * addressable before the salt is even consulted, because a deployment with no `LAB_V2_MEMBER_SALT`
 * must fail at the freeze with `NOT_CONFIGURED` and not at the queue with a mystery.
 */
export function freezeItemKey(engine: string, sourceKey: string): string {
  return `freeze:${hash({ engine, key: sourceKey })}`;
}

/** Decision 99's shape for an exclusion: a hash of what failed, never the key that failed. */
export function exclusionKey(engine: string, sourceKey: string): string {
  return `${engine}:${createHash('sha256').update(`excluded|${sourceKey}`).digest('hex').slice(0, 32)}`;
}

export interface FreezeItemPayload {
  engine: string;
  source_key_hash: string;
  /** Removed from the row when the item settles — see the header. */
  source_key?: string;
}

/** What one settled freeze item leaves behind, as its artifact. The assembly reads only these. */
export interface FreezeItemArtifact {
  ok: boolean;
  engine: string;
  case_key: string;
  member_key: string | null;
  frozen: Record<string, unknown> | null;
  source_versions: Record<string, unknown> | null;
  reason: string | null;
}

export interface DatasetFreezeDeps {
  db: Db;
  /** Injection seam for unit tests (repo idiom). Production passes nothing. */
  freeze?: (documentId: string, deps?: IpdDischargeSourceDeps) => Promise<{
    case_key: string; member_key: string | null; frozen: unknown; source_versions: Record<string, unknown>;
  }>;
  /** Handed to the freeze so the recording pass's phase deadlines can be shortened in a test. */
  sourceDeps?: IpdDischargeSourceDeps;
}

/**
 * Erase the source key from this item's payload. Runs on EVERY settle — success, refusal or a
 * deadline breach — because the key's only job was to be read once.
 *
 * ⚠️ IT IS A `jsonb - 'source_key'`, NOT A REWRITE OF THE ROW. A read-modify-write would race the
 * heartbeat's own writes; the minus operator is one statement and touches one key.
 */
export async function eraseSourceKey(db: Db, itemId: string): Promise<void> {
  await db.query(`UPDATE lab_v2.items SET payload = payload - 'source_key' WHERE id = $1`, [itemId]);
}

/**
 * Assemble the dataset from every item of this run, and return what was written. Called by the
 * LAST item to settle, with its own outcome passed in — its row is still `running` at that moment,
 * so it cannot read its own result back out of the table.
 *
 * Returns null when this item is not the last: some sibling is still queued or running, and that
 * sibling will do the assembly when it finishes.
 */
export async function assembleIfLast(
  db: Db, runId: string, selfItemId: string, self: FreezeItemArtifact,
): Promise<{ dataset_id: string; hash: string; frozen: number; excluded: number; requested: number } | null> {
  const items = await itemsOf(db, runId, 1000, 0);
  const others = items.filter((i) => i.id !== selfItemId);
  const settled = (state: string) => state !== 'queued' && state !== 'running';
  if (others.some((i) => !settled(i.state))) return null;

  const run = await getRun(db, runId);
  if (!run) throw new LabError('NOT_FOUND', `freeze run ${runId} vanished mid-assembly`);

  const cases: { case_key: string; member_key: string | null; frozen: Record<string, unknown> }[] = [];
  const excluded: { case_key: string; reason: string }[] = [];
  const sourceVersions: Record<string, unknown>[] = [];

  const take = (a: FreezeItemArtifact | null, fallbackKey: string) => {
    if (!a) {
      excluded.push({ case_key: fallbackKey, reason: 'the freeze item settled without a readable artifact' });
      return;
    }
    if (a.ok && a.frozen) {
      cases.push({ case_key: a.case_key, member_key: a.member_key, frozen: a.frozen });
      if (a.source_versions) sourceVersions.push(a.source_versions);
    } else {
      excluded.push({ case_key: a.case_key, reason: a.reason ?? 'the freeze failed with no reason recorded' });
    }
  };

  for (const i of others) {
    const stored = (i.result ?? null) as { artifact_id?: string } | null;
    const artifact = stored?.artifact_id ? await getObject(db, stored.artifact_id) : null;
    take((artifact?.body ?? null) as FreezeItemArtifact | null, i.case_key);
  }
  take(self, self.case_key);

  if (!cases.length) {
    /**
     * Every case failed. The run is `failed` by its own items and there is nothing to store: a
     * dataset of zero cases would not parse (`datasetBodySchema` requires one) and would be a
     * research object asserting nothing. The reasons are on the items, where `run_result` reads them.
     */
    await recordEvent(db, 'system', runId, 'dataset_freeze_empty',
      { requested: items.length, excluded: excluded.length }).catch(() => {});
    return null;
  }

  // Decision 99 one more time, on the ASSEMBLED cases — `sliceDDataset` runs the same walk at the
  // same point, and for the same reason: assembly is the last thing to touch a case before storage.
  for (const c of cases) {
    const hits = identifyingKeys(c.frozen);
    if (hits.length) {
      throw new LabError('CLASSIFICATION_REQUIRED',
        `a frozen ipd_discharge case carries identifying key(s) ${hits.join(', ')}; refused rather than stored (decision 99)`);
    }
  }

  const body = datasetBodySchema.parse({
    engine: 'ipd_discharge',
    cases,
    snapshot_policy: 'episode_at_creation',
    exclusions: excluded.map((e) => e.case_key),
    classification: 'deidentified',
    source_versions: {
      origin: 'discharge_extracted_cases + db13',
      frozen_at: new Date().toISOString(),
      cases: cases.length,
      excluded: excluded.length,
      requested: items.length,
      freeze_run_id: runId,
      // The per-case detail every synchronous freeze already reported, kept per case rather than
      // flattened, so a dataset assembled from N items says what each of them recorded.
      per_case: sourceVersions,
      exclusion_reasons: excluded,
    },
    replay_exactness: 'frozen',
  });

  const { object } = await putObject(db, run.owner, 'dataset', body, 'deidentified', `freeze:${runId}`);
  await recordEvent(db, 'system', runId, 'dataset_freeze_assembled', {
    dataset_id: object.id, hash: object.hash, frozen: cases.length, excluded: excluded.length, requested: items.length,
  }).catch(() => {});
  return { dataset_id: object.id, hash: object.hash, frozen: cases.length, excluded: excluded.length, requested: items.length };
}

export function makeDatasetFreezeAdapter(deps: DatasetFreezeDeps): Adapter {
  const freeze = deps.freeze ?? (freezeIpdDischargeDocument as unknown as NonNullable<DatasetFreezeDeps['freeze']>);
  return {
    engine: 'ipd_discharge',
    // A freeze prices no stage: it makes no governed model call at all. The recording pass answers
    // six labels from `trace_events`, the cite gate from a literal and the skeleton by throwing.
    stages: [],
    engineVersion: () => 'dataset_freeze/1.0',
    frozenInputs: [],
    /** Decision 147's own budget for one case: the recording pass, plus its reads. */
    perAttemptTimeoutMs: 300_000,

    async run(ctx: AdapterContext): Promise<AdapterOutcome> {
      /**
       * ⚠️ THE PAYLOAD IS READ FROM THE ROW, NOT FROM `ctx.frozen`, AND THAT IS DECISION 144's
       * SHAPE BEING HONOURED RATHER THAN WORKED AROUND. The ruling says the item carries
       * `{engine, source_key_hash, source_key}` — flat, with no `frozen` wrapper — because there is
       * nothing frozen yet; freezing is what this item is for. `AdapterContext` hands an adapter
       * `payload.frozen`, so a freeze item would arrive as `{}`.
       *
       * Nesting the three fields under `frozen` to fit the seam would have put the source key one
       * level deeper in the same row and changed nothing about who can read it; widening the seam
       * for every engine would change a shared path for one caller's benefit. This adapter already
       * holds the db — the assembly needs it — so it reads its own row, which is also the only
       * place the erase can be observed from.
       */
      const rows = await deps.db.query<{ payload: FreezeItemPayload }>(
        `SELECT payload FROM lab_v2.items WHERE id = $1`, [ctx.itemId]);
      const payload = (rows[0]?.payload ?? {}) as FreezeItemPayload;
      const sourceKey = payload?.source_key == null ? '' : String(payload.source_key);
      const startedAt = Date.now();
      let artifact: FreezeItemArtifact;

      if (!sourceKey) {
        artifact = {
          ok: false, engine: 'ipd_discharge', case_key: ctx.caseKey, member_key: null,
          frozen: null, source_versions: null,
          reason: 'SOURCE_UNAVAILABLE: this freeze item has already settled once and its source key was '
            + 'erased from the payload (decision 144). Re-freeze the document through dataset_create.',
        };
      } else {
        try {
          ctx.event('freeze_phase', { phase: 'freeze', state: 'started' });
          const out = await freeze(sourceKey, {
            ...(deps.sourceDeps ?? {}),
            onPhase: (phase, state, ms) => ctx.event('freeze_phase', { phase, state, ms }),
          } as IpdDischargeSourceDeps);
          artifact = {
            ok: true, engine: 'ipd_discharge', case_key: out.case_key, member_key: out.member_key,
            frozen: out.frozen as Record<string, unknown>,
            source_versions: out.source_versions, reason: null,
          };
          ctx.event('freeze_phase', { phase: 'freeze', state: 'frozen', ms: Date.now() - startedAt });
        } catch (e) {
          const err = e as LabError;
          /**
           * ⚠️ `NOT_CONFIGURED` AND `CLASSIFICATION_REQUIRED` ARE RE-THROWN, exactly as
           * `sliceDDataset` re-throws them. The first is the deployment's problem (no member salt)
           * and would otherwise produce N identical exclusions; the second means an upstream engine
           * stopped de-identifying, and burying that in an exclusion list is how it would be missed.
           */
          if (err.code === 'NOT_CONFIGURED' || err.code === 'CLASSIFICATION_REQUIRED') throw err;
          artifact = {
            ok: false, engine: 'ipd_discharge', case_key: exclusionKey('ipd_discharge', sourceKey),
            member_key: null, frozen: null, source_versions: null,
            reason: `${err.code ?? 'ERROR'}: ${String(err.message).slice(0, 300)}`,
          };
          ctx.event('freeze_phase', { phase: 'freeze', state: 'failed', ms: Date.now() - startedAt, code: err.code ?? null });
        }
      }

      // The key has done its one job. Erased before the assembly, so a dataset can never be
      // assembled from a run that still holds one.
      await eraseSourceKey(deps.db, ctx.itemId).catch(() => { /* the erase is best effort; the key is not returned either way */ });

      const assembled = await assembleIfLast(deps.db, ctx.runId, ctx.itemId, artifact);
      if (assembled) ctx.event('dataset_assembled', { ...assembled });

      return {
        result: artifact,
        /**
         * Decision 144 — `dataset_id` and `hash` ride in the SUMMARY of the item that assembled the
         * dataset, which is what `run_result` returns inline. `run_status` and `run_result` keep
         * their shapes; the summary is already `z.record(z.unknown()).nullable()` on both.
         */
        summary: {
          engine: 'ipd_discharge',
          ok: artifact.ok,
          case_key: artifact.case_key,
          reason: artifact.reason,
          ms: Date.now() - startedAt,
          ...(assembled ?? {}),
        },
        execution_status: artifact.ok ? 'succeeded' : 'failed',
        assessment_status: artifact.ok ? 'assessed' : 'not_reached',
      };
    },
  };
}

/** The map `worker.ts` routes a `dataset_freeze` item through. One engine, by decision 144. */
export function freezeAdapters(db: Db): Record<string, Adapter> {
  return { ipd_discharge: makeDatasetFreezeAdapter({ db }) };
}
