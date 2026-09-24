/**
 * services/audio-join/twin/server.mjs — the join TWIN's front door (JOIN-SHARD, 24 Sep).
 *
 * The Cloudflare service is Worker + Durable Object + container. The container half
 * (`../container/server.mjs`, ffmpeg) is plain Node and has no storage access, so it runs unchanged
 * anywhere Docker does. What a box does NOT have is the Worker's R2 BINDING — so this file plays the
 * Worker's part: bearer check, per-shard busy check, read the pieces, frame them, hand them to the
 * container, write the clip back with its provenance — over R2's S3 API instead of the binding.
 *
 * It speaks the SAME `POST /join` contract as the Worker (`../README.md`), so the app just lists it
 * as a second entry in AUDIO_JOIN_URLS and `lib/service-pool.ts` does the failover. Same token, same
 * named refusals, same "never a bare 500".
 *
 * THIS PROCESS HOLDS A CREDENTIAL: an R2 S3 key pair (unlike the Cloudflare deployment, where no key
 * exists anywhere). It needs Object Read on the tape prefix and Object Write on `clips/` only —
 * scope the token that way, and keep it out of the image (env at run time).
 *
 * Buffers whole pieces, unlike the Worker: the container reads the whole frame into memory anyway
 * (MAX_INPUT_BYTES, 128 MB), so streaming here would add code and save nothing.
 */

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  FORMATS,
  JOIN_SERVICE_VERSION,
  JOIN_SHARDS,
  MAX_INPUT_BYTES,
  SHARD_HEADER,
  contentTypeFor,
  frameJob,
  shardInstanceName,
  shardKeyFromHeaders,
  validateJoinRequest,
} from "../container/join-core.mjs";

const MAX_BODY_BYTES = 1024 * 1024; // a job body is keys and numbers; 1 MB is generous

