/**
 * services/audio-join/worker/index.js — the door in front of the joining container (D14).
 *
 * One route: POST /join. Everything else is a named 404.
 *
 * How the container reaches the recordings: IT DOES NOT.
 * The Worker holds the R2 binding (`env.AUDIO`), reads the covering pieces itself, hands the
 * bytes to the container over the Durable Object's internal channel, takes the joined bytes back,
 * and writes the clip — with its provenance (D4) — through the same binding. The container runs
 * with `enableInternet = false` and holds no key, no token and no bucket name. So there is no
 * long-lived credential in the image (there is none anywhere in this service), and the audio
 * never leaves Cloudflare: R2 → Worker → container → Worker → R2, all inside the account.
 *
 * The alternative — minting presigned S3 URLs and letting the container fetch them — would have
 * required an R2 access key pair as a Worker secret and outbound internet in the container. The
 * binding route needs neither, and R2 custom metadata (the provenance) has to be written through
 * the binding anyway.
 *
 * "One join at a time" (guard rail) is enforced INSIDE the Durable Object, not in the Worker
 * isolate: a `Container` is a Durable Object, `getContainer(env.JOINER, INSTANCE)` always
 * resolves to the same single object, and a Durable Object is single-threaded. A flag on the
 * instance is therefore a real mutex across every isolate in every colo. A flag in the Worker
 * would only have been a mutex for one isolate.
 */

import { Container, getContainer } from "@cloudflare/containers";
import {
  CLIPS_PREFIX,
  MAX_INPUT_BYTES,
  OUT_CONTENT_TYPE,
  frameHeader,
  framePiecePrefix,
  frameWireLength,
  validateJoinRequest,
} from "../container/join-core.mjs";

