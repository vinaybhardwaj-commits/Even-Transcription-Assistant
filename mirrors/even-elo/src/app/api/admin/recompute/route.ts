import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { recomputeAndPersist, type RecomputeInput } from "@/lib/scoring/persist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/admin/recompute
 *
 * Two modes (mutually exclusive):
 *   - ?vc=<uuid>      → recompute that single VC (same as POST /api/recompute/[vcId])
 *   - ?all=true       → recompute every active VC in sequence
 *
 * Optional body: { triggered_by_position?: string, trigger?: ... }
 *
 * Performance budget: <2s per VC, <30s for 12 active VCs (PRD §6.4).
 */
export async function POST(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const all = params.get("all") === "true";
  const vcId = params.get("vc");

  if (all && vcId) {
    return NextResponse.json(
      { ok: false, error: "use either ?vc=... or ?all=true, not both" },
      { status: 400 },
    );
  }
  if (!all && !vcId) {
    return NextResponse.json(
      { ok: false, error: "?vc=<uuid> or ?all=true required" },
      { status: 400 },
    );
  }
  if (vcId && !UUID_RE.test(vcId)) {
    return NextResponse.json({ ok: false, error: "invalid vc UUID" }, { status: 400 });
  }

  // EPI.0b — actor from JWT
  let _actor;
  try {
    const { actorFromRequest } = await import("@/lib/auth");
    _actor = await actorFromRequest();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthenticated" }, { status: 401 });
  }
  let triggered_by_position = _actor.position_label;
  let trigger: RecomputeInput["trigger"] = "manual";
  try {
    const body = await req.json();
    if (body?.triggered_by_position && typeof body.triggered_by_position === "string") {
      triggered_by_position = body.triggered_by_position;
    }
    if (body?.trigger) trigger = body.trigger;
  } catch {
    /* body optional */
  }

  // Single-VC mode.
  if (vcId) {
    const exists = (await sql`SELECT id FROM vcs WHERE id = ${vcId}`) as Array<{ id: string }>;
    if (exists.length === 0) {
      return NextResponse.json({ ok: false, error: "VC not found" }, { status: 404 });
    }
    const start = Date.now();
    try {
      const { result, snapshotId } = await recomputeAndPersist({
        vcId,
        trigger,
        triggeredByPosition: triggered_by_position,
      });
      return NextResponse.json({
        ok: true,
        mode: "single",
        vc_id: vcId,
        snapshot_id: snapshotId,
        composite: result.composite,
        tier: result.tier,
        low_confidence: result.low_confidence,
        duration_ms: Date.now() - start,
      });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  }

  // Batch mode (all=true).
  const vcs = (await sql`
    SELECT id, full_name FROM vcs WHERE status = 'active' ORDER BY full_name
  `) as Array<{ id: string; full_name: string }>;

  const batchStart = Date.now();
  const results: Array<{
    vc_id: string;
    full_name: string;
    composite?: number;
    tier?: string;
    duration_ms?: number;
    error?: string;
  }> = [];

  for (const v of vcs) {
    const t0 = Date.now();
    try {
      const { result } = await recomputeAndPersist({
        vcId: v.id,
        trigger,
        triggeredByPosition: triggered_by_position,
      });
      results.push({
        vc_id: v.id,
        full_name: v.full_name,
        composite: result.composite,
        tier: result.tier,
        duration_ms: Date.now() - t0,
      });
    } catch (e) {
      results.push({
        vc_id: v.id,
        full_name: v.full_name,
        error: e instanceof Error ? e.message : String(e),
        duration_ms: Date.now() - t0,
      });
    }
  }

  const ok = results.every((r) => !r.error);
  const totalMs = Date.now() - batchStart;
  return NextResponse.json({
    ok,
    mode: "batch",
    count: results.length,
    successes: results.filter((r) => !r.error).length,
    failures: results.filter((r) => r.error).length,
    duration_ms: totalMs,
    results,
  });
}
