/**
 * lib/lab-v2/releases/apply.ts — `release_apply` (LAB-MCP-V2-PRD-v1.0 §11, decisions 79, 79a, 81).
 *
 * ⚠️ THIS IS THE FUNCTION THAT CHANGES WHAT A CLINICIAN'S RETRIEVAL RETURNS. Everything in it is
 * a check, in an order that matters, and the write itself is v1's.
 *
 * THE ORDER, AND WHY IT IS THIS ORDER.
 *
 *   1. IDEMPOTENCE FIRST. A receipt for this release already exists ⇒ return it and touch nothing.
 *      §11 requires it, and putting it first means a retry after a timeout cannot re-activate.
 *   2. THE APPROVAL, before anything is read from production. Missing, expired, bound to a
 *      different hash, or written by the preparer ⇒ refuse by name. There is no reason to read a
 *      corpus for a release nobody approved.
 *   3. THE STAGED SET (decision 79a). v1's activation is keyed on the LABEL, so it moves whatever
 *      is under that label at the moment it runs. The ids are re-read and compared with the set the
 *      preparer recorded; a difference is `STAGED_SET_CHANGED` and the release must be re-prepared.
 *      Without this check, a chunk added to the batch after review would be activated unreviewed.
 *   4. THE COMPARE-AND-SWAP. One statement, `WHERE name = $1 AND revision = $2`. Zero rows is
 *      `REVISION_MISMATCH`. It claims the slot BEFORE the production write, so two applies racing
 *      cannot both reach `corpusActivate`.
 *   5. THE ACTIVATION — v1's `corpusActivate`, imported through `releases/corpus-writer.ts`.
 *   6. THE POST-CHECK (decision 79a). The ids now under `lab:<label>` must equal the recorded set.
 *      If they do not, the receipt records `ACTIVATION_DRIFT` with both sets and the apply STOPS —
 *      it does not try to fix anything, because the one thing worse than an unexpected activation
 *      is an unexpected activation plus an improvised repair.
 *   7. THE RECEIPT, always. Including on drift.
 *
 * ⚠️ THE REVISION IS BUMPED BEFORE THE WRITE AND STAYS BUMPED ON DRIFT. That is deliberate: rows
 * moved, so the corpus is not what revision N described any more, and a revision that rolled back
 * to N would say it was. The receipt carries the truth; the revision carries "something happened".
 *
 * ⚠️ ROUND C2 — THE `rules` TARGET RUNS THE SAME SEVEN STEPS, and steps 1 and 2 are literally the
 * same code. Decision 81's refusals are about the RELEASE, not about what is being released, so
 * sharing them is what makes "the same checks apply to rules exactly as to corpus" a fact rather
 * than a claim two functions each make separately. Only steps 3 to 6 differ, because what a rules
 * release changes is one row in `lvc_recommendations` rather than a set of chunks:
 *
 *   3'. THE PROPOSAL IS RE-READ. Still `proposed`, and still the same statement. If v1's own
 *       `lvc_ratify` promoted it in the meantime, this is `STAGED_SET_CHANGED` for the same reason
 *       a chunk appearing under a label is: the reviewed thing is not the thing that would land.
 *   5'. THE PROMOTION — v1's `lvcRatify`, imported through `releases/rules-target.ts`.
 *       ⚠️ `ratified_by` IS THE APPROVING PRINCIPAL AND THE RATIONALE IS THE REVIEW'S OWN. v1
 *       requires a ratifier that is not the default author because "a ratification has to name a
 *       person, or the append-only ledger records nothing accountable"; decision 5 says the
 *       reviewer key is the accountable one. So `lvc_ratifications` records the key that approved
 *       this release and the words it was approved with, and neither was typed twice.
 *   6'. THE POST-CHECK reads the promoted row back by id and requires it active. A promotion that
 *       returned an id naming no active row is `ACTIVATION_DRIFT`, receipted, and stops.
 */
import {
  APPROVAL_TTL_MS, LabError, hash, type ReleaseTarget,
} from '../contracts';
import {
  advanceTarget, getObject, getReceipt, getTarget, putReceipt, recordEvent, reviewsOf,
} from '../store';
import { activateLabel, type CorpusWriterDeps } from './corpus-writer';
import { readStagedIds } from '../tools/corpus';
import {
  RECOMMENDATION_SQL, promoteProposal, readProposal, type RulesDeps,
} from './rules-target';
import { boundedRead } from '../sources/read';
import type { ReviewRow } from '../store';
import type { Db } from '../db';

