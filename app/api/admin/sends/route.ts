/**
 * GET /api/admin/sends
 *
 * Aggregated send_event data for /admin/sends (Sprint 11, Figma S8).
 * ?window=today|week|month|all  (defaults to month)
 *
 * Gated by eta_admin_session cookie.
 */
import { NextRequest } from "next/server";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { getAdminSends, type SendsWindow } from "@/lib/admin/sends";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseWindow(raw: string | null): SendsWindow {
  if (raw === "today" || raw === "week" || raw === "month" || raw === "all") return raw;
  return "month";
}

export async function GET(req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try {
    await verifyAdminJwt(cookie);
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }
  const url = new URL(req.url);
  const window = parseWindow(url.searchParams.get("window"));
  const bundle = await getAdminSends({ window });
  return respondOk({ ...bundle, window });
}
