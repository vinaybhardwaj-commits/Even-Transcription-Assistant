/**
 * lib/lab-v2/tools/release.ts — `release_prepare`, `review_submit`, `release_apply`,
 * `release_status`, `release_rollback` (LAB-MCP-V2-PRD-v1.0 §11, §17.7).
 *
 * The schemas and the dispatch; the decisions live in `lib/lab-v2/releases/*`. Splitting them that
 * way is not tidiness — `release_apply`'s ordering IS the guarantee, and it should be readable in
 * one file without a schema between every step.
 *
 * ⚠️ THE SCOPES ARE THE SEPARATION. `release_prepare`, `release_apply` and `release_rollback` are
 * scope `release`; `review_submit` is scope `review`; `release_status` is `production_read` so
 * anyone who can see the platform can see what is in force. Decision 5: the two keys differ, and
 * if one person holds both, the ledger records `release` and `reviewer` and claims nothing more.
 */
import { z } from 'zod';
import { RECEIPT_KINDS, RELEASE_TARGETS, REVIEW_DECISIONS } from '../contracts';
import { getObject, listTargets, recentReceipts, reviewsOf } from '../store';
import { releasePrepare } from '../releases/prepare';
import { reviewSubmit } from '../releases/review';
import { releaseApply } from '../releases/apply';
import { releaseRollback } from '../releases/rollback';
import type { Db } from '../db';

const receiptOutSchema = z.object({
  receipt_id: z.string().uuid(),
  release_id: z.string().uuid(),
  target: z.string(),
  revision: z.number().int(),
  kind: z.enum(RECEIPT_KINDS),
  outcome: z.string(),
  chunk_ids: z.array(z.number().int()),
  body: z.record(z.unknown()),
  created_at: z.string(),
  /** True when this call did nothing because the release had already been applied or rolled back. */
  replayed_receipt: z.boolean(),
});

export const RELEASE_SCHEMAS = {
  release_prepare: {
    input: z.object({
      target: z.enum(RELEASE_TARGETS),
      staged_set_id: z.string().uuid(),
      /** A `corpus_diff` artifact id, so the reviewer reads an impact estimate and not a promise. */
      impact_ref: z.string().max(200).optional(),
      notes: z.string().max(4000).optional(),
      idempotency_key: z.string().min(1),
    }),
    output: z.object({
      release_id: z.string().uuid(),
      artifact_hash: z.string(),
      deduplicated: z.boolean(),
      target: z.enum(RELEASE_TARGETS),
      label: z.string(),
      chunk_ids: z.array(z.number().int()),
      expected_revision: z.number().int(),
      predecessor_id: z.string().nullable(),
      predecessor_visible_hash: z.string(),
      impact_ref: z.string().nullable(),
      /** What apply will do, and what a rollback would undo — in words, for the reviewer. */
      will: z.string(),
      rollback: z.string(),
    }),
  },
  review_submit: {
    input: z.object({
      release_id: z.string().uuid(),
      decision: z.enum(REVIEW_DECISIONS),
      rationale: z.string().min(1).max(4000),
      idempotency_key: z.string().min(1),
    }),
    output: z.object({
      review_id: z.string().uuid(),
      release_id: z.string().uuid(),
      reviewer: z.string(),
      artifact_hash: z.string(),
      decision: z.enum(REVIEW_DECISIONS),
      rationale: z.string(),
      created_at: z.string(),
      expires_at: z.string(),
      binds: z.string(),
    }),
  },
  release_apply: {
    input: z.object({ release_id: z.string().uuid() }),
    output: receiptOutSchema,
  },
  release_rollback: {
    input: z.object({ release_id: z.string().uuid() }),
    output: receiptOutSchema.extend({ caveat: z.string() }),
  },
  release_status: {
    input: z.object({ limit: z.number().int().min(1).max(20).default(5) }),
    output: z.object({
      targets: z.array(z.object({
        name: z.string(),
        revision: z.number().int(),
        artifact_id: z.string().nullable(),
        predecessor_id: z.string().nullable(),
        release_id: z.string().nullable(),
        /** Null on a target that has never been released — a real state, not an absence. */
        in_force: z.record(z.unknown()).nullable(),
      })),
      recent: z.array(z.object({
        receipt_id: z.string().uuid(),
        release_id: z.string().uuid(),
        target: z.string(),
        revision: z.number().int(),
        kind: z.string(),
        outcome: z.string(),
        chunks: z.number().int(),
        created_at: z.string(),
      })),
      pending_approval: z.array(z.object({
        release_id: z.string().uuid(),
        target: z.string(),
        label: z.string().nullable(),
        artifact_hash: z.string(),
        preparer: z.string(),
        chunks: z.number().int(),
        reviews: z.number().int(),
        /** Why it is still pending: never reviewed, rejected, expired, or bound to an old hash. */
        state: z.enum(['unreviewed', 'rejected', 'expired', 'hash_superseded', 'approved_not_applied']),
      })),
    }),
  },
} as const;

