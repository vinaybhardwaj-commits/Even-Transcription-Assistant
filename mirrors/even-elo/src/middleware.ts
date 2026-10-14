import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { isPublicCaptureApi, isPublicCapturePage, isUploadCaptureHost } from "@/lib/capture/access";
import { checkCronAuth } from "@/lib/cron-auth";
import { isAllowedOnDoctorsHost, isDoctorsHost } from "@/lib/host-lock";

const COOKIE_NAME = "epi_session";

// Public routes — no auth required
const PUBLIC_ROUTES = ["/auth/login", "/auth/signup", "/auth/pending", "/report"];
const PUBLIC_API_ROUTES = [
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/logout",
  "/api/hospitals-public",
  "/api/positions",
  // Public external incident intake (/report page) — no auth by design.
  "/api/public/physicians",
  "/api/public/incidents",
  // Governance MCP server — does its own bearer-token auth.
  "/api/mcp",
  // Daily Dash GV service intake — does its own bearer-token auth.
  "/api/service/observations",
  // OAuth endpoints for the MCP connector.
  "/api/oauth/register",
  "/api/oauth/authorize",
  "/api/oauth/token",
];

// Admin-bootstrap routes — URL-gated like v1 (no auth required so we can run
// migrate + seed during deploys). Keep this list short and explicit.
// Every route below EXCEPT portal-welcome (which checks MCP_BEARER_TOKEN itself) is listed only so
// a deploy script can reach it with `Authorization: Bearer ${ADMIN_OPS_TOKEN}` and no cookie. The
// handler is the gate: each one calls requireOps() (src/lib/ops-auth.ts), which wants that bearer
// or a super_admin session and answers 401 otherwise. A route added here MUST gate itself.
const ADMIN_BOOTSTRAP_ROUTES = [
  "/api/admin/migrate",
  "/api/admin/portal-welcome",
  "/api/admin/seed-epi-base",
  "/api/admin/db-snapshot",
  "/api/admin/db-fresh",
  "/api/admin/wipe-smoke-residue",
  "/api/admin/seed-profile",
  "/api/admin/oppe-scheduler",
  "/api/admin/oppe-kickstart",
  "/api/admin/bulk-import-physicians",
  "/api/admin/dedupe-physicians",
  "/api/admin/map-cdmss-doctors",
];

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

interface MiddlewarePayload {
  profileId?: unknown;
  email?: unknown;
  status?: unknown;
  is_super_admin?: unknown;
  is_sgc_member?: unknown;
  must_change_pin?: unknown;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // M0-B doctors host lock: runs before every other rule (including the static and
  // .well-known bypasses) so nothing outside the portal allowlist can be served there.
  const lockHost = (request.headers.get("host") || "").toLowerCase();
  if (isDoctorsHost(lockHost, request.headers.get("x-test-host"))) {
    if (pathname === "/") return NextResponse.redirect(new URL("/portal", request.url));
    // nextUrl strips /_next/data/<id>/...json down to the page path, so also check the raw URL path.
    if (!isAllowedOnDoctorsHost(pathname) || !isAllowedOnDoctorsHost(new URL(request.url).pathname)) return new NextResponse(null, { status: 404 });
  }

  // OAuth discovery metadata — always public (RFC 9728 / 8414).
  if (request.nextUrl.pathname.startsWith("/.well-known/")) {
    return NextResponse.next();
  }

