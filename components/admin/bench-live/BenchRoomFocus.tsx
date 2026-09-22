"use client";

import type { RoomState } from "@/lib/bench-bus-constants";
import type {
  CommandOutcome,
  ListenerRowView,
  RoomLive,
  RoomsLiveResp,
} from "@/components/admin/bench-live/types";
import type { RoomPresentation } from "@/components/admin/bench-live/roomPresentation";
import {
  BenchRoomVitals,
  StatusPill,
} from "@/components/admin/bench-live/BenchRoomVitals";
import { BenchCommandTransport } from "@/components/admin/bench-live/BenchCommandTransport";

const STATE_WORD: Record<RoomState, string> = {
  cant_tell: "can't tell",
  paused: "paused",
  recording: "recording",
  finished: "finished",
  ready: "ready",
  dropped: "dropped",
  offline: "offline",
};

export function BenchRoomFocus({
  room,
  listener,
  presentation,
  outcome,
  confirmingStop,
  invalidRoom,
  nowMs,
  thresholds,
  confirmWindowSeconds,
  onArmStop,
  onSend,
}: {
  room: RoomLive | null;
  listener: ListenerRowView | undefined;
  presentation: RoomPresentation | null;
  outcome: CommandOutcome | undefined;
  confirmingStop: boolean;
  invalidRoom: string | null;
  nowMs: number;
  thresholds: RoomsLiveResp["thresholds"] | null;
  confirmWindowSeconds: number;
  onArmStop: () => void;
  onSend: (kind: string) => void;
}) {
  return (
    <section
      className="rounded-xl border border-even-blue-100 bg-even-blue-50/60 p-4"
      aria-label="Room focus"
      data-testid="room-focus-panel"
    >
      {invalidRoom ? (
        <p className="mb-3 rounded-lg border border-warning-200 bg-warning-50 px-3 py-2 text-caption text-warning-700">
          Room “{invalidRoom}” is not on this fleet. Choose a room card below.
        </p>
      ) : null}
      {!room || !presentation ? (
        <p className="text-caption text-even-ink-500">
          Choose a room to see its tape facts and controls together.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500">
                Room focus
              </p>
              <h3 className="text-heading text-even-navy-800">
                {room.room.name}
              </h3>
              <p className="text-caption text-even-ink-500">{room.room.slug}</p>
            </div>
            <StatusPill
              level={presentation.state.level}
              title={presentation.state.hint ?? undefined}
            >
              {STATE_WORD[presentation.state.state]}
            </StatusPill>
          </div>
          <p className="mt-2 text-body text-even-navy-800">
            {presentation.state.label}
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <BenchRoomVitals
                room={room}
                listener={listener}
                state={presentation.state}
                operational={presentation.operational}
                syncUnknown={presentation.hostCloudDesync === null}
                nowMs={nowMs}
                thresholds={thresholds}
                compact
              />
              <p className="mt-2 text-caption text-even-ink-600">
                Tape · {room.lanes.tape.state}
              </p>
            </div>
            <div>
              <BenchCommandTransport
                room={room}
                listener={listener}
                state={presentation.state}
                canReachKiosk={presentation.canReachKiosk}
                outcome={outcome}
                confirmingStop={confirmingStop}
                confirmWindowSeconds={confirmWindowSeconds}
                showEmptyOutcome
                onArmStop={onArmStop}
                onSend={onSend}
              />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
