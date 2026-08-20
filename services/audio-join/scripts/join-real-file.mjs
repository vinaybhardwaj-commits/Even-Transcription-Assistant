/**
 * services/audio-join/scripts/join-real-file.mjs — run REAL tape through the joining path.
 *
 * The unit tests prove the decisions; this proves the audio. Bench recordings are audio-only
 * inside a container format that usually carries video, and several tools mishandle that quietly
 * — a concat that silently produces a five-minute clip from three pieces, or a stream-copy that
 * writes a file no player will seek. Nothing here is synthetic.
 *
 * It runs the container's OWN server (`../container/server.mjs`) as a local process and speaks
 * the same framed protocol the Worker speaks, so the code under test is the code in the image.
 * The only thing it substitutes for is the R2 binding: the pieces arrive by presigned GET rather
 * than through `env.AUDIO`, because a laptop has no binding.
 *
 * Usage:
 *   node services/audio-join/scripts/join-real-file.mjs job.json
 *
 * job.json:
 *   {
 *     "session_id": "bs_…",
 *     "source": "primary",
 *     "window": { "start": "2026-08-19T07:05:00Z", "end": "2026-08-19T07:17:00Z" },
 *     "pieces": [ { "idx": 11, "key": "bench/…", "started_at": "…", "ended_at": "…", "url": "https://…" } ]
 *   }
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { frameHeader, framePiecePrefix, validateJoinRequest } from "../container/join-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8791;

const ms = (v) => Date.parse(v);
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

/** The same mapping `lib/bench-range.ts resolveRange` does, and the same trim arithmetic as
 *  `lib/bench-join.ts buildJoinRequest` — repeated here only because this script runs outside
 *  the Next.js module graph. Any drift shows up as a wrong duration below. */
function coveringFrom(pieces, startMs, endMs) {
  const covering = [];
  for (const p of [...pieces].sort((a, b) => a.idx - b.idx)) {
    const cs = ms(p.started_at);
    const ce = ms(p.ended_at);
    if (ce <= startMs || cs >= endMs) continue;
    const from = Math.max(cs, startMs);
    const to = Math.min(ce, endMs);
    covering.push({ ...p, offset_in_chunk_s: (from - cs) / 1000, duration_s: (to - from) / 1000 });
  }
  return covering;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args);
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

async function probe(path) {
  const r = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,format_name,size:stream=codec_name,codec_type,sample_rate,channels",
    "-of", "json", path,
  ]);
  if (r.code !== 0) fail(`ffprobe: ${r.err}`);
  return JSON.parse(r.out);
}

