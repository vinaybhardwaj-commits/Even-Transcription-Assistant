/**
 * POST /api/admin/installs/{installId}/allow-rekey — an operator approves ONE re-key of this install's fleet key (gating/fleet-rekey, migration 0167).
 *
 * Body: { "reason": "<1..200 chars>" }. Sets room_install.rekey_allowed_until = now() + 2 hours and rekey_allowed_by = the admin actor, and writes an audit row.
 * The approval is consumed by the next POST /api/fleet/register that carries a different key, a valid room JWT and a valid proof of possession (lib/fleet/register.ts);
 * that call clears it. Refused: an unknown install (404), a retired install (409 RETIRED), an install with no active fleet device (409 NOTHING_TO_REKEY).
 * Auth is the retire route's guard, unchanged: the admin cookie or the migration secret (installAdminGuard).
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { installAdminGuard } from "@/lib/room-install";
import { allowRekey, parseAllowRekeyBody } from "@/lib/fleet/rekey";

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
    return err(400, "BAD_ARGS", "body must be JSON: { reason: string (1..200) }");
  }
  const body = parseAllowRekeyBody(json);
  if (!body.ok) return err(400, "BAD_ARGS", "body must be JSON: { reason: string (1..200) }");

  try {
    const r = await allowRekey(sql as never, { installId, actor: guard.adminId, reason: body.reason });
    if (!r.ok) {
      const message = r.code === "NOT_FOUND" ? "no such install" : r.code === "RETIRED" ? "this install is retired" : "this install has no active fleet device to re-key";
      return err(r.status, r.code, message);
    }
    return NextResponse.json({ install_id: r.install_id, rekey_allowed_until: r.allowed_until, rekey_allowed_by: r.allowed_by }, NO_STORE);
  } catch (e) {
    console.error("[allow-rekey] database fault:", e instanceof Error ? e.message.slice(0, 200) : "error");
    return err(503, "DB", "database unavailable");
  }
}
