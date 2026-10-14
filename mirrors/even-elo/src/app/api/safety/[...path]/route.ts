import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The AI RCA suggest (Gemini, 15-40s) flows through this proxy — the default
// fn timeout 504'd it (bug found by V, 2 Jul). Match even-incident's budget.
export const maxDuration = 60;

const BASE = process.env.INCIDENT_API_BASE;
const APITOK = process.env.INCIDENT_API_TOKEN;

/** The verified SGC/super user, or null. Returns the user so fwd() can attribute the call. */
async function authed() {
  const u = await getCurrentUser();
  if (!u || u.status !== "active") return null;
  if (!(u.is_super_admin || u.is_sgc_member)) return null;
  return u;
}

async function fwd(req: NextRequest, path: string[], method: string): Promise<NextResponse> {
  const user = await authed();
  if (!user) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  if (!BASE || !APITOK) return NextResponse.json({ ok: false, error: "Incident API not configured" }, { status: 500 });
  const url = `${BASE}/api/${(path || []).join("/")}${req.nextUrl.search || ""}`;
  // Reviewer identity crosses the proxy as headers (M&M PRD decision 12): the
  // shared bearer alone cannot tell even-incident who is calling, and FR-11
  // ratification needs a named human. Downstream trusts these ONLY on requests
  // bearing the service token. The name is URI-encoded — header values must
  // stay ASCII-safe, and clinician names are not.
  const init: RequestInit = {
    method,
    // Belt-and-braces: these are live governance reads, never cache them.
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${APITOK}`,
      "Content-Type": "application/json",
      "x-actor-name": encodeURIComponent(user.full_name || ""),
      "x-actor-email": user.email || "",
      "x-actor-super": user.is_super_admin ? "1" : "0",
      "x-actor-sgc": user.is_sgc_member ? "1" : "0",
    },
  };
  if (method !== "GET" && method !== "DELETE") init.body = await req.text();
  const res = await fetch(url, init);
  const body = await res.text();
  return new NextResponse(body, { status: res.status, headers: { "Content-Type": res.headers.get("content-type") || "application/json" } });
}

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) { return fwd(req, params.path, "GET"); }
export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) { return fwd(req, params.path, "POST"); }
export async function PATCH(req: NextRequest, { params }: { params: { path: string[] } }) { return fwd(req, params.path, "PATCH"); }
export async function DELETE(req: NextRequest, { params }: { params: { path: string[] } }) { return fwd(req, params.path, "DELETE"); }
