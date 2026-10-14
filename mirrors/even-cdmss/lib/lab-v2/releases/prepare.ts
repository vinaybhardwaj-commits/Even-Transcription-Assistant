/**
 * lib/lab-v2/releases/prepare.ts — `release_prepare` (LAB-MCP-V2-PRD-v1.0 §11, §17.7).
 *
 * ⚠️ WHAT PREPARE PRODUCES IS AN IMMUTABLE, HASHED OBJECT, and everything downstream depends on
 * that. The artifact is written to `lab_v2.objects` (kind `release`), which is content-addressed
 * and never updated. A review binds to its HASH; if anyone changes anything about the release
 * afterwards they get a different hash and a different object, and `release_apply` refuses the old
 * approval with `APPROVAL_HASH_MISMATCH`. Storing the artifact in a mutable ledger row instead
 * would make decision 81 unenforceable — the bytes could move under an approval that still pointed
 * at them.
 *
 * ⚠️ IT RECORDS THE EXPECTED REVISION, NOT THE CURRENT ONE. `expected_revision` is what the
 * preparer SAW. `release_apply`'s compare-and-swap demands the target still be there. Two releases
 * prepared against revision 4 cannot both land: the second is told `REVISION_MISMATCH` and has to
 * be re-prepared against what is actually in force, which is the only honest thing to do — its
 * diff was computed against a corpus that no longer exists.
 *
 * ⚠️ AND IT RECORDS THE PREDECESSOR STATE BY ID. Decision 80: a release records the exact set it
 * changed, and rollback flips exactly that set. `predecessor_state` is the `(id, source, visible)`
 * of every staged chunk at prepare time — what they must return to — and `predecessor_visible_hash`
 * is its hash, so drift between prepare and apply is one comparison rather than a walk.
 *
 * ⚠️ ROUND C2 ADDS THE `rules` TARGET AND ADDS NO INPUT FIELD. `rule_propose` writes a `staged_set`
 * object of its own — `{target: 'rules', proposal_id, proposal_hash, statement}` — so `rules` is
 * prepared through the SAME `staged_set_id` the corpus uses, and `impact_ref` carries the
 * `rule_simulate` artifact the same way it carries a `corpus_diff` one. A second target that needed
 * a second input schema would have made the release core target-shaped rather than generic.
 *
 * ⚠️ AND `ratified_by` IS NOT AN INPUT EITHER, DELIBERATELY. v1's `parseRatifyArgs` demands a
 * ratifier that is not the default author, and decision 5 already names the one principal
 * accountable for a rulebook change: the REVIEWER. `release_apply` passes the approval's own
 * reviewer and its own rationale into `lvcRatify`, so `lvc_ratifications` records the key that
 * approved it and the words it was approved with — not a name typed into a prepare call and
 * reviewed by nobody.
 */
import { LabError, RELEASE_TARGETS, hash, type ReleaseTarget } from '../contracts';
import { getObject, getTarget, putObject, type StoredObject } from '../store';
import { CHUNK_STATE_SQL, readStagedIds } from '../tools/corpus';
import { boundedRead } from '../sources/read';
import { activeRuleIds, readProposal, type RulesDeps } from './rules-target';
import { KEYWORDLESS_PROPOSAL } from '../tools/rules';
import type { Db } from '../db';

export interface PrepareDeps extends RulesDeps {
  read?: <T>(source: string, statement: string, params?: unknown[]) => Promise<T[]>;
  stagedIds?: (label: string) => Promise<number[]>;
}

const liveRead = <T>(source: string, statement: string, params: unknown[] = []) => boundedRead<T>(source, statement, params, 500);

export interface ChunkState { id: number; source: string | null; visible: boolean }

