/**
 * lib/jobs/kinds/stubs.ts — the five kinds Slices C and D fill in.
 *
 * REGISTERED, NOT ABSENT, and the difference matters to a caller. An unregistered kind is refused at
 * submit as "unknown kind", which reads as a typo; these are accepted, queued and then failed with
 * `not_implemented`, which reads as "this exists and is not ready yet" — and leaves a job row with
 * the args, so the work is recorded and can simply be re-run once the body lands.
 *
 * They carry their REAL scope and a real `parseArgs` from the day they are registered, so Slice C/D
 * replaces one function body and changes nothing a caller can see about how a job is submitted.
 */

import { JobArgsError, failWith, type JobKind } from "../types";
import { jobError } from "../errors";

const requireString = (o: Record<string, unknown>, key: string): string => {
  const v = typeof o[key] === "string" ? (o[key] as string).trim() : "";
  if (!v) throw new JobArgsError(`${key} is required`);
  return v;
};

const stub = (name: string, scope: JobKind["scope"], parseArgs: JobKind["parseArgs"]): JobKind => ({
  name,
  first: "start",
  scope,
  parseArgs,
  run: async () => failWith(jobError("not_implemented", `${name} lands in a later Tier 2 slice`)),
});

export const STUB_KINDS: JobKind[] = [
  // §4.4 — ffmpeg astats / silencedetect / ebur128 over a clip.
  stub("audio_measure", "invoke", (raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return { clip_key: requireString(o, "clip_key") };
  }),
  // §5.4 — the Mini's emotion tunnel, serialised at ≤ 110 s a piece.
  stub("emotion_clip", "invoke", (raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return { clip_key: requireString(o, "clip_key"), ...(o.model === "emotion2vec" ? { model: "emotion2vec" } : {}) };
  }),
  // §5.3 — pyannote on a clip; embeddings stored, never inlined.
  stub("diarize_clip", "invoke", (raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return { clip_key: requireString(o, "clip_key") };
  }),
  // §4.6 — N engines on one clip, N transcription_run rows.
  stub("stt_fanout", "invoke", (raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const engines = Array.isArray(o.engines) ? o.engines.filter((e): e is string => typeof e === "string") : [];
    if (!engines.length) throw new JobArgsError("engines[] is required");
    return { clip_key: requireString(o, "clip_key"), engines };
  }),
  // §4.1 — every chunk of a room-day, presigned. Read scope: it creates nothing.
  stub("day_manifest", "read", (raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return { room: requireString(o, "room"), ist_date: requireString(o, "ist_date") };
  }),
];
