import { NextResponse } from "next/server";
import { sanitizeFreeText } from "@/lib/capture/provenance";
import { getSheet, isMissingSheetTable, reviewSheet } from "@/lib/capture/sheets-db";
import { toPublicSheetDetail } from "@/lib/capture/sheets";
import { isUuid, requireCaptureStaff, sheetMigrationRequiredResponse } from "@/lib/capture/staff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: { id: string } }) {
  const gate = await requireCaptureStaff();
  if ("response" in gate) return gate.response;
  if (!isUuid(context.params.id) || !isUuid(gate.user.profileId)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  let decision: string | null = null;
  let note: string | null = null;
  try {
    const body = (await request.json()) as { decision?: unknown; note?: unknown };
    decision = typeof body.decision === "string" ? body.decision : null;
    note = sanitizeFreeText(body.note, 200);
  } catch {
    decision = null;
  }
  if (decision !== "approved" && decision !== "rejected") {
    return NextResponse.json({ ok: false, error: "decision must be approved or rejected" }, { status: 400 });
  }
  try {
    const saved = await reviewSheet({
      id: context.params.id,
      decision,
      profileId: gate.user.profileId,
      note,
    });
    if (!saved) {
      const existing = await getSheet(context.params.id);
      if (!existing) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
      return NextResponse.json(
        { ok: false, error: "This sheet is already reviewed.", review_status: existing.review_status },
        { status: 409 },
      );
    }
    const row = await getSheet(context.params.id);
    if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, sheet: toPublicSheetDetail(row) });
  } catch (error) {
    if (isMissingSheetTable(error)) return sheetMigrationRequiredResponse();
    return NextResponse.json({ ok: false, error: "Could not review the OT sheet." }, { status: 500 });
  }
}
