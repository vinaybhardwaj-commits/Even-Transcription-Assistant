import { NextRequest } from "next/server";
import { respondError, respondOk } from "@/lib/respond";

/**
 * POST /api/auth/pin
 *
 * Body: { slug: string, token: string, pin: string }
 * Returns: { jwt, expires_at, doctor: { id, full_name } } on success
 * Or: 401/423 with §7.5 error envelope on failure.
 *
 * Sprint 0: stub that validates payload shape and returns 501 NOT_IMPLEMENTED.
 * Sprint 1 wires: doctor lookup by slug+token, bcrypt PIN verify,
 *   failed_pin_count increment, lockout escalation (5/10/20/30 thresholds),
 *   per-slug rate limit (1/sec, 60/hr), signed JWT issue.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return respondError("VALIDATION_FAILED", "Body must be JSON");
  }

  const b = body as { slug?: unknown; token?: unknown; pin?: unknown };
  if (
    typeof b.slug !== "string" ||
    typeof b.token !== "string" ||
    typeof b.pin !== "string" ||
    !/^\d{4}$/.test(b.pin)
  ) {
    return respondError(
      "VALIDATION_FAILED",
      "slug, token, and 4-digit pin are required"
    );
  }

  // Sprint 0: stub. Sprint 1 wires the real flow.
  return respondOk(
    {
      stub: true,
      received: { slug: b.slug, pin_len: b.pin.length },
      message: "Sprint 0 stub. Real PIN verify in Sprint 1.",
    },
    200
  );
}
