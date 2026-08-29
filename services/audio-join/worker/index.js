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
 *
 * THREE HOPS, EACH NAMED. A join is three transfers — caller → Durable Object, Durable Object →
 * container, clip → R2 — and all three can fail with a stream error that reads identically from
 * outside. Each is wrapped in its own catch and every failure carries `hop`, so no one has to
 * guess which one broke. They are also the reason nothing here is buffered: the pieces stream in
 * one at a time and the clip streams out, so a 30-minute window costs ~5 MB of Worker memory.
 *
 * BOTH DIRECTIONS NEED A DECLARED LENGTH, for the same reason and by different means. Going out,
 * `FixedLengthStream(wireBytes)`. Coming back, a relay through `FixedLengthStream(content-length)`
 * — because `@cloudflare/containers` re-wraps the container's response in a plain TransformStream
 * and only the HEADERS survive that; see the long note at hop 3. Draining that response is also
 * what lets the Durable Object go to sleep, so it is drained on every path, including failures.
 */

import { Container, getContainer } from "@cloudflare/containers";
import {
  CLIPS_PREFIX,
  MAX_INPUT_BYTES,
  OUT_CONTENT_TYPE,
  contentTypeFor,
  FORMATS,
  JOIN_SERVICE_VERSION,
  frameHeader,
  framePiecePrefix,
  frameWireLength,
  validateJoinRequest,
} from "../container/join-core.mjs";

/** One box, one name — the mutex below depends on every request landing on the same object. */
const INSTANCE = "joiner";

/**
 * A join is three transfers and nothing else. Every one of them can fail with a stream error that
 * reads the same from the outside, so each is wrapped in its own catch and each failure carries
 * the name of the hop it happened on. Three attempts were spent guessing which hop was at fault;
 * the answer now arrives in the response body.
 */
const HOPS = {
  /** the caller's POST → the Durable Object (`stub.fetch`) */
  worker_to_do: "worker_to_do",
  /** the framed job → the container (`containerFetch`, plus the pump that feeds it) */
  do_to_container: "do_to_container",
  /** the finished clip → the bucket (`AUDIO.put`) */
  clip_to_r2: "clip_to_r2",
};

