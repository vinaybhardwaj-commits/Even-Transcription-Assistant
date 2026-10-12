/**
 * GET /api/reb/roles — the REB role.llm-roles track for one consult or a batch. Roles and times only.
 *
 * Auth: Bearer REB_INDEX_READ_TOKEN or REB_INDEX_TOKEN. 503 when neither is set.
 * Query: consult_uid= | consult_uids=a,b (max 25) | ist_date=YYYY-MM-DD.
 * Does not flip ETA_REB_ROLE_LLM. Read-only. A segment text field is not returned.
 *   200 { ok, selector, n, rows }    400 bad_args | bad_date    401 unauthorized    503 not_configured
 */
import { NextRequest, NextResponse } from "next/server";
import { exportRoleTracks } from "@/lib/room-access/readers/reb-role-export";
import { checkRebReadBearer } from "@/lib/reb/read-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const auth = checkRebReadBearer(req.headers.get("authorization"));
  if (auth) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const url = new URL(req.url);
  const one = url.searchParams.get("consult_uid");
  const listed = url.searchParams.get("consult_uids");
  const day = url.searchParams.get("ist_date");
  const uids = listed ? listed.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : one ? [one] : undefined;
  if (!uids?.length && !day) return NextResponse.json({ ok: false, error: "bad_args" }, { status: 400 });
  try {
    const out = await exportRoleTracks({ consult_uids: uids, ist_date: uids?.length ? null : day });
    const status = out.ok === false && (out.error === "bad_date" || out.error === "bad_args") ? 400 : 200;
    return NextResponse.json(out, { status, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `db:${(e as { code?: string }).code ?? "unknown"}` }, { status: 503 });
  }
}
