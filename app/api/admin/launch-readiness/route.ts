/**
 * GET  /api/admin/launch-readiness          — bundle for the page
 * POST /api/admin/launch-readiness/attest   — toggle audio offline test
 *
 * Body for POST: { passed: boolean }
 */
import { NextRequest } from "next/server";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import {
  getLaunchReadiness,
  attestAudioOfflineTest,
  clearAudioOfflineTestAttestation,
} from "@/lib/admin/launch-readiness";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function guard(): Promise<{ ok: true; adminId: string } | { ok: false; code: "AUTH_REQUIRED" | "AUTH_EXPIRED"; msg: string }> {
  const cookie = await readAdminCookie();
  if (!cookie) return { ok: false, code: "AUTH_REQUIRED", msg: "Sign in required" };
  try {
    const claims = await verifyAdminJwt(cookie);
    return { ok: true, adminId: String(claims.admin_id ?? "") };
  } catch {
    return { ok: false, code: "AUTH_EXPIRED", msg: "Session invalid" };
  }
}

export async function GET() {
  const g = await guard();
  if (!g.ok) return respondError(g.code, g.msg);
  const bundle = await getLaunchReadiness();
  return respondOk(bundle);
}

export async function POST(req: NextRequest) {
  const g = await guard();
  if (!g.ok) return respondError(g.code, g.msg);

  let body: { passed?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const passed = body.passed === true;

  const result = passed
    ? await attestAudioOfflineTest(g.adminId)
    : await clearAudioOfflineTestAttestation(g.adminId);
  if (!result.ok) return respondError("PIPELINE_FAILED", result.error?.slice(0, 200) ?? "attest_failed");
  return respondOk({ ok: true, passed });
}
