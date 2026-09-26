/**
 * lib/jev/client.ts — Slice J1 (ETA-JEV-ARM-D §4). The Jev provider client.
 *
 * RAW FETCH, no SDK (spec §4, §9 forbids adding `@typesafe-ai/sdk`). Follows the repo's existing
 * fetch+abort pattern (lib/llm/gemini.ts, lib/sarvam.ts): AbortController + setTimeout + an
 * optional caller signal.
 *
 * ETA_JEV_ENABLED unset → JevDisabledError THROWN BEFORE any network call — proved by test
 * (jev-client.test.ts "disabled").  ETA_JEV_MOCK on → getJevClient() returns the mock so no
 * caller anywhere needs its own branch.
 *
 * Every call opens an llm-trace with surface:"jev" carrying only question ids and the state's
 * byte size — NEVER the state text (spec §4, INTEGRATION §7 "log metadata only").
 *
 * REFUTER F5 (19 Sep): the trace is now finalised with status:"errored" on EVERY exit path that
 * isn't a clean success — retry exhaustion (429/529 x3), a timed-out attempt, an aborted attempt
 * (caller signal), and any other thrown fetch error — not only the explicit 401/422 branch. A
 * `finalised` flag makes this idempotent so an outer catch never double-finalises a trace an
 * inner branch already closed.
 */
import { parseFlag, FlagValueError } from "@/lib/flags";
import { openTrace } from "@/lib/llm-trace/log";
import { getMockJevClient } from "./mock";
import { safeJevErrorMessage } from "./safe-error";
import { JevBadResponseError, JevDisabledError, JevHttpError, JevStateTooLargeError, type JevClient, type JevRequest, type JevResult } from "./types";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const STATE_CHAR_GUARD = 100_000; // ~25k tokens (spec §4)
const MAX_ATTEMPTS = 3;

function flagOn(name: string): boolean {
  try {
    return parseFlag(name);
  } catch (e) {
    if (e instanceof FlagValueError) throw e;
    throw e;
  }
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Exponential backoff with jitter for 429/529 only. Never retried: 401, 422. */
function backoffMs(attempt: number): number {
  const base = 250 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 100);
}

type FetchFn = typeof fetch;

/** The real client. `deps.fetchImpl` is the seam every test replaces; production never sets it. */
export function createHttpJevClient(deps: { fetchImpl?: FetchFn } = {}): JevClient {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async systemOne(req: JevRequest, opts): Promise<JevResult> {
      if (!flagOn("ETA_JEV_ENABLED")) throw new JevDisabledError();

      const stateStr = JSON.stringify(req.state ?? null);
      if (stateStr.length > STATE_CHAR_GUARD) throw new JevStateTooLargeError(stateStr.length);

      const model = req.model ?? process.env.ETA_JEV_MODEL ?? "jev-latest";
      const timeoutMs = envInt("ETA_JEV_TIMEOUT_MS", 15_000);
      const apiKey = process.env.TYPESAFE_API_KEY ?? "";

      const trace =
        opts?.trace ??
        (await openTrace({
          surface: "jev",
          request_input: { question_ids: Object.keys(req.questions), state_bytes: stateStr.length, model },
        }));

      // F5: exactly one finalise call per invocation, on whichever exit path is actually taken.
      let finalised = false;
      const finaliseError = async (reason: string): Promise<void> => {
        if (finalised) return;
        finalised = true;
        await trace.finalise({ status: "errored", error_message: reason });
      };

      let attempt = 0;
      let lastErr: unknown;
      try {
        while (attempt < MAX_ATTEMPTS) {
          attempt += 1;
          const controller = new AbortController();
          let timedOut = false;
          const tid = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);
          if (opts?.signal) {
            if (opts.signal.aborted) controller.abort();
            else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
          }
          const t0 = Date.now();
          try {
            const res = await fetchImpl(ENDPOINT, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
              body: JSON.stringify({ model, state: req.state, questions: req.questions }),
              signal: controller.signal,
            });
            const latency_ms = Date.now() - t0;
            if (res.status === 429 || res.status === 529) {
              lastErr = new JevHttpError(res.status, await res.text().catch(() => ""));
              if (attempt < MAX_ATTEMPTS) {
                await sleep(backoffMs(attempt));
                continue;
              }
              await finaliseError(`jev_http_${res.status}_retries_exhausted`);
              throw lastErr;
            }
            if (!res.ok) {
              // 401/422 and anything else not retried.
              const body = await res.text().catch(() => "");
              const err = new JevHttpError(res.status, body);
              await finaliseError(`jev_http_${res.status}`);
              throw err;
            }
            const json = (await res.json().catch(() => {
              throw new JevBadResponseError();
            })) as {
              model?: string;
              answers?: JevResult["answers"];
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            const result: JevResult = {
              model: json.model ?? model,
              answers: json.answers ?? {},
              usage: { input_tokens: json.usage?.input_tokens ?? 0, output_tokens: json.usage?.output_tokens ?? 0 },
              latency_ms,
            };
            finalised = true;
            await trace.finalise({
              status: "completed",
              model_calls: [{ model: result.model, latency_ms, tokens_in: result.usage.input_tokens, tokens_out: result.usage.output_tokens }],
            });
            return result;
          } catch (e) {
            if (e instanceof JevHttpError) throw e; // already finalised above
            const isAbort = e instanceof Error && e.name === "AbortError";
            if (isAbort) {
              await finaliseError(timedOut ? "jev_timeout" : "jev_aborted");
            } else {
              await finaliseError(`jev_fetch_error: ${safeJevErrorMessage(e).replace(/^jev_error: /, "")}`);
            }
            throw e;
          } finally {
            clearTimeout(tid);
          }
        }
        await finaliseError("jev_retries_exhausted");
        throw lastErr instanceof Error ? lastErr : new Error("jev: exhausted retries");
      } catch (e) {
        // Belt-and-braces: any path above that threw without going through finaliseError (there
        // should be none left, but a future edit is cheaper to protect here than to re-audit).
        await finaliseError(safeJevErrorMessage(e));
        throw e;
      }
    },
  };
}

let cached: JevClient | null = null;

/** ETA_JEV_MOCK on → the deterministic mock. Otherwise the real HTTP client. */
export function getJevClient(): JevClient {
  if (flagOn("ETA_JEV_MOCK")) return getMockJevClient();
  if (!cached) cached = createHttpJevClient();
  return cached;
}

/** Test-only: drop the cached real client so a new fetch mock takes effect. */
export function _resetJevClientForTests(): void {
  cached = null;
}
