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
import { resetBreakers } from "@/lib/service-pool";

const VARS = [
  "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "CF_ACCESS_HOST_SUFFIXES",
  "WHISPER_BASE_URL", "DIARIZE_BASE_URL", "EMOTION_BASE_URL", "EMOTION_SEGMENTS_SECRET", "INDICCONFORMER_BASE_URL",
  "ETA_ROUTER_URL", "WHISPER_BASE_URLS", "WHISPER_BULK_URLS", "DIARIZE_BASE_URLS", "DIARIZE_BULK_URLS", "EMOTION_BASE_URLS",
  "EMOTION_BULK_URLS", "ETA_ROUTER_URLS", "ETA_ROUTER_BULK_URLS", "INDICCONFORMER_BASE_URLS", "INDICCONFORMER_BULK_URLS", "BULK_AGE_MINUTES",
];
const saved: Record<string, string | undefined> = {};
type Seen = { url: string; headers: Headers };
let seen: Seen[] = [];

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const record = (input: string | URL | Request, init?: RequestInit) => {
  seen.push({ url: typeof input === "string" ? input : input.toString(), headers: new Headers(init?.headers) });
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
];

const setServiceEnv = () => {
  process.env.WHISPER_BASE_URL = `https://whisper.${HOST}`;
  process.env.DIARIZE_BASE_URL = `https://diarize.${HOST}`;
  process.env.EMOTION_BASE_URL = `https://emotion.${HOST}`;
  process.env.EMOTION_SEGMENTS_SECRET = "seg";
  process.env.INDICCONFORMER_BASE_URL = `https://indic.${HOST}`;
  process.env.ETA_ROUTER_URL = `https://route.${HOST}`;
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
      }
    });
  }
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
  it("every lib/ or app/ file that reads a service base URL and calls fetch imports service-access", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const SERVICE_ENVS = /\b(WHISPER_BASE_URLS?|WHISPER_BULK_URLS|DIARIZE_BASE_URLS?|DIARIZE_BULK_URLS|EMOTION_BASE_URLS?|EMOTION_BULK_URLS|INDICCONFORMER_BASE_URLS?|INDICCONFORMER_BULK_URLS|ETA_ROUTER_URLS?|ETA_ROUTER_BULK_URLS)\b/;
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
      });
    const missing: string[] = [];
    for (const f of [...walk("lib"), ...walk("app")]) {
      const src = readFileSync(f, "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (SERVICE_ENVS.test(code) && /\bfetch(Impl)?\(|doFetch\(/.test(code) && !/service-access/.test(code)) missing.push(f);
    }
    expect(missing, "a caller of a service hostname that never sends the Access headers").toEqual([]);
  });
});
