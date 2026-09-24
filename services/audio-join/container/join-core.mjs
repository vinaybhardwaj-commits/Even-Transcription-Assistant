/**
 * services/audio-join/container/join-core.mjs — PURE core of the joining service.
 *
 * Shared by BOTH sides of the container boundary and by the unit tests:
 *   - the Worker / Durable Object (`../worker/index.js`) validates the job with it and frames
 *     the piece bytes with it;
 *   - the container process (`./server.mjs`) unframes with it and builds the ffmpeg argv with it.
 *
 * No I/O, no ffmpeg, no Cloudflare API — so `tests/unit/audio-join-service.test.ts` can prove the
 * two things that matter without Docker: pieces are joined in the order they arrive, and an
 * over-long job is refused by name.
 *
 * Contract (ETA-MCP-U2 kickoff rev 2, §"Contract"):
 *   POST /join { pieces:[{key,idx}], trim:{start_ms,end_ms}, out_key, meta }
 *     → { ok:true,  key, bytes, duration_ms }
 *     → { ok:false, error:"<named reason>" }        never a bare 500
 *
 * Guard rails (§"Guard rails"):
 *   - more than 30 minutes of output   → input_too_long
 *   - a second job while one runs      → join_already_running   (enforced in the DO, not here)
 *   - a key outside the clips prefix   → bad_out_key
 * plus two bounds the kickoff does not name but the box needs: too_many_pieces and
 * input_too_large, so one malformed job cannot pin the instance.
 */

/** D2 — a joined clip may be at most 30 minutes. The app repeats this number in
 *  `lib/bench-join.ts`; they sit on opposite sides of a network boundary, so both must
 *  state it. Change one, change the other. */
export const MAX_JOIN_MS = 30 * 60_000;

/** D3 — every kept clip lives under this prefix, in the same bucket as the tape. */
export const CLIPS_PREFIX = "clips/";

/** A 30-minute window over 5-minute pieces needs 7; 64 leaves room for short pieces from a
 *  crashed day without letting one job decode an entire clinic. */
export const MAX_PIECES = 64;

/** Real bench pieces run ~4.9 MB per five minutes (48 kHz Opus), so a full 30-minute window is
 *  about 30 MB. 128 MB is four times the worst honest case and still small enough that the
 *  container can hold a whole job in memory on the configured instance. */
export const MAX_INPUT_BYTES = 128 * 1024 * 1024;

export const OUT_CONTENT_TYPE = "audio/webm";

/**
 * Build 3.1 — the output container is a REQUEST PARAMETER now, defaulting to webm.
 *
 * WHY THIS EXISTS. Gemini accepts wav/mp3/aiff/aac/ogg/flac and NOT webm, and webm was the only
 * thing this service could emit, so the room drain could not feed Gemini at all. The codec does
 * not change — libopus either way — only the container the same Opus stream is muxed into.
 *
 * WHY DEFAULTING TO webm IS LOAD-BEARING. Every existing caller sends no `format` at all, and
 * this default is what makes their request byte-identical to yesterday's. A required parameter,
 * or a default of ogg, would silently change the container of every clip the room drain, the MCP
 * extract tool and the operator page have ever produced — and `clipKey()` is deterministic, so
 * re-joining a window OVERWRITES the stored object. The blast radius of getting this default
 * wrong is the whole clip archive.
 *
 * WHY THE KEY CARRIES THE EXTENSION. `clipKey()` is deterministic by design: the same window on
 * the same session and microphone is the same key, so asking twice overwrites one object rather
 * than growing the archive. Two CONTAINERS of the same window would collide on that key and the
 * second would silently replace the first — a webm clip and an ogg clip are different bytes with
 * the same name. The extension is therefore part of the identity, and `outKeyForFormat` below
 * enforces it in the SERVICE rather than trusting every caller to remember.
 */
export const FORMATS = {
  webm: { ffmpegFormat: "webm", contentType: "audio/webm", ext: ".webm" },
  ogg: { ffmpegFormat: "ogg", contentType: "audio/ogg", ext: ".ogg" },
};

export const DEFAULT_FORMAT = "webm";

/**
 * The version this code reports over /health, so a deploy is verifiable FROM OUTSIDE without
 * reading the container's logs or trusting that `wrangler deploy` did what it said.
 *
 * Bumped whenever the wire contract changes. It lives here, next to the contract it describes,
 * rather than in package.json — nothing reads that file at runtime, and a version that is not
 * served is not evidence.
 */
