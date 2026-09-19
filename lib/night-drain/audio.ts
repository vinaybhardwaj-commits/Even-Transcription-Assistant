/**
 * lib/night-drain/audio.ts — a window's audio, without an R2 key on the Mini (ruling A).
 *
 * The 2,450 backlog windows have no joined clip (`clip_r2_key IS NULL`; the only writer of that column
 * is the transcription drain). What they do have is their session's chunks in R2. So:
 *
 *   1. covering chunks   — `resolveRange`, the app's own pure function, on the session's chunk rows
 *                          (production's exact query). Same chunks, same offsets as production's join.
 *   2. a link per chunk  — the Scribe MCP door, `scribe_get_recording` mode=chunk (scope: read). One
 *                          presigned GET per chunk. NOT `scribe_extract_audio`: that joins server-side
 *                          when no room is recording and would write a kept clip to R2 for every window.
 *   3. download          — a plain fetch of the presigned link, in memory.
 *   4. join locally      — with the PRODUCTION join's own ffmpeg argv (`buildFfmpegArgs`, imported from
 *                          services/audio-join, not copied): each piece normalised to 48 kHz mono, the
 *                          concat filter, `atrim` to the window, re-encoded to Opus 32 kbps WebM. The
 *                          trim is `buildJoinRequest`'s (start = offset into the first piece; end =
 *                          start + every covered second). The clip goes to /diarize as audio/webm, so the
 *                          service sees the same input it sees for a window production joined.
 *
 * Presigned links are credentials for their lifetime: they are never logged or stored.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRange, type RangeChunk as AppRangeChunk } from "@/lib/bench-range";
import type { FailedCode, DeferredCode } from "./outcome";
// join-core.mjs is plain JS and tsconfig has allowJs off; the signature is pinned by the cast below and by the tests.
// @ts-ignore TS7016 when allowJs is off; no error when it is on — either way the import is what runs.
import { buildFfmpegArgs as productionJoinArgs } from "../../services/audio-join/container/join-core.mjs";

const buildJoinArgv = productionJoinArgs as (files: string[], startMs: number, endMs: number, outPath: string, format?: string) => string[];

/** The chunk row production loads for a window (lib/stt/room-drain.ts loadWindowContext), field for field. */
export type RangeChunk = AppRangeChunk;
export type Piece = { idx: number; offset_in_chunk_s: number; duration_s: number };

/** Anything that stops a window's audio being assembled. `kind` says what the worker must do about it. */
export type AudioFailure =
  | { ok: false; kind: "failed"; code: FailedCode }
  | { ok: false; kind: "deferred"; code: DeferredCode }
  | { ok: false; kind: "fatal"; code: "mcp_auth_refused" | "mcp_not_configured" }
  | { ok: false; kind: "abandoned" };

const failed = (code: FailedCode): AudioFailure => ({ ok: false, kind: "failed", code });
const deferred = (code: DeferredCode): AudioFailure => ({ ok: false, kind: "deferred", code });
const ABANDONED: AudioFailure = { ok: false, kind: "abandoned" };

export type Plan = { pieces: Piece[]; trimStartMs: number; coveredMs: number };

/** PURE — which chunks, and the trim. Mirrors `buildJoinRequest` (lib/bench-join.ts). */
export function planWindowAudio(chunks: readonly RangeChunk[], startMs: number, endMs: number, source: "primary" | "backup"): { ok: true; plan: Plan } | AudioFailure {
  const res = resolveRange(chunks, startMs, endMs, source);
  if (res.kind === "none") return failed("no_covering_chunks");
  const covering = res.kind === "single" ? [res.covering] : res.covering;
  const pieces: Piece[] = covering.map((c) => ({ idx: c.chunk.idx, offset_in_chunk_s: c.offset_in_chunk_s, duration_s: c.duration_s }));
  return {
    ok: true,
    plan: {
      pieces,
      trimStartMs: Math.round((pieces[0]?.offset_in_chunk_s ?? 0) * 1000),
      coveredMs: Math.round(pieces.reduce((a, p) => a + p.duration_s, 0) * 1000),
    },
  };
}

export type McpConfig = { baseUrl: string; token: string; timeoutMs?: number };
type FetchFn = typeof fetch;

