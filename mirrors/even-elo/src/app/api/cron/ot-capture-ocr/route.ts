import { NextRequest, NextResponse } from "next/server";
import { cronGuard } from "@/lib/cron-auth";
import { isOtCaptureOcrEnabled } from "@/lib/capture/access";
import { isMissingCaptureTable } from "@/lib/capture/db";
import { clampOcrLimit, processQueuedCaptures } from "@/lib/capture/ocr/run";
import { isMissingSheetTable } from "@/lib/capture/sheets-db";
import { isUuid } from "@/lib/capture/staff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 180;

/**
 * OCR worker. Vercel Cron GET every 5 minutes.
 * No-ops when FEATURE_OT_CAPTURE_OCR is not exactly "true".
 * Does not mint surgical_cases.
 */
async function run(req: NextRequest) {
  const denied = cronGuard(req, "/api/cron/ot-capture-ocr");
  if (denied) return denied;
  if (!isOtCaptureOcrEnabled()) {
    return NextResponse.json({ ok: true, skipped: "flag_off", processed: 0, results: [] });
  }
  let limit = clampOcrLimit(req.nextUrl.searchParams.get("limit"));
  let ids: string[] | undefined;
  let retry = req.nextUrl.searchParams.get("retry") === "1";
  if (req.method === "POST") {
    try {
      const body = (await req.json()) as { limit?: unknown; ids?: unknown; retry?: unknown };
      if (body.limit != null) limit = clampOcrLimit(body.limit);
      retry = body.retry === true;
      if (Array.isArray(body.ids)) {
        if (body.ids.some((id) => typeof id !== "string" || !isUuid(id))) {
          return NextResponse.json({ ok: false, error: "invalid id" }, { status: 400 });
        }
        ids = body.ids;
      }
    } catch {
      // GET-shaped POST still drains the oldest queued rows.
    }
  }
  try {
    const result = await processQueuedCaptures({ limit, ids, retry });
    return NextResponse.json(result);
  } catch (error) {
    if (isMissingSheetTable(error) || isMissingCaptureTable(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "OT capture tables are not migrated yet. POST /api/admin/migrate on this deployment.",
          code: "migration_required",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: "Could not process captures." }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
