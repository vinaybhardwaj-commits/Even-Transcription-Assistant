import { parseFlag } from "@/lib/flags";

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

/**
 * `DIARIZE_LOCAL_LABEL` — whether the hybrid's LOCAL COMPARISON run (the `local_label` step) happens.
 *
 * WHY IT EXISTS (Fable, 24 Sep 01:55). The comparison run holds the Mini's diarizer for a whole window
 * per job, and on the night of 23→24 Sep every running diarize job sat in that step while ~90 windows
 * waited for their CLINICAL diarization. This flag turns the comparison off WITHOUT turning off
 * pyannote.ai's teacher labels, which are written in the poll step and are what diar-lab trains on.
 *
 * UNSET = WHATEVER `DIARIZE_TEACHER_LABELS` SAYS, so shipping this flag changes nothing until someone sets
 * it. SET = the strict parse every flag gets (a typo throws), AND teacher labels must also be on: with
 * them off the comparison run's only output, its label, would be discarded, so running it would spend
 * the Mini for nothing.
 */
export const DIARIZE_LOCAL_LABEL_ENV = "DIARIZE_LOCAL_LABEL";

export function localLabelEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env[DIARIZE_LOCAL_LABEL_ENV] === undefined) return teacherLabelsEnabled(env);
  return parseFlag(DIARIZE_LOCAL_LABEL_ENV, env) && teacherLabelsEnabled(env);
}
