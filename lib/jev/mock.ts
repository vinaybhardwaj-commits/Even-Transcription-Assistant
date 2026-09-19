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
