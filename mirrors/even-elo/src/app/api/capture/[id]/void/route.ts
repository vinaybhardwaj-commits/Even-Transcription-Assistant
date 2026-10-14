import { NextResponse } from "next/server";
import { getCapture, isMissingCaptureTable, voidCapture } from "@/lib/capture/db";
import { toPublicCapture } from "@/lib/capture/present";
import { sanitizeVoidReason } from "@/lib/capture/provenance";
import { isUuid, migrationRequiredResponse, requireCaptureStaff } from "@/lib/capture/staff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: { id: string } }) {
  const gate = await requireCaptureStaff();
  if ("response" in gate) return gate.response;
  const id = context.params.id;
  if (!isUuid(id) || !isUuid(gate.user.profileId)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }

  let reason: string | null = null;
  try {
    const body = (await request.json()) as { reason?: unknown };
    reason = sanitizeVoidReason(body.reason);
  } catch {
    reason = null;
  }

  try {
    const updated = await voidCapture(id, gate.user.profileId, reason);
    if (updated) return NextResponse.json({ ok: true, capture: toPublicCapture(updated) });
    const existing = await getCapture(id);
    if (!existing) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    return NextResponse.json(
      { ok: false, error: "Only a queued capture can be voided.", status: existing.status },
      { status: 409 },
    );
  } catch (error) {
    if (isMissingCaptureTable(error)) return migrationRequiredResponse();
    return NextResponse.json({ ok: false, error: "Could not void the capture." }, { status: 500 });
  }
}
