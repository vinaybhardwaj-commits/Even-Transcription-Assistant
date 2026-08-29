/**
 * lib/diarize-gate.ts — depth-1 admission control for the Mac Mini /diarize service.
 *
 * WHY THIS EXISTS (measurement, not theory).
 *
 * The 22 Aug 2026 timing probe (docs/ETA-DIARIZE-TIMING-PROBE-22-AUG-2026.md) killed the
 * "diarization fails on long files" premise: of Ankit Bhojani's six encounters FIVE completed,
 * and the one that failed (enc_7kszcrtwzc, 288 s) was SHORTER than the longest success
 * (enc_bn5ttmn7qm, 482 s). Length was never the discriminator. What the probe did find is that
 * the service SERIALISES — single-worker uvicorn, GIL plus MPS (handover §"Known issues") — so a
 * second request does not run sooner for having been sent sooner. It waits INSIDE the service,
 * where our timeout clock is already running. That is how 26 seconds of real work breaches a
 * 90-second budget.
 *
 * So the queue has to be on OUR side, one deep, and the timeout must not start until the request
 * is actually dispatched. This module is the queue; lib/diarize.ts starts the clock after it.
 *
 * DESIGN. One lease row in `diarize_slot`, claimed by a single atomic upsert that only steals an
 * EXPIRED lease. TTL'd so a worker killed mid-call (Vercel function timeout, instance recycle)
 * frees the slot without anyone to run a finally block — the same idiom as the per-encounter
 * `processing_step_at` lock from migration 0033, for the same reason.
 *
 * Cross-instance on purpose. An in-process mutex would hold within one Node instance and prove
 * nothing: two encounters submitted together are two function invocations, quite possibly on two
 * instances, and those are exactly the two that collide at the Mini. The lease is in Postgres
 * because that is the only thing both instances can see.
 *
 * NOT an advisory lock. `pg_advisory_lock` is session-scoped and would have to be held across the
 * whole multi-minute call; APP_DATABASE_URL is Neon's POOLED endpoint (pgbouncer, transaction
 * mode), where a session-scoped lock is not safe to hold across statements. The xact-scoped lock
 * lib/brain/lock.ts uses is safe precisely because it never outlives its transaction, and this
 * hold must.
 *
 * FAILS OPEN, ONCE. If `diarize_slot` does not exist (deploy landed before migration 0063), the
 * gate says so loudly and admits the call — degrading to today's behaviour rather than turning a
 * missing table into a diarization outage. Any OTHER database error is treated as "slot not
 * available yet" and retried, because a transient DB blip is not permission to double-dispatch.
 *
 * Env: DIARIZE_QUEUE_WAIT_MS (see DIARIZE_QUEUE_WAIT_MS_DEFAULT).
 */

import { sql } from "@/lib/db";

/** Single-row key. The Mini has one diarization worker, so there is one slot. */
export const DIARIZE_SLOT = "diarize";

/**
 * How long a caller waits in the queue before giving up.
 *
 * Default 120 000 ms. NOT a measured figure and not pretending to be one: it is a budget chosen
 * against the caller's ceiling, which is the 300 s `maxDuration` on the /process route. Waiting
 * 120 s still leaves room for a full dispatched call underneath it inside one invocation. Giving
 * up is CHEAP and non-terminal — the step machine's 5-minute lock TTL and bounded retry pick the
 * encounter up again — which is why this is allowed to be a budget rather than a measurement.
 */
export const DIARIZE_QUEUE_WAIT_MS_DEFAULT = 120_000;
export const DIARIZE_QUEUE_WAIT_MS = (): number =>
  Number(process.env.DIARIZE_QUEUE_WAIT_MS || DIARIZE_QUEUE_WAIT_MS_DEFAULT);

/** Poll cadence while queued. Jittered so two waiters do not synchronise on the retry. */
const POLL_MIN_MS = 400;
const POLL_MAX_MS = 1_200;

/**
 * The label a room-window caller puts on the lease.
 *
 * THE QUEUE IS ALREADY SHARED, AND THAT IS THE POINT. `DIARIZE_SLOT` is a single global key, not
 * one slot per subject, so a room window and an encounter contend for the SAME lease by
 * construction — no mechanism changes to admit the room path, only a label so the holder is
 * legible in `readDiarizeSlot()` and in the logs. A per-subject slot would have been the bug: two
 * callers would each hold "their own" lease and both reach the Mini, which serialises anyway and
 * would charge the first one's runtime to the second's budget.
 *
 * The prefix is a NAME, not a table reference: this module stays free of schema vocabulary so it
 * remains readable as pure admission control.
 */
export const ROOM_DIARIZE_LABEL_PREFIX = "room";

/** PURE — the lease label for a room-window diarize call. */
export function roomDiarizeLabel(windowId: string): string {
  return `${ROOM_DIARIZE_LABEL_PREFIX}:${windowId}`;
}

