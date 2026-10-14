/**
 * Doctor-portal feature flags (A2).
 *
 * The flags used to gate the UI only: the nav hid Findings when PORTAL_FINDINGS was off, but a
 * signed-in doctor could still call the API routes directly. Every portal Findings route now asks
 * this module, so a dark flag means a dark endpoint, not just a hidden button.
 *
 *   PORTAL_FINDINGS          reading findings: GET /api/portal/findings, /document-audits, the PDF proxy
 *   PORTAL_REACTIONS         the private reaction (also needs PORTAL_FINDINGS)
 *   PORTAL_FINDINGS_RESPOND  answering a finding, on both lists (also needs PORTAL_FINDINGS)
 *
 * A flag is on only when the env var is exactly "1". Read per call (never cached at import) so a
 * redeploy with new env takes effect and tests can toggle it.
 */

import { NextResponse } from "next/server";

const on = (name: string) => process.env[name] === "1";

/** The flag set the portal UI reads from /api/portal/announcements. */
export function portalFlags() {
  return {
    incidents: on("PORTAL_INCIDENTS"),
    findings: on("PORTAL_FINDINGS"),
    reactions: on("PORTAL_REACTIONS"),
    findingsRespond: on("PORTAL_FINDINGS_RESPOND"),
  };
}

export function findingsEnabled(): boolean {
  return on("PORTAL_FINDINGS");
}

export function reactionsEnabled(): boolean {
  return on("PORTAL_FINDINGS") && on("PORTAL_REACTIONS");
}

export function respondEnabled(): boolean {
  return on("PORTAL_FINDINGS") && on("PORTAL_FINDINGS_RESPOND");
}

/** A read route behind a dark flag: 404, as if the endpoint did not exist. */
export function disabledRead(): NextResponse {
  return NextResponse.json({ ok: false, error: "disabled" }, { status: 404 });
}

/** A write route behind a dark flag: the portal's usual 200 + named word, so the card can say so. */
export function disabledWrite(): NextResponse {
  return NextResponse.json({ ok: false, error: "disabled" });
}
