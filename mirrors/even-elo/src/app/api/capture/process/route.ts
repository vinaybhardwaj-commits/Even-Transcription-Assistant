import { NextRequest, NextResponse } from "next/server";
import { isOtCaptureOcrEnabled } from "@/lib/capture/access";
import { isMissingCaptureTable } from "@/lib/capture/db";
import { clampOcrLimit, processQueuedCaptures } from "@/lib/capture/ocr/run";
import { isMissingSheetTable } from "@/lib/capture/sheets-db";
import { isUuid, migrationRequiredResponse, requireCaptureStaff, sheetMigrationRequiredResponse } from "@/lib/capture/staff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * Staff trigger for the OCR worker. No-ops unless FEATURE_OT_CAPTURE_OCR is exactly "true".
 * Vercel Cron uses /api/cron/ot-capture-ocr so this route stays on the session gate.
 */
export async function POST(request: NextRequest) {
  const gate = await requireCaptureStaff();
  if ("response" in gate) return gate.response;
  if (!isOtCaptureOcrEnabled()) {
    return NextResponse.json({ ok: true, skipped: "flag_off", processed: 0, results: [] });
  }

  let limit = clampOcrLimit(undefined);
  let ids: string[] | undefined;
  let retry = false;
  try {
    const body = (await request.json()) as { limit?: unknown; ids?: unknown; retry?: unknown };
    if (body && typeof body === "object") {
      if (body.limit != null) limit = clampOcrLimit(body.limit);
      retry = body.retry === true;
      if (body.ids != null) {
        if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string" || !isUuid(id))) {
          return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
        }
        ids = body.ids;
      }
    }
  } catch {
    // Empty body still drains the queue.
  }

  try {
    const result = await processQueuedCaptures({ limit, ids, retry });
    return NextResponse.json(result);
  } catch (error) {
    if (isMissingSheetTable(error)) return sheetMigrationRequiredResponse();
    if (isMissingCaptureTable(error)) return migrationRequiredResponse();
    return NextResponse.json({ ok: false, error: "Could not process captures." }, { status: 500 });
  }
}