  // Static assets
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/manifest") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".svg")
  ) {
    return NextResponse.next();
  }

  // -- Friendly host routing --
  // doctors.evenos.app  → Doctor Portal (root redirects to /portal, which then
  //                       cascades to /portal/login if there's no physician session).
  // governance.evenos.app → Admin app served at root by default (no rewrite needed).
  // upload.governance.evenos.app → phone capture shell (no auth). /capture remains
  // the path fallback on the governance host before that DNS exists.
  // even-elo.vercel.app stays fully path-addressable for both surfaces.
  const host = (request.headers.get("host") || "").toLowerCase();
  if (isUploadCaptureHost(host) && pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/capture";
    return NextResponse.rewrite(url);
  }

  // Phone capture: shared staff link, no Governance session.
  // Staff queue, image proxy, and void stay behind the session below.
  if (isPublicCapturePage(pathname) || isPublicCaptureApi(pathname)) {
    return NextResponse.next();
  }

  // -- Physician portal: separate auth surface (epi_physician_session) --
  if (pathname.startsWith("/portal") || pathname.startsWith("/api/portal")) {
    if (pathname === "/portal/login" || pathname.startsWith("/api/portal/auth/")) {
      return NextResponse.next();
    }
    const ptoken = request.cookies.get("epi_physician_session")?.value;
    const psecret = getJwtSecret();
    if (!ptoken || !psecret) {
      if (pathname.startsWith("/api/")) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
      return NextResponse.redirect(new URL("/portal/login", request.url));
    }
    try {
      const { payload } = await jwtVerify(ptoken, psecret);
      if ((payload as Record<string, unknown>).kind !== "physician") throw new Error("not physician");
      if ((payload as Record<string, unknown>).portal_must_change_pin === true && pathname !== "/portal/set-pin") {
        if (pathname.startsWith("/api/")) return NextResponse.json({ ok: false, error: "PIN change required" }, { status: 403 });
        return NextResponse.redirect(new URL("/portal/set-pin", request.url));
      }
      return NextResponse.next();
    } catch {
      if (pathname.startsWith("/api/")) return NextResponse.json({ ok: false, error: "Session expired" }, { status: 401 });
      return NextResponse.redirect(new URL("/portal/login", request.url));
    }
  }

  // Public pages
  if (PUBLIC_ROUTES.some((r) => pathname === r)) {
    return NextResponse.next();
  }

  // Public + bootstrap API routes (exact match)
  if (PUBLIC_API_ROUTES.some((r) => pathname === r)) {
    return NextResponse.next();
  }
  if (ADMIN_BOOTSTRAP_ROUTES.some((r) => pathname === r)) {
    return NextResponse.next();
  }

  // Cron routes accept ONE credential: Authorization: Bearer ${CRON_SECRET}
  // (Vercel Cron sends it automatically). No User-Agent trust, no session
  // fallback, and no blanket bypass: a request without the bearer is refused
  // here (401), and a deployment without CRON_SECRET answers 503 (fail
  // closed). The route handlers re-check with the same function.
  if (pathname === "/api/cron" || pathname.startsWith("/api/cron/")) {
    const cron = checkCronAuth(request.headers.get("authorization"), process.env.CRON_SECRET);
    if (cron.ok) return NextResponse.next();
    return NextResponse.json({ ok: false, error: cron.error }, { status: cron.status });
  }

  // Session cookie
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }
    return NextResponse.redirect(new URL("/auth/login", request.url));
  }

  const secret = getJwtSecret();
  if (!secret) {
    return NextResponse.redirect(new URL("/auth/login", request.url));
  }

  try {
    const { payload: rawPayload } = await jwtVerify(token, secret);
    const payload = rawPayload as MiddlewarePayload;

    // Status must be active
    if (payload.status !== "active") {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { ok: false, error: "Account pending approval" },
          { status: 403 },
        );
      }
      return NextResponse.redirect(new URL("/auth/pending", request.url));
    }

    // Users Module #11 — force first-login PIN change. Exempt the change-pin
    // page + all /api/auth/* so the user can complete it (no lock-out).
    if (
      payload.must_change_pin === true &&
      pathname !== "/auth/change-pin" &&
      !pathname.startsWith("/api/auth/")
    ) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ ok: false, error: "PIN change required" }, { status: 403 });
      }
      return NextResponse.redirect(new URL("/auth/change-pin", request.url));
    }

    // /surgical-governance gated to super_admin only (Users PRD #18 — ELO super_admin-only)
    if (
      pathname.startsWith("/surgical-governance") &&
      !payload.is_super_admin
    ) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { ok: false, error: "Forbidden" },
          { status: 403 },
        );
      }
      return NextResponse.redirect(new URL("/home", request.url));
    }

    // /surgical-governance/admin and any /admin gated to super_admin only
    if (
      (pathname.startsWith("/surgical-governance/admin") ||
        pathname.startsWith("/admin")) &&
      !payload.is_super_admin
    ) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { ok: false, error: "Forbidden" },
          { status: 403 },
        );
      }
      return NextResponse.redirect(new URL("/home", request.url));
    }

    return NextResponse.next();
  } catch {
    // Invalid/expired token — clear cookie + send to login
    const response = pathname.startsWith("/api/")
      ? NextResponse.json(
          { ok: false, error: "Session expired" },
          { status: 401 },
        )
      : NextResponse.redirect(new URL("/auth/login", request.url));
    response.cookies.delete(COOKIE_NAME);
    return response;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