const main = async () => {
  const jobPath = process.argv[2];
  if (!jobPath) fail("usage: join-real-file.mjs job.json");
  const spec = JSON.parse(await readFile(jobPath, "utf8"));

  const startMs = ms(spec.window.start);
  const endMs = ms(spec.window.end);
  const covering = coveringFrom(spec.pieces, startMs, endMs);
  if (covering.length < 2) fail(`the window covers ${covering.length} piece(s) — this proof needs a window that crosses`);

  const trimStartMs = Math.round(covering[0].offset_in_chunk_s * 1000);
  const coveredMs = Math.round(covering.reduce((a, c) => a + c.duration_s, 0) * 1000);
  const trim = { start_ms: trimStartMs, end_ms: trimStartMs + coveredMs };

  // The Worker's validation runs first, exactly as it would in production.
  const outKey = `clips/${spec.session_id}/local-proof-${spec.source}.webm`;
  const v = validateJoinRequest({
    pieces: covering.map((c) => ({ key: c.key, idx: c.idx })),
    trim,
    out_key: outKey,
    meta: { session_id: spec.session_id, requested_start: spec.window.start, requested_end: spec.window.end, source: spec.source, created_at: new Date().toISOString() },
  });
  if (!v.ok) fail(`the job was refused before it started: ${JSON.stringify(v)}`);

  console.log(`session       ${spec.session_id}`);
  console.log(`window        ${spec.window.start} → ${spec.window.end}  (${((endMs - startMs) / 60_000).toFixed(2)} min)`);
  console.log(`pieces        ${covering.map((c) => c.idx).join(", ")}  (${covering.length})`);
  console.log(`trim          ${JSON.stringify(trim)}`);

  // 1. Real bytes.
  const scratch = join(here, ".scratch");
  await mkdir(scratch, { recursive: true });
  const bodies = [];
  for (const c of covering) {
    const res = await fetch(c.url);
    if (!res.ok) fail(`piece ${c.idx}: GET ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    bodies.push(buf);
    console.log(`  piece ${String(c.idx).padStart(3)}  ${buf.length.toLocaleString()} bytes  ${res.headers.get("content-type")}`);
  }
  const inputBytes = bodies.reduce((a, b) => a + b.length, 0);

  // A piece on its own: what a player would say about the raw tape.
  await writeFile(join(scratch, "piece0.webm"), bodies[0]);
  const p0 = await probe(join(scratch, "piece0.webm"));
  console.log(`  piece ${covering[0].idx} alone → ${p0.format.format_name}, ${Number(p0.format.duration).toFixed(2)} s, streams: ${p0.streams.map((s) => `${s.codec_type}/${s.codec_name}@${s.sample_rate ?? "-"}Hz x${s.channels ?? "-"}`).join(", ")}`);

  // 2. The container's own server, on this machine, with the local ffmpeg.
  const child = spawn(process.execPath, [join(here, "..", "container", "server.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`  [container] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`  [container] ${d}`));
  const up = async () => {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/health`);
        if (r.ok) return true;
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  if (!(await up())) { child.kill(); fail("the container process never came up"); }

  try {
    // 3. The same frame the Worker writes, piece by piece, in order.
    const header = { trim, pieces: covering.map((c) => ({ key: c.key, idx: c.idx })) };
    const parts = [Buffer.from(frameHeader(header))];
    for (const b of bodies) parts.push(Buffer.from(framePiecePrefix(b.length)), b);
    const framed = Buffer.concat(parts);

    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${PORT}/join`, {
      method: "POST",
      body: framed,
      headers: { "content-type": "application/octet-stream" },
    });
    const elapsed = Date.now() - t0;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) fail(`the joiner refused: ${JSON.stringify(await res.json())}`);

    const clip = Buffer.from(await res.arrayBuffer());
    const outPath = join(scratch, "joined.webm");
    await writeFile(outPath, clip);

    const info = await probe(outPath);
    const durationS = Number(info.format.duration);
    const expectedS = coveredMs / 1000;

    console.log("");
    console.log(`joined        ${clip.length.toLocaleString()} bytes from ${inputBytes.toLocaleString()} in ${(elapsed / 1000).toFixed(1)} s`);
    console.log(`reported      ${res.headers.get("x-join-duration-ms")} ms (${res.headers.get("x-join-duration-source")}), ${res.headers.get("x-join-pieces")} pieces`);
    console.log(`ffprobe       ${info.format.format_name}, ${durationS.toFixed(2)} s, streams: ${info.streams.map((s) => `${s.codec_type}/${s.codec_name}@${s.sample_rate}Hz x${s.channels}`).join(", ")}`);
    console.log(`expected      ${expectedS.toFixed(2)} s`);
    console.log(`written to    ${outPath}`);

    // The trap this run exists to catch: a "successful" join that is really one piece long.
    const drift = Math.abs(durationS - expectedS);
    if (drift > 1.0) fail(`the joined clip is ${durationS.toFixed(2)} s, not ${expectedS.toFixed(2)} s — the pieces did not join (drift ${drift.toFixed(2)} s)`);
    if (info.streams.some((s) => s.codec_type === "video")) fail("the joined clip carries a video stream");
    console.log("");
    console.log(`PASS — ${covering.length} pieces became one ${durationS.toFixed(2)} s clip, within ${drift.toFixed(2)} s of the window asked for.`);
  } finally {
    child.kill("SIGTERM");
  }
};

main().catch((e) => fail(String(e?.stack ?? e)));
