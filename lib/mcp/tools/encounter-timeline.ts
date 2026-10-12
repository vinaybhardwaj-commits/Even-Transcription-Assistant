/**
 * lib/mcp/tools/encounter-timeline.ts — scribe_encounter_timeline (epic #23 i).
 *
 * Read-only. One room-day's calibrated patient-leave shadow consults, plus agreement against Pulse
 * presence windows and cutter cuts. Times, counts, reason codes. No speech text and no names.
 * A held-out room-day is refused before any read. The shadow flag does not have to be on: this only reads.
 */
import { timelineBoard } from "@/lib/encounter-clock/timeline-view";
import { findRoomDay } from "@/lib/brain/state";
import { argInt, argStr, type McpTool, type ToolArgs } from "../registry";
import { pickIstDate, resolveRoom } from "./brain";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import { roomDayIsBlind } from "@/lib/room-access/check";
import { loadTimelineView, type TimelineLoad } from "@/lib/room-access/encounter-timeline-read";

export type { TimelineLoad };

const HELP = "Read-only shadow consult boundaries for one room-day (migration 0156): start, end, calibrated confidence, reason codes, and agreement against Pulse presence windows and cutter cuts. A consult end is patient-leave; encounter_end_ms is the note (endConsult) when one was clicked. url_clear is counted as a weak close, not an end. Held-out room-days are refused. No transcript, no speech text, and no names. Times UTC.";

export type TimelineReadDeps = {
  resolveRoom: typeof resolveRoom;
  pickIstDate: typeof pickIstDate;
  findRoomDay: typeof findRoomDay;
  isBlindRoomDay: typeof isBlindRoomDay;
  roomDayIsBlind: typeof roomDayIsBlind;
  load: (q: { room_id: string; room_day_id: string; ist_date: string; limit: number }) => Promise<TimelineLoad | { error: string }>;
};

const defaultDeps = (): TimelineReadDeps => ({
  resolveRoom, pickIstDate, findRoomDay, isBlindRoomDay, roomDayIsBlind, load: loadTimelineView,
});

export async function readEncounterTimeline(args: ToolArgs, deps: Partial<TimelineReadDeps> = {}): Promise<Record<string, unknown>> {
  const d = { ...defaultDeps(), ...deps };
  const room = await d.resolveRoom(args);
  if (!room) return { ok: false, error: "unknown_room" };
  const date = d.pickIstDate(args);
  if ("error" in date) return { ok: false, error: date.error };
  if (d.isBlindRoomDay(date.date, room.id)) return { ok: false, error: "blind_room_day" };
  let roomDayId = argStr(args, "room_day_id", 64);
  if (!roomDayId) {
    const day = await d.findRoomDay(room.id, date.date);
    if (!day) return { ok: false, error: "no_room_day", room_id: room.id, ist_date: date.date };
    roomDayId = day.id;
  }
  if (await d.roomDayIsBlind(roomDayId)) return { ok: false, error: "blind_room_day" };
  const limit = argInt(args, "limit", 50, 1, 200);
  const loaded = await d.load({ room_id: room.id, room_day_id: roomDayId, ist_date: date.date, limit });
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const board = timelineBoard({ room_id: room.id, consults: loaded.consults, pulse: loaded.pulse, cuts: loaded.cuts });
  return {
    ok: true,
    room_id: room.id,
    room_day_id: roomDayId,
    ist_date: date.date,
    run_id: loaded.run?.id ?? null,
    model: loaded.run?.model ?? null,
    calibration_sha: loaded.run?.calibration_sha ?? null,
    truncated: loaded.truncated,
    n_consults: board.consults.length,
    consults: board.consults,
    agreement: board.agreement,
    pulse_close: board.pulse_close,
  };
}

export const encounterTimelineTool: McpTool = {
  name: "scribe_encounter_timeline",
  description: HELP,
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      room_day_id: { type: "string", description: "shadow rows for this day" },
      room_id: { type: "string" },
      room_slug: { type: "string" },
      ist_date: { type: "string", description: "YYYY-MM-DD, Pulse day" },
      limit: { type: "number", description: "max consults, default 50" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => readEncounterTimeline(args),
};

export const ENCOUNTER_TIMELINE_TOOLS: readonly McpTool[] = [encounterTimelineTool];
