// eta-lab-viewer: read-only viewer for the eta-lab-results vault (ruling 184 part B).
// Bindings: RESULTS (eta-lab-results) and AUDIO (eta-audio) are used ONLY through get/head/list.
// Every request is authenticated (Cloudflare Access JWT, verified here) BEFORE any routing or binding call.
// Nothing on this Worker writes or removes anything. Audio is addressed by (window key, chunk number), never by an R2 key.
import { verifyAccess } from "./access.js";
import { parseKey } from "../../lab-vault/worker/validate.js";
import { shell } from "./ui.js";

const forbidden = () => new Response("forbidden", { status: 403, headers: { "content-type": "text/plain", "cache-control": "private, no-store" } });

function baseHeaders(extra = {}) {
  return {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
    "x-frame-options": "DENY",
    ...extra,
  };
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: baseHeaders({ "content-type": "application/json" }) });

// A window is addressed as run_id/room_id/ist_date/window_id; the vault key is rebuilt and re-validated.
function windowKey(parts) {
  if (parts.length !== 4) return null;
  const key = `runs/${parts.join("/")}.json`;
  const p = parseKey(key);
  return p && p.kind === "run" ? key : null;
}

let windowCache = new Map(); // vault objects are immutable, so a cached window can never go stale
async function loadWindow(env, key) {
  if (windowCache.has(key)) return windowCache.get(key);
  const obj = await env.RESULTS.get(key);
  if (!obj) return null;
  const doc = JSON.parse(await obj.text());
  if (windowCache.size >= 200) windowCache = new Map(); // bounded: start over rather than evict one by one
  windowCache.set(key, doc);
  return doc;
}

async function newest(env, prefix, suffix) {
  let cursor, best = null;
  do {
    const page = await env.RESULTS.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) if (o.key.endsWith(suffix) && (!best || o.key > best)) best = o.key;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return best;
}

async function streamObject(env, key) {
  const obj = await env.RESULTS.get(key);
  return obj ? new Response(obj.body, { status: 200, headers: baseHeaders({ "content-type": "application/x-ndjson; charset=utf-8", "x-vault-key": key }) }) : null;
}

// bytes=a-b | a- | -n ; returns {offset,length} | "invalid" | null (no Range header)
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start, end;
  if (m[1] === "") { const n = Number(m[2]); if (n === 0) return "invalid"; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!(start <= end) || start >= size) return "invalid";
  return { offset: start, length: end - start + 1 };
}

// The audio chunks of a window, in the order the client uses: the record's own source_chunks, else the chunks the cut
// actually used (cut.chunk_keys, exact), else source_audio_keys (may over-report in early hist-bulk runs).
export function windowChunkKeys(doc) {
  const p = doc?.provenance ?? {};
  if (Array.isArray(p.source_chunks) && p.source_chunks.length) return p.source_chunks.map((c) => c?.r2_key);
  if (Array.isArray(doc?.cut?.chunk_keys) && doc.cut.chunk_keys.length) return doc.cut.chunk_keys;
  return Array.isArray(p.source_audio_keys) ? p.source_audio_keys : [];
}

async function serveAudio(env, request, parts) {
  const n = parts.pop();
  const key = windowKey(parts);
  if (!key || !/^\d{1,3}$/.test(n)) return json(404, { error: "not found" });
  const doc = await loadWindow(env, key);
  const r2 = doc ? windowChunkKeys(doc)[Number(n)] : undefined;
  if (typeof r2 !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,300}$/.test(r2) || r2.includes("..") || r2.includes("//")) return json(404, { error: "not found" });
  const head = await env.AUDIO.head(r2);
  if (!head) return json(404, { error: "audio not found" });
  const range = parseRange(request.headers.get("range"), head.size);
  const h = { "content-type": "audio/webm", "accept-ranges": "bytes" };
  if (range === "invalid") return new Response(null, { status: 416, headers: baseHeaders({ ...h, "content-range": `bytes */${head.size}` }) });
  if (range === null) {
    const obj = await env.AUDIO.get(r2);
    return new Response(obj.body, { status: 200, headers: baseHeaders({ ...h, "content-length": String(head.size) }) });
  }
  const obj = await env.AUDIO.get(r2, { range });
  return new Response(obj.body, { status: 206, headers: baseHeaders({ ...h, "content-range": `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`, "content-length": String(range.length) }) });
}

