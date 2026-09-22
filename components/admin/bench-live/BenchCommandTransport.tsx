"use client";

import type { RoomStateView } from "@/lib/bench-bus-constants";
import type {
  CommandOutcome,
  ListenerRowView,
  RoomLive,
} from "@/components/admin/bench-live/types";

const CTRL_BTN =
  "min-h-11 min-w-11 px-4 py-2 rounded-lg text-label bg-even-ink-100 hover:bg-even-ink-200 active:bg-even-ink-200 disabled:opacity-40 disabled:cursor-not-allowed";

const COMMAND_LABEL: Record<string, string> = {
  start_day: "Start",
  pause_day: "Pause",
  resume_day: "Resume",
  end_day: "Stop",
  close_orphan: "Close abandoned session",
};

export function startBlockedReason(state: RoomStateView): string | null {
  if (state.start_available) return null;
  switch (state.state) {
    case "ready":
      return null;
    case "finished":
      return "This day is finished. To record again, open the room page on the clinic Mac — no kiosk page is listening in this room right now.";
    case "recording":
      return "Start is off because this room is already recording. Use stop to end the day first.";
    case "paused":
      return "Start is off because this room is paused for consent. Use resume, not start.";
    case "dropped":
      return "Start is off because the kiosk page stopped responding. Reopen the room page on the clinic Mac.";
    case "offline":
      return "Start is off because no kiosk page is open in this room. Open the room page on the clinic Mac.";
    case "cant_tell":
      return "Start is off because the kiosk state could not be read just now. It will offer itself when the next poll succeeds.";
    default:
      return "Start is off until the kiosk is listening and the room is neither recording nor paused.";
  }
}

export function CommandOutcomeView({
  outcome,
}: {
  outcome: CommandOutcome | undefined;
}) {
  if (!outcome) {
    return (
      <p className="text-caption text-even-ink-500">
        No command outcome is available for this room yet.
      </p>
    );
  }
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        outcome.state === "acked"
          ? "border-success-500/40 bg-success-100"
          : outcome.state === "queued"
            ? "border-even-blue-100 bg-even-blue-50"
            : "border-warning-200 bg-warning-50"
      }`}
      data-testid="command-outcome"
      aria-live="polite"
    >
      <p className="text-caption font-semibold text-even-navy-800">
        Last command · {COMMAND_LABEL[outcome.kind] ?? outcome.kind} ·{" "}
        {outcome.state === "acked" ? "acknowledged" : outcome.state}
      </p>
      <p className="text-caption text-even-ink-600">{outcome.detail}</p>
    </div>
  );
}

export function BenchCommandTransport({
  room,
  listener,
  state,
  canReachKiosk,
  outcome,
  confirmingStop,
  confirmWindowSeconds,
  showEmptyOutcome = false,
  onArmStop,
  onSend,
}: {
  room: RoomLive;
  listener: ListenerRowView | undefined;
  state: RoomStateView;
  canReachKiosk: boolean;
  outcome: CommandOutcome | undefined;
  confirmingStop: boolean;
  confirmWindowSeconds: number;
  showEmptyOutcome?: boolean;
  onArmStop: () => void;
  onSend: (kind: string) => void;
}) {
  const blocked = startBlockedReason(state);
  return (
    <div onClick={(event) => event.stopPropagation()}>
      {outcome || showEmptyOutcome ? (
        <div className="mt-3">
          <CommandOutcomeView outcome={outcome} />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!state.start_available}
          title={state.start_available ? "queue start_day" : blocked ?? undefined}
          onClick={() => onSend("start_day")}
          className={CTRL_BTN}
        >
          start
        </button>
        <button
          type="button"
          disabled={!room.recording || !canReachKiosk}
          title={!canReachKiosk ? "No kiosk is listening; pause would be queued into the dark." : undefined}
          onClick={() => onSend("pause_day")}
          className={CTRL_BTN}
        >
          pause
        </button>
        <button
          type="button"
          disabled={state.state !== "paused" || !canReachKiosk}
          title={!canReachKiosk ? "No kiosk is listening; resume would be queued into the dark." : undefined}
          onClick={() => onSend("resume_day")}
          className={CTRL_BTN}
        >
          resume
        </button>
        {confirmingStop ? (
          <button
            type="button"
            disabled={!canReachKiosk}
            onClick={() => onSend("end_day")}
            className="min-h-11 min-w-11 px-4 py-2 rounded-lg text-label font-semibold bg-danger-500 text-even-white ring-2 ring-danger-700 ring-offset-1 hover:bg-danger-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            confirm stop
          </button>
        ) : (
          <button
            type="button"
            disabled={(!room.recording && !room.paused_session) || !canReachKiosk}
            title={!canReachKiosk ? "No kiosk is listening; stop would be queued into the dark." : undefined}
            onClick={onArmStop}
            className={CTRL_BTN}
          >
            stop
          </button>
        )}
      </div>
      {!canReachKiosk && (room.recording || room.paused_session) ? (
        <p className="mt-2 text-caption font-semibold text-warning-700 leading-snug">
          Kiosk offline — pause, resume, and stop are disabled because they would be queued into the dark.
        </p>
      ) : null}
      {blocked ? (
        <p className="mt-2 text-caption text-even-ink-600 leading-snug">
          {blocked}
        </p>
      ) : null}
      {confirmingStop ? (
        <p className="mt-2 text-caption text-danger-700 leading-snug">
          Tap “confirm stop” to end this day. This disarms itself in{" "}
          {confirmWindowSeconds} seconds.{" "}
          {listener?.listening
            ? "This room is reporting itself, so start should be available again from here. If it goes quiet after stopping, it has to be restarted at the Mac in the room."
            : "This room is NOT reporting itself right now, so you will not be able to start it again from this screen — somebody has to open the room page on the Mac in that room."}
        </p>
      ) : null}
    </div>
  );
}
