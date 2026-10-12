/**
 * lib/encounter-clock/timeline-cache.ts — pin the timeline Jev call without a temperature field.
 *
 * typesafe's systemOne returns 400 if the body contains `temperature`. The pin is the model version,
 * the question-set hash and an answer cache keyed by those plus the canonical state. The same state
 * is not sent twice in one run, and a stored row with the same key is a hit on a later run.
 */
import { hashOf } from "@/lib/jev/worker/canonical";
import { U10_PROMPT_VERSION, u10EndSignalQuestion, u10KindQuestion, u10LateStartQuestion } from "@/lib/jev/prompts/timeline-v1";

/** main's client default (lib/jev/client.ts). The leave lane passes this explicitly and does not read ETA_JEV_MODEL. */
export const TIMELINE_MODEL_PIN = "jev-1.13.0";

export type CachedReading = {
  end_row: string | null;
  end_signal: string | null;
  end_conf: number | null;
  late_start_p: number | null;
  kind: string | null;
  kind_conf: number | null;
};

/** PURE — hash of the fixed U10 wording plus the model pin. The per-call end-row menu is not part of it. */
export function timelineQuestionSetSha(): string {
  return hashOf({
    model: TIMELINE_MODEL_PIN,
    prompt_version: U10_PROMPT_VERSION,
    end_signal: u10EndSignalQuestion(),
    kind: u10KindQuestion(),
    late_start: u10LateStartQuestion(),
  });
}

/** PURE — cache key. State is canonicalised, so key order in the timeline JSON does not matter. */
export function answerCacheKey(model: string, setSha: string, state: unknown): string {
  return hashOf({ model, set_sha: setSha, state });
}

export type AnswerCache = {
  get(key: string): CachedReading | null;
  set(key: string, value: CachedReading): void;
};

export function memoryCache(): AnswerCache {
  const m = new Map<string, CachedReading>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); } };
}

/**
 * The body the HTTP client is allowed to send. `temperature` is absent on purpose.
 * Kept in step with the JSON.stringify in lib/jev/client.ts — a test reads that file.
 */
export function timelineWireBody(model: string, state: unknown, questions: Record<string, unknown>): { model: string; state: unknown; questions: Record<string, unknown> } {
  return { model, state, questions };
}

/** PURE — the client source sends model, state and questions, and does not mention temperature in that body. */
export function clientBodyOmitsTemperature(source: string): boolean {
  const m = source.match(/JSON\.stringify\(\{[^}]+\}\)/);
  return !!m && !m[0].includes("temperature") && m[0].includes("model") && m[0].includes("questions");
}
