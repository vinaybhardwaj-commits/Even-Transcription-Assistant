/**
 * POST /api/admin/installs/{installId}/undo-rekey — the written reversal of one re-key (gating/fleet-rekey, migration 0167).
 *
 * Body: { "approval_id": "rka_...", "reason": "<1..200 chars>" }. In one transaction the rotated device row goes back to 'active', the device the re-key created goes to
 * 'retired' (retired_at), and the approval records outcome 'undone'. Nothing is deleted. Audited (audit_log + fleet_audit). Refused: an unknown approval for this install
 * (404), a retired install (409 RETIRED), an approval that did not end 'rekeyed' or whose devices are no longer in the re-keyed state (409 NOT_UNDOABLE).
 * Auth is the retire route's guard, unchanged: the admin cookie or the migration secret (installAdminGuard).
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { installAdminGuard } from "@/lib/room-install";
import { parseUndoRekeyBody, undoRekey } from "@/lib/fleet/rekey";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "cache-control": "no-store" } };
const err = (status: number, code: string, message: string) => NextResponse.json({ error: { code, message } }, { status, ...NO_STORE });

export async function POST(req: NextRequest, ctx: { params: Promise<{ installId: string }> }) {
  const guard = await installAdminGuard(req);
  if (!guard.ok) return err(401, "AUTH_REQUIRED", "admin or migration secret required");

  const { installId } = await ctx.params;
  let json: unknown;
  try {
    json = JSON.parse(await req.text());
  } catch {
    return err(400, "BAD_ARGS", "body must be JSON: { approval_id: string, reason: string (1..200) }");
  }
  const body = parseUndoRekeyBody(json);
  if (!body.ok) return err(400, "BAD_ARGS", "body must be JSON: { approval_id: string, reason: string (1..200) }");

  try {
    const r = await undoRekey(sql as never, { installId, approvalId: body.approval_id, actor: guard.adminId, reason: body.reason });
    if (!r.ok) {
      const message = r.code === "NOT_FOUND" ? "no such approval for this install" : r.code === "RETIRED" ? "this install is retired" : "this re-key can no longer be undone";
      return err(r.status, r.code, message);
    }
    return NextResponse.json({ approval_id: r.approval_id, install_id: r.install_id, restored_device_id: r.restored_device_id, retired_device_id: r.retired_device_id }, NO_STORE);
  } catch (e) {
    console.error("[undo-rekey] database fault:", e instanceof Error ? e.message.slice(0, 200) : "error");
    return err(503, "DB", "database unavailable");
  }
}
