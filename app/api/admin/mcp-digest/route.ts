/**
 * /api/admin/mcp-digest — the 20:00 IST daily digest of non-V MCP activity, mailed to the approver (vercel.json: 30 14 * * * UTC). Also the 30-day purge of the owner security log.
 * GET: Bearer CRON_SECRET (Vercel Cron sends it when the project has CRON_SECRET set); no secret configured = always 401. Counts per user and tool for the last 24 h; never subject ids, never the owner security log. A mail failure is reported, not thrown.
 */
import { NextRequest, NextResponse } from "next/server";
import { digestSince, digestText, purgeSeclog } from "@/lib/mcp/audit-views";
import { mailApprover } from "@/lib/mcp/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorised(req: NextRequest): boolean {
  // R3: the x-vercel-cron header alone is NOT enough (a client can send it); the Vercel cron secret is required, as on the other safe routes.
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let lines;
  try {
    lines = await digestSince(since);
  } catch {
    return NextResponse.json({ ok: false, error: "digest_unavailable" }, { status: 503 });
  }
  const sent = await mailApprover("EvenScribe MCP daily digest", digestText(lines, since));
  let purged: number | null = null;
  try { purged = await purgeSeclog(); } catch { /* reported as null */ }
  return NextResponse.json({ ok: true, users: lines.length, mailed: sent, seclog_purged: purged });
}
