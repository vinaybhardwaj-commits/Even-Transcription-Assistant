/**
 * lib/jev/worker/slots.ts — the GLOBAL in-flight count (PRD §10), in the database, not in module memory: serverless
 * instances share nothing, so the old per-module semaphore (jev-window.ts) cannot bound the whole fleet.
 *
 * A slot is a jev_slot row claimed before a call and deleted after it. A row older than SLOT_TTL_MS is a crashed call and
 * does not count (and is swept on the next claim). Claim is ONE statement: insert-if-room, so two instances cannot both take the last slot
 * except through a same-statement race, which `GLOBAL_SLOTS` has headroom for (PROVISIONAL 8; TypeSafe allows 80 req/s).
 */
import { customAlphabet } from "nanoid";
import { sql } from "@/lib/db";

export const GLOBAL_SLOTS = 8;
export const SLOT_TTL_MS = 5 * 60_000;
const nano = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

export async function claimSlot(jobId: string | null, max = GLOBAL_SLOTS): Promise<string | null> {
  const id = `slot_${nano()}`;
  await sql`DELETE FROM jev_slot WHERE claimed_at < now() - make_interval(secs => ${SLOT_TTL_MS / 1000})`;
  const rows = (await sql`
    INSERT INTO jev_slot (slot_id, job_id)
    SELECT ${id}, ${jobId} WHERE (SELECT count(*) FROM jev_slot) < ${max}::int
    RETURNING slot_id`) as Array<{ slot_id: string }>;
  return rows[0]?.slot_id ?? null;
}

export async function releaseSlot(slotId: string): Promise<void> {
  await sql`DELETE FROM jev_slot WHERE slot_id = ${slotId}`;
}

/** How long a step waits for a slot before it defers. JEV_SLOT_WAIT_MS overrides it (a test sets it short); junk falls back to the default. */
export const SLOT_WAIT_MS = 5_000;
export function slotWaitMs(): number {
  const n = Number(process.env.JEV_SLOT_WAIT_MS);
  return Number.isFinite(n) && n >= 0 && n <= 60_000 ? n : SLOT_WAIT_MS;
}

/** Wait for a slot (bounded): the caller defers the step if none frees. */
export async function acquireSlot(jobId: string | null, waitMs = slotWaitMs()): Promise<string | null> {
  const t0 = Date.now();
  for (;;) {
    const s = await claimSlot(jobId);
    if (s) return s;
    if (Date.now() - t0 >= waitMs) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}
