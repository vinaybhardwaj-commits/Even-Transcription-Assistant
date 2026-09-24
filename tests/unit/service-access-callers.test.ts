/**
 * TUNNEL-HARDENING P2(b) — EVERY server-side caller of a service hostname sends the Access headers when they are
 * configured, and changes by nothing when they are not.
 *
 * Enforcing Access on a hostname whose callers do not send headers takes that service down, so this is the test that
 * has to be true BEFORE anyone turns enforcement on. Each caller is driven for real against a stubbed fetch and the
 * request it actually made is inspected. A caller that is missing from this list is a caller nobody checked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({ sql: async () => [] }));
vi.mock("@/lib/diarize-gate", () => ({
  DIARIZE_QUEUE_WAIT_MS: () => 0,
  acquireDiarizeSlot: async () => ({ acquired: true, hold: { queueWaitMs: 0, ungated: false, release: async () => {} } }),
}));

import { transcribeWithWhisper } from "@/lib/whisper";
import { runDiarize } from "@/lib/diarize";
import { embedSpeakers } from "@/lib/diarize-embed";
import { requestSpeechRegions } from "@/lib/diarize-vad-trim";
import { runEnroll } from "@/lib/enroll";
import { emotionHealth, scoreSegments } from "@/lib/emotion/client";
import { routeTranscribe, submitRouteJob, pollRouteJob } from "@/lib/stt/eta-router";
import { runRouteProbe } from "@/lib/stt/adapters/route";
import { indicconformerAdapter } from "@/lib/stt/adapters/indicconformer";
import { whisperAdapter } from "@/lib/stt/adapters/whisper";
import { runWhisperProbe } from "@/lib/health/whisper-probe";
import { probePyannote } from "@/lib/mcp/tools/health";
import { embedQuery as kbEmbedQuery } from "@/lib/kb-embed";
import { fetchOllamaModels } from "@/lib/health/ollama-probe";
import { resetBreakers } from "@/lib/service-pool";

const VARS = [
  "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "CF_ACCESS_HOST_SUFFIXES",
  "WHISPER_BASE_URL", "DIARIZE_BASE_URL", "EMOTION_BASE_URL", "EMOTION_SEGMENTS_SECRET", "INDICCONFORMER_BASE_URL",
  "ETA_ROUTER_URL", "WHISPER_BASE_URLS", "WHISPER_BULK_URLS", "DIARIZE_BASE_URLS", "DIARIZE_BULK_URLS", "EMOTION_BASE_URLS",
  "OLLAMA_BASE_URL", "LLM_API_KEY", "EMOTION_BULK_URLS", "ETA_ROUTER_URLS", "ETA_ROUTER_BULK_URLS", "INDICCONFORMER_BASE_URLS", "INDICCONFORMER_BULK_URLS", "BULK_AGE_MINUTES",
];
const saved: Record<string, string | undefined> = {};
type Seen = { url: string; headers: Headers; redirect: RequestRedirect | undefined };
let seen: Seen[] = [];

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const record = (input: string | URL | Request, init?: RequestInit) => {
  seen.push({ url: typeof input === "string" ? input : input instanceof Request ? input.url : input.toString(), headers: new Headers(init?.headers), redirect: init?.redirect });
};
const reply = (url: string): unknown => {
  if (url.endsWith("/embed_speakers")) return { ok: true, speakers: [] };
  if (url.endsWith("/speech_regions")) return { ok: true, regions: [], total_samples: 16000, sample_rate: 16000 };
  if (url.endsWith("/enroll")) return { ok: true, embedding_base64: "AAAA", dim: 1 };
  if (url.endsWith("/diarize")) return { speakers: [], transcript_segments: [] };
  if (url.endsWith("/route/job")) return { job_id: "j1" };
  if (url.includes("/route/job/")) return { ok: true, state: "running" };
  if (url.endsWith("/route")) return { ok: true, transcript_native: "x" };
  if (url.endsWith("/health") || url.endsWith("/healthz")) return { ok: true, max_duration_s: 60, min_speech_s: 1.5, models: {}, device: "cpu" };
  if (url.endsWith("/embeddings")) return { object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], model: "m", usage: { prompt_tokens: 1, total_tokens: 1 } };
  if (url.endsWith("/models")) return { object: "list", data: [] };
  if (url.endsWith("/inference")) return { text: "hello", language: "en", duration: 1, segments: [] };
  return { ok: true };
};
const svcFetch = async (input: string | URL | Request, init?: RequestInit) => { record(input, init); return ok(reply(String(input))); };

const HOST = "llmvinayminihome.uk";
const SP = [{ idx: 0, start_s: 0, end_s: 2, total_speech_sec: 2 }];
const RP = { pad_s: 0, merge_gap_s: 0, min_region_s: 0, threshold: 0.5, min_silence_ms: 100, speech_pad_ms: 30, min_speech_ms: 250 } as never;

/** Every caller, each making one real request to a `*.llmvinayminihome.uk` service. The label is what a failure names. */
const CALLERS: Array<[string, () => Promise<unknown>]> = [
  ["whisper /inference (lib/whisper.ts)", () => transcribeWithWhisper(new Uint8Array([1]))],
  ["whisper adapter health", () => whisperAdapter.health()],
  ["whisper probe (health tool)", () => runWhisperProbe({ readFixture: async () => new Uint8Array([1]), fetchImpl: svcFetch })],
  ["diarize /diarize", () => runDiarize(new Uint8Array([1]), "audio/webm", { encounterId: "w" })],
  ["diarize /embed_speakers", () => embedSpeakers(new Uint8Array([1]), SP, [], { batchThreshold: 0.65, label: "w" })],
  ["diarize /speech_regions", () => requestSpeechRegions(new Uint8Array([1]), RP, { label: "w", allowCut: [] })],
  ["diarize /enroll", () => runEnroll(new Uint8Array([1]), "audio/webm")],
  ["pyannote /health probe", () => probePyannote()],
  ["emotion /health", () => emotionHealth(svcFetch)],
  ["emotion /inference/wavlm/segments", () => scoreSegments("https://r2.example/p", [{ start_s: 0, end_s: 1 }], svcFetch)],
  ["router /route (sync)", () => routeTranscribe(new Uint8Array([1]))],
  ["router /route/job (submit)", () => submitRouteJob("https://r2.example/a")],
  ["router /route/job/{id} (poll)", () => pollRouteJob("j1")],
  ["router probe", () => runRouteProbe({ readFixture: async () => new Uint8Array([1]), fetchImpl: svcFetch })],
  ["indicconformer /inference", () => indicconformerAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm", language: "kn" })],
  ["indicconformer /healthz", () => indicconformerAdapter.health()],
  // Ruling 121 — the ollama host, before llm goes behind Access.
  ["ollama /embeddings (lib/kb-embed.ts)", () => kbEmbedQuery("hello")],
  ["ollama /models probe (health route + dashboard, one helper)", () => fetchOllamaModels(process.env.OLLAMA_BASE_URL!, 1000)],
];

const setServiceEnv = () => {
  process.env.WHISPER_BASE_URL = `https://whisper.${HOST}`;
  process.env.DIARIZE_BASE_URL = `https://diarize.${HOST}`;
  process.env.EMOTION_BASE_URL = `https://emotion.${HOST}`;
  process.env.EMOTION_SEGMENTS_SECRET = "seg";
  process.env.INDICCONFORMER_BASE_URL = `https://indic.${HOST}`;
  process.env.ETA_ROUTER_URL = `https://route.${HOST}`;
  process.env.OLLAMA_BASE_URL = `https://llm.${HOST}/v1`;
};

beforeEach(() => {
  for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  seen = [];
  resetBreakers();
  vi.stubGlobal("fetch", svcFetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("token configured → every caller sends it to its service host", () => {
  for (const [label, run] of CALLERS) {
    it(label, async () => {
      setServiceEnv();
      process.env.CF_ACCESS_CLIENT_ID = "the-id";
      process.env.CF_ACCESS_CLIENT_SECRET = "the-secret";
      await run();
      expect(seen.length, `${label} made no request, so it proves nothing`).toBeGreaterThan(0);
      for (const r of seen) {
        expect(new URL(r.url).hostname.endsWith(`.${HOST}`), r.url).toBe(true);
        expect(r.headers.get("CF-Access-Client-Id"), `${label} → ${r.url}`).toBe("the-id");
        expect(r.headers.get("CF-Access-Client-Secret"), `${label} → ${r.url}`).toBe("the-secret");
        expect(r.redirect, `${label} → ${r.url} must refuse a redirect while it carries the token`).toBe("error");
      }
    });
  }
});

describe("DARK: token not configured → no caller adds anything", () => {
  for (const [label, run] of CALLERS) {
    it(label, async () => {
      setServiceEnv();
      await run();
      expect(seen.length).toBeGreaterThan(0);
      for (const r of seen) {
        expect(r.headers.has("CF-Access-Client-Id"), `${label} → ${r.url}`).toBe(false);
        expect(r.headers.has("CF-Access-Client-Secret"), `${label} → ${r.url}`).toBe(false);
        expect(r.redirect, `${label} → ${r.url}: DARK means no redirect key at all`).toBeUndefined();
      }
    });
  }
});

describe("the shared ollama probe keeps its own authorization header in BOTH modes (Refuter-2)", () => {
  it("default key, custom key, token on and off", async () => {
    const base = `https://llm.${HOST}/v1`;
    await fetchOllamaModels(base, 1000);
    expect(seen[0].headers.get("authorization")).toBe("Bearer ollama");
    process.env.LLM_API_KEY = "custom-key";
    await fetchOllamaModels(base, 1000);
    expect(seen[1].headers.get("authorization")).toBe("Bearer custom-key");
    process.env.CF_ACCESS_CLIENT_ID = "the-id";
    process.env.CF_ACCESS_CLIENT_SECRET = "the-secret";
    await fetchOllamaModels(base, 1000);
    expect(seen[2].headers.get("authorization"), "attaching the token must not drop it").toBe("Bearer custom-key");
    expect(seen[2].headers.get("CF-Access-Client-Id")).toBe("the-id");
  });
});

describe("an Access login redirect must not read as healthy (Refuter-2 R1)", () => {
  // What Access does to a call whose token it rejects: 302 to its login page, which answers 200. `redirect: "error"`
  // makes undici throw instead of following it; without that option the stub follows and answers the login page's 200.
  const accessLike = async (input: string | URL | Request, init?: RequestInit) => {
    record(input, init);
    if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
    return ok({ login: "page" });
  };
  it("with the token attached, a rejected token turns the health probes RED, not green", async () => {
    setServiceEnv();
    process.env.CF_ACCESS_CLIENT_ID = "the-id";
    process.env.CF_ACCESS_CLIENT_SECRET = "the-secret";
    vi.stubGlobal("fetch", accessLike);
    expect((await whisperAdapter.health()).ok).toBe(false);
    expect((await indicconformerAdapter.health()).ok).toBe(false);
    expect((await probePyannote()).ok).toBe(false);
  });
  it("DARK, the same stub follows the redirect exactly as before (nothing changed by shipping this)", async () => {
    setServiceEnv();
    vi.stubGlobal("fetch", accessLike);
    expect((await whisperAdapter.health()).ok).toBe(true);
    expect((await indicconformerAdapter.health()).ok).toBe(true);
  });
});

describe("the token never travels to a host that is not a service host", () => {
  it("a service pointed at another vendor's host gets nothing", async () => {
    process.env.CF_ACCESS_CLIENT_ID = "the-id";
    process.env.CF_ACCESS_CLIENT_SECRET = "the-secret";
    process.env.WHISPER_BASE_URL = "https://whisper.other-vendor.example";
    process.env.DIARIZE_BASE_URL = "http://diarize.llmvinayminihome.uk"; // cleartext
    await transcribeWithWhisper(new Uint8Array([1]));
    await runDiarize(new Uint8Array([1]), "audio/webm", { encounterId: "w" });
    expect(seen.length).toBe(2);
    for (const r of seen) {
      expect(r.headers.has("CF-Access-Client-Id"), r.url).toBe(false);
      expect(r.headers.has("CF-Access-Client-Secret"), r.url).toBe(false);
    }
  });
});

describe("bulk pools carry it too — every endpoint in a *_BULK_URLS list", () => {
  it("a bulk whisper endpoint on a twin hostname gets the token", async () => {
    process.env.CF_ACCESS_CLIENT_ID = "the-id";
    process.env.CF_ACCESS_CLIENT_SECRET = "the-secret";
    process.env.BULK_AGE_MINUTES = "60";
    process.env.WHISPER_BASE_URL = `https://whisper.${HOST}`;
    process.env.WHISPER_BULK_URLS = `https://whisper-box.${HOST},https://whisper-gcpl4.${HOST}`;
    process.env.ETA_ROUTER_BULK_URLS = `https://route-box.${HOST}`;
    process.env.INDICCONFORMER_BULK_URLS = `https://indic-box.${HOST}`;
    const { withPoolContext } = await import("@/lib/service-pool");
    await withPoolContext({ bulk: true }, async () => {
      await transcribeWithWhisper(new Uint8Array([1]));
      await submitRouteJob("https://r2.example/a");
      await indicconformerAdapter.transcribe(Buffer.from([1]), { contentType: "audio/webm", language: "kn" });
    });
    expect(seen.map((r) => new URL(r.url).hostname)).toEqual([`whisper-box.${HOST}`, `route-box.${HOST}`, `indic-box.${HOST}`]);
    for (const r of seen) expect(r.headers.get("CF-Access-Client-Id"), r.url).toBe("the-id");
  });
});

describe("no caller can be added without the wrapper (source scan)", () => {
  it("every lib/ or app/ file that reads a service base URL or a pool and calls fetch imports service-access", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    // Pool callers never NAME an env var (endpointsFor("diarize_embed") does it for them), so the trigger is the pool helpers
    // too (Refuter-2 R2). bench-join is the audio-join service: a Worker, not a tunnel hostname, with its own AUDIO_JOIN_TOKEN.
    const NOT_A_TUNNEL_HOST = new Set(["lib/bench-join.ts"]);
    const POOL_HELPERS = /\b(endpointsFor|poolEndpoints)\(/;
    const SERVICE_ENVS = /\b(WHISPER_BASE_URLS?|WHISPER_BULK_URLS|DIARIZE_BASE_URLS?|DIARIZE_BULK_URLS|EMOTION_BASE_URLS?|EMOTION_BULK_URLS|INDICCONFORMER_BASE_URLS?|INDICCONFORMER_BULK_URLS|ETA_ROUTER_URLS?|ETA_ROUTER_BULK_URLS|OLLAMA_BASE_URL)\b/;
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
      });
    const missing: string[] = [];
    for (const f of [...walk("lib"), ...walk("app")]) {
      const src = readFileSync(f, "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (NOT_A_TUNNEL_HOST.has(f)) continue;
      const reachesAService = SERVICE_ENVS.test(code) || POOL_HELPERS.test(code);
      // `new OpenAI(` counts as a call only in a file that already reaches a service (lib/llm.ts): the vendor OpenAI client in
      // lib/stt/scoring.ts reads no service URL and must NEVER carry the token.
      if (reachesAService && /\bfetch(Impl)?\(|doFetch\(|new OpenAI\(/.test(code) && !/service-access|health\/ollama-probe/.test(code)) missing.push(f);
    }
    expect(missing, "a caller of a service hostname that never sends the Access headers").toEqual([]);
  });
});

// LAST in the file on purpose: vi.resetModules() gives later dynamic imports a fresh module graph, which would split the
// pool context the bulk test above depends on.
describe("lib/llm.ts — the OpenAI SDK client (ruling 121)", () => {
  const opts: Array<Record<string, unknown>> = [];
  const load = async () => {
    opts.length = 0;
    vi.resetModules();
    vi.doMock("openai", () => ({ default: class { constructor(o: Record<string, unknown>) { opts.push(o); } } }));
    return import("@/lib/llm");
  };
  afterEach(() => { vi.doUnmock("openai"); vi.resetModules(); });

  it("DARK: no token → the client is constructed with NO fetch option, exactly as before", async () => {
    process.env.OLLAMA_BASE_URL = `https://llm.${HOST}/v1`;
    await load();
    expect(opts).toHaveLength(1);
    expect("fetch" in opts[0]).toBe(false);
    expect(opts[0]).toEqual({ baseURL: `https://llm.${HOST}/v1`, apiKey: "ollama" });
  });
  it("a Request input keeps its OWN headers (fetch would replace them with init's), and a URL input works (Refuter-2)", async () => {
    process.env.CF_ACCESS_CLIENT_ID = "the-id";
    process.env.CF_ACCESS_CLIENT_SECRET = "the-secret";
    const { serviceAccessFetch } = await import("@/lib/service-access");
    await serviceAccessFetch(new Request(`https://llm.${HOST}/v1/embeddings`, { method: "POST", headers: { "x-own": "kept" } }));
    await serviceAccessFetch(new URL(`https://llm.${HOST}/v1/models`));
    expect(seen).toHaveLength(2);
    expect(seen[0].url).toBe(`https://llm.${HOST}/v1/embeddings`);
    expect(seen[0].headers.get("x-own"), "the Request's own header survives").toBe("kept");
    expect(seen[0].headers.get("CF-Access-Client-Id")).toBe("the-id");
    expect(seen[0].redirect).toBe("error");
    expect(seen[1].headers.get("CF-Access-Client-Id")).toBe("the-id");
  });
  it("token configured → the client gets serviceAccessFetch, and each request carries the token to an allowed host only", async () => {
    process.env.OLLAMA_BASE_URL = `https://llm.${HOST}/v1`;
    process.env.CF_ACCESS_CLIENT_ID = "the-id";
    process.env.CF_ACCESS_CLIENT_SECRET = "the-secret";
    await load();
    const f = opts[0].fetch as (u: string, i?: RequestInit) => Promise<Response>;
    expect(typeof f).toBe("function");
    await f(`https://llm.${HOST}/v1/embeddings`, { method: "POST", headers: { authorization: "Bearer ollama" } });
    await f("https://api.sarvam.ai/x", { method: "POST" });
    expect(seen).toHaveLength(2);
    expect(seen[0].headers.get("CF-Access-Client-Id")).toBe("the-id");
    expect(seen[0].headers.get("authorization"), "the SDK's own header is kept").toBe("Bearer ollama");
    expect(seen[0].redirect).toBe("error");
    expect(seen[1].headers.has("CF-Access-Client-Id"), "another vendor's host gets nothing").toBe(false);
  });
});
