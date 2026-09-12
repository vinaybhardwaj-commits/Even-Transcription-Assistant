/**
 * lib/stt/diarize-budget.ts — admission control for the diarize step.
 *
 * The service is ~1.5x realtime (16.8 s for an 11 s clip, measured), and it is serialised behind a
 * depth-1 gate on the Mini, so a window that cannot finish inside the lease does not merely run
 * late — it holds the only slot while it does, and then may be re-claimed and run again.
 *
 * Budgeted against LEASE_MS for the same reason the transcription step is: MAX_STEP_MS is never
 * enforced on a running step, while lease expiry actually causes the work to be redone.
 */
import { LEASE_MS } from "@/lib/jobs/types";

export const DIARIZE_REALTIME_FACTOR_ENV = "ETA_DIARIZE_REALTIME_FACTOR";
export const DEFAULT_DIARIZE_REALTIME_FACTOR = 1.5;
/** Upload of a multi-megabyte clip over the tunnel, plus the cue read and the span writes. */
export const DIARIZE_IO_MARGIN_MS = 45_000;

export function DIARIZE_REALTIME_FACTOR(raw: string | undefined = process.env[DIARIZE_REALTIME_FACTOR_ENV]): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DIARIZE_REALTIME_FACTOR;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DIARIZE_REALTIME_FACTOR;
  return Math.min(20, n);
}

export function diarizeFits(audioSeconds: number, factor: number = DIARIZE_REALTIME_FACTOR()): { fits: boolean; projected_ms: number; budget_ms: number } {
  const projected_ms = Math.round(audioSeconds * factor * 1000) + DIARIZE_IO_MARGIN_MS;
  return { fits: projected_ms <= LEASE_MS, projected_ms, budget_ms: LEASE_MS };
}
