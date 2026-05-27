import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * middleware.ts — short-URL rewrites for admin pages.
 *
 * Lets V (and any other admin) type memorable 1-word paths instead of
 * the canonical deeply-nested admin URLs. Uses NextResponse.rewrite(),
 * so the browser URL stays at /launch (not /admin/settings/launch-readiness)
 * — cleanest mental model for daily use.
 *
 * Doctor app paths /dr-<slug>/* are NOT matched (matcher is explicit).
 */
const SHORT_URL_MAP: Record<string, string> = {
  "/launch":     "/admin/settings/launch-readiness",
  "/dashboard":  "/admin",
  "/traces":     "/admin/traces",
  "/sends":      "/admin/sends",
  "/encounters": "/admin/encounters",
  "/doctors":    "/admin/doctors",
  "/settings":   "/admin/settings",
  "/health":     "/admin/settings/health",
};

export function middleware(req: NextRequest) {
  const target = SHORT_URL_MAP[req.nextUrl.pathname];
  if (!target) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = target;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: [
    "/launch",
    "/dashboard",
    "/traces",
    "/sends",
    "/encounters",
    "/doctors",
    "/settings",
    "/health",
  ],
};
