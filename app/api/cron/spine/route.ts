/**
 * GET /api/cron/spine — the Spine cron (S1: signal ingest only). NOT scheduled: there is no vercel.json entry; the schedule is set at go-live.
 * BEARER, as the other cron routes: `Authorization: Bearer $CRON_SECRET`. CRON_SECRET unset -> 503 and nothing runs; wrong bearer -> 401.
 * Gated by spine_config (kill_switch / ingest): off, missing or malformed -> a no-op that returns { skipped: "off" } and writes nothing.
 * Response: counts only. A failure returns 500 { error: { code: "SPINE_INGEST_FAILED" } }.
 */
import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/spine/auth";
import { ingestSpineSignals } from "@/lib/spine/ingest-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "CRON_SECRET is not set" } }, { status: 503, ...NO_STORE });
  if (!bearerMatches(req.headers.get("authorization"), secret)) return NextResponse.json({ error: { code: "AUTH_REQUIRED", message: "cron bearer required" } }, { status: 401, ...NO_STORE });
  try {
    const ingest = await ingestSpineSignals(Date.now());
    return NextResponse.json({ ok: true, ingest }, NO_STORE);
  } catch (e) {
    console.error("spine cron: ingest failed", (e as { code?: string }).code ?? "unknown");
    return NextResponse.json({ error: { code: "SPINE_INGEST_FAILED" } }, { status: 500, ...NO_STORE });
  }
}
