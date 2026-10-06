/**
 * GET /api/admin/steward/decisions?room=&since=&limit= — the Room Steward's decision log, newest first (part 3's panel; FLEET's judging of the shadow days).
 *
 * Admin-cookie auth like /api/admin/fleet-attention (benchAdminGuard). Read-only. `room` = a room id (exact); `since` = an ISO-8601 instant (rows with ts >= since);
 * `limit` = 1..500 (default 100). Every value is a bound parameter. Rows come back with `ts` as an ISO string; `inputs` carries ids, hashes and counts only.
 */
import { NextResponse } from "next/server";
import { benchAdminGuard } from "@/lib/bench";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };
const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 100;

type Row = {
  id: unknown;
  ts: unknown;
  room_id: string | null;
  machine: string | null;
  window_kind: string | null;
  rule: string;
  action: string;
  params: unknown;
  mode: string;
  result: string | null;
  actor: string;
  why: string | null;
  why_not: string | null;
  inputs_hash: string | null;
  inputs: unknown;
};

export async function GET(req: Request) {
  const guard = await benchAdminGuard();
  if (!guard.ok) {
    return NextResponse.json({ error: { code: guard.code, message: guard.msg } }, { status: 401, headers: NO_STORE });
  }
  const url = new URL(req.url);
  const room = url.searchParams.get("room");
  if (room !== null && (room.length === 0 || room.length > 64 || /\u0000/.test(room))) {
    return NextResponse.json({ error: { code: "BAD_REQUEST", message: "room must be 1..64 characters" } }, { status: 400, headers: NO_STORE });
  }
  const sinceRaw = url.searchParams.get("since");
  let since: string | null = null;
  if (sinceRaw !== null) {
    const t = Date.parse(sinceRaw);
    if (!Number.isFinite(t)) return NextResponse.json({ error: { code: "BAD_REQUEST", message: "since must be an ISO-8601 time" } }, { status: 400, headers: NO_STORE });
    since = new Date(t).toISOString();
  }
  const limRaw = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limRaw !== null) {
    const n = Number(limRaw);
    if (!Number.isInteger(n) || n < 1) return NextResponse.json({ error: { code: "BAD_REQUEST", message: "limit must be a positive integer" } }, { status: 400, headers: NO_STORE });
    limit = Math.min(n, MAX_LIMIT);
  }
  try {
    const rows = (await sql`
      SELECT id, ts, room_id, machine, window_kind, rule, action, params, mode, result, actor, why, why_not, inputs_hash, inputs
        FROM steward_decisions
       WHERE (${room}::text IS NULL OR room_id = ${room}::text)
         AND (${since}::timestamptz IS NULL OR ts >= ${since}::timestamptz)
       ORDER BY ts DESC, id DESC
       LIMIT ${limit}::int
    `) as unknown as Row[];
    const decisions = rows.map((r) => ({
      ...r,
      id: Number(r.id),
      ts: new Date(r.ts as string | number | Date).toISOString(),
    }));
    return NextResponse.json({ decisions, count: decisions.length, limit }, { headers: NO_STORE });
  } catch {
    console.error("[steward-decisions] read failed");
    return NextResponse.json({ error: { code: "STEWARD_DECISIONS_READ_FAILED", message: "could not read the decision log" } }, { status: 500, headers: NO_STORE });
  }
}
