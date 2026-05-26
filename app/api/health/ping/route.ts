import { NextResponse } from "next/server";

/**
 * GET /api/health/ping
 * Cheapest possible probe — no DB, no upstream calls.
 * Used by the mobile pre-flight check before starting a recording.
 * PRD §4.18 — 2s timeout on the client side; this should reply <50ms.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, ts: Date.now() });
}
