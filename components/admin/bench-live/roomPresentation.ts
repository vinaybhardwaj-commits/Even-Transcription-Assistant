import { roomState, type RoomStateView } from "@/lib/bench-bus-constants";
import {
  hostCloudDesync,
  roomOperationalAlerts,
  type OperationalAlert,
} from "@/lib/room-facts";
import type {
  Level,
  ListenerRowView,
  RoomLive,
} from "@/components/admin/bench-live/types";

export type RoomPresentation = {
  state: RoomStateView;
  operational: OperationalAlert[];
  hostCloudDesync: boolean | null;
  worst: Level;
  canReachKiosk: boolean;
  orphaned: boolean;
};

/** Build the shared card/focus-panel picture from room-facts and the fresh listener poll. */
export function roomPresentation(
  room: RoomLive,
  listener: ListenerRowView | undefined,
  listenersKnown: boolean,
  nowMs: number,
): RoomPresentation {
  const state = roomState({
    listenerReadFailed: !listenersKnown,
    listener: listener
      ? { last_poll_at: listener.last_poll_at, paused: listener.paused }
      : null,
    pausedSession: room.paused_session,
    recording: room.recording,
    recordingSince: room.session_started_at,
    nowMs,
    lastSessionEnded: Boolean(room.last_session_ended),
    recordedMsToday: room.audio_recorded_ms ?? null,
  });
  const sessionDesync = hostCloudDesync({
    listenerKnown: listenersKnown,
    kioskListening: Boolean(listener?.listening),
    hostSessionId: listener?.recording_session_id,
    cloudSessionId: room.session_id,
  });
  const operational = roomOperationalAlerts({
    recording: room.recording,
    kioskListening: listenersKnown ? Boolean(listener?.listening) : null,
    stalled: room.stalled,
    stalledAgeMs: room.stalled_age_ms,
    activeMicAlert: room.active_mic_alert ?? null,
    tapeWithoutCues: room.tape_without_cues ?? null,
    pausedDisagrees: listenersKnown && listener
      ? listener.paused !== room.paused_session
      : null,
    hostCloudDesync: sessionDesync,
  });
  const worst: Level =
    operational.some((alert) => alert.severity === "red")
      || room.ended_disagrees
      || room.stalled
      || state.level === "red"
      || room.mic_level === "red"
      || room.doctor_clock_level === "red"
      || Boolean(room.recording && room.mic_size?.proven_dead_by_size)
      ? "red"
      : operational.some((alert) => alert.severity === "amber")
        || state.level === "amber"
        || room.mic_level === "amber"
        || room.doctor_clock_level === "amber"
        || room.ended_at_lies
        || room.marks_not_sent > 0
        ? "amber"
        : state.level === "unknown" || room.degraded.length > 0
          ? "unknown"
          : "ok";
  const kioskClaimsThis = Boolean(
    listener
      && listener.listening
      && listener.recording_session_id === room.session_id,
  );

  return {
    state,
    operational,
    hostCloudDesync: sessionDesync,
    worst,
    canReachKiosk: listenersKnown && Boolean(listener?.listening),
    orphaned:
      listenersKnown
      && (room.recording || room.paused_session)
      && !kioskClaimsThis,
  };
}
