/**
 * Room Bench capture surface — RETIRED (Room-Bench PRD §3.3 superseded).
 *
 * /room/{slug} — used to be the kiosk-style Chrome PIN screen + in-browser
 * recorder for the room Mac Mini. Every room now records with the native
 * Room Recorder app instead. A leftover Chrome tab on a room Mac may still
 * point at this URL, so this route must render nothing: no PIN screen, no
 * recorder, no text, no "nothing to do" message — just a blank page. If a
 * PIN were still accepted here, submitting it would stand up a second,
 * unwanted listener for the room's commands (see api/login/route.ts, which
 * now returns 410 and mints no session for the same reason).
 *
 * No DB lookup, no cookie read — this must never 500, and there is nothing
 * left to look up.
 */

export const dynamic = "force-dynamic";

export const metadata = {
  title: "",
};

export default function RoomPage() {
  return null;
}