export async function releasePrepare(
  db: Db, principal: string,
  args: { target: string; staged_set_id: string; impact_ref?: string; notes?: string; idempotency_key: string },
  deps: PrepareDeps = {},
) {
  const target = String(args.target) as ReleaseTarget;
  if (!(RELEASE_TARGETS as readonly string[]).includes(target)) {
    throw new LabError('INVALID_INPUT', `'${target}' is not a release target; decision 77 names ${RELEASE_TARGETS.join(' and ')}`);
  }
  const staged = await getObject(db, args.staged_set_id);
  const stagedBody = (staged?.body ?? {}) as { kind?: string; label?: string; target?: string; chunk_ids?: number[] };
  if (!staged || stagedBody.kind !== 'staged_set') {
    throw new LabError('NOT_FOUND', `no staged set ${args.staged_set_id}`);
  }
  // ⚠️ A staged set knows which target it is for, and preparing one as the other would produce an
  // artifact whose predecessor described a different thing entirely. The corpus sets written before
  // C2 carry no `target`, so an absent one reads as `corpus` — the only thing it could have been.
  const stagedTarget = String(stagedBody.target ?? 'corpus');
  if (stagedTarget !== target) {
    throw new LabError('INVALID_INPUT',
      `staged set ${staged.id} is a '${stagedTarget}' set and this is a '${target}' release`);
  }

  if (target === 'rules') return prepareRules(db, principal, args, staged, deps);
  if (target !== 'corpus') {
    throw new LabError('ENGINE_UNSUPPORTED', `'${target}' has no prepare path`);
  }

  if (!stagedBody.label) throw new LabError('NOT_FOUND', `staged set ${staged.id} names no label`);
  const label = String(stagedBody.label);

  // ⚠️ RE-READ, NEVER TRUST THE STAGED OBJECT. The staged set was written at some earlier moment;
  // what matters is what is under the label NOW, because that is what an activation would move.
  const chunk_ids = await (deps.stagedIds ?? ((l: string) => readStagedIds(l)))(label);
  if (!chunk_ids.length) {
    throw new LabError('CASE_NOT_FOUND', `nothing is quarantined under labq:${label} any more`);
  }

  const read = deps.read ?? liveRead;
  const stateRows = await read<Record<string, unknown>>('mksap_chunks', CHUNK_STATE_SQL(chunk_ids));
  const predecessor_state: ChunkState[] = stateRows.map((r) => ({
    id: Number(r.id),
    source: r.source == null ? null : String(r.source),
    visible: r.visible === true,
  })).sort((a, b) => a.id - b.id);

  const already = predecessor_state.filter((c) => c.visible || !String(c.source ?? '').startsWith('labq:'));
  if (already.length) {
    throw new LabError('INVALID_INPUT',
      `${already.length} of ${predecessor_state.length} staged chunk(s) are already live; run corpus_validate — a release may not activate what is already activated`);
  }

  const t = await getTarget(db, target);
  if (!t) throw new LabError('STORE_UNAVAILABLE', `target '${target}' is missing; apply migrations/lab-v2/0002_releases.sql`);

  const artifact = {
    kind: 'release',
    target,
    label,
    staged_set_id: staged.id,
    chunk_ids,
    predecessor_visible_hash: hash(predecessor_state),
    predecessor_id: t.artifact_id,
    impact_ref: args.impact_ref ?? null,
    notes: args.notes ?? null,
    expected_revision: t.revision,
  };
  const { object, deduplicated } = await putObject(db, principal, 'release', artifact, 'deidentified', args.idempotency_key);

  return {
    release_id: object.id,
    artifact_hash: object.hash,
    deduplicated,
    target,
    label,
    chunk_ids,
    expected_revision: t.revision,
    predecessor_id: t.artifact_id,
    predecessor_visible_hash: artifact.predecessor_visible_hash,
    impact_ref: artifact.impact_ref,
    // What apply will do, in words, so a reviewer reads the consequence and not only the hash.
    will: `activate ${chunk_ids.length} chunk(s) under labq:${label} to lab:${label} via v1 corpusActivate, then bump corpus revision ${t.revision} to ${t.revision + 1}`,
    rollback: `return exactly those ${chunk_ids.length} id(s) to labq:${label} with visible = false`,
  };
}

/**
 * THE `rules` TARGET (§17.7 C2). The artifact §17.7 names, exactly:
 * `{target: 'rules', proposal_id, proposal_hash, simulation_ref, predecessor: <hash of the current
 * active recommendation ids>}`.
 *
 * ⚠️ THE PROPOSAL IS RE-READ FROM `lvc_recommendation_proposals`, NEVER TAKEN OFF THE OBJECT — the
 * same discipline the corpus path uses for its staged ids. A proposal can be ratified or rejected by
 * v1's own `lvc_ratify` between the propose and the prepare, and a release prepared against a stale
 * copy would ask `lvcRatify` to promote a row it has already promoted.
 *
 * ⚠️ AND THE SIMULATION IS MANDATORY. §17.7 puts `simulation_ref` in the artifact, and a rules
 * release without one asks a reviewer to approve a change to the governed rulebook with no evidence
 * about what it would do. It must be a `rule_simulate` report ABOUT THIS PROPOSAL — a simulation of
 * a different rule attached to this release would be worse than none.
 */
