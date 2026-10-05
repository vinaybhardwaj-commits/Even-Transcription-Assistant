/**
 * GET /api/encounter-windows — read encounter windows (eta_encounter_windows), ordered by t_open.
 *
 * Auth: ADMIN_TOKEN via `Authorization: Bearer <token>` (lib/admin-gate requireAdmin — the same internal gate the
 * other token-guarded admin routes use; unset token refuses, never allows).
 * Query params (all optional): room_id, doctor_uid, from, to (ISO timestamps, from <= t_open < to), quality
 * (clean|ambiguous|multi_doctor|unclosed|unattributed), mismatch (true: only consults where the warehouse and the
 * extension name different doctors), limit (1..5000, default 1000).
 * Returns { ok, count, windows: [...] }. Only what the table holds: ids, times, doctor uids/names and labels. Each row carries
 * both views of the doctor: doctor_uid/display_name/attribution (the extension's) and warehouse_* (Pulse's own consult record,
 * migration 0124), plus consulting_doctor_uid/_name + attribution_source (the one to report: warehouse > extension > none)
 * and doctor_mismatch.
 * No transcripts, no patient identifiers. Bad params -> 400.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-gate";
import { sql } from "@/lib/db";
import { queryWindows } from "@/lib/encounter-windows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { headers: { "cache-control": "no-store" } };
const QUALITIES = ["clean", "ambiguous", "multi_doctor", "unclosed", "unattributed"];
const bad = (message: string) => NextResponse.json({ error: { code: "VALIDATION_FAILED", message } }, { status: 400, ...NO_STORE });

function isoParam(v: string | null): string | null | "bad" {
  if (v === null || v === "") return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? "bad" : new Date(t).toISOString();
}

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const p = req.nextUrl.searchParams;
  const from = isoParam(p.get("from"));
  const to = isoParam(p.get("to"));
  if (from === "bad") return bad("from is not a timestamp");
  if (to === "bad") return bad("to is not a timestamp");
  const quality = p.get("quality") || null;
  if (quality !== null && !QUALITIES.includes(quality)) return bad("unknown quality");
  const mismatchRaw = p.get("mismatch");
  if (mismatchRaw !== null && mismatchRaw !== "" && mismatchRaw !== "true" && mismatchRaw !== "false") return bad("mismatch must be true or false");
  const limitRaw = p.get("limit");
  const limit = limitRaw === null || limitRaw === "" ? 1000 : Number(limitRaw);
  if (!Number.isFinite(limit) || limit < 1) return bad("limit must be a positive number");

  try {
    const windows = await queryWindows(sql, {
      room_id: p.get("room_id") || null,
      doctor_uid: p.get("doctor_uid") || null,
      from,
      to,
      quality,
      mismatch: mismatchRaw === "true" ? true : null,
      limit,
    });
    return NextResponse.json({ ok: true, count: windows.length, windows }, NO_STORE);
  } catch (e) {
    console.error(`[encounter-windows] read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return NextResponse.json({ error: { code: "READ_FAILED", message: "read failed" } }, { status: 500, ...NO_STORE });
  }
}
