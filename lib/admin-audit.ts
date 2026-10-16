/**
 * lib/admin-audit.ts — one audit_log row for an admin write on a room or an install (ADMIN-1, 13 Oct 2026).
 *
 * WHY. The OPD 4 lost day (RCA, 13 Oct) could not be traced to a person: the Bench disable and the
 * install retire both wrote a bare UPDATE and no audit row. Every admin write now goes through here,
 * from the Bench route, the install-retire route and the MCP tool scribe_admin alike.
 *
 * SHAPE follows lib/mcp/audit.ts: audit_log.actor_type is an enum ('admin' | 'doctor' | 'system');
 * an MCP principal is 'system' with actor_id `mcp:<actor>`, an admin-session user is 'admin' with the
 * admin id. metadata_json carries {reason, before, after, room_id, install_id?} and NOTHING ELSE the
 * caller passes in: never a bootstrap token, never an install command.
 *
 * BEST-EFFORT, like every other audit writer here: a failed insert is logged (action and error only)
 * and returns false. It never undoes or blocks the write it describes.
 */
import { sql } from "@/lib/db";

export type AdminActor = { type: "admin" | "system" | "person"; id: string };

export type AdminAuditInput = {
  actor: AdminActor;
  /** `admin.<action>` or `admin.<action>.refused`. */
  action: string;
  targetType: "room" | "room_install" | "mcp_person";
  targetId: string;
  meta: Record<string, unknown>;
  /** ADMIN-1b: true = a failed insert THROWS (the MCP tool writes its audit row before the write and fails closed). Default false = best-effort. */
  strict?: boolean;
};

/**
 * ADMIN-5 (L4): the strict insert of the ONE row a scribe_admin write leaves. Returns the new row's id (audit_log.id is the UUID primary key, migration 0001) and
 * THROWS on failure so the caller fails closed. The result fields are merged into the same row afterwards by finishAdminAudit.
 */
export async function insertAdminAuditStrict(input: Omit<AdminAuditInput, "strict">): Promise<string> {
  const rows = (await sql`
    INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
    VALUES (${input.actor.type}, ${input.actor.id}, ${input.action}, ${input.targetType}, ${input.targetId},
            ${JSON.stringify(input.meta)}::jsonb)
    RETURNING id
  `) as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw new Error("audit_log insert returned no id");
  return String(id);
}

/** Best-effort: merge the result fields into the row `insertAdminAuditStrict` wrote. True when the update ran. Never put a token or a command in `patch`. */
export async function finishAdminAudit(id: string, patch: Record<string, unknown>): Promise<boolean> {
  try {
    await sql`UPDATE audit_log SET metadata_json = metadata_json || ${JSON.stringify(patch)}::jsonb WHERE id = ${id}::uuid`;
    return true;
  } catch (e) {
    console.warn("[admin-audit] audit_log update failed", JSON.stringify({ id, err: String((e as Error)?.message ?? e).slice(0, 160) }));
    return false;
  }
}

export async function writeAdminAudit(input: AdminAuditInput): Promise<boolean> {
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES (${input.actor.type}, ${input.actor.id}, ${input.action}, ${input.targetType}, ${input.targetId},
              ${JSON.stringify(input.meta)}::jsonb)
    `;
    return true;
  } catch (e) {
    if (input.strict) throw e;
    console.warn("[admin-audit] audit_log insert failed", JSON.stringify({ action: input.action, target_id: input.targetId, err: String((e as Error)?.message ?? e).slice(0, 160) }));
    return false;
  }
}
