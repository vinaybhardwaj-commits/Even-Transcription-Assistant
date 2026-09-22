/**
 * tests/unit/jev-translate.test.ts — Jev's English translation, off qwen and onto OpenRouter.
 *
 * Drives the REAL `openrouterChat` with an injected fetch, so the ZDR body, the key header and the
 * response label are asserted where they are built. Every call passes an explicit env: this shell
 * has a live OPENROUTER_API_KEY, and no test may read it or reach the network.
 *
 * Synthetic text only — never patient content.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openrouterChat, readOpenRouterKey, OpenRouterError } from "@/lib/openrouter";
import {
  translateToEnglish, translateChain, verifiedEnglish, TRANSLATE_SYSTEM_PROMPT,
  JEV_TRANSLATE_MODEL_DEFAULT, JEV_TRANSLATE_FALLBACK_DEFAULT, SKIP_ENGLISH_LABEL,
} from "@/lib/jev/translate";

const FAKE_KEY = "sk-or-v1-FAKEKEY-must-never-appear-anywhere-0123456789abcdef";
const ENV = { OPENROUTER_API_KEY: FAKE_KEY } as Record<string, string | undefined>;
const HINDI = "मुझे बुखार है";
const ROMANISED = "aapko kitne din se bukhar hai";

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function ok(content = "I have a fever", model = "google/gemini-2.5-flash-lite-001") {
  return new Response(JSON.stringify({ model, choices: [{ message: { content } }] }), { status: 200 });
}

/** A scripted fetch: each call takes the next response (or throws it). */
function script(...steps: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const s = steps.shift();
    if (!s) throw new Error("fetch called more times than scripted");
    if (s instanceof Error) throw s;
    return s;
  }) as unknown as typeof fetch;
  const chat: typeof openrouterChat = (a) => openrouterChat({ ...a, fetchImpl });
  return { calls, chat };
}

const run = (text: string, chat: typeof openrouterChat, env = ENV) => translateToEnglish(text, "hi", { chat, env });