export interface ApplyDeps extends CorpusWriterDeps, RulesDeps {
  stagedIds?: (label: string) => Promise<number[]>;
  now?: () => number;
}

export interface ReleaseArtifact {
  kind?: string; target?: ReleaseTarget; label?: string; chunk_ids?: number[];
  staged_set_id?: string; predecessor_visible_hash?: string; predecessor_id?: string | null;
  impact_ref?: string | null; expected_revision?: number;
  /** The `rules` target (C2). Absent on a corpus release. */
  proposal_id?: string; proposal_hash?: string; statement?: string;
  simulation_ref?: string | null; predecessor_rule_ids?: string[];
}

/** Sorted, so two id lists that differ only in order are the SAME set. */
const asSet = (ids: readonly number[]): number[] => [...new Set(ids.map(Number))].sort((a, b) => a - b);
const sameSet = (a: readonly number[], b: readonly number[]) => hash(asSet(a)) === hash(asSet(b));

export async function releaseApply(
  db: Db, principal: string, args: { release_id: string }, deps: ApplyDeps = {},
) {
  const now = deps.now ?? Date.now;
  const release = await getObject(db, args.release_id);
  if (!release || release.kind !== 'release') throw new LabError('NOT_FOUND', `no release ${args.release_id}`);
  const artifact = (release.body ?? {}) as ReleaseArtifact;
  const target = String(artifact.target ?? '') as ReleaseTarget;
  const label = String(artifact.label ?? '');
  const recorded = asSet(artifact.chunk_ids ?? []);

  // ── 1. idempotence, before anything else ────────────────────────────────────────────
  const existing = await getReceipt(db, release.id, 'apply');
  if (existing) {
    return { ...receiptOut(existing), replayed_receipt: true };
  }

  // ── 2. the approval ─────────────────────────────────────────────────────────────────
  const reviews = await reviewsOf(db, release.id);
  const approvals = reviews.filter((r) => r.decision === 'approved');
  if (!approvals.length) {
    throw new LabError('APPROVAL_MISSING',
      `release ${release.id} has no approval${reviews.length ? ` (${reviews.length} review(s), none approved)` : ''}`);
  }
  // ⚠️ Checked in this order so the message names the REAL reason. An approval that is both stale
  // and bound to an old hash is reported as the hash mismatch, because re-approving would not fix
  // it — the artifact is a different object now.
  const onHash = approvals.filter((r) => r.artifact_hash === release.hash);
  if (!onHash.length) {
    throw new LabError('APPROVAL_HASH_MISMATCH',
      `the approval on record names artifact ${approvals[0].artifact_hash.slice(0, 12)}… and this release is ${release.hash.slice(0, 12)}…; the artifact changed after it was reviewed`);
  }
  const live = onHash.filter((r) => new Date(r.expires_at).getTime() > now());
  if (!live.length) {
    throw new LabError('APPROVAL_STALE',
      `every approval on this artifact expired (approvals are good for ${APPROVAL_TTL_MS / 86_400_000} days); it must be reviewed again`);
  }
  const approval = live[0];
  // Decision 5. Refused at review too; refused again here because a review row could predate a
  // change of key ownership, and this is the last moment before a production write.
  if (approval.reviewer === release.owner) {
    throw new LabError('REVIEWER_IS_PREPARER',
      `principal '${release.owner}' both prepared and approved this release; the two keys must differ (decision 5)`);
  }

  // ── the one fork: everything above is decision 81 and is shared verbatim ────────────
  if (target === 'rules') return applyRules(db, principal, release, artifact, approval, deps, now);
  if (target !== 'corpus') {
    throw new LabError('ENGINE_UNSUPPORTED', `'${target}' has no apply path`);
  }
  if (!label || !recorded.length) {
    throw new LabError('INVALID_INPUT', `release ${release.id} carries no label or no chunk ids`);
  }

  // ── 3. the staged set (decision 79a) ────────────────────────────────────────────────
  const current = asSet(await (deps.stagedIds ?? readStagedIds)(label));
  if (!sameSet(current, recorded)) {
    const added = current.filter((id) => !recorded.includes(id));
    const removed = recorded.filter((id) => !current.includes(id));
    throw new LabError('STAGED_SET_CHANGED',
      `labq:${label} now holds ${current.length} chunk(s); the release was prepared and reviewed against ${recorded.length}`
      + `${added.length ? `, ${added.length} added` : ''}${removed.length ? `, ${removed.length} gone` : ''}`
      + ' — re-run release_prepare so the review names what would actually be activated',
      { added, removed });
  }

  // ── 4. the compare-and-swap ─────────────────────────────────────────────────────────
  const t = await getTarget(db, target);
  if (!t) throw new LabError('STORE_UNAVAILABLE', `target '${target}' is missing; apply 0002_releases.sql`);
  const expected = Number(artifact.expected_revision ?? -1);
  const revision = await advanceTarget(db, target, expected, {
    artifact_id: release.id,
    predecessor_id: t.artifact_id,
    release_id: release.id,
  });
  if (revision == null) {
    throw new LabError('REVISION_MISMATCH',
      `target '${target}' is at revision ${t.revision}; this release was prepared against ${expected}. Another release landed first — re-prepare against what is in force.`);
  }

  // ── 5. the activation: v1's function, imported ──────────────────────────────────────
  let activated: { source: string; activated: number; ids: number[] };
  try {
    activated = await activateLabel(label, deps);
  } catch (e) {
    // The revision has already moved and the write failed. The receipt is the only place that can
    // say so, and it is written rather than swallowed.
    const body = failureBody(release, artifact, approval.id, recorded, String((e as Error).message));
    const receipt = await putReceipt(db, { release_id: release.id, target, revision, kind: 'apply', body });
    await recordEvent(db, principal, release.id, 'release_apply_failed', { release_id: release.id, error: String((e as Error).message).slice(0, 300) }).catch(() => {});
    return { ...receiptOut(receipt), replayed_receipt: false };
  }

  // ── 6. the post-check (decision 79a) ────────────────────────────────────────────────
  const landed = asSet(activated.ids);
  const drifted = !sameSet(landed, recorded);

  // ── 7. the receipt, always ──────────────────────────────────────────────────────────
  const body = {
    kind: 'apply',
    outcome: drifted ? 'activation_drift' : 'applied',
    release_id: release.id,
    artifact_hash: release.hash,
    target,
    label,
    revision,
    previous_revision: expected,
    approval: { review_id: approval.id, reviewer: approval.reviewer, expires_at: approval.expires_at },
    preparer: release.owner,
    // ⚠️ NAMED, NOT RESTATED. An earlier draft copied v1's statement into the receipt; the grep
    // test caught it, and it was right to: a receipt carrying a copy of SQL is a copy that can
    // drift from the statement that actually ran. The file and the function are the durable facts.
    writer: 'lib/lab.ts corpusActivate (v1), imported',
    recorded_chunk_ids: recorded,
    activated_chunk_ids: landed,
    activated_count: activated.activated,
    active_source: activated.source,
    predecessor_id: t.artifact_id,
    predecessor_visible_hash: artifact.predecessor_visible_hash ?? null,
    impact_ref: artifact.impact_ref ?? null,
    applied_at: new Date(now()).toISOString(),
    ...(drifted
      ? {
        drift: {
          // ⚠️ BOTH SETS, IN FULL. A rollback is driven off `activated_chunk_ids`, so what actually
          // moved has to be recoverable from the receipt even when it is not what anyone expected.
          expected: recorded,
          landed,
          extra: landed.filter((id) => !recorded.includes(id)),
          missing: recorded.filter((id) => !landed.includes(id)),
          note: 'the activation moved a set that is not the reviewed set; the release STOPPED here and nothing was repaired automatically',
        },
      }
      : {}),
  };
  const receipt = await putReceipt(db, { release_id: release.id, target, revision, kind: 'apply', body });
  await recordEvent(db, principal, release.id, drifted ? 'release_activation_drift' : 'release_applied', {
    release_id: release.id, target, revision, chunks: landed.length,
  }).catch(() => {});

  if (drifted) {
    throw new LabError('ACTIVATION_DRIFT',
      `the activation moved ${landed.length} chunk(s) and the reviewed set was ${recorded.length}; receipt ${receipt.id} records both sets and the release stopped`,
      { receipt_id: receipt.id, expected: recorded, landed });
  }
  return { ...receiptOut(receipt), replayed_receipt: false };
}

