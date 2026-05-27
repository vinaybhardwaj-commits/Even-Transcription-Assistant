/**
 * GET /{slug}/api/recipients/global — doctor reads the active global
 * address book. Inactive entries are filtered out server-side so the
 * SendPanel never offers a disabled recipient.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readDoctorCookie } from "@/lib/cookie";
import { verifyDoctorJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const cookie = await readDoctorCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try {
    const c = await verifyDoctorJwt(cookie);
    if (c.slug !== slug) return respondError("FORBIDDEN", "Slug mismatch");
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }
  try {
    type Row = { id: string; email: string; name: string; role: string };
    const rows = (await sql`
      SELECT id, email, name, role
        FROM recipient_global
       WHERE active = true
       ORDER BY name ASC
    `) as Row[];
    return respondOk({ recipients: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return respondError("PIPELINE_FAILED", msg.slice(0, 150));
  }
}
