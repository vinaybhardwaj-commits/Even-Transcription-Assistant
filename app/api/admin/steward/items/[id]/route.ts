/**
 * PATCH /api/admin/steward/items/[id] — an admin approves or rejects an item. Admin session cookie (the auth of the other /api/admin routes).
 *   { state: "approved"|"rejected" } -> 200 { ok, state } | 404 | 409 bad_transition
 * Only open -> approved|rejected is allowed. The change is ONE conditional UPDATE, so a lost race is a 409 and changes nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminSession, readJsonBody } from "@/lib/enc/auth";
import { itemDecisionSchema } from "@/lib/enc/schemas";
import { canTransition } from "@/lib/enc/transitions";
import { getItemState, moveItem } from "@/lib/enc/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await adminSession();
  if (!admin) return json({ ok: false, error: "unauthorized" }, 401);
  const { id } = await params;
  if (!UUID.test(id)) return json({ ok: false, error: "validation_failed" }, 400);
  const b = await readJsonBody(req, 1_024);
  if (!b.ok) return json({ ok: false, error: b.status === 413 ? "bad_body" : "bad_json" }, b.status);
  const p = itemDecisionSchema.safeParse(b.body);
  if (!p.success) return json({ ok: false, error: "validation_failed" }, 400);
  try {
    const cur = await getItemState(id);
    if (!cur) return json({ ok: false, error: "not_found" }, 404);
    if (!canTransition(cur, p.data.state)) return json({ ok: false, error: "bad_transition", from: cur }, 409);
    const moved = await moveItem(id, cur, p.data.state, { decided_by: admin });
    return moved ? json({ ok: true, state: p.data.state }) : json({ ok: false, error: "bad_transition" }, 409);
  } catch (e) {
    console.error("[steward] decide failed", JSON.stringify({ err: String((e as Error)?.name ?? "error") }));
    return json({ ok: false, error: "db" }, 503);
  }
}
