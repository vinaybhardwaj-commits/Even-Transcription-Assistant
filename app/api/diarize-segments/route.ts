/**
 * GET /api/diarize-segments — speaker timings WITHOUT text, for one encounter, one room window, or one
 * bench session (plan §D, the doctor-ID feed). Read-only.
 *
 *   ?encounter_id=enc_…   phone encounter; times from the start of the recording
 *   ?window_id=bw_…       room window; times from the clip's start, origin_ms is its wall clock
 *   ?session_id=bs_…      every diarized window of a bench session, in order (&limit=, max 500)
 *
 * Exactly one id. AUTH IS THE MCP BEARER (lib/mcp/auth), and the token must hold `read` — not an
 * admin cookie, not a doctor JWT. The payload is built by lib/diarize-segments.ts from named fields
 * only: no transcript text, no embedding, no stored label or name.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkMcpBearer } from "@/lib/mcp/auth";
import { mcpAuthFailureResponse } from "@/lib/mcp/handler";
import { lookupSegments } from "@/lib/diarize-segments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: NextRequest) {
  const auth = checkMcpBearer(req);
  if (!auth.ok) return mcpAuthFailureResponse(auth.failure);
  if (!auth.principal.scopes.has("read")) {
    return NextResponse.json({ ok: false, error: "scope_or_tool_unavailable", needs: "read" }, { status: 403, headers: NO_STORE });
  }
  const p = req.nextUrl.searchParams;
  try {
    const r = await lookupSegments({
      encounter_id: p.get("encounter_id"),
      window_id: p.get("window_id"),
      session_id: p.get("session_id"),
      limit: p.get("limit") === null ? null : Number(p.get("limit")),
    });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: r.status, headers: NO_STORE });
    return NextResponse.json({ ok: true, ...r.payload }, { headers: NO_STORE });
  } catch (e) {
    console.error("[diarize-segments] read failed:", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: "read_failed" }, { status: 500, headers: NO_STORE });
  }
}
