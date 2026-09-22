"use client";

import { BenchCommandTransport } from "@/components/admin/bench-live/BenchCommandTransport";
import type { RoomStateView } from "@/lib/bench-bus-constants";
import type {
  BusCommandView,
  CommandOutcome,
  ListenerRowView,
  RoomLive,
} from "@/components/admin/bench-live/types";

const LABEL: Record<string, string> = {
  start_day: "Start",
  pause_day: "Pause",
  resume_day: "Resume",
  end_day: "Stop",
  close_orphan: "Close abandoned session",
};

function historyState(status: BusCommandView["status"]) {
  if (status === "acked") return "ack";
  if (status === "expired") return "timeout";
  if (status === "failed") return "conflict";
  return "queued";
}

export function BenchCommandPanel({
  room,
  listener,
  state,
  canReachKiosk,
  outcome,
  history,
  confirmingStop,
  confirmWindowSeconds,
  onArmStop,
  onSend,
  children,
}: {
  room: RoomLive;
  listener: ListenerRowView | undefined;
  state: RoomStateView;
  canReachKiosk: boolean;
  outcome: CommandOutcome | undefined;
  history: readonly BusCommandView[];
  confirmingStop: boolean;
  confirmWindowSeconds: number;
  onArmStop: () => void;
  onSend: (kind: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <section
      className="rounded-xl border border-warning-200 bg-warning-50/50 p-4"
      aria-label="Act on selected room"
      data-testid="command-panel"
    >
      <div className="mb-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-warning-700">
          Act · writes to this room
        </p>
        <p className="text-caption text-even-ink-600">
          Transport commands are listener-gated and remain queued until the kiosk acknowledges them.
        </p>
      </div>
      <BenchCommandTransport
        room={room}
        listener={listener}
        state={state}
        canReachKiosk={canReachKiosk}
        outcome={outcome}
        confirmingStop={confirmingStop}
        confirmWindowSeconds={confirmWindowSeconds}
        showEmptyOutcome
        onArmStop={onArmStop}
        onSend={onSend}
      />
      {children}
      <div className="mt-4 border-t border-warning-200 pt-3">
        <h4 className="text-label font-semibold text-even-navy-800">Command bus history</h4>
        {history.length === 0 ? (
          <p className="mt-1 text-caption text-even-ink-500">
            Outcome unknown · no recent command-bus entry for this room.
          </p>
        ) : (
          <ol className="mt-2 space-y-2" data-testid="command-history">
            {history.map((command) => (
              <li key={command.id} className="rounded-lg border border-even-ink-100 bg-even-white px-3 py-2">
                <div className="flex items-center justify-between gap-3 text-caption">
                  <span className="font-semibold text-even-navy-800">
                    {LABEL[command.kind] ?? command.kind}
                  </span>
                  <span className="font-semibold text-even-ink-600">{historyState(command.status)}</span>
                </div>
                <p className="text-caption text-even-ink-500">
                  {new Date(command.created_at).toLocaleTimeString()}
                  {command.error ? ` · ${command.error}` : ""}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
