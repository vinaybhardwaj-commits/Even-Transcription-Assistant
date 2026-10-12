/**
 * POST /api/admin/steward/run — the steward (box) opens or closes a run. Bearer ENC_STEWARD_TOKEN.
 *   { op: "create", mode: "advise"|"act", model? }            -> 200 { ok, id }
 *   { op: "close", id, status: "ok"|"failed"|"capped", tokens_in?, tokens_out?, cost_usd?, summary_md? } -> 200 { ok } | 409 not_open
 * summary_md passes the PHI guard (ids and counts only). Logs carry codes only.
 */
import { NextRequest, NextResponse } from "next/server";
import { readJsonBody, stewardAuth } from "@/lib/enc/auth";
import { phiGuard } from "@/lib/enc/phi-guard";
import { runBodySchema } from "@/lib/enc/schemas";
import { closeRun, createRun, getStewardGate } from "@/lib/enc/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: NextRequest) {
  const a = stewardAuth(req);
  if (a === "not_configured") return json({ ok: false, error: "not_configured" }, 503);
  if (a !== "ok") return json({ ok: false, error: "unauthorized" }, 401);
  try {
    if (!(await getStewardGate()).enabled) return json({ ok: false, error: "steward_disabled" }, 423);
  } catch {
    return json({ ok: false, error: "db" }, 503);
  }
  const b = await readJsonBody(req);
  if (!b.ok) return json({ ok: false, error: b.status === 413 ? "bad_body" : "bad_json" }, b.status);
  const p = runBodySchema.safeParse(b.body);
  if (!p.success) return json({ ok: false, error: "validation_failed" }, 400);
  try {
    if (p.data.op === "create") {
      const id = await createRun(p.data.mode, p.data.model ?? null);
      return json({ ok: true, id });
    }
    if (p.data.summary_md !== undefined) {
      const hit = phiGuard(p.data.summary_md);
      if (hit) return json({ ok: false, error: "phi_rejected", rule: hit }, 422);
    }
    const closed = await closeRun(p.data.id, p.data);
    return closed ? json({ ok: true }) : json({ ok: false, error: "not_open" }, 409);
  } catch (e) {
    console.error("[steward] run failed", JSON.stringify({ err: String((e as Error)?.name ?? "error") }));
    return json({ ok: false, error: "db" }, 503);
  }
}
