/**
 * lib/jev/client.ts — Slice J1. The Jev ("System One") provider client.
 *
 * TRANSPORT (spec §4 as amended by v1.2). Jev is reached THROUGH the even-jev MCP on the Mini
 * (`~/dev/even-jev-mcp`, launcher `run.sh`, key at `~/.config/even-jev/key`) — NOT by a hand-written
 * HTTP client and NOT via the SDK (both forbidden, spec §9 / v1.2 line 32). §4's "raw fetch to
 * /v1/systemone" text is superseded on transport by v1.2; its SEMANTICS are kept: disabled-flag
 * throws before any network, a state-size guard, a trace finalised with token counts, and retry of
 * transient failures. The launcher loads the key itself, so this file NEVER reads or logs the key.
 *
 * The transport is an INJECTED SEAM (`deps.transport`), mirroring J0's `translate.ts` injecting
 * `qwenJson`: every unit test drives a fake transport, so the whole client is tested with no child
 * process, no network, and no real Jev call — and D1b (real transcripts to the vendor) stays closed.
 *
 * Log metadata only (integration doc §7): question ids, counts, byte sizes, token counts, latency —
 * NEVER the state text, never the key.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { parseFlag } from "@/lib/flags";
import { jevModel, jevTimeoutMs } from "@/lib/env";
import { openTrace, type TraceHandle } from "@/lib/llm-trace/log";
import {
  JevDisabledError,
  JevStateTooLargeError,
  JevTransportError,
  type JevClient,
  type JevRequest,
  type JevResult,
} from "./types";
import { MockJevClient, getMockJevClient } from "./mock";

export const ETA_JEV_ENABLED = "ETA_JEV_ENABLED";
export const ETA_JEV_MOCK = "ETA_JEV_MOCK";
/** ~25k tokens. State over this must be chunked by the caller (spec §4). */
export const JEV_STATE_MAX_CHARS = 100_000;
const MAX_ATTEMPTS = 3;

/** The single-shot call the client retries around. Returns the raw jev_ask payload. */
export type JevTransport = (
  payload: { state: unknown; questions: JevRequest["questions"]; model: string },
  opts: { signal?: AbortSignal; timeoutMs: number },
) => Promise<{ model?: string; answers: JevResult["answers"]; usage: { input_tokens: number; output_tokens?: number }; latency_ms?: number }>;

type ClientDeps = {
  transport?: JevTransport;
  openTrace?: typeof openTrace;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Exponential backoff with jitter: ~200ms, ~400ms between the three attempts. */
const backoffMs = (attempt: number) => Math.round(200 * 2 ** (attempt - 1) * (0.5 + Math.random()));

/** Transient patterns that make a vendor/tool error worth retrying (429/529, overload, timeouts). */
function isRetryableMessage(msg: string): boolean {
  return /\b(429|529)\b|overload|temporar|timeout|ETIMEDOUT|ECONNRESET|EPIPE|socket hang up/i.test(msg);
}

function safeParse(text: unknown): { model?: string; answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number }; latency_ms?: number } | null {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The default transport: spawn the even-jev MCP once per call and drive `jev_ask` over stdio
 * (newline-delimited JSON-RPC). One call per batch, so a fresh child per call is simplest and cannot
 * leak state between jobs. Never unit-tested directly (no live MCP in CI); validated by a guarded
 * synthetic smoke and exercised for real by J2. `ETA_JEV_MCP_CMD` overrides the launcher path.
 */
export function mcpStdioTransport(): JevTransport {
  return (payload, opts) =>
    new Promise((resolve, reject) => {
      const cmd = process.env.ETA_JEV_MCP_CMD || path.join(homedir(), "dev", "even-jev-mcp", "run.sh");
      const t0 = Date.now();
      const child = spawn(cmd, [], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      let buf = "";
      let settled = false;
      const initId = 1;
      const askId = 2;

      const cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      };
      const fail = (e: Error) => { if (settled) return; settled = true; cleanup(); reject(e); };
      const ok = (v: Awaited<ReturnType<JevTransport>>) => { if (settled) return; settled = true; cleanup(); resolve(v); };

      const timer = setTimeout(
        () => fail(new JevTransportError(`jev MCP call timed out after ${opts.timeoutMs}ms`, { retryable: true })),
        opts.timeoutMs,
      );
      const onAbort = () => fail(new JevTransportError("jev MCP call aborted", { retryable: false }));
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      const send = (msg: unknown) => { try { child.stdin.write(JSON.stringify(msg) + "\n"); } catch (e) { fail(new JevTransportError(`jev MCP write failed: ${(e as Error).message}`, { retryable: true })); } };

      child.on("error", (e) => fail(new JevTransportError(`jev MCP spawn failed: ${e.message}`, { retryable: true })));
      child.on("exit", (code) => { if (!settled) fail(new JevTransportError(`jev MCP exited early (code ${code})`, { retryable: true })); });
      child.stderr.on("data", () => { /* one audit line per call; may carry status but never content — not surfaced */ });

      const handle = (msg: { id?: number; result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown }; error?: unknown }) => {
        if (msg.id === initId) {
          if (msg.error) return fail(new JevTransportError(`jev MCP initialize failed: ${JSON.stringify(msg.error)}`, { retryable: true }));
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: askId, method: "tools/call", params: { name: "jev_ask", arguments: payload } });
          return;
        }
        if (msg.id === askId) {
          if (msg.error) return fail(new JevTransportError(`jev_ask rpc error: ${JSON.stringify(msg.error)}`, { retryable: isRetryableMessage(JSON.stringify(msg.error)) }));
          const result = msg.result;
          if (result?.isError) {
            const text = result?.content?.[0]?.text ?? "jev_ask failed";
            return fail(new JevTransportError(`jev_ask failed: ${text}`, { retryable: isRetryableMessage(text) }));
          }
          const out = (result?.structuredContent as ReturnType<typeof safeParse>) ?? safeParse(result?.content?.[0]?.text);
          if (!out || typeof out !== "object" || !out.answers || !out.usage || typeof out.usage.input_tokens !== "number") {
            return fail(new JevTransportError("jev_ask returned an unrecognised shape", { retryable: false }));
          }
          return ok({
            model: out.model,
            answers: out.answers as JevResult["answers"],
            usage: { input_tokens: out.usage.input_tokens, output_tokens: out.usage.output_tokens ?? 0 },
            latency_ms: typeof out.latency_ms === "number" ? out.latency_ms : Date.now() - t0,
          });
        }
      };

      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: unknown;
          try { msg = JSON.parse(line); } catch { continue; }
          try { handle(msg as Parameters<typeof handle>[0]); } catch (e) { fail(e as Error); }
        }
      });

      send({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "eta-jev-client", version: "1" } } });
    });
}

