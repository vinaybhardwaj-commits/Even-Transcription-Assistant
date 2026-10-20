/**
 * lib/jobs/audit-read.ts — the read half of the audit trail (Slice A rollout gap).
 *
 * WHY THIS IS NARROW. `audit_log.metadata_json` is written by many callers, and this tool must not
 * become a way to read whatever any of them chose to put there. So: an ALLOW-LIST of actions, a
 * bounded window, a bounded limit, and no free-text argument at all — there is nothing to search
 * with, only rows to list. The metadata is returned as stored because the writers that produce
 * these actions already restrict themselves to ids, counts and channel names.
 */

import { sql } from "@/lib/db";

/** The actions this tool will return. Anything else is refused by name rather than silently empty. */
export const READABLE_ACTIONS = [
  "install.assign_channel",
  "install.channel_reported",
  "install.poll_write_failed",
  "mcp.tools/call",
  "mcp.rpc",
  "mcp.denied",
  "mcp.oauth_refused",
  "admin.person_grant",
  "admin.person_revoke",
  "bench.command",
] as const;

export const AUDIT_ACTIONS_HINT = `Limited to ${READABLE_ACTIONS.join(", ")}.`;

/** A non-owner's own rows keep their shape but lose the subject ids (consult uid, room, dates). */
function stripSubject(m: unknown): unknown {
  if (m && typeof m === "object" && !Array.isArray(m) && "subject" in m) {
    const { subject: _s, ...rest } = m as Record<string, unknown>;
    return rest;
  }
  return m;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;

export async function readRecentAudit(input: {
  action: string | null;
  /** OAUTH-O3: exact match on actor_id (e.g. `person:<email>`), so "per user" is one call. */
  actor?: string | null;
  since: string | null;
  limit: number;
  /** R3 F1: who is asking. Not the owner = only your own person rows, subject ids stripped. */
  viewer?: { owner: boolean; email: string | null };
}): Promise<Record<string, unknown>> {
  if (input.action && !(READABLE_ACTIONS as readonly string[]).includes(input.action)) {
    return { rows: [], error: "action_not_readable", action: input.action, allowed: READABLE_ACTIONS };
  }
  const owner = input.viewer?.owner === true;
  const own = input.viewer?.email ? `person:${input.viewer.email}` : null;
  const since = input.since ?? new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString();
  const rows = (await sql`
    SELECT action, actor_type, actor_id, target_type, target_id, metadata_json,
           created_at::text AS created_at
      FROM audit_log
     WHERE action = ANY(${READABLE_ACTIONS as unknown as string[]})
       AND (${input.action}::text IS NULL OR action = ${input.action}::text)
       AND (${input.actor ?? null}::text IS NULL OR actor_id = ${input.actor ?? null}::text)
       AND created_at >= ${since}::timestamptz
       AND (${owner}::boolean OR (actor_id NOT LIKE 'person:%' AND actor_id NOT LIKE 'unknown:%' AND action NOT LIKE 'admin.person%') OR actor_id = ${own}::text)
     ORDER BY created_at DESC
     LIMIT ${input.limit}
  `) as Array<Record<string, unknown>>;
  return {
    since,
    count: rows.length,
    rows: rows.map((r) => ({
      action: r.action,
      actor: r.actor_id,
      actor_type: r.actor_type,
      target_type: r.target_type,
      target_id: r.target_id,
      metadata: owner ? r.metadata_json : stripSubject(r.metadata_json),
      created_at: r.created_at,
    })),
  };
}
