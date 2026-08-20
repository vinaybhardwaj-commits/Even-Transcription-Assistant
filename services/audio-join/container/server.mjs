/**
 * services/audio-join/container/server.mjs — the joining process inside the container.
 *
 * It does exactly one thing: take a framed job (header + piece bytes, in order) on POST /join,
 * run ffmpeg once, and answer with the joined bytes or a named reason. It never talks to storage
 * and never reaches the network — the image runs with `enableInternet = false` and holds no
 * credential of any kind. The Worker reads the pieces through its R2 binding and writes the clip
 * back through the same binding; this process only sees bytes.
 *
 * Routes:
 *   GET  /health → { ok:true }              (readiness)
 *   POST /join   → audio/webm bytes, with x-join-duration-ms
 *                  or application/json { ok:false, error } — never a bare 500
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFfmpegArgs, unframeJob, MAX_INPUT_BYTES } from "./join-core.mjs";

const PORT = Number(process.env.PORT || 8080);
/** A 30-minute re-encode on the configured instance is seconds, not minutes; 10 minutes is a
 *  ceiling that lets a pathological file fail by name instead of hanging the DO. */
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 600_000);

const json = (res, status, body) => {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
  res.end(payload);
};

/** Read the whole request body, refusing anything past the input bound. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_INPUT_BYTES) {
        reject(Object.assign(new Error("input_too_large"), { named: "input_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    // ffmpeg is chatty on stderr even at loglevel error; keep only the tail for the reason.
    child.stderr.on("data", (d) => { err = (err + d.toString()).slice(-4000); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e?.message ?? e), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
  });
}

/** ffprobe the joined clip. Returns null when ffprobe is unavailable or says nothing useful —
 *  the caller then falls back to the trim window, and says which it used. */
async function probeDurationMs(path) {
  const r = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path,
  ], 30_000);
  if (r.code !== 0) return null;
  const seconds = Number(String(r.out).trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

async function handleJoin(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 200, { ok: false, error: e?.named ?? "body_read_failed" });
  }

  let header;
  let pieces;
  try {
    ({ header, pieces } = unframeJob(new Uint8Array(body)));
  } catch {
    return json(res, 200, { ok: false, error: "bad_frame" });
  }
  if (!pieces.length) return json(res, 200, { ok: false, error: "no_pieces" });

  const startMs = Number(header?.trim?.start_ms ?? 0);
  const endMs = Number(header?.trim?.end_ms ?? 0);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !(endMs > startMs)) {
    return json(res, 200, { ok: false, error: "bad_trim" });
  }

  const dir = await mkdtemp(join(tmpdir(), "join-"));
  try {
    // Position in the frame == position in the join. The names are padded so even a stray
    // directory listing keeps the order the caller asked for.
    const files = [];
    for (let i = 0; i < pieces.length; i++) {
      const p = join(dir, `p${String(i).padStart(4, "0")}.webm`);
      await writeFile(p, pieces[i]);
      files.push(p);
    }
    const outPath = join(dir, "out.webm");
    const r = await run("ffmpeg", buildFfmpegArgs(files, startMs, endMs, outPath), FFMPEG_TIMEOUT_MS);
    if (r.timedOut) return json(res, 200, { ok: false, error: "ffmpeg_timeout" });
    if (r.code !== 0) {
      return json(res, 200, { ok: false, error: "ffmpeg_failed", detail: r.err.slice(-600) });
    }
    let bytes;
    try {
      bytes = await readFile(outPath);
    } catch {
      return json(res, 200, { ok: false, error: "output_missing" });
    }
    if (bytes.length === 0) return json(res, 200, { ok: false, error: "output_empty" });

    const probed = await probeDurationMs(outPath);
    res.writeHead(200, {
      "content-type": "audio/webm",
      "content-length": bytes.length,
      "x-join-duration-ms": String(probed ?? endMs - startMs),
      "x-join-duration-source": probed === null ? "trim_window" : "ffprobe",
      "x-join-pieces": String(pieces.length),
    });
    res.end(bytes);
    return undefined;
  } catch (e) {
    return json(res, 200, { ok: false, error: "join_failed", detail: String(e?.message ?? e).slice(0, 300) });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://container").pathname;
  if (req.method === "GET" && (path === "/health" || path === "/")) return json(res, 200, { ok: true });
  if (req.method === "POST" && path === "/join") return void handleJoin(req, res);
  return json(res, 404, { ok: false, error: "no_such_route" });
});

// The platform sends SIGTERM when the sleepAfter timer expires; exit cleanly so the next wake
// is a cold start of a healthy process rather than a SIGKILL.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

server.listen(PORT, () => {
  console.log(`[audio-join] listening on ${PORT}`);
});
