import { NextRequest, NextResponse } from "next/server";
import { actorFromRequest } from "@/lib/auth";
import { HOSPITAL_FILTER_COOKIE } from "@/lib/hospital-filter";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * POST /api/hospital-filter
 *
 * Body: { code: "all" | "EHRC" | "EHBR" | "EHIN" | "EHBO" }
 *
 * Sets the epi_hospital_filter cookie (NOT httpOnly so the client UI can
 * read it for the dropdown's current value). 7-day TTL matches session length.
 */
export async function POST(req: NextRequest) {
  try {
    await actorFromRequest();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  }
  const body = await req.json().catch(() => ({}));
  const raw = String(body?.code ?? "").trim().toUpperCase();
  const code = raw === "ALL" ? "all" : (/^[A-Z]{2,8}$/.test(raw) ? raw : "all");
  const res = NextResponse.json({ ok: true, code }, { headers: NO_STORE });
  res.cookies.set(HOSPITAL_FILTER_COOKIE, code, {
    httpOnly: false,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