/** PURE — did this lease belong to a room-window caller? For operator visibility. */
export function isRoomDiarizeLabel(holder: string | null | undefined): boolean {
  return typeof holder === "string" && holder.startsWith(`${ROOM_DIARIZE_LABEL_PREFIX}:`);
}

export type SlotHold = {
  holder: string;
  /** Milliseconds spent waiting for the slot. NOT charged against the dispatch timeout. */
  queueWaitMs: number;
  /** True when the gate admitted without a lease (missing table). Recorded, never hidden. */
  ungated: boolean;
  release: () => Promise<void>;
};

export type SlotOutcome =
  | { acquired: true; hold: SlotHold }
  | { acquired: false; queueWaitMs: number; reason: "queue_wait_exceeded" | "aborted" };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = () => POLL_MIN_MS + Math.floor(Math.random() * (POLL_MAX_MS - POLL_MIN_MS));

/** Postgres 42P01 = undefined_table. The one error that means "migration 0063 has not run". */
function isMissingTable(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  if (err?.code === "42P01") return true;
  return /relation .*diarize_slot.* does not exist/i.test(String(err?.message ?? ""));
}

function newHolder(label: string): string {
  const dep = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL || "local";
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${label}@${dep}:${rnd}`.slice(0, 160);
}

/**
 * Take the one diarize slot, or report that we never got it.
 *
 * `ttlMs` must cover the whole dispatched call — the caller passes its timeout plus headroom, so
 * a lease can never expire under a call that is still legitimately running.
 */
export async function acquireDiarizeSlot(opts: {
  label: string;
  ttlMs: number;
  waitMs?: number;
  signal?: AbortSignal;
}): Promise<SlotOutcome> {
  const t0 = Date.now();
  const waitMs = opts.waitMs ?? DIARIZE_QUEUE_WAIT_MS();
  const holder = newHolder(opts.label);
  const ttlSec = Math.max(1, Math.ceil(opts.ttlMs / 1000));

  for (;;) {
    if (opts.signal?.aborted) return { acquired: false, queueWaitMs: Date.now() - t0, reason: "aborted" };

    let got = false;
    try {
      // ONE statement, so the claim is atomic across instances. The ON CONFLICT arm only fires
      // when the incumbent lease has expired; a live lease matches no row and returns nothing,
      // which is the "still busy" signal — not an error.
      const rows = (await sql`
        INSERT INTO diarize_slot (slot, holder, acquired_at, expires_at)
        VALUES (${DIARIZE_SLOT}, ${holder}, now(), now() + make_interval(secs => ${ttlSec}))
        ON CONFLICT (slot) DO UPDATE
           SET holder = EXCLUDED.holder, acquired_at = now(), expires_at = EXCLUDED.expires_at
         WHERE diarize_slot.expires_at < now()
        RETURNING holder
      `) as Array<{ holder: string }>;
      got = rows.length > 0 && rows[0]!.holder === holder;
    } catch (e) {
      if (isMissingTable(e)) {
        console.warn(
          `[diarize-gate] diarize_slot missing — run migration 0063 via /api/run-migrations. ` +
            `Admitting UNGATED (depth-1 not enforced) rather than failing diarization.`,
        );
        return {
          acquired: true,
          hold: { holder, queueWaitMs: Date.now() - t0, ungated: true, release: async () => {} },
        };
      }
      // Transient DB fault. A blip is not permission to double-dispatch: treat as "busy".
      console.warn(`[diarize-gate] claim failed (treating as busy): ${e instanceof Error ? e.message : String(e)}`);
    }

    if (got) {
      return {
        acquired: true,
        hold: {
          holder,
          queueWaitMs: Date.now() - t0,
          ungated: false,
          release: async () => {
            try {
              await sql`DELETE FROM diarize_slot WHERE slot = ${DIARIZE_SLOT} AND holder = ${holder}`;
            } catch (e) {
              // Not fatal: the TTL frees it. Worst case the next caller waits out the lease.
              console.warn(`[diarize-gate] release failed for ${holder}: ${e instanceof Error ? e.message : String(e)}`);
            }
          },
        },
      };
    }

    if (Date.now() - t0 >= waitMs) return { acquired: false, queueWaitMs: Date.now() - t0, reason: "queue_wait_exceeded" };
    await sleep(jitter());
  }
}

/** Who holds the slot right now (or null). Read-only; for operator visibility. */
export async function readDiarizeSlot(): Promise<{ holder: string; acquired_at: string; expires_at: string } | null> {
  try {
    const rows = (await sql`
      SELECT holder, acquired_at, expires_at FROM diarize_slot
       WHERE slot = ${DIARIZE_SLOT} AND expires_at > now()
    `) as Array<{ holder: string; acquired_at: string; expires_at: string }>;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
