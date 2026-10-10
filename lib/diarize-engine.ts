import { parseFlag } from "@/lib/flags";

/**
 * lib/diarize-engine.ts — WHICH diarizer runs, as one strict parser.
 *
 * NEMOTRON IS THE ROOM DIARIZE ENGINE (V, 10 Oct 2026: pyannote is gone from production). Room windows
 * are diarized by the GPU-box Nemotron worker, which posts turns to /api/diarize/nemotron/ingest; the
 * ingest then submits a `diarize_window` job that embeds the speakers, matches enrolled voiceprints and
 * writes the room tables (lib/jobs/kinds/diarize-window.ts).
 *
 *   unset | "" | "nemotron"   -> nemotron      (the default: it no longer means local pyannote)
 *   "local" | "pyannoteai"    -> known, but REFUSED by the room job (`pushEngine` throws; 0 calls)
 *   anything else             -> THROWS DiarizeEngineError
 *
 * THE THROW IS THE POINT. A typo must never read as a default: an operator who believes they have
 * switched, and has not, is comparing clinical output from the engine they did not choose.
 * Same shape and rules as `parseFlag` in lib/flags.ts (trimmed, case-insensitive, unset = default).
 */

/** The env var that chooses the engine. */
export const DIARIZE_ENGINE_ENV = "DIARIZE_ENGINE";

/**
 * Every engine this system KNOWS, so the label CHECK (0117/0140), the read path and the env share one
 * vocabulary and history written by `local` / `pyannoteai` stays legible. Only `nemotron` runs.
 */
export const DIARIZE_ENGINES = ["local", "pyannoteai", "nemotron"] as const;
export type DiarizeEngine = (typeof DIARIZE_ENGINES)[number];

/** What an unset or empty `DIARIZE_ENGINE` means. NOT local pyannote any more. */
export const DIARIZE_ENGINE_DEFAULT: DiarizeEngine = "nemotron";

/** Thrown for a value in neither set, or for an engine the room job refuses. Never reads as a default. */
export class DiarizeEngineError extends Error {}

export function diarizeEngine(env: Record<string, string | undefined> = process.env): DiarizeEngine {
  const raw = env[DIARIZE_ENGINE_ENV];
  if (raw === undefined) return DIARIZE_ENGINE_DEFAULT;
  const v = raw.trim().toLowerCase();
  if (v === "") return DIARIZE_ENGINE_DEFAULT;
  if ((DIARIZE_ENGINES as readonly string[]).includes(v)) return v as DiarizeEngine;
  // Length only: an env value is not something to echo into a response or a log line.
  throw new DiarizeEngineError(
    `${DIARIZE_ENGINE_ENV} has an unrecognised value (length ${raw.length}) — use ${DIARIZE_ENGINE_DEFAULT}, ` +
      `or leave it unset for ${DIARIZE_ENGINE_DEFAULT}. Refusing to guess.`,
  );
}

/** The engines the room `diarize_window` job can run. */
export const PUSH_ENGINES = ["nemotron"] as const;
export type PushEngine = (typeof PUSH_ENGINES)[number];

/**
 * The engine the room `diarize_window` job runs, or a THROW. `local` and `pyannoteai` are refused by
 * name BEFORE the job touches a clip, the Mini or pyannote.ai: the refusal makes no external call.
 */
export function pushEngine(env: Record<string, string | undefined> = process.env): PushEngine {
  const e = diarizeEngine(env);
  if ((PUSH_ENGINES as readonly string[]).includes(e)) return e as PushEngine;
  throw new DiarizeEngineError(
    `${DIARIZE_ENGINE_ENV}=${e} is refused for room diarization (pyannote is retired from production) — ` +
      `the diarize_window job runs ${PUSH_ENGINES.join("|")} only. Refusing to fall through to another engine.`,
  );
}

/**
 * `DIARIZE_NEMOTRON_SHADOW` — whether Nemotron work is OFFERED to the worker and its turns STORED.
 *
 * Off (the shipped state): the three /api/diarize/nemotron routes answer 404 `disabled` and touch no
 * table. Strict parse: a typo throws. It gates the Nemotron routes, whose ingest now drives the
 * room `diarize_window` job (nemotron is the only room engine).
 */
export const DIARIZE_NEMOTRON_SHADOW_ENV = "DIARIZE_NEMOTRON_SHADOW";

export function nemotronShadowEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseFlag(DIARIZE_NEMOTRON_SHADOW_ENV, env);
}

/** True when a value names an engine this build knows. Pure; used by tests and by arg validation. */
export function isDiarizeEngine(v: unknown): v is DiarizeEngine {
  return typeof v === "string" && (DIARIZE_ENGINES as readonly string[]).includes(v);
}

/**
 * `DIARIZE_TEACHER_LABELS` — whether each engine's raw turns are stored as training labels.
 *
 * SEPARATE FROM `DIARIZE_ENGINE` ON PURPOSE (Fable's ruling, 23 Sep). One chooses what production
 * consumes; this one chooses whether we keep a record of what each diarizer said. They move
 * independently: labelling can be turned off while the hybrid keeps running, and — the case that
 * matters — labelling can be turned off INSTANTLY without touching the engine that clinicians'
 * notes depend on, which is what a permission being withdrawn would require.
 *
 * Same strict rule as every other flag in this system: unrecognised values throw rather than
 * reading as off, because a label store that silently stopped collecting would look exactly like
 * one that was working.
 */
export const DIARIZE_TEACHER_LABELS_ENV = "DIARIZE_TEACHER_LABELS";

export function teacherLabelsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseFlag(DIARIZE_TEACHER_LABELS_ENV, env);
}
