/**
 * GET /api/encounter-windows — read encounter windows (eta_encounter_windows), ordered by t_open.
 *
 * Auth: ADMIN_TOKEN via `Authorization: Bearer <token>` (lib/admin-gate requireAdmin — the same internal gate the
 * other token-guarded admin routes use; unset token refuses, never allows).
 * Query params (all optional): room_id, doctor_uid (matches consulting_doctor_uid OR the extension's doctor_uid), from, to (ISO timestamps, from <= t_open < to), quality
 * (clean|ambiguous|multi_doctor|unclosed|unattributed), mismatch (true: only consults where the warehouse and the
 * extension name different doctors; false: only those where they do not), limit (1..5000, default 1000).
 * Returns { ok, count, windows: [...] }. Only what the table holds: ids, times, doctor uids/names and labels. Each row carries
 * both views of the doctor: doctor_uid/display_name/attribution (the extension's) and warehouse_* (Pulse's own consult record,
 * migration 0124), plus consulting_doctor_uid/_name + attribution_source (the one to report: warehouse > extension > none)
 * and doctor_mismatch.
 * ?occupancy=1 (optionally as_of=<ISO>) returns { ok, as_of, count, machines: [...] } instead: one row per machine with the extension's resolved
 * occupant and occupant_display = { uid, name, source: 'warehouse'|'cookie', cookie_uid, cookie_name, stale }. The warehouse consulting doctor of the
 * machine's most recent consult (opened within 90 min of as_of, or unclosed) is shown in preference to the extension's Google-cookie identity, which
 * Pulse never clears (lib/encounter-windows/occupant.ts). stale = the cookie identity differs from the warehouse doctor. Read-only.
 * The occupancy response also carries `ext_health`: counts by status ({ok, no_tab, missing, behind, offline, total}) of the Pulse Presence extension
 * across the presence machines, or null when that read failed (it never fails the occupancy read).
 * ?ext_health=1 (optionally as_of=<ISO>) returns { ok, as_of, count, summary, machines: [...] }: one row per presence machine
 * (lib/encounter-windows/ext-health.ts) with last_ext_ts, ext_age_s, ext_version, version_state, poller {ok, chrome_running, console_user, age_s} and
 * status ok | no_tab | missing | behind | offline. Home Office, ORB3 and ORB2 (no extension) are never listed. Read-only.
 * No transcripts, no patient identifiers. Bad params -> 400.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-gate";
import { sql } from "@/lib/db";
import { extHealth, machineOccupancy, queryWindows, summarizeExtHealth } from "@/lib/encounter-windows";

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
  const extRaw = p.get("ext_health");
  if (extRaw === "1" || extRaw === "true") {
    const asOf = isoParam(p.get("as_of"));
    if (asOf === "bad") return bad("as_of is not a timestamp");
    try {
      const at = asOf ?? new Date().toISOString();
      const machines = await extHealth(sql, { asOf: at });
      return NextResponse.json({ ok: true, as_of: at, count: machines.length, summary: summarizeExtHealth(machines), machines }, NO_STORE);
    } catch (e) {
      console.error(`[encounter-windows] ext_health read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      return NextResponse.json({ error: { code: "READ_FAILED", message: "read failed" } }, { status: 500, ...NO_STORE });
    }
  }
  const occRaw = p.get("occupancy");
  if (occRaw === "1" || occRaw === "true") {
    const asOf = isoParam(p.get("as_of"));
    if (asOf === "bad") return bad("as_of is not a timestamp");
    try {
      const at = asOf ?? new Date().toISOString();
      const machines = await machineOccupancy(sql, at);
      // The extension's health rides along; a failure here must never take the occupancy read down with it.
      let ext_health: ReturnType<typeof summarizeExtHealth> | null = null;
      try {
        ext_health = summarizeExtHealth(await extHealth(sql, { asOf: at }));
      } catch (e) {
        console.error(`[encounter-windows] occupancy ext_health failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
      return NextResponse.json({ ok: true, as_of: at, count: machines.length, machines, ext_health }, NO_STORE);
    } catch (e) {
      console.error(`[encounter-windows] occupancy read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      return NextResponse.json({ error: { code: "READ_FAILED", message: "read failed" } }, { status: 500, ...NO_STORE });
    }
  }
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
      mismatch: mismatchRaw === "true" ? true : mismatchRaw === "false" ? false : null,
      limit,
    });
    return NextResponse.json({ ok: true, count: windows.length, windows }, NO_STORE);
  } catch (e) {
    console.error(`[encounter-windows] read failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return NextResponse.json({ error: { code: "READ_FAILED", message: "read failed" } }, { status: 500, ...NO_STORE });
  }
}
