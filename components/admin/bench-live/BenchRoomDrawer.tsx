"use client";

import * as React from "react";
import {
  ageMs,
  BenchRoomStatusChips,
  BenchRoomVitals,
  fmtAge,
  fmtMinutes,
  StatusPill,
} from "@/components/admin/bench-live/BenchRoomVitals";
import { STRANDED_MEASURE_NOTE } from "@/lib/room-facts";
import type { RoomPresentation } from "@/components/admin/bench-live/roomPresentation";
import type {
  Attention,
  ListenerRowView,
  RoomLive,
  RoomsLiveResp,
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

export function BenchRoomDrawer({
  open,
  room,
  listener,
  presentation,
  attention,
  nowMs,
  factsAsOf,
  listenerAsOf,
  thresholds,
  onClose,
  children,
}: {
  open: boolean;
  room: RoomLive | null;
  listener: ListenerRowView | undefined;
  presentation: RoomPresentation | null;
  attention: readonly Attention[];
  nowMs: number;
  factsAsOf: number | null;
  listenerAsOf: number | null;
  thresholds: RoomsLiveResp["thresholds"] | null;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !room || !presentation) return null;

  return (
    <div className="fixed inset-0 z-40" data-testid="room-drawer">
      <button
        type="button"
        aria-label="Close room drawer"
        className="absolute inset-0 bg-even-navy-800/30"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="bench-room-drawer-title"
        className="absolute inset-y-0 right-0 w-full max-w-2xl overflow-y-auto bg-even-white p-5 shadow-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-even-blue-700">
              Observe · room facts
            </p>
            <h3 id="bench-room-drawer-title" className="text-heading text-even-navy-800">
              {room.room.name}
            </h3>
            <p className="text-caption text-even-ink-500">
              {room.room.slug} · {room.room.id}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 min-w-11 rounded-lg bg-even-ink-100 text-heading text-even-ink-600 hover:bg-even-ink-200"
            aria-label="Close room drawer"
          >
            ×
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StatusPill level={presentation.state.level}>
            {STATE_WORD[presentation.state.state]}
          </StatusPill>
          <StatusPill level={room.recording || room.paused_session ? "ok" : "unknown"}>
            Session {room.recording || room.paused_session ? "open" : "closed"}
          </StatusPill>
        </div>
        <BenchRoomStatusChips
          roomName={room.room.name}
          operational={presentation.operational}
          syncUnknown={presentation.hostCloudDesync === null}
          listener={listener}
        />

        <section className="mt-4 rounded-xl border border-even-blue-100 bg-even-blue-50/40 p-4">
          <h4 className="text-label font-semibold text-even-navy-800">Why this room is placed here</h4>
          {attention.length ? (
            <ul className="mt-1 space-y-1">
              {attention.map((item) => (
                <li key={`${item.title}-${item.rank}`} className="text-caption text-even-ink-600">
                  <span className="font-semibold">{item.title}.</span> {item.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-caption text-even-ink-500">
              No room-facts alert is elevating it; this room is in the default S3 band.
            </p>
          )}
        </section>

        <section className="mt-4 rounded-xl border border-even-ink-200 p-4">
          <h4 className="text-label font-semibold text-even-navy-800">Tape, microphone &amp; freshness</h4>
          <p className="mt-1 text-caption text-even-ink-600">
            {presentation.state.label}
          </p>
          <BenchRoomVitals
            room={room}
            listener={listener}
            state={presentation.state}
            operational={presentation.operational}
            syncUnknown={presentation.hostCloudDesync === null}
            nowMs={nowMs}
            thresholds={thresholds}
            showStatus={false}
          />
          {room.stranded && room.stranded.total_ms > 0 ? (
            <div className="mt-3 rounded-lg border border-warning-200 bg-warning-50 p-3" data-testid="stranded-audio">
              <p className="text-caption text-even-navy-800">
                <span className="font-semibold">{fmtMinutes(room.stranded.total_ms)}</span> of audio cannot currently be turned into words. It is recorded and safe.
              </p>
              <ul className="mt-1 space-y-0.5">
                {room.stranded.reasons.map((reason) => (
                  <li key={reason.reason} className="text-caption text-even-ink-600">
                    {fmtMinutes(reason.ms)} · {reason.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-caption text-even-ink-400">{STRANDED_MEASURE_NOTE}</p>
            </div>
          ) : null}
          <dl className="mt-3 space-y-1.5 border-t border-even-ink-100 pt-3">
            <div className="flex justify-between gap-3 text-caption">
              <dt className="text-even-ink-500">Kiosk listener</dt>
              <dd className="font-semibold text-even-navy-800">
                {listener
                  ? `${listener.listening ? "listening" : "offline"} · last poll ${fmtAge(ageMs(listener.last_poll_at, nowMs))} ago`
                  : "unknown"}
              </dd>
            </div>
            <div className="flex justify-between gap-3 text-caption">
              <dt className="text-even-ink-500">Room facts last success</dt>
              <dd className="font-semibold text-even-navy-800">
                {factsAsOf ? `${fmtAge(nowMs - factsAsOf)} ago` : "unknown"}
              </dd>
            </div>
            <div className="flex justify-between gap-3 text-caption">
              <dt className="text-even-ink-500">Listener last success</dt>
              <dd className="font-semibold text-even-navy-800">
                {listenerAsOf ? `${fmtAge(nowMs - listenerAsOf)} ago` : "unknown"}
              </dd>
            </div>
            <div className="flex justify-between gap-3 text-caption">
              <dt className="text-even-ink-500">Newest stored piece</dt>
              <dd className="font-semibold text-even-navy-800">
                {room.last_piece_at ? `${fmtAge(ageMs(room.last_piece_at, nowMs))} ago` : "unknown"}
              </dd>
            </div>
          </dl>
          {room.degraded?.length ? (
            <p className="mt-3 rounded-lg bg-warning-50 px-3 py-2 text-caption text-warning-700">
              Partial facts · {room.degraded.join(" · ")}. Missing fields remain unknown.
            </p>
          ) : null}
        </section>

        <div className="mt-4">{children}</div>
      </aside>
    </div>
  );
}