const bearerOk = (given, expected) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * @param {object} deps
 * @param {{ head(key:string):Promise<{size:number}|null>, get(key:string):Promise<Uint8Array|null>,
 *           put(key:string, body:Uint8Array, opts:{contentType:string, meta:Record<string,string>}):Promise<void> }} deps.store
 *   the storage seam — S3 in production (see `s3Store`), a fake in the tests
 * @param {string|undefined} deps.token  shared bearer; absent fails CLOSED (503)
 * @param {string} deps.containerUrl     the unchanged join container, e.g. http://127.0.0.1:8080
 * @param {number} [deps.maxConcurrent]  ceiling across shards — c3 is a shared CPU box
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createTwin({ store, token, containerUrl, maxConcurrent = 2, fetchImpl = fetch }) {
  /** Instance names with a join in flight — the same one-flag-per-shard mutex as the Worker's. */
  const busy = new Set();

  async function join(job, rid) {
    let totalBytes = 0;
    const sized = [];
    for (const p of job.pieces) {
      const head = await store.head(p.key);
      if (!head) return { ok: false, error: "piece_missing", key: p.key };
      totalBytes += head.size;
      if (totalBytes > MAX_INPUT_BYTES) {
        return { ok: false, error: "input_too_large", bytes: totalBytes, limit_bytes: MAX_INPUT_BYTES };
      }
      sized.push({ key: p.key, idx: p.idx, size: head.size });
    }

    const bodies = [];
    try {
      for (const p of sized) {
        const bytes = await store.get(p.key);
        if (!bytes) throw new Error(`piece_vanished:${p.key}`);
        if (bytes.byteLength !== p.size) throw new Error(`piece_size_changed:${p.key}:${bytes.byteLength}!=${p.size}`);
        bodies.push(bytes);
      }
    } catch (e) {
      return { ok: false, error: "piece_read_failed", hop: "do_to_container", rid, detail: String(e?.message ?? e).slice(0, 300) };
    }

    const header = { trim: job.trim, format: job.format, pieces: sized.map((p) => ({ key: p.key, idx: p.idx })) };
    let res;
    try {
      res = await fetchImpl(`${containerUrl.replace(/\/+$/, "")}/join`, {
        method: "POST",
        body: frameJob(header, bodies),
        headers: { "content-type": "application/octet-stream", "x-join-request-id": rid },
      });
    } catch (e) {
      return { ok: false, error: "container_failed", hop: "do_to_container", rid, detail: String(e?.message ?? e).slice(0, 300) };
    }
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      const named = await res.json().catch(() => ({ ok: false, error: "container_bad_response" }));
      return { ...(named.ok === false ? named : { ok: false, error: "container_refused" }), rid };
    }
    if (!res.ok) return { ok: false, error: "container_failed", hop: "do_to_container", rid, status: res.status };

    const clip = new Uint8Array(await res.arrayBuffer());
    if (clip.byteLength === 0) return { ok: false, error: "output_empty", hop: "clip_to_r2", rid };
    try {
      await store.put(job.out_key, clip, { contentType: contentTypeFor(job.format), meta: job.meta });
    } catch (e) {
      return { ok: false, error: "join_failed", hop: "clip_to_r2", rid, detail: String(e?.message ?? e).slice(0, 300) };
    }
    const durationMs = Number(res.headers.get("x-join-duration-ms") ?? NaN);
    return {
      ok: true,
      rid,
      key: job.out_key,
      bytes: clip.byteLength,
      duration_ms: Number.isFinite(durationMs) ? durationMs : job.trim.end_ms - job.trim.start_ms,
      pieces: sized.length,
      input_bytes: totalBytes,
      duration_source: res.headers.get("x-join-duration-source") ?? "trim_window",
    };
  }

  const send = (res, body, status = 200) => {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
    res.end(payload);
  };

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  return async function handle(req, res) {
    const path = new URL(req.url ?? "/", "http://twin").pathname;
    if (req.method === "GET" && path === "/health") {
      return send(res, {
        ok: true,
        service: "eta-audio-join-twin",
        version: JOIN_SERVICE_VERSION,
        formats: Object.keys(FORMATS),
        shards: JOIN_SHARDS,
        shard_header: SHARD_HEADER,
        max_concurrent: maxConcurrent,
      });
    }
    if (path !== "/join") return send(res, { ok: false, error: "no_such_route" }, 404);
    if (req.method !== "POST") return send(res, { ok: false, error: "method_not_allowed" }, 405);

    if (!token) return send(res, { ok: false, error: "join_token_not_configured" }, 503);
    const given = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!bearerOk(given, token)) return send(res, { ok: false, error: "unauthorized" }, 401);

    const rid = String(req.headers["x-join-request-id"] ?? "none");
    const shard = shardKeyFromHeaders(new Headers(req.headers));
    if (!shard.ok) return send(res, { ok: false, error: shard.error, rid });
    const instance = shardInstanceName(shard.key);

    // Refuse, never queue — the pool's other endpoint (or the caller's wait) takes it from here.
    if (busy.has(instance) || busy.size >= maxConcurrent) {
      console.log(`[audio-join-twin] rid=${rid} instance=${instance} refused=join_already_running`);
      return send(res, { ok: false, error: "join_already_running", rid });
    }
    busy.add(instance);
    try {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, { ok: false, error: "bad_request_body" });
      }
      const v = validateJoinRequest(body);
      if (!v.ok) return send(res, v);
      const out = await join(v.job, rid);
      console.log(`[audio-join-twin] rid=${rid} instance=${instance} ${out.ok ? `ok bytes=${out.bytes} pieces=${out.pieces}` : `failed=${out.error}`}`);
      return send(res, out);
    } catch (e) {
      // Never a bare 500 — and never an unattributed one either.
      return send(res, { ok: false, error: "join_failed", hop: "unknown", rid, detail: String(e?.message ?? e).slice(0, 300) });
    } finally {
      busy.delete(instance);
    }
  };
}

/** The production store: R2 through its S3 API. Loaded lazily so the tests never need the SDK. */
export async function s3Store({ endpoint, bucket, accessKeyId, secretAccessKey }) {
  const { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
  const notFound = (e) => e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
  return {
    async head(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: Number(r.ContentLength ?? 0) };
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return await r.Body.transformToByteArray();
      } catch (e) {
        if (e?.name === "NoSuchKey" || notFound(e)) return null;
        throw e;
      }
    },
    async put(key, body, { contentType, meta }) {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentLength: body.byteLength, ContentType: contentType, Metadata: meta,
      }));
    },
  };
}

// Run as a process: `node twin/server.mjs`. Everything comes from the environment; nothing is
// logged but names and counts.
if (import.meta.url === `file://${process.argv[1]}`) {
  const need = (name) => {
    const v = process.env[name];
    if (!v) {
      console.error(`[audio-join-twin] missing env ${name}`);
      process.exit(2);
    }
    return v;
  };
  const store = await s3Store({
    endpoint: need("R2_ENDPOINT"),
    bucket: need("R2_BUCKET"),
    accessKeyId: need("R2_ACCESS_KEY_ID"),
    secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
  });
  const handle = createTwin({
    store,
    token: need("JOIN_TOKEN"),
    containerUrl: process.env.JOIN_CONTAINER_URL || "http://127.0.0.1:8080",
    maxConcurrent: Number(process.env.TWIN_MAX_CONCURRENT || 2),
  });
  const port = Number(process.env.PORT || 8090);
  // Loopback only: the tunnel's connector (cloudflared on the host) is the one way in.
  createServer((req, res) => void handle(req, res)).listen(port, "127.0.0.1", () => {
    console.log(`[audio-join-twin] listening on 127.0.0.1:${port}`);
  });
}
