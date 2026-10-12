/**
 * PATCH /api/admin/steward/settings — an admin changes the steward's settings. Admin session cookie only.
 *   body: any of { enabled: bool, mode: "advise"|"act", daily_cap_usd: number 0..50, model_id: string } (at least one)
 *   -> 200 { ok, updated: [keys] } | 400 validation_failed | 401 | 409 act_not_approved
 * Setting mode to "act" is refused with 409 until phase 3 is approved. Nothing is written in that case.
 */
import { NextRequest, NextResponse } from "next/server";
import { adminSession, readJsonBody } from "@/lib/enc/auth";
import { settingsPatchSchema } from "@/lib/enc/schemas";
import { upsertStewardSettings } from "@/lib/enc/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function PATCH(req: NextRequest) {
  if (!(await adminSession())) return json({ ok: false, error: "unauthorized" }, 401);
  const b = await readJsonBody(req, 2_048);
  if (!b.ok) return json({ ok: false, error: b.status === 413 ? "bad_body" : "bad_json" }, b.status);
  const p = settingsPatchSchema.safeParse(b.body);
  if (!p.success) return json({ ok: false, error: "validation_failed" }, 400);
  if (p.data.mode === "act") return json({ ok: false, error: "act_not_approved" }, 409);
  try {
    await upsertStewardSettings(p.data);
    return json({ ok: true, updated: Object.keys(p.data) });
  } catch (e) {
    console.error("[steward] settings failed", JSON.stringify({ err: String((e as Error)?.name ?? "error") }));
    return json({ ok: false, error: "db" }, 503);
  }
}
