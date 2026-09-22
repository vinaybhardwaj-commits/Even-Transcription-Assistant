/**
 * tests/unit/routed-chat-deadline.test.ts — F1: an OVERALL deadline on routedChat.
 *
 * routed-chat-fallback.test.ts pins the chain (Gemini -> OpenRouter, never Ollama) with fetch steps
 * that resolve or reject immediately. This file adds the case that test file cannot express: a
 * stage that HANGS past its own per-call timeout. The fake fetch below only settles when its
 * request's AbortSignal fires — exactly what a genuinely stuck backend looks like — so these tests
 * fail if the overall deadline stops aborting in-flight calls, not just stops trying new ones.
 *
 * ETA_ROUTED_CHAT_DEADLINE_MS is set to a small real value (tens of ms) rather than mocking Date —
 * an AbortController firing off a real setTimeout is the actual mechanism under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const gcpMock = vi.hoisted(() => ({ getToken: async (): Promise<string> => "vertex-token-not-a-secret" }));
vi.mock("@/lib/gcp-auth", () => ({ getVertexAccessToken: () => gcpMock.getToken() }));

const FAKE_KEY = "sk-or-v1-FAKEKEY-must-never-appear-anywhere-0123456789abcdef";
const MSGS = [{ role: "system", content: "Reply with one word." }, { role: "user", content: "ok" }];
const ENV_KEYS = [
  "GCP_PROJECT", "GCP_SA_KEY", "GCP_LOCATION", "GEMINI_ALL", "GEMINI_NOTE",
  "OPENROUTER_API_KEY", "OPENROUTER_API_KEY_FILE", "OPENROUTER_API_URL", "LLM_FALLBACK_MODELS",
  "ETA_ROUTED_CHAT_DEADLINE_MS",
];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

type Step = { kind: "ok"; content: string; model?: string } | { kind: "http"; status: number } | { kind: "hang" };
let hits: Array<{ url: string; signal?: AbortSignal }> = [];
let script: Step[] = [];

function isVertex(u: string) { return u.includes("aiplatform.googleapis.com"); }
function isOpenRouter(u: string) { return u.includes("openrouter.ai"); }

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.OPENROUTER_API_KEY = FAKE_KEY;
  hits = [];
  script = [];
  gcpMock.getToken = async () => "vertex-token-not-a-secret";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const signal = init.signal ?? undefined;
    hits.push({ url: String(url), signal });
    const step = script.shift();
    if (!step) throw new Error(`unscripted fetch to ${url}`);
    if (step.kind === "hang") {
      // A backend that never answers. Settles ONLY when this request's own AbortSignal fires —
      // the same shape a truly stuck fetch has. If nothing ever aborts it, the test hangs too,
      // which is the point: a passing test here PROVES something aborted it.
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) { reject(abortError()); return; }
        signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    }
    if (step.kind === "http") return new Response("", { status: step.status });
    return new Response(JSON.stringify({ ...(step.model ? { model: step.model } : {}), choices: [{ message: { content: step.content } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  vi.resetModules();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}
function geminiOn() {
  process.env.GCP_PROJECT = "proj";
  process.env.GCP_SA_KEY = "{}";
  process.env.GCP_LOCATION = "global";
  process.env.GEMINI_ALL = "1";
}
async function router() { return import("@/lib/llm/gemini"); }

describe("routedChatDeadlineMs — pure", () => {
  it("defaults to 1.5x the per-call timeout in effect", async () => {
    const { routedChatDeadlineMs } = await router();
    expect(routedChatDeadlineMs(100_000, {})).toBe(150_000);
    expect(routedChatDeadlineMs(1_000, {})).toBe(1_500);
  });

  it("defaults to 1.5x GEMINI_DEFAULT_TIMEOUT_MS (240_000) when no per-call timeout was passed", async () => {
    const { routedChatDeadlineMs } = await router();
    expect(routedChatDeadlineMs(undefined, {})).toBe(360_000);
  });

  it("is never tighter than the per-call timeout itself (the ordinary case is never affected)", async () => {
    const { routedChatDeadlineMs } = await router();
    for (const t of [1, 100, 60_000, 240_000, 999_999]) {
      expect(routedChatDeadlineMs(t, {})).toBeGreaterThanOrEqual(t);
    }
  });

  it("ETA_ROUTED_CHAT_DEADLINE_MS overrides the formula outright", async () => {
    const { routedChatDeadlineMs } = await router();
    expect(routedChatDeadlineMs(100_000, { ETA_ROUTED_CHAT_DEADLINE_MS: "5000" })).toBe(5000);
  });

  it("an unparseable, zero, or negative override falls back to the formula, not to 0 or NaN", async () => {
    const { routedChatDeadlineMs } = await router();
    for (const bad of ["", "not-a-number", "0", "-5", "   "]) {
      expect(routedChatDeadlineMs(1_000, { ETA_ROUTED_CHAT_DEADLINE_MS: bad })).toBe(1_500);
    }
  });
});

describe("the deadline aborts an in-flight call and reports which stage", () => {
  it("Gemini hangs past the overall deadline: aborted, OpenRouter is never even tried", async () => {
    geminiOn();
    process.env.ETA_ROUTED_CHAT_DEADLINE_MS = "40";
    script = [{ kind: "hang" }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS, timeoutMs: 60_000 });
    expect(r.ok).toBe(false);
    expect(r.provider).toBe("none");
    expect(r.error).toMatch(/^deadline_exceeded:gemini:/);
    expect(hits).toHaveLength(1); // only the hung Gemini call — the fallback loop was never entered
    expect(warn.mock.calls.some((c) => String(c[0]).includes("deadline exceeded") && String(c[0]).includes("gemini:"))).toBe(true);
    warn.mockRestore();
  }, 5_000);

  it("Gemini fails fast, then OpenRouter's first model hangs: aborted mid-fallback, second model never tried", async () => {
    geminiOn();
    process.env.ETA_ROUTED_CHAT_DEADLINE_MS = "50";
    script = [{ kind: "http", status: 500 }, { kind: "hang" }];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS, timeoutMs: 60_000 });
    expect(r.ok).toBe(false);
    expect(r.provider).toBe("none");
    expect(r.error).toMatch(/^deadline_exceeded:openrouter:google\/gemini-3\.8-flash$/);
    expect(hits).toHaveLength(2); // gemini + the one hung openrouter call; llama-4-scout never reached
    expect(hits.map((h) => (isVertex(h.url) ? "vertex" : isOpenRouter(h.url) ? "openrouter" : h.url))).toEqual(["vertex", "openrouter"]);
  }, 5_000);

  it("getVertexAccessToken itself hangs: routedChat still returns at the deadline, labelled gemini", async () => {
    geminiOn();
    process.env.ETA_ROUTED_CHAT_DEADLINE_MS = "40";
    gcpMock.getToken = () => new Promise<string>(() => { /* never resolves */ });
    const { routedChat } = await router();
    const t0 = Date.now();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(Date.now() - t0).toBeLessThan(2_000); // did not wait for a promise that never settles
    expect(r).toMatchObject({ ok: false, provider: "none" });
    expect(r.error).toMatch(/^deadline_exceeded:gemini:/);
    expect(hits).toEqual([]); // no fetch ever happened — it never got past the token
  }, 5_000);

  it("a caller's own AbortSignal still works exactly as before: 'aborted', not 'deadline_exceeded'", async () => {
    script = [{ kind: "hang" }];
    const controller = new AbortController();
    const { routedChat } = await router();
    const p = routedChat({ surface: "note", tier: "flash", messages: MSGS, signal: controller.signal });
    controller.abort();
    const r = await p;
    expect(r).toMatchObject({ ok: false, error: "aborted", provider: "none" });
  }, 5_000);
});

describe("the ordinary case is never affected", () => {
  it("Gemini answers well inside its own timeout: succeeds, no deadline warning logged", async () => {
    geminiOn();
    script = [{ kind: "ok", content: "hi" }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS, timeoutMs: 30_000 });
    expect(r).toMatchObject({ ok: true, provider: "gemini:gemini-2.5-flash" });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("deadline"))).toBe(false);
    warn.mockRestore();
  });

  it("a normal Gemini-fails-then-OpenRouter-succeeds run is unaffected by the new deadline plumbing", async () => {
    geminiOn();
    script = [{ kind: "http", status: 500 }, { kind: "ok", content: "ok", model: "google/gemini-3.8-flash-001" }];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r).toMatchObject({ ok: true, provider: "openrouter:google/gemini-3.8-flash-001" });
  });

  it("total failure (no hang, every stage answers with an error) is still all_failed, not deadline_exceeded", async () => {
    geminiOn();
    script = [{ kind: "http", status: 500 }, { kind: "http", status: 502 }, { kind: "http", status: 503 }];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("all_failed");
    expect(r.error).not.toContain("deadline_exceeded");
  });
});
