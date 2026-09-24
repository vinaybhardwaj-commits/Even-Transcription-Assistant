/**
 * REDUNDANCY-R1 Phase 4 — service pools: failover, the breaker, bulk routing, served_by, and the NO-ENV
 * IDENTITY (with none of the new variables set, every client makes exactly the call it made before and
 * returns exactly what it returned before).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const db = { rows: [] as unknown[], calls: [] as string[] };
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    db.calls.push(strings.join("?"));
    return Promise.resolve(db.rows);
  },
}));
vi.mock("@/lib/diarize-gate", () => ({
  DIARIZE_QUEUE_WAIT_MS: () => 0,
  acquireDiarizeSlot: async () => ({ acquired: true, hold: { queueWaitMs: 0, ungated: false, release: async () => {} } }),
}));

import {
  BREAKER_OPEN_MS, breakerOpen, bulkAgeMinutes, isBulkContext, isBulkWindow, poolConfigured, poolEndpoints,
  resetBreakers, runPool, servedByOf, withPoolContext,
} from "@/lib/service-pool";
import { transcribeWithWhisper } from "@/lib/whisper";
import { callJoinService, joinVerdict } from "@/lib/bench-join";
import { runDiarize } from "@/lib/diarize";
import { embedSpeakers } from "@/lib/diarize-embed";
import { requestSpeechRegions } from "@/lib/diarize-vad-trim";
import { runEnroll } from "@/lib/enroll";
import { emotionHealth, scoreSegments, EMOTION_FALLBACK_URL } from "@/lib/emotion/client";
import { withServedBy } from "@/lib/jobs/runner";
import { roomWindowKind } from "@/lib/jobs/kinds/room-window";

const POOL_VARS = [
  "WHISPER_BASE_URL", "WHISPER_BASE_URLS", "WHISPER_BULK_URLS",
  "AUDIO_JOIN_URL", "AUDIO_JOIN_URLS", "AUDIO_JOIN_BULK_URLS", "AUDIO_JOIN_TOKEN",
  "DIARIZE_BASE_URL", "DIARIZE_BASE_URLS", "DIARIZE_BULK_URLS",
  "EMOTION_BASE_URL", "EMOTION_BASE_URLS", "EMOTION_BULK_URLS", "EMOTION_SEGMENTS_SECRET",
  "BULK_AGE_MINUTES",
];
const saved: Record<string, string | undefined> = {};
const calls: string[] = [];
type Reply = { status: number; body: unknown } | "throw";
let route: (url: string) => Reply = () => ({ status: 200, body: {} });

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const fakeFetch = async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input.toString();
  calls.push(url);
  const r = route(url);
  if (r === "throw") throw new TypeError("fetch failed");
  return reply(r.status, r.body);
};

beforeEach(() => {
  for (const k of POOL_VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  calls.length = 0; db.rows = []; db.calls.length = 0;
  resetBreakers();
  vi.stubGlobal("fetch", fakeFetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of POOL_VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const WHISPER_OK = { text: "hello", language: "english", duration: 1, segments: [] };

// ── 1. the endpoint list ────────────────────────────────────────────────────────────────────────
describe("poolEndpoints — which endpoints, in which order", () => {
  it("NO-ENV IDENTITY: only the old single var → exactly [that value], untouched (trailing slash kept)", () => {
    expect(poolEndpoints("whisper", {}, { WHISPER_BASE_URL: "https://mini.example/" })).toEqual(["https://mini.example/"]);
    expect(poolConfigured("whisper", { WHISPER_BASE_URL: "https://mini.example/" })).toBe(false);
  });
  it("nothing set → [] (the caller answers its own 'not configured'); a fallback fills in only then", () => {
    expect(poolEndpoints("join", {}, {})).toEqual([]);
    expect(poolEndpoints("emotion", { fallback: "https://fb.example" }, {})).toEqual(["https://fb.example"]);
    expect(poolEndpoints("emotion", { fallback: "https://fb.example" }, { EMOTION_BASE_URL: "https://e" })).toEqual(["https://e"]);
  });
  it("the list, when set, replaces the single var; blanks and spaces are dropped", () => {
    expect(poolEndpoints("diarize", {}, { DIARIZE_BASE_URL: "https://old", DIARIZE_BASE_URLS: " https://a , ,https://b " }))
      .toEqual(["https://a", "https://b"]);
  });
  it("bulk puts the BULK list first, then the ordinary list, duplicates dropped; not bulk ignores it", () => {
    const env = { WHISPER_BASE_URLS: "https://mini,https://box", WHISPER_BULK_URLS: "https://box,https://gcp" };
    expect(poolEndpoints("whisper", { bulk: true }, env)).toEqual(["https://box", "https://gcp", "https://mini"]);
    expect(poolEndpoints("whisper", { bulk: false }, env)).toEqual(["https://mini", "https://box"]);
  });
  it("served_by is the ORIGIN only — never a path, query or credential", () => {
    expect(servedByOf("https://user:pw@example.com:8443/join/x?t=secret")).toBe("https://example.com:8443");
    expect(servedByOf("not a url")).toBe("unparseable_endpoint");
  });
});

// ── 2. the loop and the breaker ─────────────────────────────────────────────────────────────────
describe("runPool — failover and the breaker", () => {
  const cls = (v: string) => (v === "ok" ? "ok" : v === "down" ? "failover" : "final") as "ok" | "failover" | "final";

  it("fails over past a down endpoint and returns the first good answer", async () => {
    const seen: string[] = [];
    const r = await runPool("whisper", ["a", "b", "c"], async (b) => { seen.push(b); return b === "a" ? "down" : "ok"; }, cls);
    expect(seen).toEqual(["a", "b"]);
    expect(r.value).toBe("ok");
    expect(r.base).toBe("b");
  });
  it("a FINAL answer is the answer: no failover", async () => {
    const seen: string[] = [];
    const r = await runPool("whisper", ["a", "b"], async (b) => { seen.push(b); return "refused"; }, cls);
    expect(seen).toEqual(["a"]);
    expect(r.value).toBe("refused");
  });
  it("the LAST endpoint's failover answer is returned as it came", async () => {
    const r = await runPool("whisper", ["a", "b"], async () => "down", cls);
    expect(r.value).toBe("down");
    expect(r.base).toBe("b");
  });
  it("a throw fails over; the last throw is rethrown unchanged", async () => {
    const e = new Error("boom-b");
    await expect(runPool("join", ["a", "b"], async (b) => { throw b === "a" ? new Error("boom-a") : e; }, cls)).rejects.toBe(e);
  });
  it("BREAKER: 3 consecutive failures open an endpoint for 5 minutes; it is skipped, then tried again", async () => {
    let t = 1_000_000;
    const now = () => t;
    for (let i = 0; i < 3; i++) await runPool("diarize", ["a", "b"], async (b) => (b === "a" ? "down" : "ok"), cls, { now });
    expect(breakerOpen("diarize", "a", t)).toBe(true);
    const seen: string[] = [];
    await runPool("diarize", ["a", "b"], async (b) => { seen.push(b); return "ok"; }, cls, { now });
    expect(seen, "an open endpoint is skipped").toEqual(["b"]);
    t += BREAKER_OPEN_MS - 1;
    expect(breakerOpen("diarize", "a", t)).toBe(true);
    t += 2;
    expect(breakerOpen("diarize", "a", t)).toBe(false);
    seen.length = 0;
    await runPool("diarize", ["a", "b"], async (b) => { seen.push(b); return "ok"; }, cls, { now });
    expect(seen, "after 5 min it is tried again, first").toEqual(["a"]);
  });
  it("BREAKER: two failures then a success do NOT open it (consecutive only)", async () => {
    const seq = ["down", "down", "ok", "down"];
    for (const v of seq) await runPool("emotion", ["a", "b"], async (b) => (b === "a" ? v : "ok"), cls);
    expect(breakerOpen("emotion", "a")).toBe(false);
  });
  it("BREAKER: every endpoint open → all are tried anyway, in order (never 'nothing attempted')", async () => {
    for (let i = 0; i < 3; i++) await runPool("join", ["a", "b"], async () => "down", cls);
    expect(breakerOpen("join", "a") && breakerOpen("join", "b")).toBe(true);
    const seen: string[] = [];
    await runPool("join", ["a", "b"], async (b) => { seen.push(b); return "down"; }, cls);
    expect(seen).toEqual(["a", "b"]);
  });
  it("breakers are per SERVICE: the same URL down for join is not skipped for whisper", async () => {
    for (let i = 0; i < 3; i++) await runPool("join", ["a", "b"], async (b) => (b === "a" ? "down" : "ok"), cls);
    expect(breakerOpen("join", "a")).toBe(true);
    expect(breakerOpen("whisper", "a")).toBe(false);
  });
});

// ── 3. bulk routing ─────────────────────────────────────────────────────────────────────────────
describe("bulk routing", () => {
  it("BULK_AGE_MINUTES: unset/blank = off; strict on a bad value", () => {
    expect(bulkAgeMinutes({})).toBeNull();
    expect(bulkAgeMinutes({ BULK_AGE_MINUTES: " " })).toBeNull();
    expect(bulkAgeMinutes({ BULK_AGE_MINUTES: "90" })).toBe(90);
    expect(() => bulkAgeMinutes({ BULK_AGE_MINUTES: "ninety" })).toThrow();
    expect(() => bulkAgeMinutes({ BULK_AGE_MINUTES: "0" })).toThrow();
  });
  it("a window is bulk only when it closed MORE than the age ago", () => {
    const env = { BULK_AGE_MINUTES: "60" };
    const now = 10_000_000_000;
    expect(isBulkWindow(now - 60 * 60_000, now, env)).toBe(false);
    expect(isBulkWindow(now - 60 * 60_000 - 1, now, env)).toBe(true);
    expect(isBulkWindow(null, now, env)).toBe(false);
    expect(isBulkWindow(now - 999 * 60 * 60_000, now, {})).toBe(false);
  });
  it("inside a bulk context a pooled call tries the BULK endpoint first; outside, the ordinary one", async () => {
    process.env.WHISPER_BASE_URL = "https://mini";
    process.env.WHISPER_BULK_URLS = "https://box";
    route = () => ({ status: 200, body: WHISPER_OK });
    const bulk = await withPoolContext({ bulk: true }, () => transcribeWithWhisper(new Uint8Array([1])));
    expect(calls).toEqual(["https://box/inference"]);
    expect(bulk.served_by).toEqual({ whisper: "https://box" });
    calls.length = 0;
    const live = await withPoolContext({ bulk: false }, () => transcribeWithWhisper(new Uint8Array([1])));
    expect(calls).toEqual(["https://mini/inference"]);
    expect(live.served_by).toEqual({ whisper: "https://mini" });
  });
  it("room_window.poolBulk: BULK_AGE_MINUTES unset → false with NO query (no-env identity)", async () => {
    const out = await roomWindowKind.poolBulk!({ job: {} as never, step: "prepare", args: { window_id: "w1" }, progress: {}, runner: "r" });
    expect(out).toBe(false);
    expect(db.calls).toEqual([]);
  });
  it("room_window.poolBulk: reads the window's own closed_at against BULK_AGE_MINUTES", async () => {
    process.env.BULK_AGE_MINUTES = "60";
    const ctx = { job: {} as never, step: "prepare", args: { window_id: "w1" }, progress: {}, runner: "r" };
    db.rows = [{ closed_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }];
    expect(await roomWindowKind.poolBulk!(ctx)).toBe(true);
    db.rows = [{ closed_at: new Date(Date.now() - 10 * 60_000).toISOString() }];
    expect(await roomWindowKind.poolBulk!(ctx)).toBe(false);
    db.rows = [];
    expect(await roomWindowKind.poolBulk!(ctx)).toBe(false);
    expect(isBulkContext()).toBe(false);
  });
});

// ── 4. every client: identity without the new env, failover with it ─────────────────────────────
describe("whisper", () => {
  it("NO-ENV IDENTITY: one call to the old URL, and no served_by on the result", async () => {
    process.env.WHISPER_BASE_URL = "https://mini/";
    route = () => ({ status: 200, body: WHISPER_OK });
    const r = await transcribeWithWhisper(new Uint8Array([1]));
    expect(calls).toEqual(["https://mini/inference"]);
    expect(r.ok).toBe(true);
    expect("served_by" in r).toBe(false);
  });
  it("a 503 on the first endpoint fails over; the answer says who served it", async () => {
    process.env.WHISPER_BASE_URLS = "https://mini,https://box";
    route = (u) => (u.startsWith("https://mini") ? { status: 503, body: {} } : { status: 200, body: WHISPER_OK });
    const r = await transcribeWithWhisper(new Uint8Array([1]));
    expect(calls).toEqual(["https://mini/inference", "https://box/inference"]);
    expect(r.ok).toBe(true);
    expect(r.served_by).toBe("https://box");
  });
  it("a connect error fails over too", async () => {
    process.env.WHISPER_BASE_URLS = "https://mini,https://box";
    route = (u) => (u.startsWith("https://mini") ? "throw" : { status: 200, body: WHISPER_OK });
    const r = await transcribeWithWhisper(new Uint8Array([1]));
    expect(r.ok && r.served_by).toBe("https://box");
  });
  it("a 4xx is the answer: no failover", async () => {
    process.env.WHISPER_BASE_URLS = "https://mini,https://box";
    route = () => ({ status: 400, body: { error: "bad" } });
    const r = await transcribeWithWhisper(new Uint8Array([1]));
    expect(calls).toEqual(["https://mini/inference"]);
    expect(r.ok).toBe(false);
  });
});

describe("audio join", () => {
  const REQ = { pieces: [] } as never;
  it("NO-ENV IDENTITY: one POST to the old URL, no served_by", async () => {
    process.env.AUDIO_JOIN_URL = "https://join/";
    process.env.AUDIO_JOIN_TOKEN = "t";
    route = () => ({ status: 200, body: { ok: true, key: "k", bytes: 1, duration_ms: 2 } });
    const r = await callJoinService(REQ);
    expect(calls).toEqual(["https://join/join"]);
    expect(r).toEqual({ ok: true, key: "k", bytes: 1, duration_ms: 2 });
  });
  it("BUSY on one instance hands the job to the next: that is the whole point of a second join", async () => {
    process.env.AUDIO_JOIN_URLS = "https://j1,https://j2";
    process.env.AUDIO_JOIN_TOKEN = "t";
    route = (u) => (u.startsWith("https://j1")
      ? { status: 409, body: { ok: false, error: "join_already_running" } }
      : { status: 200, body: { ok: true, key: "k", bytes: 1, duration_ms: 2 } });
    const r = await callJoinService(REQ);
    expect(calls).toEqual(["https://j1/join", "https://j2/join"]);
    expect(r.ok && r.served_by).toBe("https://j2");
  });
  it("every instance busy → the caller still sees join_already_running (T2's wait takes over)", async () => {
    process.env.AUDIO_JOIN_URLS = "https://j1,https://j2";
    process.env.AUDIO_JOIN_TOKEN = "t";
    route = () => ({ status: 409, body: { ok: false, error: "join_already_running" } });
    const r = await callJoinService(REQ);
    expect(!r.ok && r.error).toBe("join_already_running");
  });
  it("a failure the service REPORTED (a hop) is final; unreachable, timeout and 5xx fail over", () => {
    expect(joinVerdict({ ok: false, error: "clip_to_r2_failed", hop: "clip_to_r2" })).toBe("final");
    expect(joinVerdict({ ok: false, error: "join_unreachable" })).toBe("failover");
    expect(joinVerdict({ ok: false, error: "join_timeout" })).toBe("failover");
    expect(joinVerdict({ ok: false, error: "join_http_502" })).toBe("failover");
    expect(joinVerdict({ ok: false, error: "join_http_404" })).toBe("final");
    expect(joinVerdict({ ok: false, error: "join_bad_response", detail: "status 502" })).toBe("failover");
    expect(joinVerdict({ ok: false, error: "join_bad_response", detail: "status 200" })).toBe("final");
  });
});

describe("eta-diarize: /diarize, /embed_speakers, /speech_regions, /enroll share one pool", () => {
  it("/diarize NO-ENV IDENTITY and failover", async () => {
    process.env.DIARIZE_BASE_URL = "https://mini";
    route = () => ({ status: 200, body: { speakers: [], transcript_segments: [] } });
    const one = await runDiarize(new Uint8Array([1]), "audio/webm", { encounterId: "w" });
    expect(calls).toEqual(["https://mini/diarize"]);
    expect("served_by" in one).toBe(false);

    calls.length = 0;
    process.env.DIARIZE_BASE_URLS = "https://mini,https://box";
    route = (u) => (u.startsWith("https://mini") ? { status: 502, body: {} } : { status: 200, body: { speakers: [] } });
    const two = await runDiarize(new Uint8Array([1]), "audio/webm", { encounterId: "w" });
    expect(calls).toEqual(["https://mini/diarize", "https://box/diarize"]);
    expect(two.ok && two.served_by).toBe("https://box");
  });
  it("/embed_speakers fails over on a 5xx and not on a 4xx", async () => {
    process.env.DIARIZE_BASE_URLS = "https://mini,https://box";
    route = (u) => (u.startsWith("https://mini") ? { status: 500, body: {} } : { status: 200, body: { ok: true, speakers: [] } });
    const sp = [{ idx: 0, start_s: 0, end_s: 2, total_speech_sec: 2 }];
    const r = await embedSpeakers(new Uint8Array([1]), sp, [], { batchThreshold: 0.65, label: "w" });
    expect(r.ok && r.served_by).toBe("https://box");
    calls.length = 0;
    route = () => ({ status: 422, body: {} });
    const refused = await embedSpeakers(new Uint8Array([1]), sp, [], { batchThreshold: 0.65, label: "w" });
    expect(calls).toEqual(["https://mini/embed_speakers"]);
    expect(refused.ok).toBe(false);
  });
  it("/speech_regions honours its own env argument for the pool", async () => {
    const env = { DIARIZE_BASE_URLS: "https://mini,https://box" };
    route = (u) => (u.startsWith("https://mini") ? "throw" : { status: 200, body: { ok: true, regions: [], total_samples: 16000, sample_rate: 16000 } });
    const params = { pad_s: 0, merge_gap_s: 0, min_region_s: 0, threshold: 0.5, min_silence_ms: 100, speech_pad_ms: 30, min_speech_ms: 250 } as never;
    const r = await requestSpeechRegions(new Uint8Array([1]), params, { label: "w", allowCut: [], env });
    expect(calls).toEqual(["https://mini/speech_regions", "https://box/speech_regions"]);
    expect(r.ok && r.served_by).toBe("https://box");
  });
  it("/enroll NO-ENV IDENTITY and failover", async () => {
    process.env.DIARIZE_BASE_URL = "https://mini";
    route = () => ({ status: 200, body: { ok: true, embedding_base64: "AAAA" } });
    expect(await runEnroll(new Uint8Array([1]), "audio/webm")).toEqual({ ok: true, embeddingBase64: "AAAA" });
    calls.length = 0;
    process.env.DIARIZE_BASE_URLS = "https://mini,https://box";
    route = (u) => (u.startsWith("https://mini") ? "throw" : { status: 200, body: { ok: true, embedding_base64: "BBBB" } });
    const r = await runEnroll(new Uint8Array([1]), "audio/webm");
    expect(r).toEqual({ ok: true, embeddingBase64: "BBBB", served_by: "https://box" });
  });
});

describe("eta-emotion", () => {
  it("NO-ENV IDENTITY: nothing set → the built-in fallback URL, exactly as before", async () => {
    const f = vi.fn(async (u: string) => { calls.push(u); return reply(500, { ok: false }); });
    const h = await emotionHealth(f);
    expect(calls).toEqual([`${EMOTION_FALLBACK_URL}/health`]);
    expect(h).toEqual({ ok: false, error: "health_http_500" });
  });
  it("health and segments fail over past an unreachable endpoint", async () => {
    process.env.EMOTION_BASE_URLS = "https://mini,https://box";
    process.env.EMOTION_SEGMENTS_SECRET = "s";
    const f = async (u: string) => {
      calls.push(u);
      if (u.startsWith("https://mini")) throw new TypeError("fetch failed");
      return reply(503, { error: "x" });
    };
    const h = await emotionHealth(f);
    expect(calls).toEqual(["https://mini/health", "https://box/health"]);
    expect(h.served_by).toBe("https://box");
    calls.length = 0;
    const s = await scoreSegments("https://r2/presigned", [{ start_s: 0, end_s: 1 }], f);
    expect(calls).toEqual(["https://mini/inference/wavlm/segments", "https://box/inference/wavlm/segments"]);
    expect(s.ok).toBe(false);
    expect(s.served_by).toBe("https://box");
  });
});

// ── 5. the job result ───────────────────────────────────────────────────────────────────────────
describe("served_by reaches the job, derived from the calls", () => {
  it("NO-ENV IDENTITY: nothing served, nothing prior → the SAME outcome object", () => {
    const o = { kind: "done" as const, result: { a: 1 } };
    expect(withServedBy(o, {}, {})).toBe(o);
    const n = { kind: "next" as const, step: "s", progress: { x: 1 } };
    expect(withServedBy(n, null, {})).toBe(n);
  });
  it("a next step carries it in progress; a done job stores prior + this step's on its result", () => {
    const n = withServedBy({ kind: "next", step: "segment", progress: { x: 1 } }, {}, { join: "https://box" });
    expect(n).toEqual({ kind: "next", step: "segment", progress: { x: 1, served_by: { join: "https://box" } } });
    const d = withServedBy({ kind: "done", result: { ok: true } }, { served_by: { join: "https://box" } }, { whisper: "https://gcp" });
    expect(d).toEqual({ kind: "done", result: { ok: true, served_by: { join: "https://box", whisper: "https://gcp" } } });
  });
  it("a fail is left exactly as it is", () => {
    const f = { kind: "fail" as const, error: "x" };
    expect(withServedBy(f, { served_by: { join: "https://box" } }, { whisper: "https://gcp" })).toBe(f);
  });
  it("withPoolContext records what each pooled call actually used, per service", async () => {
    process.env.WHISPER_BASE_URLS = "https://mini,https://box";
    route = (u) => (u.startsWith("https://mini") ? { status: 503, body: {} } : { status: 200, body: WHISPER_OK });
    const { served_by } = await withPoolContext({ bulk: false }, async () => { await transcribeWithWhisper(new Uint8Array([1])); });
    expect(served_by).toEqual({ whisper: "https://box" });
  });
});