/** Rethrown at a hop boundary so the label survives to the outermost catch. */
class HopError extends Error {
  constructor(hop, cause) {
    super(`${hop}: ${String(cause?.message ?? cause)}`);
    this.hop = hop;
    this.cause = cause;
  }
}

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
    // Every line this invocation writes carries the caller's id AND the layer, because a Worker
    // and the Durable Object it calls each emit their own invocation log — one caller POST shows
    // up in `wrangler tail` as TWO "POST /join" lines. Without these two words there is no way to
    // tell that pair from a genuine retry.
    const rid = request.headers.get("x-join-request-id") ?? "none";
    if (url.pathname !== "/join" || request.method !== "POST") {
      return json({ ok: false, error: "no_such_route" }, 404);
    }
    console.log(`[audio-join] layer=do rid=${rid} accepted`);
    if (this.#busy) {
      console.log(`[audio-join] layer=do rid=${rid} refused=join_already_running`);
      return json({ ok: false, error: "join_already_running", rid });
    }
    this.#busy = true;
    try {
      return await this.#join(request, rid);
    } catch (e) {
      // Never a bare 500 — and never an unattributed one either.
      const hop = e?.hop ?? "unknown";
      console.log(`[audio-join] layer=do rid=${rid} failed hop=${hop} ${String(e?.message ?? e).slice(0, 200)}`);
      return json({ ok: false, error: "join_failed", hop, rid, detail: String(e?.message ?? e).slice(0, 300) });
    } finally {
      this.#busy = false;
    }
  }

  async #join(request, rid) {
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
    // Build 3.1 — the container travels in the frame header, so the box does not have to guess
    // and the two hops cannot disagree about what was asked for.
    const header = { trim: job.trim, format: job.format, pieces: sized.map((p) => ({ key: p.key, idx: p.idx })) };
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

    // HOP 2 — the framed job into the container.
    let res;
    try {
      res = await this.containerFetch("http://joiner/join", {
        method: "POST",
        body: readable,
        headers: { "content-type": "application/octet-stream", "x-join-request-id": rid },
        duplex: "half",
      });
    } catch (e) {
      // A pump failure is the real cause; the fetch only saw a broken body. The pump never
      // rejects (it catches into pumpError), and it is bounded so a container that answered
      // early and stopped reading cannot leave this awaiting for ever.
      await Promise.race([pump, new Promise((r) => setTimeout(r, 5_000))]);
      const cause = pumpError ?? e;
      return json({
        ok: false,
        error: "piece_read_failed",
        hop: HOPS.do_to_container,
        rid,
        detail: String(cause?.message ?? cause).slice(0, 300),
      });
    }
    // The container answered, so its answer is authoritative — it read the body to the end
    // before replying. No need to wait on the pump here.

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const named = await res.json().catch(() => ({ ok: false, error: "container_bad_response" }));
      return json({ ...(named.ok === false ? named : { ok: false, error: "container_refused" }), rid });
    }
    if (!res.ok || !res.body) {
      return json({ ok: false, error: "container_failed", hop: HOPS.do_to_container, rid, status: res.status });
    }

    // MEASURED, not reasoned about: `server.mjs` writes an explicit content-length on every
    // response, and that HEADER does survive to here — but the BODY does not arrive length-aware,
    // because `@cloudflare/containers` (0.2.4, containerFetch) re-wraps every container response:
    //
    //     const { readable, writable } = new TransformStream();
    //     res.body.pipeTo(writable).finally(() => this.decrementInflight());
    //     return new Response(readable, res);          // headers copied, the stream is not
    //
    // The headers are copied verbatim, so `content-length` reads back fine; the body is now a
    // plain TransformStream readable with no length at all. R2 `put()` refuses it with
    // "Provided readable stream must have a known length (request/response body or readable half
    // of FixedLengthStream)". A local workerd probe put all three shapes through `put()`: the raw
    // response body is accepted, the SDK-re-wrapped body fails with exactly that message, and the
    // same body piped through a FixedLengthStream is accepted. Hence the relay below.
    //
    // The header is therefore worth reading for its NUMBER, and worth nothing as evidence that the
    // stream is sized. It is now parsed rather than merely tested for presence.
    const declared = Number(res.headers.get("content-length"));
    if (!Number.isFinite(declared) || declared <= 0) {
      return json({ ok: false, error: "container_response_unsized", hop: HOPS.do_to_container, rid });
    }

    // 3. HOP 3 — the clip into the bucket, with its own origin on the object (D4).
    //
    // Draining `res.body` is not only how the clip gets to R2; it is the ONLY thing that settles
    // the SDK's `res.body.pipeTo(writable)` above, and that promise's `.finally()` is the ONLY
    // caller of `decrementInflight()`. Leave the body unread and `inflightRequests` stays at 1 for
    // ever; `isActivityExpired()` then renews the sleep timer on every alarm instead of expiring,
    // so the Durable Object re-arms an alarm every `sleepAfter` — 60 s — and never sleeps, and the
    // container never stops. That is the 60-second alarm that outlived the request: the same
    // wound, seen from the other side. So the body is drained on EVERY path out of here, including
    // the failing ones, and the drain is awaited before answering.
    const relay = new AbortController();
    const fixed = new FixedLengthStream(declared);
    const drained = res.body.pipeTo(fixed.writable, { signal: relay.signal });
    drained.catch(() => {}); // an aborted relay is expected below, never an unhandled rejection

    let stored;
    try {
      stored = await this.env.AUDIO.put(job.out_key, fixed.readable, {
        // The stored object's type follows the requested container. OUT_CONTENT_TYPE stays
        // exported for the webm default and for any caller still reading it.
        httpMetadata: { contentType: contentTypeFor(job.format) },
        customMetadata: job.meta,
      });
      await drained;
    } catch (e) {
      // Cancel the relay so the container's response is released rather than left half-read.
      relay.abort();
      await drained.catch(() => {});
      throw new HopError(HOPS.clip_to_r2, e);
    }
    if (!stored || stored.size === 0) return json({ ok: false, error: "output_empty", hop: HOPS.clip_to_r2, rid });

    const durationMs = Number(res.headers.get("x-join-duration-ms") ?? NaN);
    console.log(`[audio-join] layer=do rid=${rid} ok key=${job.out_key} bytes=${stored.size} pieces=${sized.length}`);
    return json({
      ok: true,
      rid,
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
      // `formats` and `version` are the deploy check: a box still running the pre-3.1 image
      // answers this route WITHOUT them, so "did my deploy land" is one curl and not a guess.
      return json({
        ok: true,
        service: "eta-audio-join",
        clips_prefix: CLIPS_PREFIX,
        version: JOIN_SERVICE_VERSION,
        formats: Object.keys(FORMATS),
      });
    }
    if (url.pathname !== "/join") return json({ ok: false, error: "no_such_route" }, 404);
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

    // Shared bearer. A missing secret fails CLOSED — an unauthenticated joiner would write
    // clips into the tape bucket for anyone who found the hostname.
    const expected = env.JOIN_TOKEN;
    if (!expected) return json({ ok: false, error: "join_token_not_configured" }, 503);
    const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(given, expected)) return json({ ok: false, error: "unauthorized" }, 401);

    // The caller's id, minted by the app (`lib/bench-join.ts`). Both layers log it, so a pair of
    // "POST /join" lines in `wrangler tail` is self-explaining: the SAME id twice is one request
    // seen at two invocation layers — the Worker's fetch handler and the Joiner Durable Object's,
    // each of which emits its own invocation log — and TWO ids is a real retry.
    const rid = request.headers.get("x-join-request-id") ?? "none";
    console.log(`[audio-join] layer=worker rid=${rid} forwarding to do`);

    // HOP 1 — the caller's POST into the Durable Object.
    try {
      return await getContainer(env.JOINER, INSTANCE).fetch(request);
    } catch (e) {
      console.log(`[audio-join] layer=worker rid=${rid} failed hop=${HOPS.worker_to_do} ${String(e?.message ?? e).slice(0, 200)}`);
      return json({
        ok: false,
        error: "join_failed",
        hop: HOPS.worker_to_do,
        rid,
        detail: String(e?.message ?? e).slice(0, 300),
      });
    }
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
