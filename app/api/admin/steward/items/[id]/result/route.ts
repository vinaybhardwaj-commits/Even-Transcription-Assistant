/**
 * POST /api/admin/steward/items/[id]/result — the steward reports what it did with an approved item. Bearer ENC_STEWARD_TOKEN.
 *   { ok: boolean, result: { <key>: string|number|boolean|null } } -> 200 { ok, state: "done"|"failed" } | 404 | 409 bad_transition | 422 phi_rejected
 * While the steward is disabled: 423. While mode is not "act", a result with ok:true (state done) is 409 advise_mode.
 * Only approved -> done|failed is allowed. result passes the PHI guard.
 */
import { NextRequest, NextResponse } from "next/server";
import { readJsonBody, stewardAuth } from "@/lib/enc/auth";
import { phiGuardJson } from "@/lib/enc/phi-guard";
import { itemResultSchema } from "@/lib/enc/schemas";
import { canTransition } from "@/lib/enc/transitions";
import { getItemState, getStewardGate, moveItem } from "@/lib/enc/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const a = stewardAuth(req);
  if (a === "not_configured") return json({ ok: false, error: "not_configured" }, 503);
  if (a !== "ok") return json({ ok: false, error: "unauthorized" }, 401);
  const { id } = await params;
  if (!UUID.test(id)) return json({ ok: false, error: "validation_failed" }, 400);
  let gate;
  try { gate = await getStewardGate(); } catch { return json({ ok: false, error: "db" }, 503); }
  if (!gate.enabled) return json({ ok: false, error: "steward_disabled" }, 423);
  const b = await readJsonBody(req);
  if (!b.ok) return json({ ok: false, error: b.status === 413 ? "bad_body" : "bad_json" }, b.status);
  const p = itemResultSchema.safeParse(b.body);
  if (!p.success) return json({ ok: false, error: "validation_failed" }, 400);
  if (p.data.ok && gate.mode !== "act") return json({ ok: false, error: "advise_mode" }, 409);
  const hit = phiGuardJson(p.data.result);
  if (hit) return json({ ok: false, error: "phi_rejected", rule: hit }, 422);
  const to = p.data.ok ? "done" : "failed";
  try {
    const cur = await getItemState(id);
    if (!cur) return json({ ok: false, error: "not_found" }, 404);
    if (!canTransition(cur, to)) return json({ ok: false, error: "bad_transition", from: cur }, 409);
    const moved = await moveItem(id, cur, to, { result: p.data.result });
    return moved ? json({ ok: true, state: to }) : json({ ok: false, error: "bad_transition" }, 409);
  } catch (e) {
    console.error("[steward] result failed", JSON.stringify({ err: String((e as Error)?.name ?? "error") }));
    return json({ ok: false, error: "db" }, 503);
  }
}
