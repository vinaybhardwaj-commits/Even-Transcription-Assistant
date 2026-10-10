/**
 * lib/diarize-nemotron/identity-enqueue.ts — ENQUEUE the ECAPA identity pass (epic #23, ticket c). Writes nothing itself.
 *
 * Per stored `ok` Nemotron row with no `ok` pass for the configured centroid set (IDENT_CENTROID_SET), and no
 * open nemotron_identity job for it, this submits one job. A `failed` pass is offered again until
 * IDENTITY_MAX_ATTEMPTS; new rows go before retries, so a failing clip never starves fresh work.
 *
 * SHIPS DARK. NEMOTRON_IDENTITY_ENABLED is the on-switch (strict: a typo throws). Off, this is a clean no-op, so
 * deploying the cron cannot start sending clips to the Mini.
 */
import { chooseIdentityRows } from "@/lib/room-access/nemotron-identity";
import { IDENTITY_MAX_ATTEMPTS, centroidSetFrom, nemotronIdentityEnabled, type CentroidSet } from "./identity";

/** Each job is one /embed_speakers call on the Mini; the worker stores at most 60 windows an hour. */
export const IDENTITY_BATCH_LIMIT = 20;

export type IdentityEnqueueResult = {
  enabled: boolean;
  centroid_set: CentroidSet | null;
  scanned: number;
  n_blind_excluded: number;
  enqueued: Array<{ row_id: number; job_id: string; retry: boolean }>;
};

export async function enqueueNemotronIdentity(opts: { limit?: number; origin?: string; actor: string }): Promise<IdentityEnqueueResult> {
  if (!nemotronIdentityEnabled()) return { enabled: false, centroid_set: null, scanned: 0, n_blind_excluded: 0, enqueued: [] };
  const set = centroidSetFrom();
  const limit = Math.max(1, Math.min(IDENTITY_BATCH_LIMIT, Math.trunc(opts.limit ?? IDENTITY_BATCH_LIMIT) || IDENTITY_BATCH_LIMIT));
  const { rows, n_blind_excluded } = await chooseIdentityRows(set, limit, IDENTITY_MAX_ATTEMPTS);
  // Lazy, as enqueueDiarizeWindows: a static import would close a cycle through lib/jobs/submit.
  const { submitJob } = await import("@/lib/jobs/submit");
  const enqueued: IdentityEnqueueResult["enqueued"] = [];
  for (const r of rows) {
    // NOT caught: a job that could not be queued must never be counted as queued.
    const job = await submitJob({
      kind: "nemotron_identity",
      args: { row_id: r.id, centroid_set: set },
      actor: opts.actor,
      ...(opts.origin ? { origin: opts.origin } : {}),
      scopes: new Set(["invoke"] as const),
    });
    enqueued.push({ row_id: r.id, job_id: job.id, retry: r.retry });
  }
  console.log("[nemotron-identity] enqueued", JSON.stringify({ set, scanned: rows.length, enqueued: enqueued.length, n_blind_excluded }));
  return { enabled: true, centroid_set: set, scanned: rows.length, n_blind_excluded, enqueued };
}