/** One box, one name — the mutex below depends on every request landing on the same object. */
const INSTANCE = "joiner";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class Joiner extends Container {
  defaultPort = 8080;

  /** Kickoff: "Sleep quickly … about 60 seconds, not the 10 minute default." At the default this
   *  workload lands just outside the included monthly allowance; at 60 s it sits well inside. */
  sleepAfter = "60s";

  /** The container has nothing to reach. Everything it needs arrives on the socket. */
  enableInternet = false;

  pingEndpoint = "localhost/health";

  /** Guard rail: refuse a second job while one is running. Do not queue. */
  #busy = false;

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/join" || request.method !== "POST") {
      return json({ ok: false, error: "no_such_route" }, 404);
    }
    if (this.#busy) {
      return json({ ok: false, error: "join_already_running" });
    }
    this.#busy = true;
    try {
      return await this.#join(request);
    } catch (e) {
      // Never a bare 500.
      return json({ ok: false, error: "join_failed", detail: String(e?.message ?? e).slice(0, 300) });
    } finally {
      this.#busy = false;
    }
  }

  async #join(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "bad_request_body" });
    }

    const v = validateJoinRequest(body);
    if (!v.ok) return json(v);
    const job = v.job;

    // 1. Size the job before reading a byte of it. R2 head() gives the length, which is both
    //    the guard rail's input and the length prefix the frame needs — so the Worker never has
    //    to hold every piece at once to know how big the job is.
    let totalBytes = 0;
    const sized = [];
    for (const p of job.pieces) {
      const head = await this.env.AUDIO.head(p.key);
      if (!head) return json({ ok: false, error: "piece_missing", key: p.key });
      totalBytes += head.size;
      if (totalBytes > MAX_INPUT_BYTES) {
        return json({ ok: false, error: "input_too_large", bytes: totalBytes, limit_bytes: MAX_INPUT_BYTES });
      }
      sized.push({ key: p.key, idx: p.idx, size: head.size });
    }

    // 2. Stream the pieces to the box, IN THE ORDER GIVEN. Nothing sorts, and nothing is
    //    buffered: one piece is in flight at a time, so a 30-minute job costs ~5 MB of Worker
    //    memory rather than the whole 30.
    const header = { trim: job.trim, pieces: sized.map((p) => ({ key: p.key, idx: p.idx })) };
    const env = this.env;

    // The header block and the 8-byte prefixes are bytes on the wire too, so the declared length
    // must count them. `frameWireLength` states that arithmetic once, next to the functions that
    // write the frame — this file does not carry a second copy of the layout. Both are tiny; the
    // piece BODIES are still streamed one at a time below.
    const headerFrame = frameHeader(header);
    const piecePrefixes = sized.map((p) => framePiecePrefix(p.size));
    const wireBytes = frameWireLength(header, sized.map((p) => p.size));

    // FixedLengthStream, NOT IdentityTransformStream: the container hop rejects a body of unknown
    // length ("Provided readable stream must have a known length …") because any other
    // ReadableStream makes the runtime reach for chunked encoding, which this hop does not take.
    // The length is already known — step 1 head()s every piece — so it is declared up front.
    //
    // Backpressure is unchanged. FixedLengthStream is an identity TransformStream that merely
    // caps the byte count, so `writer.write()` still resolves only when the container has taken
    // the chunk. That is why the pump is an awaited writer rather than a ReadableStream `start()`:
    // `start` runs to completion regardless of the consumer, and would queue all 30 MB in the
    // Worker. One piece is in flight at a time, ~5 MB, not the whole window.
    const { readable, writable } = new FixedLengthStream(wireBytes);
    let pumpError = null;
    const pump = (async () => {
      const writer = writable.getWriter();
      try {
        await writer.write(headerFrame);
        for (let i = 0; i < sized.length; i++) {
          const p = sized[i];
          const obj = await env.AUDIO.get(p.key);
          if (!obj) throw new Error(`piece_vanished:${p.key}`);
          await writer.write(piecePrefixes[i]);
          // A declared length must be met exactly, so a piece that is no longer the size head()
          // reported is now fatal rather than merely odd. Count it and say so by name — the
          // alternative is an opaque stream error with nothing in it to act on.
          let written = 0;
          for await (const chunk of obj.body) {
            written += chunk.byteLength;
            await writer.write(chunk);
          }
          if (written !== p.size) throw new Error(`piece_size_changed:${p.key}:${written}!=${p.size}`);
        }
        await writer.close();
      } catch (e) {
        pumpError = e;
        await writer.abort(e).catch(() => {});
      }
    })();

    let res;
    try {
      res = await this.containerFetch("http://joiner/join", {
        method: "POST",
        body: readable,
        headers: { "content-type": "application/octet-stream" },
        duplex: "half",
      });
    } catch (e) {
      // A pump failure is the real cause; the fetch only saw a broken body. The pump never
      // rejects (it catches into pumpError), and it is bounded so a container that answered
      // early and stopped reading cannot leave this awaiting for ever.
      await Promise.race([pump, new Promise((r) => setTimeout(r, 5_000))]);
      const cause = pumpError ?? e;
      return json({ ok: false, error: "piece_read_failed", detail: String(cause?.message ?? cause).slice(0, 300) });
    }
    // The container answered, so its answer is authoritative — it read the body to the end
    // before replying. No need to wait on the pump here.

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const named = await res.json().catch(() => ({ ok: false, error: "container_bad_response" }));
      return json(named.ok === false ? named : { ok: false, error: "container_refused" });
    }
    if (!res.ok || !res.body) return json({ ok: false, error: "container_failed", status: res.status });

    // The RETURN hop needs no FixedLengthStream: `server.mjs` writes an explicit content-length on
    // every response it sends — the audio and both JSON shapes — so the body arrives here already
    // length-aware and R2 `put()` takes it as a stream. That is load-bearing, not incidental: an
    // unsized body would fail with the very same "known length" error, one layer further down. If
    // the header ever goes missing, say so by name instead of buffering the window to invent one.
    if (res.headers.get("content-length") === null) {
      return json({ ok: false, error: "container_response_unsized" });
    }

    // 3. Stream the clip straight back into the bucket, with its own origin on the object (D4).
    //    put() returns the stored object, so the byte count is R2's, not a guess.
    const stored = await this.env.AUDIO.put(job.out_key, res.body, {
      httpMetadata: { contentType: OUT_CONTENT_TYPE },
      customMetadata: job.meta,
    });
    if (!stored || stored.size === 0) return json({ ok: false, error: "output_empty" });

    const durationMs = Number(res.headers.get("x-join-duration-ms") ?? NaN);
    return json({
      ok: true,
      key: job.out_key,
      bytes: stored.size,
      duration_ms: Number.isFinite(durationMs) ? durationMs : job.trim.end_ms - job.trim.start_ms,
      pieces: sized.length,
      input_bytes: totalBytes,
      duration_source: res.headers.get("x-join-duration-source") ?? "trim_window",
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "eta-audio-join", clips_prefix: CLIPS_PREFIX });
    }
    if (url.pathname !== "/join") return json({ ok: false, error: "no_such_route" }, 404);
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

    // Shared bearer. A missing secret fails CLOSED — an unauthenticated joiner would write
    // clips into the tape bucket for anyone who found the hostname.
    const expected = env.JOIN_TOKEN;
    if (!expected) return json({ ok: false, error: "join_token_not_configured" }, 503);
    const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(given, expected)) return json({ ok: false, error: "unauthorized" }, 401);

    return getContainer(env.JOINER, INSTANCE).fetch(request);
  },
};

/** Constant-time compare so the token cannot be probed a character at a time. */
function timingSafeEqual(a, b) {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
