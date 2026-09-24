/**
 * Fable ruling 134.5 — the diarize shared-secret Bearer (client half, DARK until a train carries it and the env is set).
 * POST /diarize, /embed_speakers, /speech_regions and /enroll carry `Authorization: Bearer <DIARIZE_SHARED_SECRET>`; /health never does. The secret only
 * goes to an https host inside the service suffixes, never overrides a caller's own Authorization, and is never logged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({ sql: async () => [] }));
vi.mock("@/lib/diarize-gate", () => ({
  DIARIZE_QUEUE_WAIT_MS: () => 0,
  acquireDiarizeSlot: async () => ({ acquired: true, hold: { queueWaitMs: 0, ungated: false, release: async () => {} } }),
}));

import { runDiarize } from "@/lib/diarize";
import { embedSpeakers } from "@/lib/diarize-embed";
import { requestSpeechRegions } from "@/lib/diarize-vad-trim";
import { runEnroll } from "@/lib/enroll";
import { probePyannote } from "@/lib/mcp/tools/health";
import { withDiarizeAuth } from "@/lib/service-access";
import { resetBreakers } from "@/lib/service-pool";

const SECRET = "s3cr3t-diarize-value";
const HOST = "llmvinayminihome.uk";
const VARS = ["DIARIZE_SHARED_SECRET", "DIARIZE_BASE_URL", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "DIARIZE_BASE_URLS", "DIARIZE_BULK_URLS"];
const saved: Record<string, string | undefined> = {};
type Seen = { url: string; headers: Headers };
let seen: Seen[] = [];

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const reply = (url: string): unknown =>
  url.endsWith("/embed_speakers") ? { ok: true, speakers: [] }
  : url.endsWith("/speech_regions") ? { ok: true, regions: [], total_samples: 16000, sample_rate: 16000 }
  : url.endsWith("/enroll") ? { ok: true, embedding_base64: "AAAA", dim: 1 }
  : url.endsWith("/diarize") ? { speakers: [], transcript_segments: [] }
  : { ok: true, device: "cpu", models: [] };
const svcFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
  seen.push({ url, headers: new Headers(init?.headers) });
  return ok(reply(url));
};

const SP = [{ idx: 0, start_s: 0, end_s: 2, total_speech_sec: 2 }];
const RP = { pad_s: 0, merge_gap_s: 0, min_region_s: 0, threshold: 0.5, min_silence_ms: 100, speech_pad_ms: 30, min_speech_ms: 250 } as never;
const POST_ROUTES: Array<[string, () => Promise<unknown>]> = [
  ["/diarize", () => runDiarize(new Uint8Array([1]), "audio/webm", { encounterId: "w" })],
  ["/embed_speakers", () => embedSpeakers(new Uint8Array([1]), SP, [], { batchThreshold: 0.65, label: "w" })],
  ["/speech_regions", () => requestSpeechRegions(new Uint8Array([1]), RP, { label: "w", allowCut: [] })],
  ["/enroll", () => runEnroll(new Uint8Array([1]), "audio/webm")],
];

beforeEach(() => {
  for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  seen = []; resetBreakers();
  process.env.DIARIZE_BASE_URL = `https://diarize.${HOST}`;
  vi.stubGlobal("fetch", svcFetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("the four diarize POST routes carry the bearer; DARK without it", () => {
  for (const [route, run] of POST_ROUTES) {
    it(`${route}: secret set → Authorization: Bearer, on the diarize host`, async () => {
      process.env.DIARIZE_SHARED_SECRET = SECRET;
      await run();
      expect(seen.length).toBeGreaterThan(0);
      for (const r of seen) {
        expect(r.url.endsWith(route), r.url).toBe(true);
        expect(r.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
      }
    });
    it(`${route}: secret UNSET → no Authorization header at all`, async () => {
      await run();
      expect(seen.length).toBeGreaterThan(0);
      for (const r of seen) expect(r.headers.has("authorization"), r.url).toBe(false);
    });
  }
});

describe("/health stays open", () => {
  it("the pyannote health probe NEVER carries the secret", async () => {
    process.env.DIARIZE_SHARED_SECRET = SECRET;
    await probePyannote();
    expect(seen).toHaveLength(1);
    expect(seen[0].url.endsWith("/health")).toBe(true);
    expect(seen[0].headers.has("authorization")).toBe(false);
  });
});

describe("the secret goes only where it belongs", () => {
  it("a foreign host, a lookalike and a cleartext URL get nothing", () => {
    const env = { DIARIZE_SHARED_SECRET: SECRET };
    for (const u of ["https://api.sarvam.ai/diarize", "https://evil-llmvinayminihome.uk/diarize", "https://llmvinayminihome.uk.evil.example/diarize", `http://diarize.${HOST}/diarize`, "not a url"]) {
      const init = { method: "POST" };
      expect(withDiarizeAuth(u, init, env), u).toBe(init);
    }
    expect(new Headers(withDiarizeAuth<RequestInit>(`https://diarize.${HOST}/diarize`, {}, env).headers).get("authorization")).toBe(`Bearer ${SECRET}`);
  });
  it("a blank value is unset, and the SAME init object comes back when dark", () => {
    const init = { method: "POST" };
    expect(withDiarizeAuth(`https://diarize.${HOST}/x`, init, { DIARIZE_SHARED_SECRET: "   " })).toBe(init);
    expect(withDiarizeAuth(`https://diarize.${HOST}/x`, init, {})).toBe(init);
  });
  it("a caller's own Authorization is never overridden", () => {
    const out = withDiarizeAuth(`https://diarize.${HOST}/x`, { headers: { Authorization: "Bearer mine" } }, { DIARIZE_SHARED_SECRET: SECRET });
    expect(new Headers(out.headers).get("authorization")).toBe("Bearer mine");
  });
  it("it coexists with the Access token: both are sent, and redirects are refused", async () => {
    process.env.DIARIZE_SHARED_SECRET = SECRET;
    process.env.CF_ACCESS_CLIENT_ID = "the-id";
    process.env.CF_ACCESS_CLIENT_SECRET = "the-access-secret";
    await runEnroll(new Uint8Array([1]), "audio/webm");
    expect(seen[0].headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(seen[0].headers.get("CF-Access-Client-Id")).toBe("the-id");
  });
  it("the value never reaches a log", async () => {
    process.env.DIARIZE_SHARED_SECRET = SECRET;
    const spies = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
    for (const [, run] of POST_ROUTES) await run();
    for (const s of spies) expect(JSON.stringify(s.mock.calls), "no log line carries the secret").not.toContain(SECRET);
  });
});
