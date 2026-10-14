import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { isOtCaptureEnabled, isOtCaptureOcrEnabled } from "@/lib/capture/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Surgical Governance submodule asks this so capture links stay off the main dashboard. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const enabled = isOtCaptureEnabled() && user.is_super_admin === true;
  return NextResponse.json({
    ok: true,
    enabled,
    ocr: enabled && isOtCaptureOcrEnabled(),
  });
}