function failureBody(
  release: { id: string; hash: string; owner: string }, artifact: ReleaseArtifact,
  reviewId: string, recorded: number[], message: string,
) {
  return {
    kind: 'apply',
    outcome: 'failed',
    release_id: release.id,
    artifact_hash: release.hash,
    target: artifact.target,
    label: artifact.label,
    approval: { review_id: reviewId },
    preparer: release.owner,
    recorded_chunk_ids: recorded,
    activated_chunk_ids: [],
    error: message.slice(0, 500),
    note: 'the revision was already advanced when the activation failed; nothing was activated',
  };
}

export function receiptOut(r: { id: string; release_id: string; target: string; revision: string | number; kind: string; body: unknown; created_at: string }) {
  const body = (r.body ?? {}) as Record<string, unknown>;
  return {
    receipt_id: r.id,
    release_id: r.release_id,
    target: r.target,
    revision: Number(r.revision),
    kind: r.kind,
    outcome: String(body.outcome ?? r.kind),
    chunk_ids: (body.activated_chunk_ids ?? body.rolled_back_chunk_ids ?? []) as number[],
    body,
    created_at: String(r.created_at),
  };
}

/**
 * THE `rules` TARGET (§17.7 C2, decisions 89 and 90). Steps 3' to 7 — steps 1 and 2 already ran in
 * `releaseApply` and are the same code for both targets.
 */
