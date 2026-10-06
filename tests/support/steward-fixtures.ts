/** Fixtures shared by the Room Steward suites: a healthy recording clinic room (every age relative to A), and the same room with no session. */
import type { RoomSense } from "@/lib/steward/sense";

export const ist = (hhmm: string, date = "2026-10-06", sec = "00") => Date.parse(`${date}T${hhmm}:${sec}+05:30`);
export const ago = (A: number, s: number) => new Date(A - s * 1000).toISOString();

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends Array<infer U> ? U[] : T[K] extends object | null ? DeepPartial<NonNullable<T[K]>> | null : T[K] };
export function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b) ? merge(b, v as never) : v;
  }
  return out as T;
}

/** A healthy, recording clinic room at A. Every age is relative to A. */
export function healthy(A: number, over: DeepPartial<RoomSense> = {}): RoomSense {
  const base: RoomSense = {
    room_id: "room_a",
    room_name: "OPD A",
    machine: "HOST-A",
    klass: "clinic",
    kind: "clinic",
    flags: [],
    as_of: new Date(A).toISOString(),
    recording: {
      session_open: true,
      session_id: "bs_1",
      session_status: "recording",
      session_started_at: ago(A, 3 * 3600),
      last_chunk_at: ago(A, 60),
      recorder_status: { state: "recording", session_open: true, received_at: ago(A, 20) },
    },
    listener: { listening: true, paused: false },
    reachable: { poller_ok_at: ago(A, 30), kh_heartbeat_at: ago(A, 30), kh_enrolled: true },
    chrome: { running: true, active: ["Profile 1"], last_used: "Profile 1", presence_ok: true, last_alert_reason: null, last_alert_at: null },
    ext: { applicable: true, status: "ok", last_event_at: ago(A, 60), last_heartbeat_reason: null, no_tab: false },
    consult_open: false,
    consult_started_at: null,
    occupancy: { state: "nobody", idle_s: 900, identity_fault: false },
    audio: { default_input_present: true, usb_removed_recent: false, device_missing_flag: false, silent_while_recording_since: null },
    start_backoff: { failed_attempts: 0, retry_after_s: 0 },
    missing: [],
  };
  return merge(base, over);
}

/** The same room with no session open. */
export const idle = (A: number, over: DeepPartial<RoomSense> = {}) =>
  healthy(A, { recording: { session_open: false, session_id: null, session_status: null, session_started_at: null, last_chunk_at: null, recorder_status: null }, ...over });

