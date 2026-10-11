/**
 * GET /api/freescript/pending — jobs the box runner should pick up. No transcript, no artifact.
 *
 * 404 when ETA_FREESCRIPT is 0 (unset is on). Auth: HMAC over `${ts}.GET ${path}` (lib/freescript/auth.ts).
 *   200 { ok, jobs: [{ job_id, consult_uid?, room?, ist_date? }] }
 */
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { FlagValueError } from "@/lib/flags";
import { checkFreescriptGet } from "@/lib/freescript/auth";
import { freescriptEnabled } from "@/lib/freescript/flag";
import { FREESCRIPT_KIND } from "@/lib/jobs/kinds/freescript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Row = { id: string; args: Record<string, unknown> | string | null };

export async function GET(req: NextRequest) {
  try {
    if (!freescriptEnabled()) return NextResponse.json({ ok: false, error: "disabled" }, { status: 404 });
  } catch (e) {
    if (e instanceof FlagValueError) return NextResponse.json({ ok: false, error: "freescript_flag" }, { status: 500 });
    throw e;
  }
  const url = new URL(req.url);
  const auth = checkFreescriptGet(req.headers, `${url.pathname}${url.search}`);
  if (auth) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  try {
    const rows = (await sql`
      SELECT id, args FROM scribe_job
       WHERE kind = ${FREESCRIPT_KIND}
         AND status IN ('queued', 'running')
         AND (step IS NULL OR step IN ('accept', 'await_box'))
       ORDER BY created_at
       LIMIT 50`) as Row[];
    const jobs = rows.map((r) => {
      const args = typeof r.args === "string" ? (JSON.parse(r.args) as Record<string, unknown>) : (r.args ?? {});
      return {
        job_id: r.id,
        ...(typeof args.consult_uid === "string" ? { consult_uid: args.consult_uid } : {}),
        ...(typeof args.room === "string" ? { room: args.room } : {}),
        ...(typeof args.ist_date === "string" ? { ist_date: args.ist_date } : {}),
      };
    });
    return NextResponse.json({ ok: true, jobs }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `db:${(e as { code?: string }).code ?? "unknown"}` }, { status: 503 });
  }
}