export interface ReleaseDeps { db: Db; principal: string }

export async function releaseStatus(deps: ReleaseDeps, args: { limit?: number }) {
  const { db } = deps;
  const limit = Math.floor(args.limit ?? 5);
  const targets = await listTargets(db);
  const withArtifact = [];
  for (const t of targets) {
    const obj = t.artifact_id ? await getObject(db, t.artifact_id) : null;
    withArtifact.push({ ...t, in_force: (obj?.body ?? null) as Record<string, unknown> | null });
  }

  const receipts = await recentReceipts(db, limit);
  const recent = receipts.map((r) => {
    const b = (r.body ?? {}) as Record<string, unknown>;
    const ids = (b.activated_chunk_ids ?? b.rolled_back_chunk_ids ?? []) as unknown[];
    return {
      receipt_id: r.id, release_id: r.release_id, target: r.target,
      revision: Number(r.revision), kind: r.kind, outcome: String(b.outcome ?? r.kind),
      chunks: Array.isArray(ids) ? ids.length : 0, created_at: String(r.created_at),
    };
  });

  // ── everything prepared and not yet applied, with WHY it is still waiting ─────────────
  const prepared = await db.query<{ id: string; owner: string; body: unknown; hash: string; created_at: string }>(
    `SELECT id, owner, body, hash, created_at FROM lab_v2.objects WHERE kind = 'release' ORDER BY created_at DESC LIMIT 50`);
  const pending: {
    release_id: string; target: string; label: string | null; artifact_hash: string;
    preparer: string; chunks: number; reviews: number;
    state: 'unreviewed' | 'rejected' | 'expired' | 'hash_superseded' | 'approved_not_applied';
  }[] = [];
  const now = Date.now();
  for (const p of prepared) {
    const applied = await db.query<{ id: string }>(
      `SELECT id FROM lab_v2.receipts WHERE release_id = $1 AND kind = 'apply'`, [p.id]);
    if (applied.length) continue;
    const body = (p.body ?? {}) as { target?: string; label?: string; chunk_ids?: number[] };
    const rs = await reviewsOf(db, p.id);
    const approvals = rs.filter((r) => r.decision === 'approved');
    const onHash = approvals.filter((r) => r.artifact_hash === p.hash);
    const live = onHash.filter((r) => new Date(r.expires_at).getTime() > now);
    const state = live.length ? 'approved_not_applied'
      : onHash.length ? 'expired'
      : approvals.length ? 'hash_superseded'
      : rs.length ? 'rejected'
      : 'unreviewed';
    pending.push({
      release_id: p.id,
      target: String(body.target ?? ''),
      label: body.label == null ? null : String(body.label),
      artifact_hash: p.hash,
      preparer: p.owner,
      chunks: (body.chunk_ids ?? []).length,
      reviews: rs.length,
      state,
    });
  }

  return { targets: withArtifact, recent, pending_approval: pending };
}

export const RELEASE_HANDLERS = {
  release_prepare: (deps: ReleaseDeps, args: Record<string, unknown>) =>
    releasePrepare(deps.db, deps.principal, args as never),
  review_submit: (deps: ReleaseDeps, args: Record<string, unknown>) =>
    reviewSubmit(deps.db, deps.principal, args as never),
  release_apply: (deps: ReleaseDeps, args: Record<string, unknown>) =>
    releaseApply(deps.db, deps.principal, args as never),
  release_rollback: (deps: ReleaseDeps, args: Record<string, unknown>) =>
    releaseRollback(deps.db, deps.principal, args as never),
  release_status: (deps: ReleaseDeps, args: Record<string, unknown>) =>
    releaseStatus(deps, args as never),
} as const;
