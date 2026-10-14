import { NextResponse } from "next/server";
import { getSheet, isMissingSheetTable, updateSheetFields } from "@/lib/capture/sheets-db";
import { parseSheetEdits, toPublicSheetDetail } from "@/lib/capture/sheets";
import { isUuid, requireCaptureStaff, sheetMigrationRequiredResponse } from "@/lib/capture/staff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: { id: string } }) {
  const gate = await requireCaptureStaff();
  if ("response" in gate) return gate.response;
  if (!isUuid(context.params.id)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  try {
    const row = await getSheet(context.params.id);
    if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, sheet: toPublicSheetDetail(row) });
  } catch (error) {
    if (isMissingSheetTable(error)) return sheetMigrationRequiredResponse();
    return NextResponse.json({ ok: false, error: "Could not load the OT sheet." }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: { id: string } }) {
  const gate = await requireCaptureStaff();
  if ("response" in gate) return gate.response;
  if (!isUuid(context.params.id)) {
    return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  const parsed = parseSheetEdits(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  try {
    const saved = await updateSheetFields(context.params.id, parsed.edits);
    if (!saved) {
      const existing = await getSheet(context.params.id);
      if (!existing) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
      return NextResponse.json(
        { ok: false, error: "Edits lock after approve or reject.", review_status: existing.review_status },
        { status: 409 },
      );
    }
    const row = await getSheet(context.params.id);
    if (!row) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, sheet: toPublicSheetDetail(row) });
  } catch (error) {
    if (isMissingSheetTable(error)) return sheetMigrationRequiredResponse();
    return NextResponse.json({ ok: false, error: "Could not save the OT sheet." }, { status: 500 });
  }
}