describe("dispatch — the default model, and the env that overrides it", () => {
  it("calls the default model first, on OpenRouter", async () => {
    const s = script(ok());
    const r = await run(HINDI, s.chat);
    expect(r).toMatchObject({ status: "ok", english: "I have a fever" });
    expect(s.calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(s.calls[0]!.body.model).toBe("google/gemini-2.5-flash-lite");
  });

  it("JEV_TRANSLATE_MODEL / JEV_TRANSLATE_FALLBACK override the chain", () => {
    expect(translateChain({ JEV_TRANSLATE_MODEL: "a/x", JEV_TRANSLATE_FALLBACK: "b/y, c/z" })).toEqual(["a/x", "b/y", "c/z"]);
  });

  it("the defaults are gemini then gpt-5-nano — and nothing is qwen", () => {
    expect(translateChain({})).toEqual([JEV_TRANSLATE_MODEL_DEFAULT, JEV_TRANSLATE_FALLBACK_DEFAULT]);
    expect(translateChain({})).toEqual(["google/gemini-2.5-flash-lite", "openai/gpt-5-nano"]);
    for (const m of translateChain({})) expect(m).not.toMatch(/qwen/i);
  });

  it("the translator no longer imports the qwen client at all", () => {
    const src = readFileSync("lib/jev/translate.ts", "utf8");
    expect(src).not.toMatch(/from ["']@\/lib\/qwen["']/);
    expect(src).not.toMatch(/qwenJson|QWEN_MODEL/);
  });

  it("sends the router's system prompt and the original ALONE as the user turn", async () => {
    const s = script(ok());
    await run(HINDI, s.chat);
    const messages = s.calls[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: TRANSLATE_SYSTEM_PROMPT });
    expect(messages[1]).toEqual({ role: "user", content: HINDI });
    for (const must of ["never summarise", "unchanged", "drug names", "units", "only the translation"]) {
      expect(TRANSLATE_SYSTEM_PROMPT.toLowerCase()).toContain(must);
    }
  });
});

describe("fallback — in order, on a 5xx or a timeout", () => {
  it("a 5xx falls to the fallback model", async () => {
    const s = script(new Response("", { status: 503 }), ok("I have a fever", "openai/gpt-5-nano-2025"));
    const r = await run(HINDI, s.chat);
    expect(s.calls.map((c) => c.body.model)).toEqual(["google/gemini-2.5-flash-lite", "openai/gpt-5-nano"]);
    expect(r).toMatchObject({ status: "ok", model: "openai/gpt-5-nano-2025" });
  });

  it("a network failure falls to the fallback model", async () => {
    const s = script(new TypeError("fetch failed"), ok());
    const r = await run(HINDI, s.chat);
    expect(s.calls.length).toBe(2);
    expect(r.status).toBe("ok");
  });

  it("a timeout falls to the fallback model", async () => {
    let n = 0;
    const chat: typeof openrouterChat = async (a) => {
      n += 1;
      if (n === 1) throw new OpenRouterError("openrouter_timeout");
      return { content: "I have a fever", model: a.model, latency_ms: 5 };
    };
    const r = await translateToEnglish(HINDI, "hi", { chat, env: ENV });
    expect(n).toBe(2);
    expect(r).toMatchObject({ status: "ok", model: "openai/gpt-5-nano" });
  });

  it("an empty answer is a failure, not a translation", async () => {
    const s = script(ok("   "), ok("I have a fever"));
    const r = await run(HINDI, s.chat);
    expect(s.calls.length).toBe(2);
    expect(r).toMatchObject({ status: "ok", english: "I have a fever" });
  });

  it("TOTAL failure is `failed` with a closed code — the source text is never passed off as English", async () => {
    const s = script(new Response("", { status: 500 }), new Response("", { status: 502 }));
    const r = await run(HINDI, s.chat);
    expect(r.status).toBe("failed");
    expect(r).toEqual({ status: "failed", reason: "all_failed:openrouter_http_500,openrouter_http_502" });
    expect(JSON.stringify(r)).not.toContain(HINDI);
  });

  it("all-empty is recorded as empty_output, the code the kind has always used", async () => {
    const s = script(ok(" "), ok(" "));
    expect(await run(HINDI, s.chat)).toEqual({ status: "failed", reason: "empty_output" });
  });

  it("an abort by the runner stops, without spending the fallback", async () => {
    const ctl = new AbortController();
    let n = 0;
    const chat: typeof openrouterChat = async () => { n += 1; ctl.abort(); throw new OpenRouterError("openrouter_abort"); };
    const r = await translateToEnglish(HINDI, "hi", { chat, env: ENV, signal: ctl.signal });
    expect(n).toBe(1);
    expect(r).toEqual({ status: "failed", reason: "translate_abort" });
  });
});

describe("ZDR — every body, every model", () => {
  it("carries provider zdr + data_collection deny, and temperature 0", async () => {
    const s = script(new Response("", { status: 503 }), ok());
    await run(HINDI, s.chat);
    expect(s.calls.length).toBe(2);
    for (const c of s.calls) {
      expect(c.body.provider).toEqual({ zdr: true, data_collection: "deny" });
      expect(c.body.temperature).toBe(0);
    }
  });
});

describe("the label is derived from the RESPONSE", () => {
  it("records the model the response reported, not the one requested", async () => {
    const s = script(ok("I have a fever", "google/gemini-2.5-flash-lite-preview-09-2025"));
    const r = await run(HINDI, s.chat);
    expect(r).toMatchObject({ model: "google/gemini-2.5-flash-lite-preview-09-2025" });
  });

  it("names the fallback that answered", async () => {
    const s = script(new Response("", { status: 500 }), ok("x", "openai/gpt-5-nano-2025"));
    expect(await run(HINDI, s.chat)).toMatchObject({ model: "openai/gpt-5-nano-2025" });
  });

  it("a skipped window is labelled skip:english, never as a translation", async () => {
    const s = script();
    const r = await run("How many days have you had the fever", s.chat);
    expect(r).toMatchObject({ status: "ok", model: SKIP_ENGLISH_LABEL, english: "How many days have you had the fever" });
    expect(s.calls).toEqual([]);
  });

  it("records input_chars before truncation", async () => {
    const s = script(ok());
    const r = await run(HINDI, s.chat);
    expect(r).toMatchObject({ input_chars: HINDI.length });
  });
});

describe("the verified-English skip — the label never decides", () => {
  it("English is skipped", () => {
    expect(verifiedEnglish("Take one tablet twice a day after food")).toBe(true);
  });
  it("romanised Hindi is translated", async () => {
    expect(verifiedEnglish(ROMANISED)).toBe(false);
    const s = script(ok());
    await run(ROMANISED, s.chat);
    expect(s.calls.length).toBe(1);
    expect((s.calls[0]!.body.messages as Array<{ content: string }>)[1]!.content).toBe(ROMANISED);
  });
  it("Malayalam and Bengali script are translated", () => {
    expect(verifiedEnglish("എത്ര ദിവസമായി")).toBe(false);
    expect(verifiedEnglish("আপনার জ্বর কত দিন")).toBe(false);
  });
  it("the langHint argument cannot force a skip or block one", async () => {
    const s1 = script(ok());
    await translateToEnglish(ROMANISED, "en", { chat: s1.chat, env: ENV });
    expect(s1.calls.length).toBe(1);                      // `en` does not skip Hindi
    const s2 = script();
    await translateToEnglish("What is your name and how old are you", "kn", { chat: s2.chat, env: ENV });
    expect(s2.calls).toEqual([]);                         // `kn` does not block English
  });
  it("thresholds: >=90% ASCII letters, >=20% function words", () => {
    expect(verifiedEnglish("the zzz zzz zzz zzz")).toBe(true);          // 20%
    expect(verifiedEnglish("the zzz zzz zzz zzz zzz")).toBe(false);     // < 20%
    expect(verifiedEnglish("... 123 ...")).toBe(false);                 // no letters
  });
});

describe("the key — header only, never logged, never in an error", () => {
  it("is sent in the Authorization header and nowhere else in the request", async () => {
    const s = script(ok());
    await run(HINDI, s.chat);
    const c = s.calls[0]!;
    expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.stringify(c.body)).not.toContain(FAKE_KEY);
    expect(c.url).not.toContain(FAKE_KEY);
  });

  it("never appears in logs, results or error codes, on any failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const failures: Array<Response | Error> = [
      new Response("", { status: 401 }), new Response("", { status: 500 }),
      new TypeError(`connect failed ${FAKE_KEY}`), new Response("not json", { status: 200 }),
    ];
    const results: unknown[] = [];
    for (const f of failures) {
      const s = script(f, f instanceof Error ? f : new Response("", { status: (f as Response).status }));
      results.push(await run(HINDI, s.chat));
    }
    const logged = spies.flatMap((s) => s.mock.calls).map((a) => JSON.stringify(a)).join("\n");
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toContain(FAKE_KEY);
    expect(JSON.stringify(results)).not.toContain(FAKE_KEY);
  });

  it("never reaches argv, and the client spawns nothing", () => {
    expect(process.argv.join(" ")).not.toContain(FAKE_KEY);
    const src = readFileSync("lib/openrouter.ts", "utf8");
    expect(src).not.toMatch(/child_process|spawn|execFile/);
  });

  it("comes from OPENROUTER_API_KEY, else the key file, read at call time", () => {
    const dir = mkdtempSync(join(tmpdir(), "orkey-"));
    const file = join(dir, "key");
    writeFileSync(file, "sk-or-v1-FROM-FILE\n");
    expect(readOpenRouterKey({ OPENROUTER_API_KEY: "sk-direct" })).toBe("sk-direct");
    expect(readOpenRouterKey({ OPENROUTER_API_KEY_FILE: file })).toBe("sk-or-v1-FROM-FILE");
    writeFileSync(file, "sk-or-v1-ROTATED\n");
    expect(readOpenRouterKey({ OPENROUTER_API_KEY_FILE: file })).toBe("sk-or-v1-ROTATED");   // not cached
  });

  it("no key at all is a coded failure, not a crash — and the source is still not English", async () => {
    expect(() => readOpenRouterKey({})).toThrow(OpenRouterError);
    const r = await translateToEnglish(HINDI, "hi", { env: {} });
    expect(r).toEqual({ status: "failed", reason: "openrouter_no_key" });
  });
});
