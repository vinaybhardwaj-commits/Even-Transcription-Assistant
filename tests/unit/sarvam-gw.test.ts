/**
 * S8A-FIX — lib/sarvam-gw.ts: the batch calls split for idempotence, transient vs terminal classification, the "auto" source language, and the
 * body-read timeout on downloads. gatewayFetch and global fetch are mocked; no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: Array<{ route: string; init: Record<string, unknown> }> = [];
let respond: (route: string, init: Record<string, unknown>) => Response | Promise<Response> = () => new Response("{}", { status: 200 });
vi.mock("@/lib/sarvam-gateway", async (orig) => ({
  ...((await orig()) as object),
  gatewayFetch: vi.fn(async (route: string, init: Record<string, unknown> = {}) => { calls.push({ route, init }); return respond(route, init); }),
}));

const W = await import("@/lib/sarvam-gw");
const { SarvamGatewayError } = await import("@/lib/sarvam-gateway");
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => { calls.length = 0; respond = () => new Response("{}", { status: 200 }); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("transient vs terminal", () => {
  it("429, 5xx, no status (timeout / network) are transient; any other 4xx is terminal", () => {
    for (const s of [429, 500, 502, 503, 504, undefined]) expect(W.isTransientStatus(s as number | undefined), String(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 422]) expect(W.isTransientStatus(s), String(s)).toBe(false);
  });

  it("every call carries status + transient; the error string never carries a body", async () => {
    respond = () => new Response("SECRET BODY text the patient said", { status: 429 });
    const t = await W.gwTranslateChunk("x", "hi-IN");
    expect(t).toEqual({ ok: false, error: "translate_429", status: 429, transient: true });
    respond = () => new Response("SECRET BODY", { status: 400 });
    expect(await W.gwTranslateChunk("x", "hi-IN")).toEqual({ ok: false, error: "translate_400", status: 400, transient: false });
    respond = () => new Response("", { status: 503 });
    expect(await W.gwBatchInit()).toMatchObject({ ok: false, error: "init_503", transient: true });
    expect(await W.gwBatchStatus("sj")).toMatchObject({ ok: false, error: "status_503", transient: true });
    expect(await W.gwBatchStartJob("sj")).toMatchObject({ ok: false, error: "start_503", transient: true });
    respond = () => new Response("", { status: 403 });
    expect(await W.gwBatchStartJob("sj")).toMatchObject({ ok: false, error: "start_403", status: 403, transient: false });
  });

  it("a thrown gateway error: configuration / key problems are terminal, a Google / AWS 4xx terminal, a 5xx or a network failure transient", async () => {
    const throwing = (e: Error) => { respond = () => { throw e; }; };
    throwing(new SarvamGatewayError("sarvam_gateway_not_configured"));
    expect(await W.gwBatchStatus("sj")).toMatchObject({ ok: false, transient: false, error: "sarvam_gateway_not_configured" });
    throwing(new SarvamGatewayError("sarvam_gateway_key_invalid", "not_json"));
    expect(await W.gwBatchStatus("sj")).toMatchObject({ transient: false });
    throwing(new SarvamGatewayError("sarvam_gateway_sts", "403 AccessDenied"));
    expect(await W.gwBatchStatus("sj")).toMatchObject({ transient: false, status: 403, error: "sarvam_gateway_sts: 403 AccessDenied" });
    throwing(new SarvamGatewayError("sarvam_gateway_sts", "503"));
    expect(await W.gwBatchStatus("sj")).toMatchObject({ transient: true, status: 503 });
    throwing(new SarvamGatewayError("sarvam_gateway_network", "timeout"));
    expect(await W.gwBatchStatus("sj")).toMatchObject({ transient: true });
    throwing(new TypeError("fetch failed"));
    expect(await W.gwBatchStatus("sj")).toMatchObject({ transient: true });
  });
});

describe("the batch submit is three separate idempotent calls", () => {
  it("init creates the job and returns its id (saaras:v3, diarization, timestamps; codemix / speakers only when asked)", async () => {
    respond = () => jsonRes({ job_id: "sj_7" });
    expect(await W.gwBatchInit()).toEqual({ ok: true, jobId: "sj_7" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ job_parameters: { model: "saaras:v3", with_diarization: true, with_timestamps: true } });
    expect(calls[0]!.route).toBe("/speech-to-text/job/v1");
    await W.gwBatchInit({ mode: "codemix", numSpeakers: 3, languageCode: "hi-IN", prompt: "p" });
    expect(JSON.parse(String(calls[1]!.init.body)).job_parameters).toMatchObject({ mode: "codemix", num_speakers: 3, language_code: "hi-IN", prompt: "p" });
    respond = () => jsonRes({});
    expect(await W.gwBatchInit()).toEqual({ ok: false, error: "init_no_job_id", transient: false });
  });

  it("start is its own call, and upload does not start; the Azure PUT is unsigned", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    respond = (route) => (route.endsWith("/upload-files") ? jsonRes({ upload_urls: { "audio.webm": { file_url: "https://blob.example.test/c/audio.webm?sv=2023-01-01&sig=ABC" } } }) : jsonRes({}));
    expect(await W.gwBatchUpload("sj_7", new Uint8Array([1, 2, 3]), "audio/webm; codecs=opus")).toEqual({ ok: true });
    expect(calls.map((c) => c.route)).toEqual(["/speech-to-text/job/v1/upload-files"]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ job_id: "sj_7", files: ["audio.webm"] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string> }];
    expect(url).toContain("blob.example.test");
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({ "x-ms-blob-type": "BlockBlob", "Content-Type": "audio/webm", "x-ms-version": "2023-01-01" });
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    calls.length = 0;
    expect(await W.gwBatchStartJob("sj 7/x")).toEqual({ ok: true });
    expect(calls[0]!.route).toBe("/speech-to-text/job/v1/sj%207%2Fx/start");
  });

  it("an Azure PUT failure is classified (503 transient, 403 terminal, network transient)", async () => {
    respond = () => jsonRes({ upload_urls: { "audio.webm": { file_url: "https://blob.example.test/x" } } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    expect(await W.gwBatchUpload("sj", new Uint8Array(1), "audio/webm")).toMatchObject({ ok: false, error: "azure_put_503", transient: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    expect(await W.gwBatchUpload("sj", new Uint8Array(1), "audio/webm")).toMatchObject({ error: "azure_put_403", transient: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("boom https://blob.example.test/x?sig=SECRET"); }));
    const r = await W.gwBatchUpload("sj", new Uint8Array(1), "audio/webm");
    expect(r).toMatchObject({ ok: false, error: "azure_put_network", transient: true });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
});

describe("G5 — the download timeout covers the body read", () => {
  it("a body that never arrives times out as a transient error instead of hanging the step", async () => {
    vi.useFakeTimers();
    respond = () => jsonRes({ download_urls: { "0.json": { file_url: "https://blob.example.test/0.json?sig=SECRET" } } });
    // headers arrive, the body stream never finishes; it ends only when the request's abort signal fires
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { signal: AbortSignal }) => ({
      ok: true,
      json: () => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))),
    })));
    const p = W.gwBatchResult("sj", ["0.json"]);
    await vi.advanceTimersByTimeAsync(61_000);
    const r = await p;
    expect(r).toEqual({ ok: false, error: "download_timeout", transient: true });
  });

  it("a normal download returns transcript, language and diarized entries; an empty one is terminal", async () => {
    respond = () => jsonRes({ download_urls: { "0.json": { file_url: "https://blob.example.test/0.json" } } });
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ transcript: "hello there", language_code: "en-IN", diarized_transcript: { entries: [{ transcript: "hello there", start_time_seconds: 0, end_time_seconds: 2, speaker_id: 1 }] } })));
    expect(await W.gwBatchResult("sj", ["0.json"])).toEqual({ ok: true, transcript: "hello there", languageCode: "en-IN", entries: [{ transcript: "hello there", start: 0, end: 2, speakerId: "1", languageCode: null }] });
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ transcript: "" })));
    expect(await W.gwBatchResult("sj", ["0.json"])).toEqual({ ok: false, error: "empty_batch_transcript", transient: false });
  });
});

describe("G7 — source language: a code with a region, else auto (the fallback lib/sarvam.ts:312 has always sent to mayura:v1)", () => {
  it("translate bodies", async () => {
    respond = () => jsonRes({ translated_text: "hello" });
    expect(await W.gwTranslateChunk("नमस्ते", "hi-IN")).toEqual({ ok: true, english: "hello" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ input: "नमस्ते", source_language_code: "hi-IN", target_language_code: "en-IN", model: "mayura:v1", mode: "formal" });
    await W.gwTranslateChunk("x", null);
    await W.gwTranslateChunk("x", "hi"); // no region
    await W.gwTranslateChunk("x", undefined);
    for (const c of calls.slice(1)) expect(JSON.parse(String(c.init.body)).source_language_code).toBe("auto");
    respond = () => jsonRes({ translated_text: "  " });
    expect(await W.gwTranslateChunk("x", null)).toEqual({ ok: false, error: "empty_translation", transient: false });
  });

  it("chunkText: <= 900 chars, sentence boundaries, deterministic", () => {
    const text = Array.from({ length: 5 }, (_, i) => `Sentence ${i}. ` + "a".repeat(500)).join(" ");
    const a = W.chunkText(text);
    expect(a).toEqual(W.chunkText(text));
    expect(a.length).toBe(5);
    for (const c of a) expect(c.length).toBeLessThanOrEqual(900);
    expect(W.chunkText("a".repeat(2000)).map((c) => c.length)).toEqual([900, 900, 200]);
    expect(W.chunkText("   ")).toEqual([]);
  });
});