export class McpJevClient implements JevClient {
  private readonly transport: JevTransport;
  private readonly openTraceFn: typeof openTrace;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: ClientDeps = {}) {
    this.transport = deps.transport ?? mcpStdioTransport();
    this.openTraceFn = deps.openTrace ?? openTrace;
    this.sleep = deps.sleep ?? realSleep;
  }

  async systemOne(req: JevRequest, opts?: { signal?: AbortSignal; trace?: TraceHandle }): Promise<JevResult> {
    // (1) Off is a deliberate state, not a failure — thrown BEFORE any spawn or trace, so a gated-off
    // caller costs nothing and never reaches the vendor.
    if (!parseFlag(ETA_JEV_ENABLED)) throw new JevDisabledError();

    // (2) State-size guard, before any network. The caller must chunk; this is not retryable.
    const stateJson = JSON.stringify(req.state ?? null);
    if (stateJson.length > JEV_STATE_MAX_CHARS) throw new JevStateTooLargeError(stateJson.length, JEV_STATE_MAX_CHARS);

    const model = req.model ?? jevModel();
    const questionIds = Object.keys(req.questions);
    // request_input carries ids + byte size ONLY — never the state text (integration doc §7).
    const trace = opts?.trace ?? (await this.openTraceFn({
      surface: "jev",
      request_input: { question_ids: questionIds, question_count: questionIds.length, state_bytes: Buffer.byteLength(stateJson) },
    }));
    const payload = { state: req.state, questions: req.questions, model };
    const timeoutMs = jevTimeoutMs();

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          const t0 = Date.now();
          const r = await this.transport(payload, { signal: opts?.signal, timeoutMs });
          const result: JevResult = {
            model: r.model || model,
            answers: r.answers,
            usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens ?? 0 },
            latency_ms: r.latency_ms ?? Date.now() - t0,
          };
          trace.event("jev_ask", `ok q=${questionIds.length}`, result.latency_ms, true);
          await trace.finalise({
            status: "completed",
            result_summary: { question_count: questionIds.length, input_tokens: result.usage.input_tokens },
            model_calls: [{ model: result.model, latency_ms: result.latency_ms, tokens_in: result.usage.input_tokens, tokens_out: result.usage.output_tokens }],
          });
          return result;
        } catch (e) {
          if (e instanceof JevTransportError && e.retryable && attempt < MAX_ATTEMPTS) {
            trace.event("jev_ask", `retry ${attempt} after transient`, undefined, false, true);
            await this.sleep(backoffMs(attempt));
            continue;
          }
          throw e;
        }
      }
      // Unreachable: the loop either returns or throws.
      throw new JevTransportError("jev_ask exhausted retries", { retryable: false });
    } catch (e) {
      const aborted = opts?.signal?.aborted === true;
      trace.event("jev_ask", "failed", undefined, true, true);
      await trace.finalise({ status: aborted ? "aborted" : "errored", error_message: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }
}

/**
 * The one entry point callers use. When ETA_JEV_MOCK is set, returns the deterministic mock (no
 * network, no vendor) — used in every unit test and while D1b is closed. Otherwise the real MCP
 * client. `deps` lets a test inject a fake transport/trace; production passes nothing.
 */
export function getJevClient(deps: ClientDeps = {}): JevClient {
  // getMockJevClient reads the module-level fixtures a job's suite sets with setMockJevAnswers,
  // which is the only way a caller reaching Jev through this function can supply them.
  if (parseFlag(ETA_JEV_MOCK)) return getMockJevClient();
  return new McpJevClient(deps);
}
