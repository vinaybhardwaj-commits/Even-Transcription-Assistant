import { NextRequest, NextResponse } from "next/server";
import { countCapturesByStatus, isMissingCaptureTable, listCaptures } from "@/lib/capture/db";
import { isHospitalCode } from "@/lib/capture/images";
import { isQueueFilter, toPublicCapture } from "@/lib/capture/present";
import { migrationRequiredResponse, requireCaptureStaff } from "@/lib/capture/staff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const gate = await requireCaptureStaff();
  if ("response" in gate) return gate.response;

  const status = request.nextUrl.searchParams.get("status") ?? "all";
  const hospitalRaw = (request.nextUrl.searchParams.get("hospital") ?? "EHRC").toUpperCase();
  if (!isQueueFilter(status)) {
    return NextResponse.json({ ok: false, error: "invalid status" }, { status: 400 });
  }
  if (hospitalRaw !== "ALL" && !isHospitalCode(hospitalRaw)) {
    return NextResponse.json({ ok: false, error: "invalid hospital" }, { status: 400 });
  }

  try {
    const [rows, counts] = await Promise.all([
      listCaptures(status, hospitalRaw),
      countCapturesByStatus(hospitalRaw),
    ]);
    return NextResponse.json({
      ok: true,
      hospital: hospitalRaw,
      status,
      counts,
      captures: rows.map(toPublicCapture),
    });
  } catch (error) {
    if (isMissingCaptureTable(error)) return migrationRequiredResponse();
    return NextResponse.json({ ok: false, error: "Could not load the capture queue." }, { status: 500 });
  }
}
