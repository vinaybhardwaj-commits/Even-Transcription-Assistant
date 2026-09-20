/**
 * lib/jev/mock.ts — Slice J1. A deterministic Jev client for unit tests and for ETA_JEV_MOCK=1.
 *
 * It NEVER touches the network or the even-jev MCP, so J1–J3 can be built and tested with D1b still
 * closed (no real transcript ever reaches the vendor). Answers come from a fixture map keyed by
 * question id; a question with no fixture gets a stable, absence-safe default for its type, so a test
 * that forgets a fixture fails loudly on the value rather than flapping.
 */
import type { JevAnswer, JevClient, JevRequest, JevResult } from "./types";

/** A stable default answer per primitive when no fixture is supplied. Absence-safe: noul=0 (not
 * "yes"), choice/score pick the FIRST declared option so the shape is valid and predictable. */
function defaultAnswer(id: string, q: JevRequest["questions"][string]): JevAnswer {
  if (q.type === "noul") return { type: "noul", noul: 0 };
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria);
    const first = keys[0] ?? "other";
    const probabilities: Record<string, number> = {};
    for (const k of keys) probabilities[k] = k === first ? 1 : 0;
    return { type: "choice", choice: first, probabilities, confidence: 1 };
  }
  // score: lowest level, index 0
  const legend: Record<string, string> = {};
  q.criteria.forEach((c, i) => { legend[String(i)] = c; });
  const probabilities: Record<string, number> = {};
  q.criteria.forEach((_c, i) => { probabilities[String(i)] = i === 0 ? 1 : 0; });
  return { type: "score", score: 0, probabilities, legend, confidence: 1 };
}

export class MockJevClient implements JevClient {
  private readonly fixtures: Record<string, JevAnswer>;
  constructor(fixtures: Record<string, JevAnswer> = {}) {
    this.fixtures = fixtures;
  }

  async systemOne(req: JevRequest): Promise<JevResult> {
    const answers: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      answers[id] = this.fixtures[id] ?? defaultAnswer(id, q);
    }
    // Deterministic, cheap usage so cost math in tests is stable and never zero for real input.
    const stateChars = JSON.stringify(req.state ?? null).length;
    const input_tokens = Math.ceil(stateChars / 4) + Object.keys(req.questions).length;
    return {
      model: req.model ?? "jev-mock",
      answers,
      usage: { input_tokens, output_tokens: 0 },
      latency_ms: 0,
    };
  }
}

// ── Module-level fixture surface, for the job kinds' own suites ─────────────────────────────────
//
// jev-window and jev-role drive the mock through `getJevClient()`, so they cannot pass fixtures to a
// constructor: they set them on the module before the job runs. This is that surface. Its default
// answers AND its token estimate are kept byte-identical to the implementation those suites were
// written against — F6(b) asserts per-window `input_tokens` apportioned from the batch total, so a
// different estimator here would silently change what those tests measure.

export type JevFixtureAnswers = Record<string, JevAnswer>;

let fixture: JevFixtureAnswers = {};

export function setMockJevAnswers(answers: JevFixtureAnswers): void {
  fixture = { ...answers };
}

export function clearMockJevAnswers(): void {
  fixture = {};
}

function defaultAnswerFor(q: JevRequest["questions"][string]): JevAnswer {
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

function estimateTokens(state: unknown, questions: Record<string, JevRequest["questions"][string]>): number {
  const chars = JSON.stringify(state ?? null).length + JSON.stringify(questions).length;
  return Math.max(1, Math.round(chars / 4));
}

/** The client `getJevClient()` returns under ETA_JEV_MOCK, reading the fixtures set above. */
export function getMockJevClient(): JevClient {
  return {
    async systemOne(req: JevRequest): Promise<JevResult> {
      const answers: Record<string, JevAnswer> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        answers[id] = fixture[id] ?? defaultAnswerFor(q);
      }
      return {
        model: req.model ?? "jev-mock",
        answers,
        usage: { input_tokens: estimateTokens(req.state, req.questions), output_tokens: Object.keys(req.questions).length * 8 },
        latency_ms: 1,
      };
    },
  };
}
