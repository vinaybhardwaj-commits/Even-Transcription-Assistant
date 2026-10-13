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

export type AdminActor = { type: "admin" | "system"; id: string };

export type AdminAuditInput = {
  actor: AdminActor;
  /** `admin.<action>` or `admin.<action>.refused`. */
  action: string;
  targetType: "room" | "room_install";
  targetId: string;
  meta: Record<string, unknown>;
};

export async function writeAdminAudit(input: AdminAuditInput): Promise<boolean> {
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES (${input.actor.type}, ${input.actor.id}, ${input.action}, ${input.targetType}, ${input.targetId},
              ${JSON.stringify(input.meta)}::jsonb)
    `;
    return true;
  } catch (e) {
    console.warn("[admin-audit] audit_log insert failed", JSON.stringify({ action: input.action, target_id: input.targetId, err: String((e as Error)?.message ?? e).slice(0, 160) }));
    return false;
  }
}
