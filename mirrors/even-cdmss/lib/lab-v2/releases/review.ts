/**
 * lib/lab-v2/releases/review.ts — `review_submit` (LAB-MCP-V2-PRD-v1.0 §11, decisions 5 and 81).
 *
 * ⚠️ AN APPROVAL BINDS FOUR THINGS AND EXPIRES. `{decision, reviewer principal, artifact_hash,
 * release_id}`, valid for seven days. The hash is what makes it un-reusable: the artifact is an
 * immutable object, so a "changed" release is a DIFFERENT object with a different hash, and an
 * approval that named the old one no longer names anything applicable. `release_apply` refuses
 * with `APPROVAL_HASH_MISMATCH` rather than applying something nobody read.
 *
 * ⚠️ `reviewer` IS THE PRINCIPAL NAME, NEVER A PERSON — decision 5, stated again here because this
 * is the file where the temptation lives. If one human holds both the `release` and `reviewer`
 * keys, the ledger says `release` and `reviewer` and the independence claim is exactly as strong as
 * the key separation and no stronger. Writing a human's name would imply a second pair of eyes this
 * platform cannot verify, and a ledger that overstates its own guarantee is worse than one that
 * states a weak guarantee plainly.
 *
 * ⚠️ A REJECTION IS RECORDED, NOT DISCARDED. `decision: 'rejected'` writes a row like any other:
 * the fact that a release was looked at and refused is exactly the fact a later reader needs, and
 * `release_apply` simply finds no APPROVED review binding the hash.
 */
import { APPROVAL_TTL_MS, LabError, REVIEW_DECISIONS } from '../contracts';
import { getObject, putReview, recordEvent } from '../store';
import type { Db } from '../db';

export async function reviewSubmit(
  db: Db, principal: string,
  args: { release_id: string; decision: string; rationale: string; idempotency_key: string },
) {
  const decision = String(args.decision);
  if (!(REVIEW_DECISIONS as readonly string[]).includes(decision)) {
    throw new LabError('INVALID_INPUT', `decision must be one of ${REVIEW_DECISIONS.join(', ')}`);
  }
  const rationale = String(args.rationale ?? '').trim();
  if (!rationale) {
    // The database enforces this too (0002's CHECK). Refusing here as well means the caller gets a
    // sentence rather than a constraint violation.
    throw new LabError('INVALID_INPUT', 'rationale is required and may not be blank: "approved" with no reason is not a review');
  }

  const release = await getObject(db, args.release_id);
  if (!release || release.kind !== 'release') throw new LabError('NOT_FOUND', `no release ${args.release_id}`);

  // ⚠️ REFUSED HERE AS WELL AS AT APPLY. Decision 5 says the preparer principal cannot also be the
  // reviewer principal; catching it at REVIEW means the ledger never acquires a self-approval that
  // apply would then have to explain away.
  if (release.owner === principal) {
    throw new LabError('REVIEWER_IS_PREPARER',
      `principal '${principal}' prepared this release and may not review it; review requires the reviewer key (decision 5)`);
  }

  const now = Date.now();
  const row = await putReview(db, {
    release_id: release.id,
    reviewer: principal,
    // The hash the reviewer is binding to is the artifact's OWN hash, read off the object — never
    // a value the caller supplies. A caller-supplied hash would let an approval name bytes the
    // reviewer never saw.
    artifact_hash: release.hash,
    decision,
    rationale: rationale.slice(0, 4000),
    expires_at: new Date(now + APPROVAL_TTL_MS).toISOString(),
    idempotency_key: args.idempotency_key,
  });

  await recordEvent(db, principal, release.id, 'review_submitted', {
    release_id: release.id, decision, artifact_hash: release.hash, expires_at: row.expires_at,
  }).catch(() => { /* the ledger row is the record; the event is a convenience */ });

  return {
    review_id: row.id,
    release_id: release.id,
    reviewer: row.reviewer,
    artifact_hash: row.artifact_hash,
    decision: row.decision,
    rationale: row.rationale,
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    /** Said out loud so nobody has to infer it from a timestamp. */
    binds: 'this approval names this release id AND this artifact hash; any change to the artifact produces a new hash and this approval stops applying',
  };
}
