"use client";

import type React from "react";
import type { RoomStateView } from "@/lib/bench-bus-constants";
import type { OperationalAlert } from "@/lib/room-facts";
import type {
  Level,
  Levels,
  ListenerRowView,
  RoomLive,
  RoomsLiveResp,
} from "@/components/admin/bench-live/types";

const PILL = "inline-block px-2 py-0.5 rounded-full text-caption font-semibold";
const LEVEL_CLASS: Record<Level, string> = {
  ok: "bg-success-100 text-success-700",
  amber: "bg-warning-100 text-warning-700",
  red: "bg-danger-100 text-danger-700",
  unknown: "bg-even-ink-100 text-even-ink-500",
};

export function fmtAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function ageMs(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? Math.max(0, nowMs - value) : null;
}

export function fmtMinutes(ms: number): string {
  const minutes = Math.round((Number(ms) || 0) / 60_000);
  if (minutes < 60) return `${minutes} m`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

export function StatusPill({
  level,
  children,
  title,
}: {
  level: Level;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span className={`${PILL} ${LEVEL_CLASS[level]}`} title={title}>
      {children}
    </span>
  );
}

function LevelBar({ label, levels }: { label: string; levels: Levels }) {
  if (!levels) return null;
  const scale = (value: number) =>
    Math.max(0, Math.min(1, Math.sqrt(Math.max(0, Math.min(1, value)) / 0.3)));
  const heard = levels.peak > 0.0015;
  return (
    <div className="flex items-center gap-2">
      <span className="text-caption text-even-ink-500 w-[70px] shrink-0">
        {label}
      </span>
      <span
        className="relative flex-1 h-2 rounded-full bg-even-ink-100 overflow-hidden"
        role="meter"
        aria-label={`${label} level`}
        aria-valuenow={Math.round(levels.avg * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ${
            heard ? "bg-success-500" : "bg-even-ink-200"
          }`}
          style={{ width: `${Math.round(scale(levels.avg) * 100)}%` }}
        />
        <span
          className="absolute inset-y-0 w-0.5 bg-even-navy-800/60"
          style={{ left: `calc(${Math.round(scale(levels.peak) * 100)}% - 1px)` }}
        />
      </span>
    </div>
  );
}

export function BenchRoomStatusChips({
  roomName,
  operational,
  syncUnknown,
  listener,
}: {
  roomName: string;
  operational: readonly OperationalAlert[];
  syncUnknown: boolean;
  listener: ListenerRowView | undefined;
}) {
  if (operational.length === 0 && !syncUnknown) return null;
  return (
    <div
      className="mt-2 flex flex-wrap gap-1.5"
      aria-label={`${roomName} operational alerts`}
    >
      {operational.map((alert) => {
        const levelDetail =
          alert.code === "digital_silence" && listener?.mic
            ? ` Current meter peak ${listener.mic.peak.toFixed(4)}, average ${listener.mic.avg.toFixed(4)}.`
            : "";
        return (
          <StatusPill
            key={alert.code}
            level={alert.severity}
            title={`${alert.detail}${levelDetail}`}
          >
            {alert.label}
          </StatusPill>
        );
      })}
      {syncUnknown ? (
        <StatusPill
          level="unknown"
          title="The listener poll is degraded, so host/cloud recording agreement cannot be checked."
        >
          Host/cloud sync unknown
        </StatusPill>
      ) : null}
    </div>
  );
}

export function BenchRoomVitals({
  room,
  listener,
  state,
  operational,
  syncUnknown,
  nowMs,
  thresholds,
  compact = false,
  showStatus = true,
}: {
  room: RoomLive;
  listener: ListenerRowView | undefined;
  state: RoomStateView;
  operational: readonly OperationalAlert[];
  syncUnknown: boolean;
  nowMs: number;
  thresholds: RoomsLiveResp["thresholds"] | null;
  compact?: boolean;
  showStatus?: boolean;
}) {
  return (
    <>
      {showStatus ? (
        <BenchRoomStatusChips
          roomName={room.room.name}
          operational={operational}
          syncUnknown={syncUnknown}
          listener={listener}
        />
      ) : null}
      <dl className="mt-3 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-caption text-even-ink-500">
            Main mic{" "}
            {!compact ? (
              <span className="text-even-ink-400">
                · newest piece, 0–5 min is healthy
                {thresholds
                  ? ` · amber at ${Math.round(thresholds.mic_amber_ms / 60_000)} min, red at ${Math.round(thresholds.mic_red_ms / 60_000)}`
                  : ""}
              </span>
            ) : null}
          </dt>
          <dd>
            {state.state === "ready" || (!room.recording && room.last_piece_at === null) ? (
              <span className="text-caption text-even-ink-400">no tape yet</span>
            ) : (
              <StatusPill
                level={room.mic_level}
                title="Newest piece on either microphone, measured on the upload clock."
              >
                {room.last_primary_at
                  ? fmtAge(ageMs(room.last_primary_at, nowMs))
                  : room.recording
                    ? "no piece yet"
                    : "—"}
              </StatusPill>
            )}
          </dd>
        </div>

        {listener?.mic ? (
          <div className="pt-1 space-y-1.5">
            <LevelBar label="Main mic" levels={listener.mic} />
            {room.spare_exists && listener.spare ? (
              <LevelBar label="Spare mic" levels={listener.spare} />
            ) : null}
          </div>
        ) : null}

        {room.mic_size && room.mic_size.newest !== "unknown" ? (
          <div className="flex items-center justify-between gap-2">
            <dt className="text-caption text-even-ink-500">
              Piece size
              {!compact ? (
                <span className="text-even-ink-400">
                  {" "}· against this room&rsquo;s recent pieces
                </span>
              ) : null}
            </dt>
            <dd>
              {room.mic_size.newest === "tiny" ? (
                <StatusPill
                  level="amber"
                  title="Full-length pieces are a fraction of this microphone's usual size."
                >
                  {room.mic_size.tiny_run > 1
                    ? `${room.mic_size.tiny_run} pieces tiny`
                    : "tiny"}
                </StatusPill>
              ) : (
                <StatusPill
                  level="ok"
                  title="Pieces are the size this microphone usually produces."
                >
                  normal here
                </StatusPill>
              )}
            </dd>
          </div>
        ) : null}
        {room.spare_exists && room.spare_size?.newest === "tiny" ? (
          <p className="text-caption text-warning-700 leading-snug">
            The spare microphone is recording unusually small pieces. The main
            microphone remains the source of record.
          </p>
        ) : null}

        {!compact && room.has_doctor_clock ? (
          <div className="flex items-center justify-between gap-2">
            <dt
              className="text-caption text-even-ink-500"
              title="Pulse clocks from the labelled doctor only. The warehouse holds no room."
            >
              This doctor
            </dt>
            <dd>
              {room.doctor_clock_silent_ms === null ? (
                <span className="text-caption text-even-ink-400">—</span>
              ) : (
                <StatusPill level={room.doctor_clock_level}>
                  {fmtAge(room.doctor_clock_silent_ms)}
                </StatusPill>
              )}
            </dd>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <dt className="text-caption text-even-ink-500">Tape today</dt>
          <dd className="text-caption text-even-navy-800">
            {fmtMinutes(room.audio_recorded_ms ?? 0)}
            {room.last_piece_at ? (
              <span className="text-even-ink-400">
                {" "}· newest {fmtAge(ageMs(room.last_piece_at, nowMs))} ago
              </span>
            ) : null}
          </dd>
        </div>

        {!compact ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-caption text-even-ink-500">Marks</dt>
              <dd className="text-caption text-even-navy-800">
                {room.marks_today}
                {room.last_mark_at ? (
                  <span className="text-even-ink-400">
                    {" "}· last {fmtAge(ageMs(room.last_mark_at, nowMs))} ago
                  </span>
                ) : null}
                {room.marks_not_sent > 0 ? (
                  <span className={`${PILL} ${LEVEL_CLASS.amber} ml-1.5`}>
                    {room.marks_not_sent} not sent
                  </span>
                ) : null}
              </dd>
            </div>
            {room.spare_exists && room.backup_chunks_today > 0 ? (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-caption text-even-ink-500">Spare mic</dt>
                <dd className="text-caption text-even-navy-800">
                  {room.backup_chunks_today} piece
                  {room.backup_chunks_today === 1 ? "" : "s"} today
                </dd>
              </div>
            ) : null}
            {room.transcript_counts.words_ms > 0 ? (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-caption text-even-ink-500">
                  Turned into words
                </dt>
                <dd className="text-caption text-even-navy-800">
                  {fmtMinutes(room.transcript_counts.words_ms)}
                </dd>
              </div>
            ) : null}
            {room.last_window_complete === false ? (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-caption text-even-ink-500">
                  Transcription
                </dt>
                <dd>
                  <StatusPill
                    level="amber"
                    title="The turns were rolled back; re-run this request."
                  >
                    request did not finish
                  </StatusPill>
                </dd>
              </div>
            ) : null}
          </>
        ) : null}
      </dl>
    </>
  );
}