export const JOIN_SERVICE_VERSION = "1.2.0";

// ---------------------------------------------------------------------------
// Sharding (JOIN-SHARD, 24 Sep) — PURE
//
// The join used to be ONE Durable Object ("joiner") with one in-memory `#busy` flag, so a single
// join anywhere refused every other join in the account. The flag protects one container, not one
// room, so it is now one flag PER SHARD: joins for different shards run in parallel, joins on the
// same shard still refuse with `join_already_running`.
//
// The caller names the shard with a header — the session id, which the app already holds as
// `meta.session_id`. The key is HASHED into a fixed number of instances rather than used as a raw
// Durable Object name, because every instance is a container and `max_instances` in
// wrangler.jsonc is a hard platform ceiling: a raw name per session would ask for a container past
// `max_instances` the moment one more session than that joined at once. Two sessions hashing to one shard just serialise, which
// is the behaviour they had before this change.
// ---------------------------------------------------------------------------

/** The request header the caller sets. Absent = the legacy single instance (back-compat). */
export const SHARD_HEADER = "x-join-shard";

/** The instance every request without a shard key goes to — the pre-shard behaviour, unchanged. */
export const LEGACY_INSTANCE = "joiner";

/**
 * How many keyed shards exist. `max_instances` in wrangler.jsonc counts the legacy instance too,
 * so this must stay at most `max_instances - 1`; `tests/unit/join-shard.test.ts` reads both files
 * and fails if they drift apart.
 *
 * WHY 32. 11 rooms are enabled and each has its own session, so up to 11 keys can join at once.
 * Hashing k keys into N shards is a birthday problem: two rooms on one shard serialise, and the
 * second is refused. Expected refusals with 11 concurrent keys: N=5 -> 6.4, N=16 -> 2.9,
 * N=32 -> 1.6 (k - N(1 - (1 - 1/N)^k)). An idle shard costs nothing (its container sleeps after 60 s and billing is for
 * active time), so the only price of a larger N is one more cold start per shard per quiet spell.
 */
export const JOIN_SHARDS = 32;

/** A plain id. `lib/bench-join.ts` (`shardHeader`) carries a copy of this pattern, because the app
 *  does not import from services/; `tests/unit/join-shard.test.ts` fails if the two differ. */
export const SHARD_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** PURE — FNV-1a, 32 bit. Deterministic and dependency free, so every colo and the twin agree. */
export function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * PURE — the shard key a request carries. `{ok:true, key:null}` when there is none (legacy path);
 * `{ok:false, error:"bad_shard_key"}` when there is one and it is not a plain id. A malformed key
 * is refused by name rather than quietly sent to the legacy instance: that would make a typo look
 * like a working join that happens to serialise.
 */
export function shardKeyFromHeaders(headers) {
  const raw = headers.get(SHARD_HEADER);
  if (raw === null) return { ok: true, key: null };
  if (!SHARD_KEY_RE.test(raw)) return { ok: false, error: "bad_shard_key" };
  return { ok: true, key: raw };
}

/** PURE — the Durable Object name for a key: the legacy instance for no key, else `shard-<n>`. */
export function shardInstanceName(key, shards = JOIN_SHARDS) {
  if (key === null || key === undefined) return LEGACY_INSTANCE;
  return `shard-${fnv1a32(key) % shards}`;
}

/** PURE — the format descriptor, or null when the name is not one this service emits. */
export function formatSpec(format) {
  if (format === undefined || format === null) return FORMATS[DEFAULT_FORMAT];
  return Object.prototype.hasOwnProperty.call(FORMATS, format) ? FORMATS[format] : null;
}

/** PURE — the content type for a format name, defaulting to webm. */
export function contentTypeFor(format) {
  return (formatSpec(format) ?? FORMATS[DEFAULT_FORMAT]).contentType;
}

/**
 * PURE — the out_key with the extension the format demands.
 *
 * A trailing `.webm` or `.ogg` is REPLACED; anything else gets the extension appended. Done in
 * the service so a caller that forgets cannot produce two containers under one key — the
 * collision this function exists to make impossible is silent and destroys the earlier clip.
 */
export function outKeyForFormat(outKey, format) {
  const spec = formatSpec(format) ?? FORMATS[DEFAULT_FORMAT];
  const stripped = outKey.replace(/\.(webm|ogg)$/i, "");
  return `${stripped}${spec.ext}`;
}

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteInt = (v) => typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);

