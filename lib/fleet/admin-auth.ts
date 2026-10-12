import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";

/** The admin id from the admin cookie, or null. Cookie only: no bearer secret, no cron, no MCP door (same guard as POST /api/admin/fleet/commands). */
export async function adminIdFromCookie(): Promise<string | null> {
  const cookie = await readAdminCookie();
  if (!cookie) return null;
  try {
    const claims = await verifyAdminJwt(cookie);
    const id = String(claims.admin_id ?? "").slice(0, 64);
    return id || null;
  } catch {
    return null;
  }
}
