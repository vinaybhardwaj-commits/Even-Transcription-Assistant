// eta-lab-ingest: the write-once door into the eta-lab-results vault (ruling 184).
// One route: PUT /v1/obj/<key>. There is no delete, no list, no overwrite and no multipart.
// An R2 binding is bucket-wide read/write, so every guarantee here is enforced in this file.
import { parseKey, provenanceProblems } from "./validate.js";

const MAX_BYTES = 50 * 1024 * 1024;
const PREFIX = "/v1/obj/";
const enc = new TextEncoder();

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256hex = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));

// Compare digests of both sides so the loop length never depends on the guess.
async function tokenOk(given, secret) {
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(secret))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// Read the body while counting, so a chunked upload with no Content-Length is capped too.
async function readCapped(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BYTES) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

async function handle(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/health") {
      return request.method === "GET" ? json(200, { ok: true }) : json(405, { error: "method not allowed" }, { allow: "GET" });
    }
    // Fail closed: no configured secret means nothing is accepted.
    if (typeof env.INGEST_TOKEN !== "string" || env.INGEST_TOKEN.length < 32) return json(503, { error: "ingest not configured" });
    const auth = request.headers.get("authorization") || "";
    const m = /^Bearer (.+)$/.exec(auth);
    if (!m || !(await tokenOk(m[1], env.INGEST_TOKEN))) return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });

    if (!url.pathname.startsWith(PREFIX)) return json(404, { error: "not found" });
    if (request.method !== "PUT") return json(405, { error: "only PUT is allowed" }, { allow: "PUT" });
    if (url.search || url.hash) return json(400, { error: "query strings are not accepted" });

    const key = url.pathname.slice(PREFIX.length);
    const parsed = parseKey(key);
    if (!parsed) return json(400, { error: "key not allowed" });
    const ctype = (request.headers.get("content-type") || "").toLowerCase();
    if (ctype.startsWith("multipart/")) return json(415, { error: "multipart is not accepted" });

    const bytes = await readCapped(request);
    if (bytes === null) return json(413, { error: `body exceeds ${MAX_BYTES} bytes` });
    if (bytes.byteLength === 0) return json(400, { error: "empty body" });

    if (parsed.kind !== "index") {
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return json(422, { error: "body is not utf-8", problems: ["body is not utf-8"] }); }
      const problems = provenanceProblems(text, parsed.runId, parsed.kind);
      if (problems.length) return json(422, { error: "provenance rejected", problems });
      if (parsed.kind === "addendum") {  // a permanent note may only be pinned on a run that already has records in the vault
        const has = async (prefix) => (await env.RESULTS.list({ prefix, limit: 1 })).objects.length > 0;
        if (!(await has(`runs/${parsed.runId}/`)) && !(await has(`manifests/${parsed.runId}.`))) return json(422, { error: "addendum rejected", problems: ["run_id has no records in the vault yet"] });
      }
    }

    const sha256 = await sha256hex(bytes);
    // With a retention lock on the prefix, R2 may throw instead of returning null for an existing key,
    // so any put failure falls through to the head() check below.
    let stored = null, putErr = null;
    try {
      stored = await env.RESULTS.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" }, // atomic: fails if the key exists, no get-then-put race
        sha256,
        httpMetadata: { contentType: parsed.kind === "index" && key.endsWith(".parquet") ? "application/octet-stream" : "application/json" },
        customMetadata: { sha256, ingested_at: new Date().toISOString() },
      });
    } catch (e) { putErr = e; }
    if (stored) return json(201, { ok: true, status: "created", key, sha256, size: bytes.byteLength });

    // Key exists: identical bytes are a no-op, anything else is a conflict.
    const head = await env.RESULTS.head(key);
    if (!head) return json(500, { error: "store failed", detail: String(putErr?.message ?? "conditional put returned null").slice(0, 200) });
    let existing = head.checksums?.sha256 ? hex(head.checksums.sha256) : head.customMetadata?.sha256;
    if (!existing) {
      const obj = await env.RESULTS.get(key);
      existing = obj ? await sha256hex(await obj.arrayBuffer()) : null;
    }
    if (existing === sha256) return json(200, { ok: true, status: "identical", key, sha256, size: bytes.byteLength });
    return json(409, { error: "key exists with different bytes", key, existing_sha256: existing, submitted_sha256: sha256 });
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      // Never an opaque 1101; the message comes from the runtime/R2, never from request headers or the secret.
      return json(500, { error: "internal", detail: `${e?.name}: ${String(e?.message).slice(0, 200)}` });
    }
  },
};
