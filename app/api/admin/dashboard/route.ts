/**
 * GET /api/admin/dashboard
 *
 * Returns the bundle that drives /admin's overview (Sprint 9, Figma S1):
 *   { kpi, attention, chart_7d, chart_total, chart_avg_per_day, health, activity }
 *
 * Gated by eta_admin_session cookie. Polled by the dashboard client every 30s.
 */
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { getAdminDashboard } from "@/lib/admin/dashboard";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try {
    await verifyAdminJwt(cookie);
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }
  const bundle = await getAdminDashboard();
  return respondOk(bundle);
}
