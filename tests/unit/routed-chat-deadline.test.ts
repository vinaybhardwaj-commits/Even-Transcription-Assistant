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

// ETA-Refuter, 23 Sep (routedchat-deadline r2 recheck): a zero-arity mock discards whatever
// signal the caller passes, so no test through this mock could ever observe that routedChat and
// geminiChatIfOn actually FORWARD their combined deadline signal into getVertexAccessToken(signal)
// — lib/gcp-auth.ts's own handling of that signal is proven sound (gcp-auth-abort.test.ts), but the
// JOIN between the two was untested. `lastSignal` records exactly what each call received.
const gcpMock = vi.hoisted(() => ({
  getToken: async (_signal?: AbortSignal): Promise<string> => "vertex-token-not-a-secret",
  lastSignal: undefined as AbortSignal | undefined,
}));
vi.mock("@/lib/gcp-auth", () => ({
  getVertexAccessToken: (signal?: AbortSignal) => {
    gcpMock.lastSignal = signal;
    return gcpMock.getToken(signal);
  },
}));

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
  gcpMock.lastSignal = undefined;
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

describe("routedChatDeadlineMs — pure (Fable's ruling, 22 Sep, replacing the flat 1.5x)", () => {
  // deadline = round((primaryBudget + 2 x fallbackBudget) * 1.10)
  //   primaryBudget  = perCallTimeoutMs, or 240_000 (GEMINI_DEFAULT_TIMEOUT_MS) when none given
  //   fallbackBudget = min(perCallTimeoutMs, 60_000) — never the caller's own value uncapped

  it("caller's timeoutMs under the 60s fallback cap: every stage gets the SAME budget", async () => {
    const { routedChatDeadlineMs } = await router();
    // primary=1000, fallback=min(1000,60000)=1000 -> (1000 + 2*1000) * 1.10 = 3300
    expect(routedChatDeadlineMs(1_000, {})).toBe(3_300);
  });

  it("caller's timeoutMs over the 60s cap: the fallback budget is capped, the primary budget is not", async () => {
    const { routedChatDeadlineMs } = await router();
    // primary=100_000 (uncapped), fallback=min(100_000,60_000)=60_000 -> (100000+120000)*1.10 = 242000
    expect(routedChatDeadlineMs(100_000, {})).toBe(242_000);
  });

  it("no per-call timeoutMs: primary defaults to 240s, fallback to the 60s cap — same as before, arithmetic aside", async () => {
    const { routedChatDeadlineMs } = await router();
    // (240000 + 2*60000) * 1.10 = 396000
    expect(routedChatDeadlineMs(undefined, {})).toBe(396_000);
  });

  it("this fixes the case the Refuter measured: after a full primary hang, a fast fallback now fits inside its OWN budget", async () => {
    const { routedChatDeadlineMs } = await router();
    // timeoutMs=200: old rule gave 300ms total (150ms of run-room after a 200ms primary hang).
    // new rule: primary=200, fallback=min(200,60000)=200 -> (200+400)*1.10 = 660ms — the fallback's
    // own full 200ms budget survives the primary's hang, with room to spare for a second fallback.
    const deadline = routedChatDeadlineMs(200, {});
    expect(deadline).toBe(660);
    expect(deadline - 200).toBeGreaterThanOrEqual(200); // full first-fallback budget after the hang
  });

  it("is never tighter than the primary budget itself (the ordinary case is never affected)", async () => {
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
      expect(routedChatDeadlineMs(1_000, { ETA_ROUTED_CHAT_DEADLINE_MS: bad })).toBe(3_300);
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
    // THE JOIN (ETA-Refuter, 23 Sep): not just "getVertexAccessToken can be aborted" (proven
    // separately, unmocked, in gcp-auth-abort.test.ts) but that routedChat actually PASSES a
    // signal — and that it is the deadline's own live signal, not an inert or unrelated one: the
    // exact object captured at call time has since transitioned to aborted.
    expect(gcpMock.lastSignal).toBeInstanceOf(AbortSignal);
    expect(gcpMock.lastSignal?.aborted).toBe(true);
  }, 5_000);

  it("the join, on the happy path: a signal is passed even when the token call succeeds fast, and it is NOT aborted", async () => {
    geminiOn();
    script = [{ kind: "ok", content: "hi" }];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS, timeoutMs: 30_000 });
    expect(r.ok).toBe(true);
    // Catches the mutant the Refuter named: dropping the argument at either call site
    // (lib/llm/gemini.ts routedChat or geminiChatIfOn) leaves `gcpMock.lastSignal` undefined.
    expect(gcpMock.lastSignal).toBeInstanceOf(AbortSignal);
    expect(gcpMock.lastSignal?.aborted).toBe(false);
  });

  it("a caller's own AbortSignal still works exactly as before: 'aborted', not 'deadline_exceeded'", async () => {
    script = [{ kind: "hang" }];
    const controller = new AbortController();
    const { routedChat } = await router();
    const p = routedChat({ surface: "note", tier: "flash", messages: MSGS, signal: controller.signal });
    controller.abort();
    const r = await p;
    expect(r).toMatchObject({ ok: false, error: "aborted", provider: "none" });
  }, 5_000);

  it("the join at geminiChatIfOn's own call site too (ETA-Refuter, 23 Sep, the second named site)", async () => {
    geminiOn();
    script = [{ kind: "ok", content: "hi" }];
    const { geminiChatIfOn } = await router();
    const controller = new AbortController();
    const r = await geminiChatIfOn("note", "flash", MSGS, { signal: controller.signal });
    expect(r?.ok).toBe(true);
    // geminiChatIfOn has no raceSignal of its own (only routedChat's deadline plumbing does) —
    // this is the caller's OWN signal, passed straight through to getVertexAccessToken. Proves the
    // fix applies at both named sites, not just the one routedChat exercises via the deadline.
    expect(gcpMock.lastSignal).toBe(controller.signal);
  });
});

