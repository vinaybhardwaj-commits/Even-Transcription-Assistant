"use client";

import { CommandOutcomeView } from "@/components/admin/bench-live/BenchCommandTransport";
import {
  ageMs,
  BenchRoomStatusChips,
  fmtAge,
  StatusPill,
} from "@/components/admin/bench-live/BenchRoomVitals";
import { severityBandForRank } from "@/components/admin/bench-live/fleetOrdering";
import { RoomCard } from "@/components/admin/bench-live/RoomCard";
import { roomPresentation } from "@/components/admin/bench-live/roomPresentation";
import type {
  Attention,
  CommandOutcome,
  ListenerRowView,
  RoomLive,
} from "@/components/admin/bench-live/types";

const STATE_WORD = {
  cant_tell: "can't tell",
  paused: "paused",
  recording: "recording",
  finished: "finished",
  ready: "ready",
  dropped: "dropped",
  offline: "offline",
} as const;

export function BenchFleetGrid({
  rooms,
  listeners,
  listenersKnown,
  selectedId,
  attention,
  outcomes,
  nowMs,
  degraded,
  factsAsOf,
  onSelect,
}: {
  rooms: readonly RoomLive[];
  listeners: ReadonlyMap<string, ListenerRowView>;
  listenersKnown: boolean;
  selectedId: string | null;
  attention: readonly Attention[];
  outcomes: Readonly<Record<string, CommandOutcome>>;
  nowMs: number;
  degraded: boolean;
  factsAsOf: number | null;
  onSelect: (room: RoomLive["room"]) => void;
}) {
  const attentionByRoom = new Map<string, Attention[]>();
  for (const item of attention) {
    const roomItems = attentionByRoom.get(item.roomId) ?? [];
    roomItems.push(item);
    attentionByRoom.set(item.roomId, roomItems);
  }

  return (
    <div
      className={`grid gap-3 sm:grid-cols-2 xl:grid-cols-3 ${degraded ? "opacity-60" : ""}`}
      data-testid="fleet-grid"
      data-degraded={degraded ? "true" : "false"}
    >
      {rooms.map((room) => {
        const listener = listeners.get(room.room.id);
        const presentation = roomPresentation(room, listener, listenersKnown, nowMs);
        const reasons = attentionByRoom.get(room.room.id) ?? [];
        const topReason = reasons[0];
        const band = severityBandForRank(topReason?.rank ?? null);
        return (
          <RoomCard
            key={room.room.id}
            id={room.room.id}
            name={room.room.name}
            level={presentation.worst}
            selected={selectedId === room.room.id}
            onSelect={() => onSelect(room.room)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-even-navy-800 truncate">{room.room.name}</p>
                <p className="text-caption text-even-ink-400 truncate">{room.room.slug}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-bold text-even-ink-400" title="Severity band">
                  {band}
                </span>
                <StatusPill level={presentation.state.level}>
                  {STATE_WORD[presentation.state.state]}
                </StatusPill>
              </div>
            </div>

            <BenchRoomStatusChips
              roomName={room.room.name}
              operational={presentation.operational}
              syncUnknown={presentation.hostCloudDesync === null}
              listener={listener}
            />

            <dl className="mt-3 space-y-1.5">
              <div className="flex justify-between gap-3 text-caption">
                <dt className="text-even-ink-500">Session</dt>
                <dd className="font-semibold text-even-navy-800">
                  {room.recording || room.paused_session ? "open" : "closed"}
                </dd>
              </div>
              <div className="flex justify-between gap-3 text-caption">
                <dt className="text-even-ink-500">Newest piece</dt>
                <dd className="text-even-navy-800">
                  {room.last_piece_at ? `${fmtAge(ageMs(room.last_piece_at, nowMs))} ago` : "unknown"}
                </dd>
              </div>
              <div className="flex justify-between gap-3 text-caption">
                <dt className="text-even-ink-500">Kiosk / mic</dt>
                <dd className="text-right text-even-navy-800">
                  {!listenersKnown
                    ? "unknown"
                    : listener?.listening
                      ? `listening · ${room.mic_level}`
                      : "offline · unknown"}
                </dd>
              </div>
            </dl>

            {topReason ? (
              <p className="mt-3 rounded-lg bg-even-white/70 px-2.5 py-2 text-caption text-even-navy-800">
                <span className="font-semibold">Elevated:</span> {topReason.title}
              </p>
            ) : (
              <p className="mt-3 text-caption text-even-ink-500">
                No room-facts alert is elevating this card.
              </p>
            )}

            <div className="mt-3 border-t border-even-ink-100 pt-3">
              <CommandOutcomeView outcome={outcomes[room.room.id]} compact />
            </div>
            {degraded && factsAsOf ? (
              <p className="mt-2 text-caption font-semibold text-warning-700">
                Last-known facts · {fmtAge(nowMs - factsAsOf)} old
              </p>
            ) : null}
          </RoomCard>
        );
      })}
    </div>
  );
}
