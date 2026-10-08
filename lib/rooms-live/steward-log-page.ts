/**
 * lib/rooms-live/steward-log-page.ts — A1 S7 / S8: everything the Steward log page needs, in one server-side call. READS ONLY (steward_decisions, steward_config, room_install).
 * A failed decisions read is reported as `readFailed` (the page says so); a failed status or install read only blanks the header line / machine.
 */
import { readInstalls, readStewardConfig, readStewardHistory, HISTORY_PAGE, type Db } from "./read";
import { loadRoster } from "./roster";
import type { RoomDef } from "./rooms";
import { STATUS_KEYS, statusFromRows } from "./steward-status";
import { stripView, type StripView } from "./steward-lines";
import { collapseRows, parseDay, parseOffset, type DayWindow, type HistoryItem } from "./steward-history";

export type LogQuery = { room: string | null; date?: string | null; show?: string | null; offset?: string | null };
export type LogPage = {
  room: RoomDef | null; // null = all rooms
  rooms: RoomDef[];
  labels: Record<string, string>;
  machine: string | null;
  day: DayWindow;
  actionsOnly: boolean;
  offset: number;
  items: HistoryItem[];
  hasNext: boolean;
  readFailed: boolean;
  strip: StripView;
};

export async function loadLogPage(db: Db, q: LogQuery, nowMs: number): Promise<LogPage | "no_such_room"> {
  const rooms = await loadRoster(db, nowMs);
  let room: RoomDef | null = null;
  if (q.room !== null) {
    room = rooms.find((r) => r.room_id === q.room) ?? null;
    if (!room) return "no_such_room";
  }
  const day = parseDay(q.date, nowMs);
  const actionsOnly = q.show !== "everything";
  const offset = parseOffset(q.offset);
  const asOf = new Date(nowMs).toISOString();
  const ids = room ? [room.room_id] : rooms.map((r) => r.room_id);
  const [hist, cfg, inst] = await Promise.allSettled([
    readStewardHistory(db, ids, asOf, day.fromIso, day.toIso, actionsOnly, offset),
    readStewardConfig(db, STATUS_KEYS),
    room ? readInstalls(db, [room.room_id]) : Promise.resolve([]),
  ]);
  const rows = hist.status === "fulfilled" ? hist.value : [];
  const page = rows.slice(0, HISTORY_PAGE);
  const status = cfg.status === "fulfilled" ? statusFromRows(cfg.value) : ({ state: "unavailable" } as const);
  return {
    room,
    rooms,
    labels: Object.fromEntries(rooms.map((r) => [r.room_id, r.label])),
    machine: inst.status === "fulfilled" ? (inst.value[0]?.hostname ?? null) : null,
    day,
    actionsOnly,
    offset,
    items: collapseRows(page),
    hasNext: rows.length > HISTORY_PAGE,
    readFailed: hist.status === "rejected",
    strip: stripView(status, nowMs),
  };
}
