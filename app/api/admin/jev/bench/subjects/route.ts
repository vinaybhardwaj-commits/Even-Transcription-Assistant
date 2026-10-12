/**
 * GET /api/admin/jev/bench/subjects?use=consult_rubric&limit=20[&set=<id>] — subject ids the bench could be pointed at, from the use's own eligibility source
 * (for the consult sets: closed consults with a stored transcript, in the source's own seeded order). Ids ONLY. Bearer CRON_SECRET only.
 */
import { NextRequest, NextResponse } from "next/server";
import { respondError } from "@/lib/respond";
import { cronAuthorized } from "@/lib/jev/worker/cron-auth";
import { REAL_USES } from "@/lib/jev/worker/flags";
import "@/lib/jev/worker/register";
import { getUse } from "@/lib/jev/worker/uses";
import { classifyDbError } from "@/lib/jev/worker/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "cron secret required");
  const q = req.nextUrl.searchParams;
  const use = q.get("use") ?? "";
  if (!(REAL_USES as readonly string[]).includes(use)) return NextResponse.json({ error: { code: "unknown_use" } }, { status: 400 });
  const rawLimit = q.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return NextResponse.json({ error: { code: "bad_limit" } }, { status: 400 });
  const set = q.get("set");
  const def = getUse(use, set ?? undefined);
  if (!def) return NextResponse.json({ error: { code: "unknown_set" } }, { status: 400 });
  try {
    const ids = await def.eligible(limit);
    return NextResponse.json({ use, set: def.setId, subject_ids: ids });
  } catch (e) {
    return respondError("PIPELINE_FAILED", `jev bench subjects failed: ${classifyDbError(e)}`);
  }
}