/**
 * Validate a /join body. PURE. Returns the normalised job or a named reason — never throws.
 * Piece ORDER IS THE CALLER'S: the array is copied as given and never sorted (the `idx` field
 * is carried for provenance only).
 */
export function validateJoinRequest(body) {
  if (!isPlainObject(body)) return { ok: false, error: "bad_request_body" };

  const { pieces, trim, out_key: outKey, meta, format } = body;

  if (!Array.isArray(pieces) || pieces.length === 0) return { ok: false, error: "no_pieces" };
  if (pieces.length > MAX_PIECES) {
    return { ok: false, error: "too_many_pieces", pieces: pieces.length, limit: MAX_PIECES };
  }
  const normPieces = [];
  for (const p of pieces) {
    if (!isPlainObject(p) || typeof p.key !== "string" || p.key.length === 0) {
      return { ok: false, error: "bad_piece" };
    }
    // Order preserved verbatim — position in the array is the position in the joined clip.
    normPieces.push({ key: p.key, idx: isFiniteInt(p.idx) ? p.idx : null });
  }

  if (!isPlainObject(trim) || !isFiniteInt(trim.start_ms) || !isFiniteInt(trim.end_ms)) {
    return { ok: false, error: "bad_trim" };
  }
  const startMs = trim.start_ms;
  const endMs = trim.end_ms;
  if (startMs < 0) return { ok: false, error: "bad_trim" };
  if (!(endMs > startMs)) return { ok: false, error: "trim_end_before_start" };
  if (endMs - startMs > MAX_JOIN_MS) {
    return {
      ok: false,
      error: "input_too_long",
      requested_ms: endMs - startMs,
      limit_ms: MAX_JOIN_MS,
      limit_minutes: MAX_JOIN_MS / 60_000,
    };
  }

  if (typeof outKey !== "string" || !outKey.startsWith(CLIPS_PREFIX) || outKey.includes("..")) {
    return { ok: false, error: "bad_out_key", required_prefix: CLIPS_PREFIX };
  }

  // ABSENT IS webm, and an UNKNOWN NAME IS A REFUSAL — not a silent fall back to the default.
  // A caller asking for flac has a reason; giving it webm and saying nothing would hand it a
  // container it cannot read while reporting success.
  const spec = formatSpec(format);
  if (spec === null) {
    return { ok: false, error: "bad_format", requested: String(format), supported: Object.keys(FORMATS) };
  }
  const normFormat = format === undefined || format === null ? DEFAULT_FORMAT : format;

  return {
    ok: true,
    job: {
      pieces: normPieces,
      trim: { start_ms: startMs, end_ms: endMs },
      format: normFormat,
      // The service, not the caller, owns the extension (see outKeyForFormat).
      out_key: outKeyForFormat(outKey, normFormat),
      // D4 — provenance rides on the stored object; anything the caller sent is carried through
      // as strings (R2 custom metadata is a string map).
      meta: isPlainObject(meta) ? stringifyMeta(meta) : {},
    },
  };
}

/** R2 custom metadata is `Record<string,string>`; flatten and bound whatever the caller sent. */
export function stringifyMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    const key = String(k).slice(0, 64);
    out[key] = (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 512);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wire framing — Worker → container
//
// The container never touches storage (it runs with the internet switched off), so the Worker
// hands it the bytes it already read through the R2 binding. A length-prefixed frame keeps the
// order explicit and needs no multipart parser in the image:
//
//   [4B BE header length][header JSON utf8]  then per piece: [8B BE byte length][bytes]
// ---------------------------------------------------------------------------

const HEADER_PREFIX_BYTES = 4;
const PIECE_PREFIX_BYTES = 8;

/** The framed header block: 4-byte big-endian length, then the JSON. PURE. */
export function frameHeader(header) {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(HEADER_PREFIX_BYTES + headerBytes.length);
  new DataView(out.buffer).setUint32(0, headerBytes.length, false);
  out.set(headerBytes, HEADER_PREFIX_BYTES);
  return out;
}

/** The 8-byte big-endian length that precedes one piece body. PURE.
 *  Emitting it separately is what lets the Worker frame a job WITHOUT ever holding every piece
 *  at once: R2 tells it each object's size before the bytes arrive, so it can write the prefix
 *  and then pipe the body straight through. */
export function framePiecePrefix(byteLength) {
  const out = new Uint8Array(PIECE_PREFIX_BYTES);
  new DataView(out.buffer).setBigUint64(0, BigInt(byteLength), false);
  return out;
}

