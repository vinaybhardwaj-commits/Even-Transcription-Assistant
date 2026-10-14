// M0-B (fable ruling G2.3): the doctors host serves only the physician portal.
// Anything else is a plain 404, so staff pages and APIs are not reachable there.

/** Path prefixes allowed on a doctors.* host. Each matches the prefix itself or anything below it. */
export const DOCTORS_HOST_ALLOWLIST: readonly string[] = [
  // Portal pages: dashboard, /portal/login, /portal/set-pin.
  "/portal",
  // Portal APIs, including /api/portal/auth/* (login, logout, request-pin, set-pin), which is
  // where the portal login page actually posts. The portal never calls /auth or /api/auth.
  "/api/portal",
  // Build output: JS/CSS chunks and next/font self-hosted fonts (/_next/static/media).
  // Deliberately not all of /_next: /_next/data/* would expose page data for staff routes.
  "/_next/static",
  // Optimised images.
  "/_next/image",
  // Browser icon request.
  "/favicon.ico",
  // Crawler file.
  "/robots.txt",
];

export function isDoctorsHost(host: string, forceHeader?: string | null): boolean {
  const h = host.toLowerCase();
  if (h.startsWith("doctors.")) return true;
  // Tests only: localhost may impersonate the doctors host, never in production.
  const local = h.startsWith("localhost") || h.startsWith("127.0.0.1");
  return local && process.env.NODE_ENV !== "production" && forceHeader === "doctors";
}

export function isAllowedOnDoctorsHost(pathname: string): boolean {
  return DOCTORS_HOST_ALLOWLIST.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
