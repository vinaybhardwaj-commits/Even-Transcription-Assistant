/**
 * lib/jev/registry.ts — J-CORE-1: the question registry, keyed by (question_id, prompt_version).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  _clearJevRegistryForTests,
  getJevQuestion,
  isJevQuestionRegistered,
  JevQuestionAlreadyRegisteredError,
  JevQuestionNotFoundError,
  listRegisteredJevQuestions,
  registerJevQuestion,
} from "@/lib/jev/registry";
import type { JevNoulQ } from "@/lib/jev/types";

beforeEach(() => {
  _clearJevRegistryForTests();
});

describe("registerJevQuestion / getJevQuestion — the roundtrip", () => {
  it("registers a builder and resolves it by the exact (question_id, prompt_version) pair", () => {
    const build = (windowId: string): JevNoulQ => ({ type: "noul", instructions: `is it ${windowId}?` });
    registerJevQuestion("q1", "v1", build);
    const resolved = getJevQuestion("q1", "v1");
    expect(resolved("w1")).toEqual({ type: "noul", instructions: "is it w1?" });
  });

  it("the same question_id under a DIFFERENT prompt_version is a separate registration", () => {
    registerJevQuestion("q1", "v1", (): JevNoulQ => ({ type: "noul", instructions: "v1 wording" }));
    registerJevQuestion("q1", "v2", (): JevNoulQ => ({ type: "noul", instructions: "v2 wording" }));
    expect(getJevQuestion("q1", "v1")().instructions).toBe("v1 wording");
    expect(getJevQuestion("q1", "v2")().instructions).toBe("v2 wording");
  });

  it("a duplicate (question_id, prompt_version) registration throws rather than silently overwriting", () => {
    registerJevQuestion("q1", "v1", (): JevNoulQ => ({ type: "noul", instructions: "first" }));
    expect(() => registerJevQuestion("q1", "v1", (): JevNoulQ => ({ type: "noul", instructions: "second" }))).toThrow(
      JevQuestionAlreadyRegisteredError,
    );
    // the FIRST registration survives — a throw on the second call must not have replaced it.
    expect(getJevQuestion("q1", "v1")().instructions).toBe("first");
  });

  it("an unregistered (question_id, prompt_version) throws JevQuestionNotFoundError, never returns undefined", () => {
    expect(() => getJevQuestion("nope", "v1")).toThrow(JevQuestionNotFoundError);
  });

  it("isJevQuestionRegistered reflects registration state without throwing", () => {
    expect(isJevQuestionRegistered("q1", "v1")).toBe(false);
    registerJevQuestion("q1", "v1", (): JevNoulQ => ({ type: "noul", instructions: "x" }));
    expect(isJevQuestionRegistered("q1", "v1")).toBe(true);
    expect(isJevQuestionRegistered("q1", "v2")).toBe(false);
  });

  it("listRegisteredJevQuestions reports every (question_id, prompt_version) pair registered", () => {
    registerJevQuestion("q1", "v1", (): JevNoulQ => ({ type: "noul", instructions: "x" }));
    registerJevQuestion("q2", "v1", (): JevNoulQ => ({ type: "noul", instructions: "y" }));
    const list = listRegisteredJevQuestions();
    expect(list).toHaveLength(2);
    expect(list).toEqual(
      expect.arrayContaining([
        { question_id: "q1", prompt_version: "v1" },
        { question_id: "q2", prompt_version: "v1" },
      ]),
    );
  });

  it("_clearJevRegistryForTests empties the registry", () => {
    registerJevQuestion("q1", "v1", (): JevNoulQ => ({ type: "noul", instructions: "x" }));
    _clearJevRegistryForTests();
    expect(listRegisteredJevQuestions()).toHaveLength(0);
    expect(() => getJevQuestion("q1", "v1")).toThrow(JevQuestionNotFoundError);
  });
});
