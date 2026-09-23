/**
 * lib/jev/registry.ts — J-CORE-1: the question registry, keyed by (question_id, prompt_version).
 *
 * "No caller builds its own request" (PLAN-v3.md §2): a use REGISTERS its question once, then
 * every ask (lib/jev/ask.ts) resolves it by id + version rather than constructing a JevQuestion
 * inline. This is also what makes prompt_version a real, checkable fact rather than a string a
 * caller remembers to pass consistently — jev_decision's own prompt_version column is only ever
 * as honest as the wiring that fills it, and resolving through this registry means the version
 * stored is the version of the wording that was ACTUALLY sent, not a caller's separate claim.
 *
 * Registration is a MODULE-LOAD side effect (each use's own prompt file calls registerJevQuestion
 * at import time), never per-request — this file holds only the lookup, not any question content
 * of its own. Existing per-use prompt modules (lib/jev/prompts/arm-d-v1.ts, role-v1.ts) are NOT
 * registered here — they predate this layer and are wired to their own callers directly; moving
 * them onto this registry is separate work for whoever migrates that caller, flagged in the
 * build report rather than done silently as part of building the registry itself.
 */
import type { JevQuestion } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JevQuestionBuilder<A extends unknown[] = any[]> = (...args: A) => JevQuestion;

export class JevQuestionAlreadyRegisteredError extends Error {
  constructor(questionId: string, promptVersion: string) {
    super(`jev question already registered: ${questionId}@${promptVersion}`);
  }
}

export class JevQuestionNotFoundError extends Error {
  constructor(questionId: string, promptVersion: string) {
    super(`no jev question registered for ${questionId}@${promptVersion}`);
  }
}

function registryKey(questionId: string, promptVersion: string): string {
  return `${questionId}@${promptVersion}`;
}

const registry = new Map<string, JevQuestionBuilder>();

/**
 * Registers ONE (question_id, prompt_version) pair. Throws on a duplicate registration rather
 * than silently overwriting — two modules registering the same id+version by accident is exactly
 * the kind of drift prompt_version exists to make impossible, and a thrown error at module-load
 * time surfaces it immediately rather than as a mismatched answer discovered later.
 */
export function registerJevQuestion<A extends unknown[]>(questionId: string, promptVersion: string, build: JevQuestionBuilder<A>): void {
  const key = registryKey(questionId, promptVersion);
  if (registry.has(key)) throw new JevQuestionAlreadyRegisteredError(questionId, promptVersion);
  registry.set(key, build as JevQuestionBuilder);
}

/** Resolves a registered question builder. Throws (never returns undefined / a default question)
 * so a caller who typos a question_id or forgets to import the registering module fails loudly at
 * the ask, not with a silently wrong question sent to Jev. */
export function getJevQuestion(questionId: string, promptVersion: string): JevQuestionBuilder {
  const key = registryKey(questionId, promptVersion);
  const found = registry.get(key);
  if (!found) throw new JevQuestionNotFoundError(questionId, promptVersion);
  return found;
}

export function isJevQuestionRegistered(questionId: string, promptVersion: string): boolean {
  return registry.has(registryKey(questionId, promptVersion));
}

export function listRegisteredJevQuestions(): Array<{ question_id: string; prompt_version: string }> {
  return [...registry.keys()].map((key) => {
    const at = key.lastIndexOf("@");
    return { question_id: key.slice(0, at), prompt_version: key.slice(at + 1) };
  });
}

/** Test-only: registrations are module-load side effects with no natural teardown; a test that
 * registers its own fixture questions needs a way back to empty between cases. */
export function _clearJevRegistryForTests(): void {
  registry.clear();
}
