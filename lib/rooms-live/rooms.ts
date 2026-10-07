/**
 * lib/rooms-live/rooms.ts — the allow-list of the 8 OPD rooms the Rooms Live screen shows (SPEC-v1 §1, AMENDMENT 3: Audiometry / Third Floor room_d74hhmc4 is a testbed and is not monitored; ORB2 and ORB3 never are). Every statement of the screen is bounded by these ids.
 * Machine / hostname are NOT here: they come from room_install (retired_at IS NULL, enrolled_at NOT NULL).
 */
export type RoomDef = { room_id: string; label: string; order: number };

export const ROOMS: readonly RoomDef[] = [
  { room_id: "room_yh3etjpf", label: "OPD 1", order: 1 },
  { room_id: "room_87frpus9", label: "OPD 3", order: 2 },
  { room_id: "room_ux92qpws", label: "OPD 4 Ortho", order: 3 },
  { room_id: "room_4ggnkg5x", label: "OPD 5", order: 4 },
  { room_id: "room_pnyc9u49", label: "OPD 6", order: 5 },
  { room_id: "room_qyzghzaf", label: "OPD 7", order: 6 },
  { room_id: "room_ymch4bxu", label: "Dietary", order: 7 },
  { room_id: "room_bh6jtq4t", label: "Cardiology", order: 8 },
];

export const ROOM_IDS: readonly string[] = ROOMS.map((r) => r.room_id);
export const isRoomId = (id: string): boolean => ROOM_IDS.includes(id);
