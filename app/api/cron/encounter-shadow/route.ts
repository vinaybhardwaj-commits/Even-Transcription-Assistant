/**
 * GET /api/cron/encounter-shadow — SPINE-P1: the producer cron. Every 15 minutes (vercel.json) it runs the encounter shadow producers over every room that has a room_day for TODAY (IST):
 * runShadowForRoomDay -> encounter_hypothesis(_run) (spine proxy: acoustic), at most once per hour per room-day (only on the tick whose IST minute is < 15, so 24 runs/day, not 96); and, every tick when
 * ENCOUNTER_TIMELINE_SHADOW is on, runTimelineLeaveForRoomDay -> encounter_timeline_shadow(_run) (spine proxy: timeline; it caches Jev by state hash).
 * R3 (interim, pending fable's ruling): runTimelineShadowForRoomDay (shadow-v3) is NOT run. The spine does not read its output (encounter_hypothesis source 'timeline') and it asks Jev (paid) per segment per tick with no cache. The v3 counts (timeline_ok, timeline_err) are gone from the response.
 * Per room-day the order is acoustic (when due), then leave; voice.ts runs v3, leave, then acoustic (or fused). No reader depends on the order. The room-day list is rotated by the tick index so the bounds do not starve the same tail rooms.
 * A leave failure is counted leave_err and stops nothing else. Blind-day refusal is the same as the MCP tool in lib/mcp/tools/voice.ts.
 * BEARER, as /api/cron/spine: `Authorization: Bearer $CRON_SECRET`. CRON_SECRET unset -> 503; wrong bearer -> 401.
 * Gated by spine_config `producers` (off|shadow|live; kill_switch respected; missing or malformed = off). Off -> { skipped: "off" } after one config read and nothing runs. "shadow" and "live" behave the same: both producers only write their own shadow tables.
 * Bounds: at most SPINE_PRODUCERS_MAX room-days per run (default 12), and no new room-day is started after 45 s (maxDuration 60).
 * TIMELINE FLAG. ENCOUNTER_TIMELINE_SHADOW must be set in Vercel prod by fable (its prod value is UNVERIFIED) to a value in FLAG_TRUTHY from lib/flags.ts: 1 | true | yes | on (case-insensitive, trimmed).
 *   FLAG_FALSY is "" | 0 | false | no | off; any other value makes parseFlag throw, which is caught here: leave skipped, `timeline_flag_invalid` = 1, acoustic still runs.
 * Response: counts only {mode, room_days, acoustic_ok, acoustic_err, leave_ok, leave_err, blind_skipped, acoustic_due, timeline_enabled, timeline_flag_invalid}. One log line per failure class; no ids, no text.
 */
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { bearerMatches } from "@/lib/spine/auth";
import { parseProducersMode } from "@/lib/spine/config";
import { parseMax, runProducers } from "@/lib/spine/producers";
import { listRoomDaysForDate } from "@/lib/room-access/room-days-for-date";
import { runShadowForRoomDay } from "@/lib/encounter-clock/shadow-io";
import { runTimelineLeaveForRoomDay } from "@/lib/encounter-clock/shadow-leave";
import { encounterTimelineShadowEnabled, encounterGateDiarEnabled } from "@/lib/encounter-clock/flag";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import { roomDayIsBlind } from "@/lib/room-access/check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE = { headers: { "cache-control": "no-store" } };
const istDateOf = (ms: number): string => new Date(ms + 19_800_000).toISOString().slice(0, 10);

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "CRON_SECRET is not set" } }, { status: 503, ...NO_STORE });
  if (!bearerMatches(req.headers.get("authorization"), secret)) return NextResponse.json({ error: { code: "AUTH_REQUIRED", message: "cron bearer required" } }, { status: 401, ...NO_STORE });
  try {
    const rows = (await sql`SELECT key, value FROM spine_config WHERE key IN ('kill_switch', 'producers')`) as Array<{ key: string; value: unknown }>;
    const mode = parseProducersMode(rows);
    if (mode === "off") return NextResponse.json({ skipped: "off" }, NO_STORE);
    const date = istDateOf(Date.now());
    const days = await listRoomDaysForDate(date);
    const { classes, ...counts } = await runProducers(days, parseMax(process.env.SPINE_PRODUCERS_MAX), {
      now: Date.now,
      isBlind: async (d) => isBlindRoomDay(d.ist_date, d.room_id) || (await roomDayIsBlind(d.id)),
      acoustic: (i) => runShadowForRoomDay(i),
      leave: (i) => runTimelineLeaveForRoomDay(i),
      timelineEnabled: encounterTimelineShadowEnabled,
      gateDiar: encounterGateDiarEnabled,
    });
    for (const k of classes) console.error("encounter-shadow cron: failure class", k);
    return NextResponse.json({ mode, ...counts }, NO_STORE);
  } catch (e) {
    console.error("encounter-shadow cron: failed", (e as { code?: string }).code ?? "unknown");
    return NextResponse.json({ error: { code: "ENCOUNTER_SHADOW_FAILED" } }, { status: 500, ...NO_STORE });
  }
}
