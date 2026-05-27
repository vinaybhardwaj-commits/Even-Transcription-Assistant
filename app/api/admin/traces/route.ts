/**
 * GET /api/admin/traces
 *
 * Lists rows from the llm_traces table for the admin trace dashboard at
 * /admin/traces. Returns both a paged list and the aggregate KPIs in one
 * shot so the page only needs one network call per poll.
 *
 * Query params:
 *   ?surface=note-pipeline   exact-match filter (omit for all)
 *   ?status=errored          one of in_progress|completed|errored|aborted
 *   ?window=today|last24h|all  defaults to last24h
 *   ?limit=50                clamped 1..500
 *   ?offset=0
 *
 * Gated by eta_admin_session cookie.
 */
import { NextRequest } from "next/server";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import {
  listAdminTraces,
  getAdminTraceAggregates,
  listAdminTraceSurfaces,
  type AdminTraceFilter,
  type TraceStatus,
} from "@/lib/llm-trace/log";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function guard(): Promise<{ ok: true } | { ok: false; code: "AUTH_REQUIRED" | "AUTH_EXPIRED"; msg: string }> {
  const cookie = await readAdminCookie();
  if (!cookie) return { ok: false, code: "AUTH_REQUIRED", msg: "Sign in required" };
  try {
    await verifyAdminJwt(cookie);
    return { ok: true };
  } catch {
    return { ok: false, code: "AUTH_EXPIRED", msg: "Session invalid" };
  }
}

function parseStatus(raw: string | null): TraceStatus | null {
  if (!raw) return null;
  switch (raw) {
    case "in_progress":
    case "completed":
    case "errored":
    case "aborted":
      return raw;
    default:
      return null;
  }
}

function parseWindow(raw: string | null): AdminTraceFilter["window"] {
  switch (raw) {
    case "today":
    case "last24h":
    case "all":
      return raw;
    default:
      return "last24h";
  }
}

export async function GET(req: NextRequest) {
  const g = await guard();
  if (!g.ok) return respondError(g.code, g.msg);

  const url = new URL(req.url);
  const surface = url.searchParams.get("surface");
  const status  = parseStatus(url.searchParams.get("status"));
  const window  = parseWindow(url.searchParams.get("window"));
  const limit   = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset  = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);

  const filter: AdminTraceFilter = {
    surface: surface ?? null,
    status,
    window,
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
  };

  // Parallel-fetch: list + aggregates + surfaces (for chip row).
  const [{ rows, total }, aggregates, surfaces] = await Promise.all([
    listAdminTraces(filter),
    getAdminTraceAggregates("today"),
    listAdminTraceSurfaces("last24h"),
  ]);

  return respondOk({
    traces: rows,
    total,
    aggregates,
    surfaces,
    filter: {
      surface: filter.surface,
      status:  filter.status,
      window:  filter.window,
      limit:   filter.limit,
      offset:  filter.offset,
    },
  });
}
