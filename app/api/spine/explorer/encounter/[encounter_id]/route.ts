/**
 * GET /api/spine/explorer/encounter/<encounter_id> — one encounter with its links, signals (no attrs but close_reason), jobs and artefacts (Spine S4b, read-only). A merged encounter shows merged_into.
 * Auth and gate as ../../day.   200 { ok, encounter, links, signals, close_reason_withheld, jobs, artefacts }   400 bad_encounter_id   401   404 (unknown id too)   503
 */
import { NextRequest, NextResponse } from "next/server";
import { encounterDetail, validEncounterId } from "@/lib/spine/explorer-read";
import { dbFail, explorerGate, fail, NO_STORE } from "@/lib/spine/explorer-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest, ctx: { params: Promise<{ encounter_id: string }> }) {
  const denied = await explorerGate(req);
  if (denied) return denied;
  const { encounter_id } = await ctx.params;
  if (!validEncounterId(encounter_id)) return fail(400, "bad_encounter_id");
  try {
    const out = await encounterDetail(encounter_id);
    return out ? NextResponse.json({ ok: true, ...out }, NO_STORE) : fail(404, "not_found");
  } catch (e) { return dbFail(e); }
}
