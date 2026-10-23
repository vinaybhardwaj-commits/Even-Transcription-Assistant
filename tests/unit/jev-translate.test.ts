/**
 * tests/unit/jev-translate.test.ts — Jev's English translation, on Vertex Gemini (V, 23 Oct: no OpenRouter).
 *
 * Drives the REAL `vertexChat` with a scripted `fetch` and a faked Vertex token, so the request URL
 * (region), body and the response label are asserted where they are built. A planted OpenRouter key
 * in the environment must never be used or echoed.
 *
 * Synthetic text only — never patient content.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { translateToEnglish, verifiedEnglish, SKIP_ENGLISH_LABEL, ROMANISED_INDIC_VETO, TRANSLATE_SYSTEM_PROMPT, JEV_TRANSLATE_TOTAL_BUDGET_MS_DEFAULT } from "@/lib/jev/translate";
import { JEV_TRANSLATE_BATCH } from "@/lib/jobs/kinds/jev-english";
import { MAX_STEP_MS } from "@/lib/jobs/types";

vi.mock("@/lib/gcp-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gcp-auth")>();
  return { ...actual, getVertexAccessToken: async () => "vertex-token-not-a-secret" };
});

const FAKE_KEY = "sk-or-v1-FAKEKEY-must-never-appear-anywhere-0123456789abcdef";
const HINDI = "मुझे बुखार है";
const ROMANISED = "aapko kitne din se bukhar hai";
const ENV_KEYS = ["GCP_PROJECT", "GCP_SA_KEY", "GCP_LOCATION", "GCP_FALLBACK_LOCATION", "OPENROUTER_API_KEY", "JEV_TRANSLATE_MODEL", "JEV_TRANSLATE_FALLBACK"];
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
let steps: Array<Response | Error> = [];

const ok = (content = "I have a fever") => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const regionOf = (u: string) => /^https:\/\/(?:([a-z0-9-]+)-)?aiplatform\.googleapis\.com/.exec(u)?.[1] ?? "global";

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.OPENROUTER_API_KEY = FAKE_KEY;
  process.env.GCP_PROJECT = "proj";
  process.env.GCP_SA_KEY = "{}";
  process.env.GCP_LOCATION = "asia-south1";
  calls = []; steps = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const st = steps.shift();
    if (!st) throw new Error("fetch called more times than scripted");
    if (st instanceof Error) throw st;
    return st;
  }) as unknown as typeof fetch;
  vi.resetModules();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const mod = () => import("@/lib/jev/translate");
const script = (...s: Array<Response | Error>) => { steps = s; };
/** Runs the REAL translator (default `vertexChat`), with the process env as set by the test. */
async function run(text: string, extra: { env?: Record<string, string | undefined>; signal?: AbortSignal } = {}) {
  const { translateToEnglish } = await mod();
  return translateToEnglish(text, "hi", { env: { ...process.env, ...(extra.env ?? {}) }, signal: extra.signal });
}

