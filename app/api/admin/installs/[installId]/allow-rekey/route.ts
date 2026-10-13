/**
 * POST /api/admin/installs/{installId}/allow-rekey — an operator approves ONE re-key of this install's fleet key (gating/fleet-rekey, migration 0167).
 *
 * Body: { "pk_fingerprint": "<base64url SHA-256 of the new raw key>", "reason": "<1..200 chars>" }. Inserts one fleet_rekey_approval (install + fingerprint, expires in 2 hours,
 * approved_by = the admin actor) and writes audit rows. The fingerprint comes from a refused attempt (fleet_rekey_attempt, written on every KEY_CONFLICT). The approval is
 * consumed by the next POST /api/fleet/register that carries THAT key for THIS install, with a valid room JWT and proof of possession (lib/fleet/register.ts).
 * Refused: an unknown install (404), a retired install (409 RETIRED), an install with no active fleet device (409 NOTHING_TO_REKEY), a fingerprint never seen in a
 * refused attempt for this install (409 UNKNOWN_FINGERPRINT).
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
    return err(400, "BAD_ARGS", "body must be JSON: { pk_fingerprint: string, reason: string (1..200) }");
  }
  const body = parseAllowRekeyBody(json);
  if (!body.ok) return err(400, "BAD_ARGS", "body must be JSON: { pk_fingerprint: string, reason: string (1..200) }");

  try {
    const r = await allowRekey(sql as never, { installId, pkFingerprint: body.pk_fingerprint, actor: guard.adminId, reason: body.reason });
    if (!r.ok) {
      const message =
        r.code === "NOT_FOUND" ? "no such install"
        : r.code === "RETIRED" ? "this install is retired"
        : r.code === "UNKNOWN_FINGERPRINT" ? "that fingerprint was never seen in a refused registration for this install"
        : "this install has no active fleet device to re-key";
      return err(r.status, r.code, message);
    }
    return NextResponse.json({ approval_id: r.approval_id, install_id: r.install_id, pk_fingerprint: r.pk_fingerprint, expires_at: r.expires_at, approved_by: r.approved_by }, NO_STORE);
  } catch (e) {
    console.error("[allow-rekey] database fault:", e instanceof Error ? e.message.slice(0, 200) : "error");
    return err(503, "DB", "database unavailable");
  }
}
