/**
 * Night drain — the audio stage. Windows have no joined clip, so the drain builds the audio from the session's chunks:
 * the app's own resolveRange picks them, the Scribe MCP door hands out one presigned link per chunk, and ffmpeg joins
 * them locally. What would break these: a different covering set than production's join, the MCP token leaving the
 * Authorization header, a 401 being treated as one window's failure (it would burn every window's retry budget), a
 * failure that maps to nothing, or a temp file left behind.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
// @ts-expect-error — plain ESM shipped inside the container image; no types, by design (as in audio-join-service.test.ts).
import { buildFfmpegArgs } from "../../services/audio-join/container/join-core.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_CLIP_BYTES, downloadPiece, fetchChunkLink, fetchWindowAudio, joinArgs, joinToClip, planWindowAudio,
  type RangeChunk, type RunFn,
} from "@/lib/night-drain/audio";

const chunk = (idx: number, startIso: string, endIso: string, source: "primary" | "backup" = "primary"): RangeChunk =>
  ({ idx, source, r2_key: `k/${idx}`, content_type: "audio/webm", started_at: startIso, ended_at: endIso, upload_state: "verified" });

// The real shape of a 11:30–11:45 IST window (06:00–06:15Z): four five-minute chunks starting 06:56:06.782 the day's clock.
const CHUNKS: RangeChunk[] = [
  chunk(28, "2026-09-18T05:51:06.782Z", "2026-09-18T05:56:06.782Z"),
  chunk(29, "2026-09-18T05:56:06.782Z", "2026-09-18T06:01:06.782Z"),
  chunk(30, "2026-09-18T06:01:06.782Z", "2026-09-18T06:06:06.782Z"),
  chunk(31, "2026-09-18T06:06:06.782Z", "2026-09-18T06:11:06.782Z"),
  chunk(32, "2026-09-18T06:11:06.782Z", "2026-09-18T06:16:06.782Z"),
  chunk(33, "2026-09-18T06:16:06.782Z", "2026-09-18T06:21:06.782Z"),
  chunk(29, "2026-09-18T05:56:06.782Z", "2026-09-18T06:01:06.782Z", "backup"),
];
const START = Date.parse("2026-09-18T06:00:00Z");
const END = Date.parse("2026-09-18T06:15:00Z");
const ac = () => new AbortController();
const MCP = { baseUrl: "https://app.example", token: "tok-SECRET-value-123" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

describe("night drain: which chunks, and the trim", () => {
  it("picks exactly the covering chunks production's join picks, with production's trim", () => {
    const p = planWindowAudio(CHUNKS, START, END, "primary");
    if (!p.ok) throw new Error("expected a plan");
    expect(p.plan.pieces.map((x) => x.idx)).toEqual([29, 30, 31, 32]);
    expect(p.plan.pieces.map((x) => x.duration_s)).toEqual([66.78, 300, 300, 233.22]);
    expect(p.plan.trimStartMs).toBe(233_220);      // how far into the first piece the window begins
    expect(p.plan.coveredMs).toBe(900_000);        // every second of the window that is on tape
  });

  it("uses only the window's own microphone stream", () => {
    const p = planWindowAudio(CHUNKS, START, END, "backup");
    if (!p.ok) throw new Error("expected a plan");
    expect(p.plan.pieces.map((x) => x.idx)).toEqual([29]);
  });

  it("collapses a gap in the tape: covered time is what exists, not the 900 s asked for", () => {
    const gappy = CHUNKS.filter((c) => c.idx !== 31 || c.source === "backup");
    const p = planWindowAudio(gappy, START, END, "primary");
    if (!p.ok) throw new Error("expected a plan");
    expect(p.plan.pieces.map((x) => x.idx)).toEqual([29, 30, 32]);
    expect(p.plan.coveredMs).toBe(600_000);        // 66.78 + 300 + 233.22
  });

  it("names a window with no tape: no_covering_chunks, a recorded failure", () => {
    expect(planWindowAudio(CHUNKS, Date.parse("2026-09-18T12:00:00Z"), Date.parse("2026-09-18T12:15:00Z"), "primary")).toEqual({ ok: false, kind: "failed", code: "no_covering_chunks" });
    expect(planWindowAudio([], START, END, "primary")).toEqual({ ok: false, kind: "failed", code: "no_covering_chunks" });
  });
});

describe("night drain: a presigned link from the door", () => {
  const okBody = (extra: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 1, result: { structuredContent: { mode: "chunk", presigned_get: "https://r2.example/obj?sig=abc", ...extra }, isError: false } });

  it("asks for one chunk in mode=chunk, sends the token only in the Authorization header, and returns the link", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return json(okBody()); }) as unknown as typeof fetch;
    const r = await fetchChunkLink(MCP, "bs_x", 30, "primary", f, ac().signal);
    expect(r).toEqual({ ok: true, url: "https://r2.example/obj?sig=abc" });
    expect(seen!.url).toBe("https://app.example/api/mcp");
    const h = seen!.init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${MCP.token}`);
    const body = JSON.parse(String(seen!.init.body));
    expect(body.method).toBe("tools/call");
    expect(body.params).toEqual({ name: "scribe_get_recording", arguments: { session_id: "bs_x", mode: "chunk", chunk_idx: 30, source: "primary" } });
    expect(seen!.url + String(seen!.init.body)).not.toContain(MCP.token);
  });

  it("treats a refused credential as FATAL — it must stop the worker, not fail every window in turn", async () => {
    for (const status of [401, 403]) {
      const f = (async () => json({ error: "unauthorized" }, status)) as unknown as typeof fetch;
      expect(await fetchChunkLink(MCP, "bs_x", 1, "primary", f, ac().signal)).toEqual({ ok: false, kind: "fatal", code: "mcp_auth_refused" });
    }
  });

  it("treats a missing token or base URL as fatal, before any request", async () => {
    let called = false;
    const f = (async () => { called = true; return json(okBody()); }) as unknown as typeof fetch;
    expect(await fetchChunkLink({ baseUrl: "", token: "x" }, "bs_x", 1, "primary", f, ac().signal)).toMatchObject({ kind: "fatal", code: "mcp_not_configured" });
    expect(await fetchChunkLink({ baseUrl: "https://a", token: "" }, "bs_x", 1, "primary", f, ac().signal)).toMatchObject({ kind: "fatal", code: "mcp_not_configured" });
    expect(called).toBe(false);
  });

  it("defers on server trouble, a network error, non-JSON and a JSON-RPC error — no row is written for any of them", async () => {
    const cases: Array<[string, typeof fetch]> = [
      ["500", (async () => json({}, 500)) as unknown as typeof fetch],
      ["503", (async () => json({}, 503)) as unknown as typeof fetch],
      ["not json", (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch],
      ["rpc error", (async () => json({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "x" } })) as unknown as typeof fetch],
      ["no structured content", (async () => json({ jsonrpc: "2.0", id: 1, result: {} })) as unknown as typeof fetch],
      ["tool failed", (async () => json(okBody({ error: "failsafe_x", presigned_get: undefined }))) as unknown as typeof fetch],
    ];
    for (const [name, f] of cases) expect(await fetchChunkLink(MCP, "bs_x", 1, "primary", f, ac().signal), name).toMatchObject({ ok: false, kind: "deferred", code: "mcp_http_error" });
    const net = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await fetchChunkLink(MCP, "bs_x", 1, "primary", net, ac().signal)).toMatchObject({ kind: "deferred", code: "mcp_unreachable" });
  });

  it("records a chunk the door does not have, and a chunk with no link — facts about THIS window", async () => {
    const nf = (async () => json(okBody({ error: "chunk_not_found", presigned_get: undefined }))) as unknown as typeof fetch;
    expect(await fetchChunkLink(MCP, "bs_x", 1, "primary", nf, ac().signal)).toEqual({ ok: false, kind: "failed", code: "chunk_not_found" });
    const sn = (async () => json(okBody({ error: "session_not_found", presigned_get: undefined }))) as unknown as typeof fetch;
    expect(await fetchChunkLink(MCP, "bs_x", 1, "primary", sn, ac().signal)).toEqual({ ok: false, kind: "failed", code: "chunk_not_found" });
    const nl = (async () => json(okBody({ presigned_get: null }))) as unknown as typeof fetch;
    expect(await fetchChunkLink(MCP, "bs_x", 1, "primary", nl, ac().signal)).toEqual({ ok: false, kind: "failed", code: "chunk_link_missing" });
  });

  it("reports an abort as abandoned, not as an outage", async () => {
    const c = ac(); c.abort();
    const f = (async (_u: string, init: RequestInit) => { if (init.signal?.aborted) throw new DOMException("aborted", "AbortError"); return json(okBody()); }) as unknown as typeof fetch;
    expect(await fetchChunkLink(MCP, "bs_x", 1, "primary", f, c.signal)).toEqual({ ok: false, kind: "abandoned" });
  });
});

describe("night drain: downloading a chunk", () => {
  const resp = (status: number, body: BodyInit | null = "abc") => (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("returns the bytes", async () => {
    const r = await downloadPiece("https://r2.example/o?sig=1", resp(200, new Uint8Array([1, 2, 3])), ac().signal);
    expect(r.ok && Array.from(r.bytes)).toEqual([1, 2, 3]);
  });

  it("records a chunk R2 no longer has (404/403) as chunk_gone, and an empty object as audio_corrupt", async () => {
    for (const s of [404, 403, 400]) expect(await downloadPiece("https://x", resp(s), ac().signal), String(s)).toEqual({ ok: false, kind: "failed", code: "chunk_gone" });
    expect(await downloadPiece("https://x", resp(200, new Uint8Array(0)), ac().signal)).toEqual({ ok: false, kind: "failed", code: "audio_corrupt" });
  });

  it("defers on 5xx, 429 and network trouble — R2 having a bad minute is not this window's fault", async () => {
    for (const s of [500, 502, 503, 429]) expect(await downloadPiece("https://x", resp(s), ac().signal), String(s)).toEqual({ ok: false, kind: "deferred", code: "chunk_download_failed" });
    const net = (async () => { throw new TypeError("terminated"); }) as unknown as typeof fetch;
    expect(await downloadPiece("https://x", net, ac().signal)).toEqual({ ok: false, kind: "deferred", code: "chunk_download_failed" });
  });
});

describe("night drain: joining locally with ffmpeg", () => {
  /** A fake ffmpeg: writes a clip of `bytes` bytes to the last argument. */
  const fakeFfmpeg = (bytes: number, code = 0): RunFn => async (_bin, args) => {
    if (code === 0 && bytes >= 0) writeFileSync(args[args.length - 1]!, Buffer.alloc(bytes));
    return { code, stderrTail: code === 0 ? "" : "Invalid data found when processing input" };
  };
  const scratch = () => mkdtempSync(join(tmpdir(), "nd-a-"));

  it("uses PRODUCTION's join argv — the same builder the joining service runs — with the production trim", () => {
    const files = ["/t/p0.webm", "/t/p1.webm", "/t/p2.webm", "/t/p3.webm"];
    const a = joinArgs(files, "/t/clip.webm", 233_220, 900_000);
    expect(a).toEqual(buildFfmpegArgs(files, 233_220, 1_133_220, "/t/clip.webm"));   // same function, same answer
    // and the facts that make it production's: one -i per piece in order, the concat filter with atrim, Opus 32k WebM
    expect(a.filter((x) => x === "-i")).toHaveLength(4);
    expect(a.filter((_, i) => a[i - 1] === "-i")).toEqual(files);
    const graph = a[a.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("concat=n=4:v=0:a=1[joined]");
    expect(graph).toContain("atrim=start=233.220:end=1133.220,asetpts=PTS-STARTPTS[out]");
    expect(a.slice(a.indexOf("-c:a"))).toEqual(["-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", "-f", "webm", "/t/clip.webm"]);
  });

  it("joins, reports the covered length, and leaves nothing behind", async () => {
    const root = scratch();
    try {
      const r = await joinToClip([new Uint8Array([1]), new Uint8Array([2])], 1000, 900_000, { ffmpeg: "ffmpeg", run: fakeFfmpeg(MIN_CLIP_BYTES + 5000), signal: ac().signal, tmpRoot: root });
      expect(r.ok && r.seconds).toBe(900);
      expect(r.ok && r.clip.byteLength).toBe(MIN_CLIP_BYTES + 5000);
      expect(readdirSync(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("records undecodable audio as audio_corrupt: a non-zero exit, an exit 0 that wrote nothing, and a clip too small to be one", async () => {
    const root = scratch();
    try {
      expect(await joinToClip([new Uint8Array([1])], 0, 5000, { ffmpeg: "f", run: fakeFfmpeg(0, 1), signal: ac().signal, tmpRoot: root })).toEqual({ ok: false, kind: "failed", code: "audio_corrupt" });
      const none: RunFn = async () => ({ code: 0, stderrTail: "" });
      expect(await joinToClip([new Uint8Array([1])], 0, 5000, { ffmpeg: "f", run: none, signal: ac().signal, tmpRoot: root })).toEqual({ ok: false, kind: "failed", code: "audio_corrupt" });
      expect(await joinToClip([new Uint8Array([1])], 0, 5000, { ffmpeg: "f", run: fakeFfmpeg(MIN_CLIP_BYTES - 1), signal: ac().signal, tmpRoot: root })).toEqual({ ok: false, kind: "failed", code: "audio_corrupt" });
      expect(readdirSync(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("records under one second of covered tape as audio_empty, without running ffmpeg at all", async () => {
    let ran = false;
    const run: RunFn = async () => { ran = true; return { code: 0, stderrTail: "" }; };
    expect(await joinToClip([new Uint8Array([1])], 0, 999, { ffmpeg: "f", run, signal: ac().signal })).toEqual({ ok: false, kind: "failed", code: "audio_empty" });
    expect(ran).toBe(false);
  });

  it("reports an abort as abandoned and still removes the temp directory", async () => {
    const root = scratch();
    const c = ac();
    try {
      const run: RunFn = async () => { c.abort(); return { code: null, stderrTail: "" }; };
      expect(await joinToClip([new Uint8Array([1])], 0, 5000, { ffmpeg: "f", run, signal: c.signal, tmpRoot: root })).toEqual({ ok: false, kind: "abandoned" });
      expect(readdirSync(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("really runs ffmpeg when it is installed: garbage in is undecodable, not a crash", async () => {
    const bin = "/opt/homebrew/bin/ffmpeg";
    if (!existsSync(bin)) return;
    const root = scratch();
    try {
      const r = await joinToClip([new Uint8Array([0, 1, 2, 3])], 0, 5000, { ffmpeg: bin, signal: ac().signal, tmpRoot: root });
      expect(r).toEqual({ ok: false, kind: "failed", code: "audio_corrupt" });
      expect(readdirSync(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("night drain: the whole audio stage", () => {
  const W = { session_id: "bs_x", start_ms: START, end_ms: END, source: "primary" as const };
  const linkFor = (idx: number) => json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { presigned_get: `https://r2.example/c${idx}?sig=s${idx}` } } });
  const clipOf = (n: number): RunFn => async (_b, args) => { writeFileSync(args[args.length - 1]!, Buffer.alloc(n)); return { code: 0, stderrTail: "" }; };

  it("fetches four links, downloads four chunks, joins once, and reports every phase's time", async () => {
    const asked: number[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/mcp")) { const idx = JSON.parse(String(init!.body)).params.arguments.chunk_idx as number; asked.push(idx); return linkFor(idx); }
      return new Response(new Uint8Array([9, 9]), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await fetchWindowAudio({ mcp: MCP, fetch: f, ffmpeg: "ffmpeg", run: clipOf(MIN_CLIP_BYTES + 3_600_000) }, W, CHUNKS, ac().signal);
    if (!r.ok) throw new Error("expected audio");
    expect(asked).toEqual([29, 30, 31, 32]);
    expect(r).toMatchObject({ pieces: 4, bytes: 8, seconds: 900 });
    for (const k of ["mcp_ms", "download_ms", "join_ms"] as const) expect(r[k]).toBeGreaterThanOrEqual(0);
  });

  it("stops at the first refused link and downloads nothing", async () => {
    let downloads = 0;
    const f = (async (url: string) => { if (url.endsWith("/api/mcp")) return json({}, 401); downloads += 1; return new Response("x"); }) as unknown as typeof fetch;
    expect(await fetchWindowAudio({ mcp: MCP, fetch: f, ffmpeg: "f" }, W, CHUNKS, ac().signal)).toEqual({ ok: false, kind: "fatal", code: "mcp_auth_refused" });
    expect(downloads).toBe(0);
  });

  it("returns no_covering_chunks without touching the network", async () => {
    let calls = 0;
    const f = (async () => { calls += 1; return json({}); }) as unknown as typeof fetch;
    expect(await fetchWindowAudio({ mcp: MCP, fetch: f, ffmpeg: "f" }, { ...W, start_ms: 0, end_ms: 900_000 }, CHUNKS, ac().signal)).toEqual({ ok: false, kind: "failed", code: "no_covering_chunks" });
    expect(calls).toBe(0);
  });
});
