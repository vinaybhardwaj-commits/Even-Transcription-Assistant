/**
 * lib/voice-room-print/enqueue.ts — ENQUEUE the Pulse-doctor room-print builder (0142). Writes nothing itself.
 *
 * Per Pulse doctor with at least MIN_WINDOWS labelling windows, no build attempt within COOLDOWN_HOURS and no open
 * job, this submits one pulse_doctor_voice job; most windows first, at most BUILD_BATCH_LIMIT per call.
 *
 * SHIPS DARK. PULSE_DOCTOR_VOICE_ENABLED is the on-switch (strict: a typo throws). Off, this is a clean no-op and
 * reads nothing.
 */
import { parseFlag } from "@/lib/flags";
import { doctorsToBuild } from "@/lib/room-access/pulse-doctor-voice";
import { MIN_WINDOWS } from "./recurring";
import { LOOKBACK_DAYS, PULSE_DOCTOR_VOICE_KIND } from "@/lib/jobs/kinds/pulse-doctor-voice";

export const PULSE_DOCTOR_VOICE_ENABLED_ENV = "PULSE_DOCTOR_VOICE_ENABLED";
/** Each job makes up to MAX_WINDOWS calls to the Mini; a nightly run of 10 is at most 160. */
export const BUILD_BATCH_LIMIT = 10;
/** A doctor is rebuilt at most once in this many hours, built or refused. */
export const COOLDOWN_HOURS = 20;

export const pulseDoctorVoiceEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  parseFlag(PULSE_DOCTOR_VOICE_ENABLED_ENV, env);

export type BuildEnqueueResult = {
  enabled: boolean;
  candidates: number;
  n_blind_excluded: number;
  enqueued: Array<{ job_id: string; windows: number }>;
};

export async function enqueuePulseDoctorVoice(opts: { limit?: number; origin?: string; actor: string }): Promise<BuildEnqueueResult> {
  if (!pulseDoctorVoiceEnabled()) return { enabled: false, candidates: 0, n_blind_excluded: 0, enqueued: [] };
  const limit = Math.max(1, Math.min(BUILD_BATCH_LIMIT, Math.trunc(opts.limit ?? BUILD_BATCH_LIMIT) || BUILD_BATCH_LIMIT));
  const { uids, n_blind_excluded } = await doctorsToBuild(LOOKBACK_DAYS, MIN_WINDOWS, COOLDOWN_HOURS, limit);
  // Lazy, as the identity enqueue: a static import would close a cycle through lib/jobs/submit.
  const { submitJob } = await import("@/lib/jobs/submit");
  const enqueued: BuildEnqueueResult["enqueued"] = [];
  for (const u of uids) {
    // NOT caught: a job that could not be queued must never be counted as queued.
    const job = await submitJob({
      kind: PULSE_DOCTOR_VOICE_KIND,
      args: { pulse_doctor_uid: u.uid },
      actor: opts.actor,
      ...(opts.origin ? { origin: opts.origin } : {}),
      scopes: new Set(["invoke"] as const),
    });
    enqueued.push({ job_id: job.id, windows: u.windows });
  }
  console.log("[pulse-doctor-voice] enqueued", JSON.stringify({ candidates: uids.length, enqueued: enqueued.length, n_blind_excluded }));
  return { enabled: true, candidates: uids.length, n_blind_excluded, enqueued };
}