describe("the DEFAULT deadline (no env override) after a REAL first-stage hang — the Refuter's missing test", () => {
  // No ETA_ROUTED_CHAT_DEADLINE_MS here: routedChatDeadlineMs computes its default from timeoutMs.
  // timeoutMs=100 -> primary budget 100, fallback budget min(100,60000)=100, deadline (100+200)*1.10
  // = 330ms. The primary's hang ends at its OWN 100ms per-call timer (openaiChat's `tid`), not at
  // the external deadline — a genuinely hung stage running to its own declared timeout, exactly the
  // production shape. That leaves ~230ms of the 330ms deadline for the fallbacks that follow.
  const TIMEOUT_MS = 100;

  it("the first fallback still ANSWERS after the primary's full hang (old rule would have starved it)", async () => {
    geminiOn();
    script = [{ kind: "hang" }, { kind: "ok", content: "answer", model: "google/gemini-3.8-flash-001" }];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS, timeoutMs: TIMEOUT_MS });
    expect(r).toMatchObject({ ok: true, provider: "openrouter:google/gemini-3.8-flash-001" });
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => (isVertex(h.url) ? "vertex" : "openrouter"))).toEqual(["vertex", "openrouter"]);
  }, 5_000);

  it("a THIRD stage (the second fallback) is reachable: primary hangs, first fallback fails fast, second fallback still runs and can answer", async () => {
    geminiOn();
    script = [{ kind: "hang" }, { kind: "http", status: 500 }, { kind: "ok", content: "answer", model: "meta-llama/llama-4-scout-17b" }];
    const { routedChat } = await router();
    const r = await routedChat({ surface: "note", tier: "flash", messages: MSGS, timeoutMs: TIMEOUT_MS });
    expect(r).toMatchObject({ ok: true, provider: "openrouter:meta-llama/llama-4-scout-17b" });
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => (isVertex(h.url) ? "vertex" : "openrouter"))).toEqual(["vertex", "openrouter", "openrouter"]);
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