const isAbort = (e: unknown): boolean => (e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError";

/** A signal that fires when either input does; null inputs are ignored. */
function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const live = signals.filter((s): s is AbortSignal => !!s);
  return live.length === 1 ? live[0]! : AbortSignal.any(live);
}

/**
 * One presigned GET for one chunk, from the door. The token is sent in a header and nowhere else.
 * 401/403 is FATAL (a refused credential would otherwise fail every window in turn); network trouble and
 * 5xx are DEFERRED (no row); "no such chunk" is a fact about THIS window and is recorded.
 */
export async function fetchChunkLink(
  cfg: McpConfig, sessionId: string, idx: number, source: "primary" | "backup", f: FetchFn, signal: AbortSignal,
): Promise<{ ok: true; url: string } | AudioFailure> {
  if (!cfg.baseUrl || !cfg.token) return { ok: false, kind: "fatal", code: "mcp_not_configured" };
  const inner = anySignal(signal, AbortSignal.timeout(cfg.timeoutMs ?? 30_000));
  let res: Response;
  try {
    res = await f(`${cfg.baseUrl.replace(/\/+$/, "")}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "scribe_get_recording", arguments: { session_id: sessionId, mode: "chunk", chunk_idx: idx, source } },
      }),
      signal: inner,
      cache: "no-store",
    });
  } catch (e) {
    if (signal.aborted) return ABANDONED;
    console.warn(`[night-drain] door unreachable (${isAbort(e) ? "timeout" : (e as Error)?.name ?? "error"})`);
    return deferred("mcp_unreachable");
  }
  if (res.status === 401 || res.status === 403) return { ok: false, kind: "fatal", code: "mcp_auth_refused" };
  if (!res.ok) return deferred("mcp_http_error");
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    console.warn(`[night-drain] door answered non-JSON (${(e as Error)?.name ?? "error"})`);
    return deferred("mcp_http_error");
  }
  const r = (body ?? {}) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean }; error?: unknown };
  if (r.error) return deferred("mcp_http_error");
  const sc = r.result?.structuredContent;
  if (!sc || typeof sc !== "object") return deferred("mcp_http_error");
  const err = typeof sc.error === "string" ? sc.error : null;
  if (err === "chunk_not_found" || err === "session_not_found") return failed("chunk_not_found");
  if (err) return deferred("mcp_http_error");
  const url = sc.presigned_get;
  if (typeof url !== "string" || !url) return failed("chunk_link_missing");
  return { ok: true, url };
}

/** One chunk's bytes. 404/403 on a listed chunk is `chunk_gone` (recorded); network / 5xx / 429 is deferred. */
export async function downloadPiece(url: string, f: FetchFn, signal: AbortSignal, timeoutMs = 120_000): Promise<{ ok: true; bytes: Uint8Array } | AudioFailure> {
  const inner = anySignal(signal, AbortSignal.timeout(timeoutMs));
  try {
    const res = await f(url, { signal: inner, cache: "no-store" });
    if (res.status === 404 || res.status === 403) return failed("chunk_gone");
    if (res.status === 429 || res.status >= 500) return deferred("chunk_download_failed");
    if (!res.ok) return failed("chunk_gone");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) return failed("audio_corrupt");
    return { ok: true, bytes };
  } catch (e) {
    if (signal.aborted) return ABANDONED;
    console.warn(`[night-drain] chunk download failed (${isAbort(e) ? "timeout" : (e as Error)?.name ?? "error"})`);
    return deferred("chunk_download_failed");
  }
}

export type RunResult = { code: number | null; stderrTail: string };
export type RunFn = (bin: string, args: string[], signal: AbortSignal) => Promise<RunResult>;

export const runProcess: RunFn = (bin, args, signal) =>
  new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], signal });
    let tail = "";
    p.stderr?.on("data", (d: Buffer) => { tail = (tail + d.toString()).slice(-400); });
    p.on("error", (e) => resolve({ code: null, stderrTail: `spawn:${(e as Error).name}` }));
    p.on("close", (code) => resolve({ code, stderrTail: tail }));
  });

/** A joined Opus clip under this is not a clip. (32 kbps ≈ 4 000 bytes a second.) */
export const MIN_CLIP_BYTES = 2_000;
/** Under one second of covered tape is not audio worth a diarize call. */
export const MIN_COVERED_MS = 1_000;

/** ffmpeg's argument list for the join: PRODUCTION's, for the pieces in order. PURE, so a test can pin it. */
export function joinArgs(files: string[], outPath: string, trimStartMs: number, coveredMs: number): string[] {
  return buildJoinArgv(files, trimStartMs, trimStartMs + coveredMs, outPath);
}

/**
 * Join the pieces into one WebM clip. The temp directory is private to this call and removed in `finally`,
 * whatever happens. Nothing is written outside it.
 */
export async function joinToClip(
  pieces: readonly Uint8Array[], trimStartMs: number, coveredMs: number,
  opts: { ffmpeg: string; run?: RunFn; signal: AbortSignal; tmpRoot?: string },
): Promise<{ ok: true; clip: Buffer; seconds: number } | AudioFailure> {
  if (coveredMs < MIN_COVERED_MS) return failed("audio_empty");
  const run = opts.run ?? runProcess;
  const dir = await mkdtemp(join(opts.tmpRoot ?? tmpdir(), `nd-${randomBytes(3).toString("hex")}-`));
  try {
    const files = pieces.map((_, i) => join(dir, `p${i}.webm`));
    await Promise.all(pieces.map((b, i) => writeFile(files[i]!, b)));
    const out = join(dir, "clip.webm");
    const r = await run(opts.ffmpeg, joinArgs(files, out, trimStartMs, coveredMs), opts.signal);
    if (opts.signal.aborted) return ABANDONED;
    if (r.code !== 0) {
      console.warn(`[night-drain] ffmpeg exit ${r.code}`);
      return failed("audio_corrupt");
    }
    let clip: Buffer;
    try {
      clip = await readFile(out);
    } catch (e) {
      console.warn(`[night-drain] ffmpeg produced no output (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      return failed("audio_corrupt");
    }
    if (clip.byteLength < MIN_CLIP_BYTES) return failed("audio_corrupt");
    return { ok: true, clip, seconds: coveredMs / 1000 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type WindowAudio = {
  ok: true;
  /** The joined WebM clip — what the diarize service is sent (contentType audio/webm). */
  clip: Buffer;
  seconds: number;
  pieces: number;
  bytes: number;
  mcp_ms: number;
  download_ms: number;
  join_ms: number;
};

export type AudioDeps = {
  mcp: McpConfig;
  fetch: FetchFn;
  ffmpeg: string;
  run?: RunFn;
  tmpRoot?: string;
};

/** The whole audio stage for one window. Returns timings so the end-to-end cost is measured, not assumed. */
export async function fetchWindowAudio(
  deps: AudioDeps,
  w: { session_id: string; start_ms: number; end_ms: number; source: "primary" | "backup" },
  chunks: readonly RangeChunk[],
  signal: AbortSignal,
): Promise<WindowAudio | AudioFailure> {
  const planned = planWindowAudio(chunks, w.start_ms, w.end_ms, w.source);
  if (!planned.ok) return planned;
  const { plan } = planned;

  const t0 = Date.now();
  const urls: string[] = [];
  for (const p of plan.pieces) {
    const l = await fetchChunkLink(deps.mcp, w.session_id, p.idx, w.source, deps.fetch, signal);
    if (!l.ok) return l;
    urls.push(l.url);
  }
  const t1 = Date.now();
  const got = await Promise.all(urls.map((u) => downloadPiece(u, deps.fetch, signal)));
  const bad = got.find((g): g is AudioFailure => !g.ok);
  if (bad) return bad;
  const bytes = got.map((g) => (g as { ok: true; bytes: Uint8Array }).bytes);
  const t2 = Date.now();
  const j = await joinToClip(bytes, plan.trimStartMs, plan.coveredMs, { ffmpeg: deps.ffmpeg, run: deps.run, signal, tmpRoot: deps.tmpRoot });
  if (!j.ok) return j;
  const t3 = Date.now();
  return {
    ok: true, clip: j.clip, seconds: j.seconds, pieces: plan.pieces.length,
    bytes: bytes.reduce((a, b) => a + b.byteLength, 0),
    mcp_ms: t1 - t0, download_ms: t2 - t1, join_ms: t3 - t2,
  };
}
