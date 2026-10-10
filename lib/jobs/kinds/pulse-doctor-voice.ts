/**
 * lib/jobs/kinds/pulse-doctor-voice.ts — `pulse_doctor_voice`: learn ONE Pulse doctor's room voiceprint.
 *
 * One step. Takes the newest Nemotron windows that Pulse labels as this doctor's alone
 * (lib/room-access/pulse-doctor-voice.ts doctorWindows), asks the Mini's /embed_speakers for one embedding per
 * Nemotron speaker in each (the identity pass's own plan, lib/diarize-nemotron/identity.ts embedPlan), finds the voice
 * that recurs across them (lib/voice-room-print/recurring.ts), and writes it as the next generation together with a
 * `built` run row, in one statement. A refusal or a failure writes only a run row and leaves the active print alone.
 *
 * Time: the step budget is MAX_STEP_MS (200 s) and one embed call may take up to EMBED_TIMEOUT_MS (120 s), so no new
 * call starts after STOP_STARTING_MS; the windows embedded by then are what the finder sees (counted).
 *
 * Held-out: the chooser leaves held-out windows out before its LIMIT, per window (as the rubric kinds do per unit),
 * so the kind-level guard has nothing to refuse for a doctor uid; it is declared so the registry stays uniform.
 *
 * Logs carry outcomes, codes and counts. Never an embedding, a uid, a name or a URL.
 */
import { getObjectBytes } from "@/lib/r2";
import { embedSpeakers } from "@/lib/diarize-embed";
import { DIARIZE_BATCH_THRESHOLD, loadClinicianCentroids } from "@/lib/stt/diarize-window";
import { decodeFloat32 } from "@/lib/stt/losing-score";
import { embedPlan, segmentsFromTurns, speechMsBySpeaker } from "@/lib/diarize-nemotron/identity";
import { nearestClinician, recurringVoice, AMBIGUITY_RATIO, MIN_DAYS, MIN_SPEECH_MS, MIN_SUPPORT, MIN_WINDOWS, SAME_VOICE, type Unit } from "@/lib/voice-room-print/recurring";
import { doctorWindows, recordDoctorVoiceRun, writeDoctorVoice } from "@/lib/room-access/pulse-doctor-voice";
import { perUnitHeldOut } from "@/lib/room-access/jobs";
import { customAlphabet } from "nanoid";
import { JobArgsError, doneWith, type JobKind, type StepContext, type StepOutcome } from "../types";

export const PULSE_DOCTOR_VOICE_KIND = "pulse_doctor_voice";
/** The embedding space the Mini's /embed_speakers returns (as voice_print). */
export const EMBEDDING_MODEL = "speechbrain/spkrec-ecapa-voxceleb";
/** How far back a doctor's windows are taken from. */
export const LOOKBACK_DAYS = 30;
/** Windows asked for per build; each is one /embed_speakers call. */
export const MAX_WINDOWS = 16;
/** No new embed call starts after this much of the step has gone. */
export const STOP_STARTING_MS = 60_000;

const UID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const nano = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

function parseArgs(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") throw new JobArgsError("args must be an object");
  const uid = (raw as Record<string, unknown>).pulse_doctor_uid;
  if (typeof uid !== "string" || !UID_RE.test(uid)) throw new JobArgsError("pulse_doctor_uid must be a Pulse doctor uid");
  return { pulse_doctor_uid: uid };
}

