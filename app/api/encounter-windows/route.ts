/**
 * GET /api/encounter-windows — read encounter windows (eta_encounter_windows), ordered by t_open.
 *
 * Auth: ADMIN_TOKEN via `Authorization: Bearer <token>` (lib/admin-gate requireAdmin — the same internal gate the
 * other token-guarded admin routes use; unset token refuses, never allows). ALSO accepted (additive, GET only): a bearer equal to
 * REB_INDEX_READ_TOKEN (constant-time compare; unset/blank means only ADMIN_TOKEN works) so the box's REB encounter-layer reader
 * need not hold ADMIN_TOKEN. The read token is bearer-header only (never ?token=).
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
 * Each machine row also carries `pending`: { display_name, since, reason: 'no_console_activity' | 'identity_stale' } | null (6 Oct 2026) — a login the
 * resolver did NOT treat as presence (no console activity at the Mac, or an identity_stale in the same seconds, or one that arrives later while it is pending).
 * It stays pending until the login's own doctor is active on the Mac (or, within 45 min of the login, any activity or a poller reset), the doctor logs out, a new
 * login replaces it, or the nightly cutoff passes. A doctor who is present and whose cookie then goes identity_stale is shown as the stale occupant below. It is not present and not counted for windows; the bench shows it
 * in grey as "session: <name> (pending, no console activity)". New optional field; null when none.
 * `stale_occupant`: { page_name, cookie_name, label } | null — set when a promoted/demoted identity_stale session (the page-name stream) is present and NOT merged into a present
 * doctor whose first name it is (F11): the occupant when no doctor is present, else shown beside the real occupant; it is never counted as a doctor nor part of ambiguity (`occupied` is
 * true when it is the only presence). The page greeting is the
 * identity ("page: <page_name> (cookie <cookie_name> stale)", or "unknown (stale cookie)"), uid null; the cookie doctor is never cookie_uid/cookie_name.
 * The occupancy response also carries `ext_health`: counts by status ({ok, no_tab, missing, quiet, behind, offline, no_chrome, total}) of the Pulse Presence extension
 * across the presence machines, or null when that read failed (it never fails the occupancy read).
 * ?ext_health=1 (optionally as_of=<ISO>) returns { ok, as_of, count, summary, machines: [...] }: one row per presence machine
 * (lib/encounter-windows/ext-health.ts) with last_ext_ts, ext_age_s, ext_version, version_state, poller {ok, chrome_running, console_user, age_s} and
 * status ok | no_tab | missing | quiet | behind | offline | no_chrome. Home Office, ORB3 and ORB2 (no extension) are never listed. Read-only.
 * No transcripts, no patient identifiers. Bad params -> 400.
 */
import { createHash, timingSafeEqual } from "node:crypto";
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

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** True only for a non-empty bearer header equal to a non-blank REB_INDEX_READ_TOKEN (hashed, constant-time; same style as app/api/reb/index). */
function hasRebReadToken(req: NextRequest): boolean {
  const expected = (process.env.REB_INDEX_READ_TOKEN ?? "").trim();
  if (expected === "") return false;
  const header = req.headers.get("authorization") || "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return presented !== "" && timingSafeEqual(digest(presented), digest(expected));
}

export async function GET(req: NextRequest) {
  const denied = hasRebReadToken(req) ? null : requireAdmin(req);
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
