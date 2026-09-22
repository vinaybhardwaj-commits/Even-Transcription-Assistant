import type { RoomLive } from "@/components/admin/bench-live/types";

export type RoomQueryResult =
  | { kind: "none" }
  | { kind: "match"; room: RoomLive }
  | { kind: "invalid"; value: string };

export function resolveRoomQuery(
  rooms: readonly RoomLive[],
  search: string,
): RoomQueryResult {
  const wanted = new URLSearchParams(search).get("room")?.trim();
  if (!wanted) return { kind: "none" };
  const room = rooms.find(
    (candidate) =>
      candidate.room.id === wanted || candidate.room.slug === wanted,
  );
  return room
    ? { kind: "match", room }
    : { kind: "invalid", value: wanted };
}

export function roomSelectionUrl(
  currentHref: string,
  room: RoomLive["room"],
): string {
  const url = new URL(currentHref);
  url.searchParams.set("room", room.slug || room.id);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function clearRoomSelectionUrl(currentHref: string): string {
  const url = new URL(currentHref);
  url.searchParams.delete("room");
  return `${url.pathname}${url.search}${url.hash}`;
}
