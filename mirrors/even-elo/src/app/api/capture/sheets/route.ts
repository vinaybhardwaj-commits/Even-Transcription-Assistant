import { NextRequest, NextResponse } from "next/server";
import { isOtCaptureOcrEnabled } from "@/lib/capture/access";
import { isHospitalCode } from "@/lib/capture/images";
import { isMissingSheetTable, listSheets, listSheetStatRows } from "@/lib/capture/sheets-db";
import { cleanSheetQuery, isSheetReviewFilter, summarizeSheets, toPublicSheetListItem } from "@/lib/capture/sheets";
import { requireCaptureStaff, sheetMigrationRequiredResponse } from "@/lib/capture/staff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const gate = await requireCaptureStaff();
  if ("response" in gate) return gate.response;

  const review = request.nextUrl.searchParams.get("review") ?? "all";
  const hospitalRaw = (request.nextUrl.searchParams.get("hospital") ?? "EHRC").toUpperCase();
  const query = cleanSheetQuery(request.nextUrl.searchParams.get("q") ?? "");
  if (!isSheetReviewFilter(review)) {
    return NextResponse.json({ ok: false, error: "invalid review" }, { status: 400 });
  }
  if (hospitalRaw !== "ALL" && !isHospitalCode(hospitalRaw)) {
    return NextResponse.json({ ok: false, error: "invalid hospital" }, { status: 400 });
  }

  try {
    const [rows, stats] = await Promise.all([
      listSheets({ hospital: hospitalRaw, review, query }),
      listSheetStatRows(hospitalRaw),
    ]);
    return NextResponse.json({
      ok: true,
      hospital: hospitalRaw,
      review,
      q: query,
      ocr_enabled: isOtCaptureOcrEnabled(),
      stats: summarizeSheets(stats),
      sheets: rows.map(toPublicSheetListItem),
    });
  } catch (error) {
    if (isMissingSheetTable(error)) return sheetMigrationRequiredResponse();
    return NextResponse.json({ ok: false, error: "Could not load OT sheets." }, { status: 500 });
  }
}
