/**
 * lib/diarize-engine.ts — WHICH diarizer runs, as one strict parser.
 *
 * Room diarization has two engines from 23 Sep 2026: the Mac Mini's local pyannote service (the
 * only one there has ever been) and hosted pyannote.ai precision-3. `DIARIZE_ENGINE` chooses.
 *
 *   unset | "" | "local"   -> local          (today's behaviour, byte-identical)
 *   "pyannoteai"           -> pyannote.ai precision-3
 *   anything else          -> THROWS DiarizeEngineError
 *
 * THE THROW IS THE POINT, and it is the half that is easy to leave untested. A typo
 * (`DIARIZE_ENGINE=pyannote`, `pyannote-ai`, `pyannoteAI ` with a stray character) must never read
 * as "local": an operator who believes they have switched, and has not, is comparing clinical
 * output from the engine they did not choose and cannot tell. Silence is the expensive failure
 * here, so an unrecognised value stops the job rather than quietly picking a side.
 *
 * Same shape and same rules as `parseFlag` in lib/flags.ts — trimmed, case-insensitive, unset is
 * the default — because a second parser with its own idea of what a value means is how two
 * switches come to disagree. This one is not a boolean, which is the only reason it is not
 * parseFlag itself.
 */

/** The env var that chooses the engine. */
export const DIARIZE_ENGINE_ENV = "DIARIZE_ENGINE";

/** Every engine this system can run. The order is not meaningful. */
export const DIARIZE_ENGINES = ["local", "pyannoteai"] as const;
export type DiarizeEngine = (typeof DIARIZE_ENGINES)[number];

/** What an unset or empty `DIARIZE_ENGINE` means: exactly what production did before the switch. */
export const DIARIZE_ENGINE_DEFAULT: DiarizeEngine = "local";

/** Thrown for a value in neither set. Callers surface it as a failure; it never reads as "local". */
export class DiarizeEngineError extends Error {}

/**
 * Read the engine from the environment.
 *
 * Takes the env map so a test never has to mutate `process.env`, and so a caller that already
 * holds a settled engine (a job step polling a submission it made under the previous value) can
 * pass its own record instead — see `lib/jobs/kinds/diarize-window.ts`, where the poll step reads
 * the engine from the job's progress and NOT from here. A paid submission is finished on the
 * engine that made it.
 */
export function diarizeEngine(env: Record<string, string | undefined> = process.env): DiarizeEngine {
  const raw = env[DIARIZE_ENGINE_ENV];
  if (raw === undefined) return DIARIZE_ENGINE_DEFAULT;
  const v = raw.trim().toLowerCase();
  if (v === "") return DIARIZE_ENGINE_DEFAULT;
  if ((DIARIZE_ENGINES as readonly string[]).includes(v)) return v as DiarizeEngine;
  // Length only: an env value is not something to echo into a response or a log line.
  throw new DiarizeEngineError(
    `${DIARIZE_ENGINE_ENV} has an unrecognised value (length ${raw.length}) — use one of ` +
      `${DIARIZE_ENGINES.join("|")}, or leave it unset for ${DIARIZE_ENGINE_DEFAULT}. Refusing to guess.`,
  );
}

/** True when a value names an engine this build knows. Pure; used by tests and by arg validation. */
export function isDiarizeEngine(v: unknown): v is DiarizeEngine {
  return typeof v === "string" && (DIARIZE_ENGINES as readonly string[]).includes(v);
}