async function applyRules(
  db: Db, principal: string,
  release: { id: string; hash: string; owner: string },
  artifact: ReleaseArtifact,
  approval: ReviewRow,
  deps: ApplyDeps,
  now: () => number,
) {
  const proposalId = String(artifact.proposal_id ?? '');
  if (!proposalId) {
    throw new LabError('INVALID_INPUT', `release ${release.id} is a rules release that names no proposal`);
  }

  // ── 3'. the proposal, re-read ───────────────────────────────────────────────────────
  const proposal = await readProposal(proposalId, deps);
  if (proposal.status !== 'proposed') {
    throw new LabError('STAGED_SET_CHANGED',
      `proposal ${proposalId} is now '${proposal.status}'${proposal.promoted_id ? ` and was promoted as ${proposal.promoted_id}` : ''}; `
      + 'it was prepared and reviewed as a staged proposal — re-run release_prepare so the review names what would actually be promoted');
  }
  if (artifact.statement != null && String(artifact.statement) !== proposal.statement) {
    throw new LabError('STAGED_SET_CHANGED',
      `proposal ${proposalId}'s statement has changed since this release was prepared; the approval on record is about text that is no longer in the table`);
  }

  // ── 4. the compare-and-swap ─────────────────────────────────────────────────────────
  const t = await getTarget(db, 'rules');
  if (!t) throw new LabError('STORE_UNAVAILABLE', "target 'rules' is missing; apply 0002_releases.sql");
  const expected = Number(artifact.expected_revision ?? -1);
  const revision = await advanceTarget(db, 'rules', expected, {
    artifact_id: release.id, predecessor_id: t.artifact_id, release_id: release.id,
  });
  if (revision == null) {
    throw new LabError('REVISION_MISMATCH',
      `target 'rules' is at revision ${t.revision}; this release was prepared against ${expected}. Another release landed first — re-prepare against what is in force.`);
  }

  // ── 5'. the promotion: v1's lvcRatify, imported ─────────────────────────────────────
  let promoted: { promoted_id: string; raw: unknown };
  try {
    promoted = await promoteProposal({
      proposal_id: proposalId,
      // ⚠️ Decision 5, and v1's own requirement, satisfied by the same fact. See the header note.
      ratified_by: approval.reviewer,
      rationale: approval.rationale,
    }, deps);
  } catch (e) {
    const body = {
      kind: 'apply', outcome: 'failed', release_id: release.id, artifact_hash: release.hash,
      target: 'rules', label: artifact.label ?? `rule:${proposalId}`,
      approval: { review_id: approval.id }, preparer: release.owner,
      proposal_id: proposalId, promoted_id: null,
      error: String((e as Error).message).slice(0, 500),
      note: 'the revision was already advanced when the promotion failed; nothing was promoted',
    };
    const receipt = await putReceipt(db, { release_id: release.id, target: 'rules', revision, kind: 'apply', body });
    await recordEvent(db, principal, release.id, 'release_apply_failed', {
      release_id: release.id, error: String((e as Error).message).slice(0, 300),
    }).catch(() => {});
    return { ...receiptOut(receipt), replayed_receipt: false };
  }

  // ── 6'. the post-check ──────────────────────────────────────────────────────────────
  // ⚠️ READ BACK, NEVER ASSUME. `lvcRatify` returns the id its own INSERT produced; whether that row
  // is ACTIVE — the only thing that puts it in `getLvcRules`' `WHERE status = 'active'` — is a
  // separate fact, and this is the round that stopped assuming such things (decision 87).
  const read = deps.read ?? (<T>(source: string, statement: string, params: unknown[] = []) => boundedRead<T>(source, statement, params, 500));
  const rows = await read<Record<string, unknown>>('lvc_recommendations', RECOMMENDATION_SQL(promoted.promoted_id))
    .catch(() => [] as Record<string, unknown>[]);
  const landed = rows[0] ?? null;
  const status = landed == null ? null : String(landed.status ?? '');
  const drifted = landed == null || status !== 'active';

  // ── 7. the receipt, always ──────────────────────────────────────────────────────────
  const body = {
    kind: 'apply',
    outcome: drifted ? 'activation_drift' : 'applied',
    release_id: release.id,
    artifact_hash: release.hash,
    target: 'rules',
    label: artifact.label ?? `rule:${proposalId}`,
    revision,
    previous_revision: expected,
    approval: { review_id: approval.id, reviewer: approval.reviewer, expires_at: approval.expires_at },
    preparer: release.owner,
    // Named, not restated — the same rule the corpus receipt follows, and the reason the decision 79
    // grep passes over this file.
    writer: 'lib/mcp-tools.ts lvcRatify (v1), imported (decision 89)',
    proposal_id: proposalId,
    // ⚠️ THE ID A ROLLBACK WILL RETIRE. Decision 90 retires exactly this and nothing else, so if it
    // were absent the release would be unrollbackable — which is why promoteProposal refuses a
    // success that carries no id rather than receipting a null.
    promoted_id: promoted.promoted_id,
    ratified_by: approval.reviewer,
    statement: proposal.statement,
    simulation_ref: artifact.simulation_ref ?? artifact.impact_ref ?? null,
    predecessor_rule_ids: artifact.predecessor_rule_ids ?? [],
    predecessor_id: artifact.predecessor_id ?? null,
    recorded_chunk_ids: [] as number[],
    activated_chunk_ids: [] as number[],
    applied_at: new Date(now()).toISOString(),
    ...(drifted
      ? {
        drift: {
          promoted_id: promoted.promoted_id,
          status_now: status,
          note: landed == null
            ? 'lvc_ratify reported an id that lvc_recommendations does not return; the release STOPPED here and nothing was repaired automatically'
            : `the promoted row is '${status}', not 'active', so it is not in the engine's selection; the release STOPPED here`,
        },
      }
      : {}),
  };
  const receipt = await putReceipt(db, { release_id: release.id, target: 'rules', revision, kind: 'apply', body });
  await recordEvent(db, principal, release.id, drifted ? 'release_activation_drift' : 'release_applied', {
    release_id: release.id, target: 'rules', revision, promoted_id: promoted.promoted_id,
  }).catch(() => {});

  if (drifted) {
    throw new LabError('ACTIVATION_DRIFT',
      `lvc_ratify promoted ${promoted.promoted_id} and the row reads '${status ?? 'absent'}' rather than 'active'; receipt ${receipt.id} records it and the release stopped`,
      { receipt_id: receipt.id, promoted_id: promoted.promoted_id, status });
  }
  return { ...receiptOut(receipt), replayed_receipt: false };
}
