"use client";

import { fmtMinutes } from "@/components/admin/bench-live/BenchRoomVitals";
import type { RoomLive, RunOutcome } from "@/components/admin/bench-live/types";
import { STRANDED_WAITING } from "@/lib/room-facts";

const ACTION =
  "min-h-11 min-w-11 rounded-lg border border-even-ink-200 bg-even-white px-4 py-2 text-label font-semibold text-even-navy-800 hover:bg-even-ink-50 disabled:opacity-40";

export function BenchRoomActions({
  room,
  pending,
  switchError,
  orphaned,
  confirmingOrphan,
  confirmingRun,
  runningWaiting,
  runResult,
  onSetLane,
  onConfirmVisits,
  onArmOrphan,
  onCloseOrphan,
  onArmRun,
  onRunWaiting,
}: {
  room: RoomLive;
  pending: Readonly<Record<string, boolean>>;
  switchError: { key: string; message: string } | null;
  orphaned: boolean;
  confirmingOrphan: boolean;
  confirmingRun: boolean;
  runningWaiting: boolean;
  runResult: { drained: RunOutcome[]; remaining: number } | undefined;
  onSetLane: (lane: "transcript" | "visits", enabled: boolean) => void;
  onConfirmVisits: () => void;
  onArmOrphan: () => void;
  onCloseOrphan: () => void;
  onArmRun: () => void;
  onRunWaiting: () => void;
}) {
  const transcriptOn = pending[`${room.room.id}:transcript`] ?? room.transcript_enabled;
  const visitsOn = pending[`${room.room.id}:visits`] ?? room.visits_enabled;
  const waitingReason = room.stranded?.reasons.find((item) => item.reason === STRANDED_WAITING);
  const waiting = waitingReason?.slots ?? 0;

  return (
    <div className="mt-4 space-y-4 border-t border-warning-200 pt-4">
      <section>
        <h4 className="text-label font-semibold text-even-navy-800">Processing lanes</h4>
        <p className="text-caption text-even-ink-500">Tape transport is above. These writes change downstream processing only.</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            role="switch"
            aria-checked={transcriptOn}
            className={ACTION}
            onClick={() => onSetLane("transcript", !transcriptOn)}
          >
            Transcript · {transcriptOn ? "on" : "off"}
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={visitsOn}
            className={ACTION}
            onClick={() => visitsOn ? onSetLane("visits", false) : onConfirmVisits()}
          >
            Visits · {visitsOn ? "on" : "off"}
          </button>
        </div>
        {switchError?.key.startsWith(`${room.room.id}:`) ? (
          <p className="mt-2 text-caption font-semibold text-danger-700">{switchError.message}</p>
        ) : null}
      </section>

      {room.transcript_enabled && waiting > 0 ? (
        <section className="rounded-lg border border-even-navy-200 bg-even-navy-50 p-3">
          <p className="text-caption text-even-navy-800">
            <span className="font-semibold">
              Waiting: {waiting} piece{waiting === 1 ? "" : "s"} · {fmtMinutes(waitingReason?.ms ?? 0)} of slot time.
            </span>{" "}
            Up to four paid transcription calls run per batch.
          </p>
          <button
            type="button"
            disabled={runningWaiting}
            onClick={confirmingRun ? onRunWaiting : onArmRun}
            className="mt-2 min-h-11 rounded-lg bg-even-navy-800 px-4 py-2 text-label font-semibold text-even-white disabled:opacity-40"
          >
            {runningWaiting
              ? "Running…"
              : confirmingRun
                ? `Confirm paid run · ${Math.min(4, waiting)} pieces max`
                : "Run waiting audio (paid)"}
          </button>
          {confirmingRun ? (
            <p className="mt-1 text-caption font-semibold text-warning-700">
              Strong confirm: each piece is a paid call. Exact cost is reported before another batch.
            </p>
          ) : null}
          {runResult ? (
            <div className="mt-2 border-t border-even-navy-100 pt-2" data-testid="run-waiting-report">
              {runResult.drained.length ? (
                <ul className="space-y-1">
                  {runResult.drained.map((result) => (
                    <li key={result.window_id} className="text-caption text-even-ink-600">
                      {result.ok
                        ? `✓ ${result.engine ?? "engine"} · ${result.transcript_chars ?? 0} chars · ${result.cost_usd == null ? "cost unknown" : `$${result.cost_usd.toFixed(4)}`}`
                        : `✗ did not run · ${result.step}`}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-caption text-even-ink-500">Nothing ran.</p>
              )}
              {runResult.remaining > 0 ? (
                <p className="mt-1 text-caption text-even-ink-500">{runResult.remaining} pieces remain.</p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {orphaned ? (
        <section className="rounded-lg border border-warning-200 bg-warning-50 p-3">
          <p className="text-caption text-even-navy-800">
            <span className="font-semibold">Abandoned session.</span> No kiosk claims this open session. Closing it preserves uploaded audio and lets the room record again.
          </p>
          <button
            type="button"
            onClick={confirmingOrphan ? onCloseOrphan : onArmOrphan}
            className="mt-2 min-h-11 rounded-lg bg-warning-500 px-4 py-2 text-label font-semibold text-even-navy-800"
          >
            {confirmingOrphan ? "Confirm close abandoned session" : "Close abandoned session"}
          </button>
        </section>
      ) : null}
    </div>
  );
}
