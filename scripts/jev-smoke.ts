/**
 * scripts/jev-smoke.ts — Jev P0.5: an operator-run smoke test of the REAL Jev endpoint with SYNTHETIC, non-PHI text.
 *
 * Sends one invented sentence through askJev(..., { persist: false }) — nothing is written to jev_decision — and prints
 * NUMBERS ONLY (model returned, latency, tokens, answered or not). Needs the real key, on a preview or local env:
 *
 *   ETA_JEV_ENABLED=1 TYPESAFE_API_KEY=... [ETA_JEV_MODEL=jev-1.13.0] npx tsx scripts/jev-smoke.ts
 *
 * Exit 0 only when the call answered, the returned model is jev-1.13.0, latency < 1 s and tokens > 0.
 * Refuses to run against the mock (ETA_JEV_MOCK) or without a key: a smoke test that passes on a stand-in proves nothing.
 */
import { askJev } from "../lib/jev/ask";
import { registerEncounterQuestions, U6_PROMPT_VERSION, U6_QUESTION_ID } from "../lib/jev/prompts/encounter-v1";

const EXPECTED_MODEL = "jev-1.13.0";
const MAX_LATENCY_MS = 1000;
// Invented dialogue. Not a real transcript, patient, doctor or place.
const SYNTHETIC_STATE = { text: "The visitor asked where the cafeteria is, and the guide said it is on the second floor." };

async function main(): Promise<number> {
  if (process.env.ETA_JEV_MOCK) { console.error("smoke: refusing — ETA_JEV_MOCK is set"); return 2; }
  if (!process.env.TYPESAFE_API_KEY) { console.error("smoke: refusing — config_missing_key"); return 2; }
  registerEncounterQuestions();
  const t0 = Date.now();
  const out = await askJev(SYNTHETIC_STATE, [{ answerKey: "k1", subjectType: "window", subjectId: "smoke", questionId: U6_QUESTION_ID, promptVersion: U6_PROMPT_VERSION }], { persist: false });
  const wall = Date.now() - t0;
  const answered = Boolean(out.results.k1);
  const tokens = out.usage.input_tokens + out.usage.output_tokens;
  console.log(JSON.stringify({ ok: answered, model_returned: out.model, latency_ms: out.latencyMs, wall_ms: wall, tokens }));
  return answered && out.model === EXPECTED_MODEL && out.latencyMs < MAX_LATENCY_MS && tokens > 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => { console.error(`smoke: failed (${(e as Error)?.name ?? "error"})`); process.exit(1); });