async function manifests(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.RESULTS.list({ prefix: "manifests/", cursor, limit: 1000 });
    for (const o of page.objects) out.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const byRun = new Map();
  for (const k of out) {
    if (/\.addendum\.json$/.test(k)) continue;
    const m = /^manifests\/(.+?)(\.start)?\.json$/.exec(k);
    if (!m) continue;
    const cur = byRun.get(m[1]);
    if (!cur || (cur.start && !m[2])) byRun.set(m[1], { key: k, start: !!m[2] }); // the final manifest wins over .start
  }
  const addenda = new Map(out.filter((k) => /\.addendum\.json$/.test(k)).map((k) => [k.slice("manifests/".length, -".addendum.json".length), k]));
  const rows = [];
  for (const [run, { key, start }] of [...byRun].slice(-300)) {
    const doc = await loadWindow(env, key);
    if (!doc) continue;
    const p = doc.provenance || {};
    rows.push({ run_id: run, status: start ? "running-or-unfinished" : "finished", producer: p.producer, created_at: p.created_at, provenance_complete: p.provenance_complete, stack: p.stack ?? null, guards: p.guards ?? null, diarizer: p.diarizer ?? null, stack_versions_sha256: p.stack_versions_sha256 ?? null, counts: doc.counts ?? null, addendum: addenda.has(run) ? ((await loadWindow(env, addenda.get(run)))?.addendum ?? null) : null });
  }
  for (const [run, key] of [...addenda].slice(-100)) {  // a run with a note but no manifest (e.g. a backfill run) still gets a row
    if (!byRun.has(run)) rows.push({ run_id: run, status: "no manifest", producer: null, created_at: null, provenance_complete: null, stack: null, guards: null, diarizer: null, stack_versions_sha256: null, counts: null, addendum: (await loadWindow(env, key))?.addendum ?? null });
  }
  return rows;
}

async function route(request, env, url) {
  const path = url.pathname;
  if (path === "/") {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    return new Response(shell(nonce), { headers: baseHeaders({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    }) });
  }
  if (path === "/api/index") {
    const key = await newest(env, "index/windows-", ".jsonl");
    return (key && (await streamObject(env, key))) || json(404, { error: "no index yet" });
  }
  if (path === "/api/chunks-index") {
    const key = await newest(env, "index/chunks-", ".jsonl");
    return (key && (await streamObject(env, key))) || json(404, { error: "no chunk index yet" });
  }
  if (path === "/api/search-index") {
    const key = await newest(env, "index/search-", ".jsonl");
    return (key && (await streamObject(env, key))) || json(404, { error: "no search index yet" });
  }
  if (path === "/api/manifests") return json(200, { runs: await manifests(env) });
  if (path.startsWith("/api/window/")) {
    const key = windowKey(path.slice("/api/window/".length).split("/"));
    const doc = key && (await loadWindow(env, key));
    return doc ? json(200, doc) : json(404, { error: "not found" });
  }
  if (path.startsWith("/audio/")) return serveAudio(env, request, path.slice("/audio/".length).split("/"));
  return json(404, { error: "not found" });
}

export default {
  async fetch(request, env) {
    const who = await verifyAccess(request, env, { fetchImpl: env.__fetch ?? fetch });
    if (!who.ok) return forbidden();
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: baseHeaders({ allow: "GET, HEAD" }) });
    try {
      return await route(request, env, new URL(request.url));
    } catch (e) {
      return json(500, { error: "internal" });
    }
  },
};
