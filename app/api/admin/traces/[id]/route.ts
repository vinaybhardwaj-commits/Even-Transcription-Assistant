/**
 * GET /api/admin/traces/{id}
 *
 * Returns full forensic detail for a single llm_traces row: all events,
 * model_calls, result_summary. Drives /admin/traces/{id} detail page.
 *
 * Gated by eta_admin_session cookie.
 */
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { getTrace } from "@/lib/llm-trace/log";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try {
    await verifyAdminJwt(cookie);
  } catch {
    return respondError("AUTH_EXPIRED", "Session invalid");
  }

  const { id } = await params;
  if (!id || id.length < 8) return respondError("VALIDATION_FAILED", "bad_id");

  const trace = await getTrace(id);
  if (!trace) return respondError("NOT_FOUND", "trace_not_found");

  return respondOk({ trace });
}
