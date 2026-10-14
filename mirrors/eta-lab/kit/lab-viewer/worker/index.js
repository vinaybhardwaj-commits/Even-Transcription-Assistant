// eta-lab-viewer: read-only viewer for the eta-lab-results vault (ruling 184 part B).
// Bindings: RESULTS (eta-lab-results) and AUDIO (eta-audio) are used ONLY through get/head/list; RATINGS (eta-lab-ratings) is the one bucket written (rate.js).
// Every request is authenticated (Cloudflare Access JWT, verified here) BEFORE any routing or binding call.
// The only writes on this Worker are the two raters' own answers in the separate eta-lab-ratings bucket (rate.js); nothing else is written or removed. Audio is addressed by (window key, chunk number), never by an R2 key.
import { verifyAccess } from "./access.js";
import { parseKey } from "../../lab-vault/worker/validate.js";
import { shell } from "./ui.js";
import { rateRoute, isRater } from "./rate.js";
import { roadmapPage } from "./roadmap.js";

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

// tests only: the Worker caches immutable vault objects per isolate
export function resetCaches() { windowCache = new Map(); viewCache = { at: 0, key: null, rows: null }; countsCache = { at: 0, val: null }; }

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

// Distinct windows with a run file in the vault, per IST date, straight from a listing of runs/ (keys only; 60 s cache per isolate).
let countsCache = { at: 0, val: null };
async function vaultCounts(env) {
  if (countsCache.val && Date.now() - countsCache.at < 60000) return countsCache.val;
  const perDate = new Map(), hist24 = new Set();
  let files = 0, cursor;
  do {
    const page = await env.RESULTS.list({ prefix: "runs/", cursor, limit: 1000 });
    for (const o of page.objects) {
      const m = /^runs\/([^/]+)\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/(.+?)(\.attempt\d+)?\.json$/.exec(o.key);
      if (!m || m[5]) continue;
      files++;
      const id = `${m[2]}/${m[4]}`;
      if (!perDate.has(m[3])) perDate.set(m[3], new Set());
      perDate.get(m[3]).add(id);
      if (m[1].startsWith("hist-bulk-2026092") && !m[1].includes("backfill")) hist24.add(`${m[2]}/${m[3]}/${m[4]}`); // last night's HIST mining: every hist-bulk run started 24-25 Sep
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const val = { listed_at: new Date().toISOString(), run_files: files, by_date: Object.fromEntries([...perDate].map(([d, s]) => [d, s.size])), hist_24sep_windows: hist24.size };
  countsCache = { at: Date.now(), val };
  return val;
}


// ---------------------------------------------------------------- consult view (ruling 337a)
// One room, one IST day: the windows in time order, every segment with its absolute time, English / readability / re-run overlays merged in.
const SCORE = { text: 5, refused: 4, no_text: 3, no_signal: 2, untested: 2, failed: 1 };
let viewCache = { at: 0, key: null, rows: null };
async function viewRows(env) {
  if (viewCache.rows && Date.now() - viewCache.at < 60000) return viewCache;
  const key = await newest(env, "index/view-", ".jsonl");
  if (!key) return { key: null, rows: [] };
  if (viewCache.key === key) { viewCache.at = Date.now(); return viewCache; }
  const obj = await env.RESULTS.get(key);
  const rows = (await obj.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  viewCache = { at: Date.now(), key, rows };
  return viewCache;
}
const GRID = /^\d{4}-\d{2}-\d{2}_room_[a-z0-9]+_\d{4}$/;   // the regular HIST windows (15-minute grid); link-3, backfill and other windows are irregular
const rank = (r) => [(r.status === "text" ? 1 : 0), (GRID.test(r.window_id ?? "") ? 1 : 0), r.n_words ?? 0, r.complete ? 1 : 0, r.run_id ?? ""];
const rankCmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i] ? -1 : 1; return 0; };
const OVERLAP_MS = 1000;
// One window per stretch of time (ruling 337a, refuter-2 #1931): rank the windows (text first, then grid, then more words) and keep each
// one that does not overlap an already-kept window by more than a second. The rest are HIDDEN (they repeat minutes already on the page).
export function splitWindows(rows) {
  const ws = rows.filter((r) => r.start && r.end && !isNaN(Date.parse(r.start)) && !isNaN(Date.parse(r.end)) && r.producer !== "stt-parity")
    .map((r) => ({ ...r, s: Date.parse(r.start), e: Date.parse(r.end) })).sort(rankCmp);
  const kept = [], hidden = [];
  for (const w of ws) (kept.some((k) => Math.min(k.e, w.e) - Math.max(k.s, w.s) > OVERLAP_MS) ? hidden : kept).push(w);
  const byTime = (a, b) => a.s - b.s || a.e - b.e;
  return { kept: kept.sort(byTime), hidden: hidden.sort(byTime) };
}
export const pickWindows = (rows) => splitWindows(rows).kept;
// annotations/speaker (337e labels, SCHEMA.md): A..Z, S<n>, or ? (unlabelled). Letters are WINDOW-LOCAL, so nothing here joins a letter across windows.
const SPK = /^(?:[A-Z]|S\d{1,3}|\?)$/;
export function speakerOf(it) {
  if (!it || typeof it.speaker !== "string" || !SPK.test(it.speaker)) return null;
  const seq = it.mixed === true && Array.isArray(it.seq) && it.seq.length >= 1 && it.seq.length <= 6 && it.seq.every((x) => typeof x === "string" && SPK.test(x) && x !== "?") ? it.seq : null;
  return { l: it.speaker, mixed: !!seq, seq };
}
async function annotationMaps(env, room, date) {
  const out = { translation: new Map(), readability: new Map(), retranscription: new Map(), speaker: new Map() }, files = {};
  let bad = 0;   // a file that is not valid JSON is skipped and counted, never a 500 for the whole consult
  for (const kind of Object.keys(out)) {
    const page = await env.RESULTS.list({ prefix: `annotations/${kind}/${room}/${date}/`, limit: 200 });
    const keys = page.objects.map((o) => o.key).sort(); // file names start with a timestamp: later files win
    files[kind] = keys.length;
    const docs = await Promise.all(keys.slice(-120).map(async (k) => { try { const o = await env.RESULTS.get(k); return o ? JSON.parse(await o.text()) : null; } catch { bad++; return null; } }));
    if (kind === "speaker") {
      // letters only mean something inside ONE labelling run of ONE window: the latest file that labels a window replaces that window's labels as a whole, never segment by segment
      const byWin = new Map();
      for (const d of docs) {
        const fresh = new Map();
        for (const it of Array.isArray(d?.items) ? d.items : []) if (typeof it?.k === "string" && Number.isInteger(it.i)) (fresh.get(it.k) || fresh.set(it.k, new Map()).get(it.k)).set(it.i, it);
        for (const [k, m] of fresh) byWin.set(k, m);
      }
      for (const [k, m] of byWin) for (const [i, it] of m) out.speaker.set(`${k}|${i}`, it);
      continue;
    }
    for (const d of docs) for (const it of Array.isArray(d?.items) ? d.items : []) if (typeof it?.k === "string" && Number.isInteger(it.i)) out[kind].set(`${it.k}|${it.i}`, it);
  }
  return { maps: out, files, bad };
}
const CORRECTION_STATUSES = ["near_silence", "undetermined", "transcribed_unconfirmed"];
// annotations/correction/<room>/<date>/ (ruling 341): window_id -> the owners' corrected status of a NO_SIGNAL mark; the later file wins
async function corrections(env, room, date) {
  const page = await env.RESULTS.list({ prefix: `annotations/correction/${room}/${date}/`, limit: 200 });
  const docs = await Promise.all(page.objects.map((o) => o.key).sort().slice(-120).map(async (k) => { const o = await env.RESULTS.get(k); try { return o ? JSON.parse(await o.text()) : null; } catch { return null; } }));
  const windows = {};
  for (const d of docs) for (const it of d?.items ?? []) if (typeof it?.k === "string" && CORRECTION_STATUSES.includes(it.status)) windows[it.k.split("/").pop()] = it.status;
  return { room_id: room, date, windows };
}
async function consult(env, room, date) {
  const { key: viewKey, rows } = await viewRows(env);
  const day = rows.filter((r) => r.room_id === room && r.ist_date === date);
  const { kept, hidden: hid0 } = splitWindows(day);
  // a hidden window that holds text in minutes no kept window covers is not thrown away: its lines in those minutes are shown
  const uncovered = (h) => { let parts = [[h.s, h.e]]; for (const k of kept) parts = parts.flatMap(([a, b]) => (k.e <= a || k.s >= b ? [[a, b]] : [...(k.s > a ? [[a, k.s]] : []), ...(k.e < b ? [[k.e, b]] : [])])); return parts.filter(([a, b]) => b - a > 5000); };
  const partials = hid0.filter((h) => h.status === "text").map((h) => ({ ...h, parts: uncovered(h), partial: true })).filter((h) => h.parts.length);
  const hidden = hid0.filter((h) => !partials.some((p) => p.key === h.key));
  const wins = [...kept, ...partials].sort((a, b) => a.s - b.s || a.e - b.e);
  const { maps, files, bad } = await annotationMaps(env, room, date);
  const segments = [], windows = [];
  const loaded = [];
  for (let i = 0; i < wins.length; i += 20) loaded.push(...(await Promise.all(wins.slice(i, i + 20).map(async (w) => (w.status === "text" || w.status === "refused" ? loadWindow(env, w.key) : null)))));
  wins.forEach((w, wi) => {
    const k = w.key.replace(/^runs\//, "").replace(/\.json$/, "");
    windows.push({ k, t0: w.t0, t1: w.t1, s: w.s, e: w.e, status: w.status, untested_kind: w.untested_kind ?? null, n_words: w.n_words, run_id: w.run_id, partial: !!w.partial });
    const d = loaded[wi];
    if (!d) return;
    const segs = Array.isArray(d.segments) ? d.segments : [];
    segs.map((s, i) => [s, i]).sort((a, b) => (Number(a[0]?.start_s) || 0) - (Number(b[0]?.start_s) || 0)).forEach(([s, i]) => {
      if (!s || typeof s !== "object") return;
      if (w.partial) { const mid = w.s + ((Number(s.start_s) || 0) + (Number(s.end_s) || 0)) * 500; if (!w.parts.some(([a, b]) => mid >= a && mid < b)) return; }   // only the minutes no other window shows
      const tr = maps.translation.get(`${k}|${i}`), rd = maps.readability.get(`${k}|${i}`), rt = maps.retranscription.get(`${k}|${i}`), sp = speakerOf(maps.speaker.get(`${k}|${i}`));
      segments.push({
        t: w.s + (Number(s.start_s) || 0) * 1000, e: w.s + (Number(s.end_s) || 0) * 1000, w: wi, i, lang: s.lang ?? null, engine: s.engine ?? null,
        text: typeof s.text === "string" ? s.text : "", refused: !!s.refused, why: s.refused_reason ?? null,
        en: (tr && typeof tr.en === "string" && tr.en) || (typeof s.text_en === "string" && s.text_en) || null,
        enq: (tr && typeof tr.q === "string" && tr.q !== "ok" && tr.q) || null,           // linker's q: ok | garbled | untranslatable | mt_failed; "ok" carries no flag
        enerr: (tr && !tr.en && (tr.err || (tr.q === "ok" ? "empty" : tr.q))) || null,   // q "ok" with an empty English (the model can return one) is said, not read as a failure reason
        flag: rd ? { ok: rd.ok ?? null, score: rd.score ?? null, why: rd.why ?? null, collapse: rd.collapse === true } : null,
        sp,
        re: rt ? { text2: rt.text2 ?? null, engine2: rt.engine2 ?? null, lang2: rt.lang2 ?? null, better: rt.better ?? null } : null,
      });
    });
  });
  segments.sort((a, b) => a.t - b.t);
  const words = segments.reduce((n, s) => n + (s.refused ? 0 : s.text.split(/\s+/).filter(Boolean).length), 0);
  const nonEn = segments.filter((s) => !s.refused && s.text.trim() && s.lang && s.lang !== "en");
  const hiddenOut = hidden.map((h) => ({ k: h.key.replace(/^runs\//, "").replace(/\.json$/, ""), t0: h.t0, t1: h.t1, s: h.s, e: h.e, status: h.status, n_words: h.n_words, run_id: h.run_id }));
  return { room_id: room, room_name: day[0]?.room_name ?? room, date, view_key: viewKey, windows, hidden: hiddenOut, segments,
    counts: { windows: windows.length, hidden_windows: hiddenOut.length, segments: segments.length, words, non_english: nonEn.length, with_english: nonEn.filter((s) => s.en).length, annotation_files: files, bad_annotation_files: bad } };
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

const CSP = (nonce) => `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
async function route(request, env, url) {
  const path = url.pathname;
  if (path === "/") {
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    return new Response(shell(nonce), { headers: baseHeaders({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP(nonce),
    }) });
  }
  if (path === "/roadmap") {   // FABLE 459.5: docs snapshot page, rendered server-side, zero client script, gated by the same Access+ALLOWED_EMAILS check as every route
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    return new Response(roadmapPage().replaceAll("__NONCE__", nonce), { headers: baseHeaders({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP(nonce),
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
  if (path === "/api/view-index") {
    const key = await newest(env, "index/view-", ".jsonl");
    return (key && (await streamObject(env, key))) || json(404, { error: "no view index yet" });
  }
  if (path === "/api/vault-counts") return json(200, await vaultCounts(env));
  if (path.startsWith("/api/corrections/")) {
    const [room, date, extra] = path.slice("/api/corrections/".length).split("/");
    if (extra !== undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(room ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return json(404, { error: "not found" });
    return json(200, await corrections(env, room, date));
  }
  if (path.startsWith("/api/consult/")) {
    const [room, date, extra] = path.slice("/api/consult/".length).split("/");
    if (extra !== undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(room ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return json(404, { error: "not found" });
    return json(200, await consult(env, room, date));
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
    const url = new URL(request.url);
    if (url.pathname === "/api/me" && request.method === "GET") return json(200, { rater: isRater(env, who.email) });
    try {
      const r = await rateRoute(request, env, url, who, (html, set) => {
        const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
        return new Response(html.replaceAll("__NONCE__", nonce), { headers: baseHeaders({ "content-type": "text/html; charset=utf-8", "content-security-policy": CSP(nonce) }) });
      });
      if (r) return r;
    } catch (e) { return json(500, { error: "internal" }); }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: baseHeaders({ allow: "GET, HEAD" }) });
    try {
      return await route(request, env, new URL(request.url));
    } catch (e) {
      return json(500, { error: "internal" });
    }
  },
};
