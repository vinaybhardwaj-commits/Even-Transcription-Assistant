/**
 * /api/admin/steward/items — Bearer ENC_STEWARD_TOKEN.
 *   POST { run_id, kind, ist_date, room_id?, consult_uid?, title, body_md, proposed_action? } -> 200 { ok, id } | 409 run_not_open | 422 phi_rejected
 *   GET ?state=approved (default "approved"; any item state)                                  -> 200 { ok, items }
 * title and body_md pass the PHI guard on write (long digit runs, emails, phones are refused). Logs carry codes only.
 */
import { NextRequest, NextResponse } from "next/server";
import { readJsonBody, stewardAuth } from "@/lib/enc/auth";
import { phiGuard } from "@/lib/enc/phi-guard";
import { ITEM_STATES, itemCreateSchema, type ItemState } from "@/lib/enc/schemas";
import { createItem, getStewardGate, listItemsByState } from "@/lib/enc/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: NextRequest) {
  const a = stewardAuth(req);
  if (a === "not_configured") return json({ ok: false, error: "not_configured" }, 503);
  if (a !== "ok") return json({ ok: false, error: "unauthorized" }, 401);
  let gate;
  try { gate = await getStewardGate(); } catch { return json({ ok: false, error: "db" }, 503); }
  if (!gate.enabled) return json({ ok: false, error: "steward_disabled" }, 423);
  const b = await readJsonBody(req);
  if (!b.ok) return json({ ok: false, error: b.status === 413 ? "bad_body" : "bad_json" }, b.status);
  const p = itemCreateSchema.safeParse(b.body);
  if (!p.success) return json({ ok: false, error: "validation_failed" }, 400);
  if (p.data.kind === "action" && gate.mode !== "act") return json({ ok: false, error: "advise_mode" }, 409);
  const hit = phiGuard(p.data.body_md) ?? phiGuard(p.data.title);
  if (hit) return json({ ok: false, error: "phi_rejected", rule: hit }, 422);
  try {
    const id = await createItem(p.data);
    return id ? json({ ok: true, id }) : json({ ok: false, error: "run_not_open" }, 409);
  } catch (e) {
    console.error("[steward] item create failed", JSON.stringify({ err: String((e as Error)?.name ?? "error") }));
    return json({ ok: false, error: "db" }, 503);
  }
}

export async function GET(req: NextRequest) {
  const a = stewardAuth(req);
  if (a === "not_configured") return json({ ok: false, error: "not_configured" }, 503);
  if (a !== "ok") return json({ ok: false, error: "unauthorized" }, 401);
  const state = req.nextUrl.searchParams.get("state") ?? "approved";
  if (!(ITEM_STATES as readonly string[]).includes(state)) return json({ ok: false, error: "validation_failed" }, 400);
  try {
    return json({ ok: true, items: await listItemsByState(state as ItemState) });
  } catch (e) {
    console.error("[steward] item list failed", JSON.stringify({ err: String((e as Error)?.name ?? "error") }));
    return json({ ok: false, error: "db" }, 503);
  }
}
