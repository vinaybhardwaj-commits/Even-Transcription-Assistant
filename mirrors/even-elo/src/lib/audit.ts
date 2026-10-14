import { sql } from "./db";

export type AuditAction =
  | "create"
  | "overwrite"
  | "void"
  | "apply_weights"
  | "edit_stream"
  | "add_vc"
  | "edit_vc"
  | "delete_vc"
  | "edit_position"
  | "recompute"
  | "migrate";

export type AuditEntityType =
  | "case"
  | "observation"
  | "weights"
  | "stream"
  | "vc"
  | "position"
  | "system";

export interface AuditPayload {
  actor_position: string;
  action: AuditAction;
  entity_type: AuditEntityType;
  entity_id: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

/**
 * Append-only writer for the audit_log table.
 *
 * NABH HRM-11/12/13 defensibility — every observation, case, weight, and admin
 * action lands here with the actor's position stamped.
 */
export async function auditWrite(p: AuditPayload): Promise<void> {
  await sql`
    INSERT INTO audit_log (actor_position, action, entity_type, entity_id, before_json, after_json)
    VALUES (
      ${p.actor_position},
      ${p.action},
      ${p.entity_type},
      ${p.entity_id},
      ${p.before ? JSON.stringify(p.before) : null}::jsonb,
      ${p.after ? JSON.stringify(p.after) : null}::jsonb
    )
  `;
}
