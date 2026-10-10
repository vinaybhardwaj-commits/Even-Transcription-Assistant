/**
 * Test-only stand-in for the removed `diarizeWindow()` wrapper (pyannote cleanup, 10 Oct 2026).
 * The production path is `finishDiarizeWindow` (shared by the Nemotron job); this feeds it a canned
 * service answer so the straddle / losing-score / role tests keep exercising the real storage code.
 */
import { finishDiarizeWindow, attributionFor, type ClinicianCentroid } from "@/lib/stt/diarize-window";
import { parseDiarizeSegments } from "@/lib/stt/speaker-clusters";
import type { DiarizeSpeaker } from "@/lib/diarize";
import type { WindowStartMs, WindowEndMs } from "@/lib/stt/window-bounds";

type Out = { ok?: boolean; latencyMs?: number; error?: string; result?: { speakers?: unknown; transcript_segments?: unknown } };

export async function diarizeWindowFromAnswer(
  opts: { windowId: string; roomDayId: string; window: { start: WindowStartMs; end: WindowEndMs }; runId: string; centroids?: ClinicianCentroid[] },
  out: Out,
) {
  const centroids = opts.centroids ?? [];
  if (out.ok === false) return { ok: false as const, error: out.error ?? "error" };
  const speakers = (out.result?.speakers ?? []) as DiarizeSpeaker[];
  return {
    ok: true as const,
    ...(await finishDiarizeWindow({ ...opts, centroids }, {
      speakers,
      rawSegments: parseDiarizeSegments(out.result?.transcript_segments),
      timing: null,
      latencyMs: out.latencyMs ?? null,
      provenance: {
        name: "local", model: null, job_id: null, attribution: attributionFor(speakers, centroids.length),
        centroids_offered: centroids.length, fallback_from: null, fallback_reason: null, audio_seconds_sent: null,
      },
    })),
  };
}
