"use client";

export function BenchDangerZone({
  confirming,
  note,
  onArm,
  onCancel,
  onConfirm,
}: {
  confirming: boolean;
  note: string | null;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <details className="rounded-xl border border-even-ink-200 bg-even-white">
      <summary className="min-h-11 cursor-pointer list-none px-4 py-3 flex items-center justify-between gap-3 text-label font-semibold text-even-ink-600">
        <span>Processing danger zone</span>
        <span className="text-caption font-normal text-even-ink-400">global controls</span>
      </summary>
      <div className="border-t border-even-ink-100 p-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-even-navy-800">Stop all processing</p>
            <p className="text-caption text-even-ink-600 leading-snug max-w-[60ch]">
              Turns Transcript and Visits off in every room. Recording carries on and no audio is lost.
              Turn lanes back on room by room when it is safe.
            </p>
          </div>
          {confirming ? (
            <div className="flex flex-wrap gap-2 shrink-0">
              <button type="button" onClick={onCancel} className="min-h-11 px-4 py-2 rounded-lg text-label bg-even-white border border-even-ink-200 hover:bg-even-ink-50">
                Cancel
              </button>
              <button type="button" onClick={onConfirm} className="min-h-11 px-4 py-2 rounded-lg text-label font-semibold bg-danger-500 text-even-white hover:bg-danger-700">
                Yes — stop all processing
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="stop-all-processing"
              onClick={onArm}
              className="min-h-11 px-4 py-2 rounded-lg text-label font-semibold border border-danger-200 bg-even-white text-danger-700 hover:bg-danger-100 shrink-0"
            >
              Stop all processing
            </button>
          )}
        </div>
        {note ? <p className="mt-3 text-caption font-semibold text-even-navy-800">{note}</p> : null}
      </div>
    </details>
  );
}