async function run(ctx: StepContext, now: () => number = Date.now): Promise<StepOutcome> {
  const uid = ctx.args.pulse_doctor_uid as string;
  const started = now();
  const { windows, n_blind_excluded } = await doctorWindows(uid, LOOKBACK_DAYS, MAX_WINDOWS);
  const counts = { windows_offered: windows.length, windows_embedded: 0, n_windows: 0, n_days: 0, runner_up_windows: 0, n_blind_excluded };

  if (windows.length < MIN_WINDOWS) {
    await recordDoctorVoiceRun({ uid, outcome: "refused", reason: "too_few_windows", ...counts });
    return doneWith({ outcome: "refused", reason: "too_few_windows", ...counts });
  }

  const centroids = await loadClinicianCentroids();
  const units: Unit[] = [];
  let failures = 0;
  for (const w of windows) {
    if (now() - started > STOP_STARTING_MS) break;
    const segs = segmentsFromTurns(w.turns_json);
    if (!segs || segs.length === 0 || !w.clip_r2_key) continue;
    const bytes = await getObjectBytes(w.clip_r2_key);
    if (!bytes) continue;
    const plan = embedPlan(segs);
    const emb = await embedSpeakers(bytes, plan.request, centroids, { batchThreshold: DIARIZE_BATCH_THRESHOLD, label: w.window_id });
    if (!emb.ok) { failures++; continue; }
    const speech = speechMsBySpeaker(segs);
    const speakers: Unit["speakers"][number][] = [];
    for (const s of emb.speakers) {
      const idx = plan.speakerOfRank.get(s.idx);
      const v = decodeFloat32(s.embedding_base64);
      if (idx === undefined || !v) continue;
      speakers.push({ label: `spk${idx}`, speech_ms: speech.get(idx) ?? 0, embedding: v });
    }
    units.push({ window_id: w.window_id, day: w.day, speakers });
  }
  counts.windows_embedded = units.length;

  // every embed call failed: the Mini is down, not the doctor unknowable. A failed run, retried by the next cron.
  if (units.length === 0 && failures > 0) {
    await recordDoctorVoiceRun({ uid, outcome: "failed", reason: "embed_failed", ...counts });
    console.warn("[pulse-doctor-voice] failed", JSON.stringify({ reason: "embed_failed", ...counts }));
    return doneWith({ outcome: "failed", reason: "embed_failed", ...counts });
  }

  const r = recurringVoice(units);
  counts.n_windows = r.n_windows;
  counts.n_days = r.n_days;
  counts.runner_up_windows = r.runner_up_windows;
  if (!r.ok) {
    await recordDoctorVoiceRun({ uid, outcome: "refused", reason: r.reason, ...counts });
    console.log("[pulse-doctor-voice] refused", JSON.stringify({ reason: r.reason, ...counts }));
    return doneWith({ outcome: "refused", reason: r.reason, ...counts });
  }

  const prints = centroids
    .map((c) => ({ clinician_id: c.clinician_id, v: decodeFloat32(c.centroid_base64) }))
    .filter((p): p is { clinician_id: string; v: Float32Array } => p.v !== null);
  const nearest = nearestClinician(r.centroid, prints);
  const written = await writeDoctorVoice({
    id: `pdv_${nano()}`,
    uid,
    actor: `job:${PULSE_DOCTOR_VOICE_KIND}`,
    embedding: Array.from(r.centroid, (x) => Math.fround(x)),
    embedding_model: EMBEDDING_MODEL,
    n_windows: r.n_windows,
    n_days: r.n_days,
    windows_offered: r.windows_offered,
    windows_embedded: counts.windows_embedded,
    support: r.support,
    runner_up_windows: r.runner_up_windows,
    nearest,
    n_blind_excluded,
    source: {
      members: r.members.map((m) => ({ window_id: m.window_id, label: m.label })),
      thresholds: { SAME_VOICE, MIN_SPEECH_MS, MIN_WINDOWS, MIN_DAYS, MIN_SUPPORT, AMBIGUITY_RATIO },
      lookback_days: LOOKBACK_DAYS,
    },
  });
  console.log("[pulse-doctor-voice] built", JSON.stringify({ generation: written.generation, retired: written.retired, ...counts, nearest_score: nearest?.score ?? null }));
  return doneWith({ outcome: "built", voice_id: written.id, generation: written.generation, ...counts, nearest_clinician_id: nearest?.clinician_id ?? null, nearest_score: nearest?.score ?? null });
}

export const pulseDoctorVoiceKind: JobKind = {
  name: PULSE_DOCTOR_VOICE_KIND,
  roomData: true,
  // per window, inside the chooser (blindWindowIds before the LIMIT, counted); a doctor uid has no placement
  heldOut: perUnitHeldOut,
  first: "build",
  scope: "invoke",
  parseArgs,
  run: (ctx) => run(ctx),
  dedupeOn: (args) => [["pulse_doctor_uid", String(args.pulse_doctor_uid)]],
};

/** Exposed for the tests: the step with an injectable clock. */
export const runWithClock = run;