describe("dispatch — the default model, and the env that overrides it", () => {
  it("calls the default model first, on Vertex, in the configured region", async () => {
    script(ok());
    const r = await run(HINDI);
    expect(r).toMatchObject({ status: "ok", english: "I have a fever", model: "gemini:gemini-2.5-flash@asia-south1" });
    expect(calls[0]!.url).toContain("asia-south1-aiplatform.googleapis.com");
    expect(calls[0]!.body.model).toBe("google/gemini-2.5-flash");
    expect(calls.some((c) => c.url.includes("openrouter"))).toBe(false);
  });

  it("JEV_TRANSLATE_MODEL / JEV_TRANSLATE_FALLBACK override the chain; entries are model[@region]", async () => {
    const { translateChain } = await mod();
    expect(translateChain({ GCP_LOCATION: "asia-south1", JEV_TRANSLATE_MODEL: "gx", JEV_TRANSLATE_FALLBACK: "gy@us-central1, google/gz" }))
      .toEqual(["gx@asia-south1", "gy@us-central1", "gz@asia-south1"]);
    expect(translateChain({ GCP_LOCATION: "asia-south1", GCP_FALLBACK_LOCATION: "us-central1" })[0]).toBe("gemini-2.5-flash@us-central1");
  });

  it("the defaults are gemini-2.5-flash then gemini-2.5-flash-lite — nothing is qwen, nothing is an OpenRouter slug", async () => {
    const { translateChain, JEV_TRANSLATE_MODEL_DEFAULT, JEV_TRANSLATE_FALLBACK_DEFAULT } = await mod();
    expect(translateChain({ GCP_LOCATION: "asia-south1" })).toEqual([`${JEV_TRANSLATE_MODEL_DEFAULT}@asia-south1`, `${JEV_TRANSLATE_FALLBACK_DEFAULT}@asia-south1`]);
    expect(JEV_TRANSLATE_MODEL_DEFAULT).toBe("gemini-2.5-flash");
    expect(JEV_TRANSLATE_FALLBACK_DEFAULT).toBe("gemini-2.5-flash-lite");
    for (const m of translateChain({})) expect(m).not.toMatch(/qwen|\/|openrouter/i);
  });

  it("a stale OpenRouter slug in the env is dropped, never sent to Vertex", async () => {
    const { translateChain } = await mod();
    expect(translateChain({ GCP_LOCATION: "us-central1", JEV_TRANSLATE_MODEL: "google/gemini-3.8-flash", JEV_TRANSLATE_FALLBACK: "meta-llama/llama-4-scout" }))
      .toEqual(["gemini-3.8-flash@us-central1", "gemini-2.5-flash-lite@us-central1"]);
    expect(translateChain({ GCP_LOCATION: "us-central1", JEV_TRANSLATE_MODEL: "meta-llama/llama-4-scout" })[0]).toBe("gemini-2.5-flash@us-central1");
  });

  it("the translator imports neither the qwen client nor the OpenRouter client", () => {
    const src = readFileSync("lib/jev/translate.ts", "utf8");
    expect(src).not.toMatch(/from ["']@\/lib\/qwen["']/);
    expect(src).not.toMatch(/from ["']@\/lib\/openrouter["']/);
    expect(src).not.toMatch(/qwenJson|QWEN_MODEL/);
  });

  it("sends the router's system prompt and the original ALONE as the user turn", async () => {
    script(ok());
    await run(HINDI);
    const messages = calls[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: TRANSLATE_SYSTEM_PROMPT });
    expect(messages[1]).toEqual({ role: "user", content: HINDI });
    expect(calls[0]!.body.temperature).toBe(0);
    for (const must of ["never summarise", "unchanged", "drug names", "units", "only the translation"]) {
      expect(TRANSLATE_SYSTEM_PROMPT.toLowerCase()).toContain(must);
    }
  });
});

describe("fallback — in order, on a 5xx or a timeout", () => {
  it("a 5xx falls to the fallback model, whose label names it and its region", async () => {
    script(new Response("", { status: 503 }), ok());
    const r = await run(HINDI, { env: { GCP_FALLBACK_LOCATION: "us-central1" } });
    expect(calls.map((c) => c.body.model)).toEqual(["google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"]);
    expect(calls.map((c) => regionOf(c.url))).toEqual(["us-central1", "us-central1"]);
    expect(r).toMatchObject({ status: "ok", model: "gemini:gemini-2.5-flash-lite@us-central1" });
  });

  it("a network failure falls to the fallback model", async () => {
    script(new TypeError("fetch failed"), ok());
    const r = await run(HINDI);
    expect(calls.length).toBe(2);
    expect(r.status).toBe("ok");
  });

  it("a timeout falls to the fallback model (injected chat seam)", async () => {
    const { translateToEnglish } = await mod();
    const { VertexError } = await import("@/lib/llm/gemini");
    let n = 0;
    const chat = async (a: { model: string }) => {
      n += 1;
      if (n === 1) throw new VertexError("vertex_timeout");
      return { content: "I have a fever", model: `gemini:${a.model}@r`, latency_ms: 5 };
    };
    const r = await translateToEnglish(HINDI, "hi", { chat, env: {} });
    expect(n).toBe(2);
    expect(r).toMatchObject({ status: "ok", model: "gemini:gemini-2.5-flash-lite@r" });
  });

  it("an empty answer is a failure, not a translation", async () => {
    script(ok("   "), ok("I have a fever"));
    const r = await run(HINDI);
    expect(calls.length).toBe(2);
    expect(r).toMatchObject({ status: "ok", english: "I have a fever" });
  });

  it("TOTAL failure is `failed` with a closed code — the source text is never passed off as English", async () => {
    script(new Response("", { status: 500 }), new Response("", { status: 502 }));
    const r = await run(HINDI);
    expect(r).toEqual({ status: "failed", reason: "all_failed:vertex_http_500,vertex_http_502" });
    expect(JSON.stringify(r)).not.toContain(HINDI);
  });

  it("all-empty is recorded as empty_output, the code the kind has always used", async () => {
    script(ok(" "), ok(" "));
    expect(await run(HINDI)).toEqual({ status: "failed", reason: "empty_output" });
  });

  it("an abort by the runner stops, without spending the fallback", async () => {
    const { translateToEnglish } = await mod();
    const { VertexError } = await import("@/lib/llm/gemini");
    const ctl = new AbortController();
    let n = 0;
    const chat = async () => { n += 1; ctl.abort(); throw new VertexError("vertex_abort"); };
    const r = await translateToEnglish(HINDI, "hi", { chat, env: {}, signal: ctl.signal });
    expect(n).toBe(1);
    expect(r).toEqual({ status: "failed", reason: "translate_abort" });
  });

  it("Vertex not configured is a coded failure, not a crash — and the source is still not English", async () => {
    delete process.env.GCP_SA_KEY;
    vi.resetModules();
    const r = await run(HINDI);
    expect(r).toEqual({ status: "failed", reason: "vertex_not_configured" });
    expect(calls).toEqual([]);
  });
});

describe("non-string content never becomes a translation (D3)", () => {
  it("content: null on the primary falls through to the fallback, which answers", async () => {
    script(new Response(JSON.stringify({ choices: [{ message: { content: null } }] }), { status: 200 }), ok("I have a fever"));
    const r = await run(HINDI);
    expect(calls.length).toBe(2);
    expect(r).toMatchObject({ status: "ok", english: "I have a fever" });
  });

  it("content as a list or null on both models is `failed` — never the literal string \"null\"", async () => {
    script(new Response(JSON.stringify({ choices: [{ message: { content: ["not", "a", "string"] } }] }), { status: 200 }),
      new Response(JSON.stringify({ choices: [{ message: { content: null } }] }), { status: 200 }));
    const r = await run(HINDI);
    expect(r.status).toBe("failed");
    expect(JSON.stringify(r)).not.toContain('"null"');
  });
});

describe("a shared total deadline bounds the whole chain, not just one call (D4)", () => {
  it("does not spend a later model once the total budget is gone", async () => {
    const { translateToEnglish } = await mod();
    const { VertexError } = await import("@/lib/llm/gemini");
    let n = 0;
    const chat = async () => { n += 1; await new Promise((r) => setTimeout(r, 30)); throw new VertexError("vertex_http_500"); };
    const r = await translateToEnglish(HINDI, "hi", { chat, env: { JEV_TRANSLATE_TOTAL_MS: "10" } });
    expect(n).toBe(1);
    expect(r.status).toBe("failed");
  });

  it("JEV_TRANSLATE_BATCH windows, each paying the full total budget, still fit under MAX_STEP_MS", () => {
    expect(JEV_TRANSLATE_BATCH * JEV_TRANSLATE_TOTAL_BUDGET_MS_DEFAULT).toBeLessThan(MAX_STEP_MS);
  });
});

describe("the label is derived from the target actually called", () => {
  it("records the model@region called, not what the response claims", async () => {
    script(new Response(JSON.stringify({ model: "something-else", choices: [{ message: { content: "I have a fever" } }] }), { status: 200 }));
    expect(await run(HINDI)).toMatchObject({ model: "gemini:gemini-2.5-flash@asia-south1" });
  });

  it("a skipped window is labelled skip:english, never as a translation", async () => {
    const r = await run("How many days have you had the fever");
    expect(r).toMatchObject({ status: "ok", model: SKIP_ENGLISH_LABEL, english: "How many days have you had the fever" });
    expect(calls).toEqual([]);
  });

  it("records input_chars before truncation", async () => {
    script(ok());
    expect(await run(HINDI)).toMatchObject({ input_chars: HINDI.length });
  });
});

describe("the verified-English skip — the label never decides", () => {
  it("English is skipped", () => {
    expect(verifiedEnglish("Take one tablet twice a day after food")).toBe(true);
  });
  it("romanised Hindi is translated", async () => {
    expect(verifiedEnglish(ROMANISED)).toBe(false);
    script(ok());
    await run(ROMANISED);
    expect(calls.length).toBe(1);
    expect((calls[0]!.body.messages as Array<{ content: string }>)[1]!.content).toBe(ROMANISED);
  });
  it("Malayalam and Bengali script are translated", () => {
    expect(verifiedEnglish("എത്ര ദിവസമായി")).toBe(false);
    expect(verifiedEnglish("আপনার জ্বর কত দিন")).toBe(false);
  });
  it("the langHint argument cannot force a skip or block one", async () => {
    const { translateToEnglish } = await mod(); // fresh import: GCP_* is read at module load
    script(ok());
    await translateToEnglish(ROMANISED, "en", { env: { ...process.env } });
    expect(calls.length).toBe(1);                         // `en` does not skip Hindi
    await translateToEnglish("What is your name and how old are you", "kn", { env: { ...process.env } });
    expect(calls.length).toBe(1);                         // `kn` does not block English
  });
  it("thresholds: >=90% ASCII letters, >=20% function words", () => {
    expect(verifiedEnglish("the zzz zzz zzz zzz")).toBe(true);          // 20%
    expect(verifiedEnglish("the zzz zzz zzz zzz zzz")).toBe(false);     // < 20%
    expect(verifiedEnglish("... 123 ...")).toBe(false);                 // no letters
  });

  // D1 (ETA-Refuter round 2, 22 Sep): the router's romanised-Indic veto, ported. The function-word
  // ratio alone let these through — both are pure Hindi/Hinglish that borrows clinical English.
  describe("D1 — the romanised-Indic veto", () => {
    it("vetoes even when the function-word ratio would otherwise pass", async () => {
      const cases = [
        "aapko kitne din se bukhar hai to take the goli morning and night",
        "vo kal the two days morning",
      ];
      for (const text of cases) {
        expect(verifiedEnglish(text)).toBe(false);
        calls = [];
        script(ok());
        await run(text);
        expect(calls.length).toBe(1);
      }
    });
    it("true English with no veto tokens still skips", () => {
      expect(verifiedEnglish("Take one tablet twice a day after food for two days")).toBe(true);
      expect(verifiedEnglish("How many days have you had the fever, morning or night")).toBe(true);
    });
    it("veto tokens that are ALSO common English are deliberately absent", () => {
      for (const safe of ["to", "is", "the", "me", "main", "sir"]) {
        expect(ROMANISED_INDIC_VETO.has(safe)).toBe(false);
      }
    });
  });
});

describe("no OpenRouter: the planted key is neither used nor echoed", () => {
  it("no request goes to OpenRouter, and the key is in no request, log or result, on any failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const results: unknown[] = [];
    for (const f of [new Response("", { status: 401 }), new TypeError(`connect failed ${FAKE_KEY}`), new Response("not json", { status: 200 })]) {
      script(f, f instanceof Error ? f : new Response("", { status: 500 }));
      results.push(await run(HINDI));
    }
    const logged = spies.flatMap((s) => s.mock.calls).map((a) => JSON.stringify(a)).join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(calls.some((c) => c.url.includes("openrouter"))).toBe(false);
    expect(JSON.stringify(calls)).not.toContain(FAKE_KEY);
    expect(logged).not.toContain(FAKE_KEY);
    expect(JSON.stringify(results)).not.toContain(FAKE_KEY);
  });
});
