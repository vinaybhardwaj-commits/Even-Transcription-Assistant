/**
 * GET /api/admin/fleet-attention — what needs a human right now (lib/fleet-attention.ts).
 *
 * Admin-cookie auth like the other Bench routes (benchAdminGuard). CACHE-FREE: every call re-reads the evidence and re-evaluates every rule,
 * and the response says so (`cache-control: no-store`, force-dynamic). Read-only — it writes nothing, anywhere.
 *
 * A failure to read the fleet answers 500 with a code and NO items: the page treats that as "could not check", never as "all clear".
 */
import { NextResponse } from "next/server";
import { benchAdminGuard } from "@/lib/bench";
import { getFleetAttention } from "@/lib/fleet-attention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

const NO_STORE = { "cache-control": "no-store" };

export async function GET() {
  const guard = await benchAdminGuard();
  if (!guard.ok) {
    return NextResponse.json({ error: { code: guard.code, message: guard.msg } }, { status: 401, headers: NO_STORE });
  }
  try {
    return NextResponse.json(await getFleetAttention(), { headers: NO_STORE });
  } catch (e) {
    console.error("[fleet-attention] read failed:", e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
    return NextResponse.json(
      { error: { code: "FLEET_ATTENTION_READ_FAILED", message: "could not read the fleet state" } },
      { status: 500, headers: NO_STORE },
    );
  }
}
