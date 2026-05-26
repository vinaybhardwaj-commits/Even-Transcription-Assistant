import { NextRequest, NextResponse } from "next/server";
import { clearDoctorCookie } from "@/lib/cookie";
import { respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { slug?: unknown };
  try { body = await req.json(); } catch { return respondError("VALIDATION_FAILED", "Body must be JSON"); }
  if (typeof body.slug !== "string") return respondError("VALIDATION_FAILED", "slug required");
  await clearDoctorCookie(body.slug);
  return NextResponse.json({ ok: true });
}