async function prepareRules(
  db: Db, principal: string,
  args: { target: string; staged_set_id: string; impact_ref?: string; notes?: string; idempotency_key: string },
  staged: StoredObject, deps: PrepareDeps,
) {
  const body = (staged.body ?? {}) as { proposal_id?: string; proposal_hash?: string; statement?: string };
  const proposalId = String(body.proposal_id ?? '');
  if (!proposalId) throw new LabError('NOT_FOUND', `staged set ${staged.id} names no proposal`);

  const proposal = await readProposal(proposalId, deps);
  if (proposal.status !== 'proposed') {
    throw new LabError('INVALID_INPUT',
      `proposal ${proposalId} is '${proposal.status}'${proposal.promoted_id ? ` (promoted as ${proposal.promoted_id})` : ''}; only a staged proposal can be released`);
  }
  // The statement the reviewer will read must be the statement in the table. If v1's row has moved
  // since `rule_propose`, the staged hash is about text that no longer exists.
  if (body.statement != null && String(body.statement) !== proposal.statement) {
    throw new LabError('INVALID_INPUT',
      `proposal ${proposalId}'s statement has changed since it was staged; re-run rule_propose so the artifact names what would actually be promoted`);
  }
  // ⚠️ See KEYWORDLESS_PROPOSAL in tools/rules.ts. Refused here as well as at rule_simulate: this is
  // the last point before a reviewer is asked to approve a rule that could never fire.
  if (!proposal.keywords.length) {
    throw new LabError('INVALID_INPUT', `proposal ${proposalId}: ${KEYWORDLESS_PROPOSAL}`);
  }

  const simulationRef = String(args.impact_ref ?? '');
  if (!simulationRef) {
    throw new LabError('INVALID_INPUT',
      'a rules release needs impact_ref set to a rule_simulate artifact id; §17.7 puts simulation_ref in the artifact, and nobody should approve a rulebook change with no evidence about what it does');
  }
  const simulation = await getObject(db, simulationRef);
  const simBody = (simulation?.body ?? {}) as { kind?: string; proposal_id?: string; changed_audits?: number; denominator?: { replayed_equal?: number } };
  if (!simulation || simBody.kind !== 'rule_simulation') {
    throw new LabError('NOT_FOUND', `impact_ref ${simulationRef} is not a rule_simulate artifact`);
  }
  if (String(simBody.proposal_id ?? '') !== proposalId) {
    throw new LabError('INVALID_INPUT',
      `simulation ${simulationRef} measured proposal ${String(simBody.proposal_id ?? 'nothing')}, not ${proposalId}`);
  }

  // The predecessor: the active rulebook as the ENGINE selects it (`WHERE status = 'active'`), by id.
  // A rules release adds one row, so the predecessor is what rollback returns the selection to.
  const predecessor_ids = await activeRuleIds(deps);

  const t = await getTarget(db, 'rules');
  if (!t) throw new LabError('STORE_UNAVAILABLE', "target 'rules' is missing; apply migrations/lab-v2/0002_releases.sql");

  const artifact = {
    kind: 'release',
    target: 'rules' as const,
    // `release_status` and every receipt read `label`; naming the proposal here is what makes a
    // rules release legible in a status list built for the corpus, with no schema change.
    label: `rule:${proposalId}`,
    staged_set_id: staged.id,
    // Kept for the shared receipt shape. A rules release moves no chunks and says so with an empty
    // list rather than by omitting the field.
    chunk_ids: [] as number[],
    proposal_id: proposalId,
    proposal_hash: String(body.proposal_hash ?? ''),
    statement: proposal.statement,
    simulation_ref: simulationRef,
    predecessor_rule_ids: predecessor_ids,
    predecessor_visible_hash: hash(predecessor_ids),
    predecessor_id: t.artifact_id,
    impact_ref: simulationRef,
    notes: args.notes ?? null,
    expected_revision: t.revision,
  };
  const { object, deduplicated } = await putObject(db, principal, 'release', artifact, 'deidentified', args.idempotency_key);

  const changed = Number(simBody.changed_audits ?? 0);
  const measured = Number(simBody.denominator?.replayed_equal ?? 0);
  return {
    release_id: object.id,
    artifact_hash: object.hash,
    deduplicated,
    target: 'rules' as ReleaseTarget,
    label: artifact.label,
    chunk_ids: [] as number[],
    expected_revision: t.revision,
    predecessor_id: t.artifact_id,
    predecessor_visible_hash: artifact.predecessor_visible_hash,
    impact_ref: simulationRef,
    will:
      `promote proposal ${proposalId} into lvc_recommendations via v1 lvcRatify, ratified_by the `
      + `APPROVING principal with the review's own rationale, joining the ${predecessor_ids.length} `
      + `already-active recommendation(s), then bump rules revision ${t.revision} to ${t.revision + 1}. `
      + `The simulation measured ${changed} audit(s) whose finding stamps would change over ${measured} `
      + 'item(s) that replayed equal.',
    rollback:
      'set that one new recommendation to status retired through v1 RETIREMENT_UPDATE_SQL, which '
      + 'removes it from the engine’s WHERE status = \'active\' selection. It is never deleted, and '
      + 'no audit written while it was live changes.',
  };
}
