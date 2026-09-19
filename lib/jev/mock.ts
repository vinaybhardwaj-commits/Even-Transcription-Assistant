/**
 * lib/jev/mock.ts — Slice J1 (ETA-JEV-ARM-D §4). Deterministic mock, used by every unit test and
 * whenever ETA_JEV_MOCK is on. Answers come from a fixture map keyed by question id when the
 * caller supplies one (tests/fixtures/jev/*), and fall back to a fixed, deterministic default per
 * question type otherwise — so a caller that forgets to seed a fixture gets a stable, inspectable
 * answer rather than a crash or randomness.
 */
import type { JevAnswer, JevClient, JevQuestion, JevRequest, JevResult } from "./types";

export type JevFixtureAnswers = Record<string, JevAnswer>;

let fixture: JevFixtureAnswers = {};

/** Test/job-fixture seam: set the answers the mock returns by question id. */
export function setMockJevAnswers(answers: JevFixtureAnswers): void {
  fixture = answers;
}

export function clearMockJevAnswers(): void {
  fixture = {};
}

function defaultAnswerFor(q: JevQuestion): JevAnswer {
  if (q.type === "noul") return { type: "noul", noul: 0 };
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria);
    const first = keys[0] ?? "other";
    const probabilities: Record<string, number> = {};
    for (const k of keys) probabilities[k] = k === first ? 1 : 0;
    return { type: "choice", choice: first, probabilities, confidence: 0.5 };
  }
  const levels = q.criteria;
  const mid = levels[Math.floor(levels.length / 2)] ?? levels[0] ?? "";
  const probabilities: Record<string, number> = {};
  const legend: Record<string, string> = {};
  levels.forEach((l, i) => {
    probabilities[String(i + 1)] = l === mid ? 1 : 0;
    legend[String(i + 1)] = l;
  });
  return { type: "score", score: Math.floor(levels.length / 2) + 1, probabilities, legend, confidence: 0.5 };
}

function estimateTokens(state: unknown, questions: Record<string, JevQuestion>): number {
  const chars = JSON.stringify(state ?? null).length + JSON.stringify(questions).length;
  return Math.max(1, Math.round(chars / 4));
}

export function getMockJevClient(): JevClient {
  return {
    async systemOne(req: JevRequest): Promise<JevResult> {
      const answers: Record<string, JevAnswer> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        answers[id] = fixture[id] ?? defaultAnswerFor(q);
      }
      const input_tokens = estimateTokens(req.state, req.questions);
      return {
        model: req.model ?? "jev-mock",
        answers,
        usage: { input_tokens, output_tokens: Object.keys(req.questions).length * 8 },
        latency_ms: 1,
      };
    },
  };
}