/**
 * How many bytes `frameJob` WOULD produce for this header and these piece sizes. PURE.
 *
 * The Worker must declare the exact length before it has read a byte of audio — its body is a
 * `FixedLengthStream`, which the container hop requires and which is unforgiving in both
 * directions: one byte over is "Attempt to write too many bytes through a FixedLengthStream",
 * one byte under is "FixedLengthStream did not see all expected bytes before close()". Both are
 * measured, not assumed — see the round-trip test.
 *
 * It lives HERE, beside the two functions that write the frame, so the layout is stated once. A
 * copy of this arithmetic in the Worker would be a second place to get it wrong, and getting it
 * wrong fails the whole join.
 */
export function frameWireLength(header, pieceSizes) {
  let total = frameHeader(header).byteLength;
  for (const size of pieceSizes) total += PIECE_PREFIX_BYTES + size;
  return total;
}

/** Frame a job header + the piece bodies, in the order given, into one buffer. PURE. */
export function frameJob(header, pieceBodies) {
  const parts = [frameHeader(header)];
  for (const b of pieceBodies) parts.push(framePiecePrefix(b.length), b);
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Inverse of frameJob. PURE. Throws only on a truncated frame (a bug, not a data reason). */
export function unframeJob(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  if (bytes.length < HEADER_PREFIX_BYTES) throw new Error("frame_truncated");
  const headerLen = view.getUint32(off, false);
  off += HEADER_PREFIX_BYTES;
  if (off + headerLen > bytes.length) throw new Error("frame_truncated");
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(off, off + headerLen)));
  off += headerLen;
  const pieces = [];
  while (off < bytes.length) {
    if (off + PIECE_PREFIX_BYTES > bytes.length) throw new Error("frame_truncated");
    const len = Number(view.getBigUint64(off, false));
    off += PIECE_PREFIX_BYTES;
    if (off + len > bytes.length) throw new Error("frame_truncated");
    pieces.push(bytes.subarray(off, off + len));
    off += len;
  }
  return { header, pieces };
}

// ---------------------------------------------------------------------------
// ffmpeg argv
// ---------------------------------------------------------------------------

const sec = (ms) => (ms / 1000).toFixed(3);

/**
 * The filter graph. PURE.
 *
 * Every input is normalised to 48 kHz mono float before `concat`, because the concat filter
 * refuses inputs whose sample rate or layout differ and a backup mic need not match the primary.
 * `a:0` on every input pins the FIRST AUDIO stream: these recordings are audio-only inside a
 * container format that usually carries video, and a plain `[i]` label lets ffmpeg pick a stream
 * that is not there. `atrim` then cuts the requested window out of the joined stream — the trim
 * happens INSIDE the join (D9), not on the pieces beforehand.
 *
 * Input index order == piece order. Nothing here sorts.
 */
export function buildFilterGraph(pieceCount, startMs, endMs) {
  const parts = [];
  for (let i = 0; i < pieceCount; i++) {
    parts.push(`[${i}:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[a${i}]`);
  }
  const labels = Array.from({ length: pieceCount }, (_, i) => `[a${i}]`).join("");
  parts.push(`${labels}concat=n=${pieceCount}:v=0:a=1[joined]`);
  parts.push(`[joined]atrim=start=${sec(startMs)}:end=${sec(endMs)},asetpts=PTS-STARTPTS[out]`);
  return parts.join(";");
}

/**
 * Full ffmpeg argv for one job. PURE — `files` is used in the order given, one `-i` each, so the
 * Nth file is the Nth input is the Nth segment of the joined clip.
 */
export function buildFfmpegArgs(files, startMs, endMs, outPath, format = DEFAULT_FORMAT) {
  const spec = formatSpec(format) ?? FORMATS[DEFAULT_FORMAT];
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  for (const f of files) args.push("-i", f);
  args.push(
    "-filter_complex", buildFilterGraph(files.length, startMs, endMs),
    "-map", "[out]",
    "-vn", "-sn", "-dn",
    // THE CODEC IS UNCHANGED. Opus either way; only the mux differs, so an ogg clip and a webm
    // clip of the same window carry the same audio at the same bitrate and are comparable.
    "-c:a", "libopus",
    "-b:a", "32k",
    "-ar", "48000",
    "-ac", "1",
    "-f", spec.ffmpegFormat,
    outPath,
  );
  return args;
}
