// Rating pages (ruling 349, bucket per ruling 359; third set ba106 per ruling 375): ONE place on the viewer where V and Sandhya label lines. Everything here lives in its OWN
// R2 bucket, eta-lab-ratings (binding RATINGS); the vault bucket (RESULTS) is never written by the viewer. Two prefixes:
//   rate-seed/<set>.json            the rows to rate (loaded by tools/rate_seed.py; read-only here)
//   rate/<set>/<hash>.json          a rater's current answers; rate-history/<set>/<hash>/<ms>.json every version (never edited)
// <hash> = first 16 hex of sha256(rater email). Raters are the verified Access identity (never a client-sent id) AND must be in the
// RATERS secret (fail closed when unset); every other allowed viewer is refused on these routes. A rater reads only their own answers,
// so the labels stay blind to each other. Keys are built only from a whitelisted set name + the hash, so no request can name another key.
import { PAGES } from "./rate_pages.js";

const LABELS = ["readable", "romanised_readable", "garbled", "wrong_language", "unsure"];
const TAGS_L = ["diff_lang_speakers", "code_mixed", "crosstalk", "non_clinical", "partly_readable", "med_terms_wrong", "audio_poor", "words_missing"];   // 421c(A): optional descriptive tags on label200, stable keys, never scored, never gate a save
const V3 = ["yes", "partly", "little", "no"];
const PAIR = ["A_better", "B_better", "same", "neither_readable", "unsure"];
export const SETS = {
  label200: {
    rows: "rows", answers: "labels", maxIds: 200, clip: "gloss",   // 421a: per-row audio clip + English gloss, both PRIVATE maps by row id (the seed bytes are frozen and untouched)
    row: (x) => ({ id: str(x.id, 40), n: num(x.n), lang: str(x.lang, 12) || "und", dur_s: num(x.dur_s), text: str(x.text, 6000) }),
    value: (v) => {
      const o = only(v, ["a", "note", "ts", "mode", "g", "tags"]);
      if (!o) return null;
      const okA = LABELS.includes(o.a) || o.a === "cant_judge";
      const okMode = o.mode === undefined || o.mode === "audio" || o.mode === "text";
      const okTags = o.tags === undefined || (Array.isArray(o.tags) && o.tags.length <= 8 && new Set(o.tags).size === o.tags.length && o.tags.every((t) => TAGS_L.includes(t)));
      return okA && okMode && okTags && (o.g === undefined || typeof o.g === "boolean") && optStr(o.note, 4000) && optStr(o.ts, 40) ? o : null;   // note cap 4,000 per 421c(B): V must not be cut off
    },
  },
  ba106: {   // r375: indic-mt's before/after sheet, A/B order shuffled and the mapping kept private by indic-mt; 10 rows are identical A/B on purpose (a position-bias control)
    rows: "rows", answers: "labels", maxIds: 106,
    row: (x) => ({ id: str(x.id, 40), n: num(x.n), lang: str(x.lang, 12) || "und", text_A: str(x.text_A, 6000), text_B: str(x.text_B, 6000) }),
    value: (v) => { const o = only(v, ["a", "note", "ts"]); return o && PAIR.includes(o.a) && optStr(o.note, 500) && optStr(o.ts, 40) ? o : null; },
  },
  rate20: {
    rows: "excerpts", answers: "ratings", maxIds: 60,
    row: (x) => ({ id: str(x.id, 40), lines: (Array.isArray(x.lines) ? x.lines : []).slice(0, 40).map((l) => ({ t: str(l?.t, 12), lang: str(l?.lang, 12) || "und", text: str(l?.text, 3000), ...(typeof l?.en === "string" && l.en ? { en: str(l.en, 3000) } : {}) })) }),
    value: (v) => {
      const o = only(v, ["readable", "useful", "wrong_lang", "garbled", "en_ok", "note", "ts"]);
      const ok = (k, set) => o[k] === undefined || set.includes(o[k]);
      return o && ok("readable", V3) && ok("useful", V3) && ok("en_ok", V3) && ok("wrong_lang", ["no", "some", "most"]) && ok("garbled", ["none", "some", "much"]) && optStr(o.note, 500) && optStr(o.ts, 40) ? o : null;
    },
  },
  calib30: {   // r414.3: V's 30-item human-vs-Jev calibration gate: 20 label200 lines (kind L) + 10 ba106 pairs (kind B), audio per item, gloss toggle, Jev hidden
    rows: "rows", answers: "labels", maxIds: 30, clip: true,
    row: (x) => ({
      id: str(x.id, 40), n: num(x.n), kind: str(x.kind, 1), lang: str(x.lang, 12) || "und",
      ...(str(x.kind, 1) === "B"
        ? { text_A: str(x.text_A, 6000), text_B: str(x.text_B, 6000), gloss_A: str(x.gloss_A, 6000), gloss_B: str(x.gloss_B, 6000) }
        : { dur_s: num(x.dur_s), text: str(x.text, 6000), gloss: str(x.gloss, 6000) }),
    }),
    value: (v, row) => {
      const o = only(v, ["a", "mode", "g", "ts"]);
      if (!o) return null;
      const allowed = (row && row.kind === "B" ? PAIR : LABELS).concat("cant_judge");
      return allowed.includes(o.a) && (o.mode === "audio" || o.mode === "text") && (o.g === undefined || typeof o.g === "boolean") && optStr(o.ts, 40) ? o : null;
    },
  },
};
const str = (s, max) => (typeof s === "string" ? s.slice(0, max) : "");
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const optStr = (s, max) => s === undefined || (typeof s === "string" && s.length <= max);
// an object holding only the listed keys, else null
function only(v, keys) { return v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => keys.includes(k)) ? v : null; }

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function raterHash(email) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email))).slice(0, 16); }
export const isRater = (env, email) => String(env.RATERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(email);

const HDRS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin", "x-frame-options": "DENY" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...HDRS, "content-type": "application/json" } });
const refuse = () => new Response("forbidden", { status: 403, headers: { ...HDRS, "content-type": "text/plain" } });

async function seedRows(env, set) {
  const o = await env.RATINGS.get(`rate-seed/${set}.json`);
  if (!o) return null;
  let d; try { d = JSON.parse(await o.text()); } catch { return null; }
  const s = SETS[set], list = Array.isArray(d) ? d : d?.[s.rows];
  if (!Array.isArray(list)) return null;
  const rows = list.filter((x) => x && typeof x === "object").map(s.row).filter((r) => r.id && (set === "label200" || set === "calib30" ? (r.kind === "B" ? r.text_A.trim() && r.text_B.trim() : r.text.trim()) : set === "ba106" ? r.text_A.trim() && r.text_B.trim() : r.lines.length));
  return new Set(rows.map((r) => r.id)).size === rows.length ? rows : null;   // ids unique, or the seed is unusable
}

// path is /rate/<set> (the page) or /api/rate/<set>/rows | mine | clip. Returns null for a path that is not ours.
export async function rateRoute(request, env, url, who, pageShell) {
  const m = /^\/(?:api\/)?rate\/([a-z0-9]+)(?:\/(rows|mine|clip))?$/.exec(url.pathname);
  if (!m) return url.pathname === "/rate" || url.pathname.startsWith("/rate/") || url.pathname.startsWith("/api/rate/") ? json(404, { error: "not found" }) : null;
  if (!isRater(env, who.email)) return refuse();
  const [, set, part] = m, s = SETS[set], api = url.pathname.startsWith("/api/");
  if (!s || (api && !part) || (!api && part)) return json(404, { error: "not found" });
  if (!api) {   // the page: the tested UI (tools/segment-label, tools/readability-rate) served with a shim, under the same nonce CSP as the viewer
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET, HEAD" } });
    return pageShell(PAGES[set], set);
  }
  if (part === "clip") {   // r414.3: id -> (window key, segment index) so the page can play THAT line's audio same-origin; nothing else is served, no R2 key ever leaves the Worker
    if (!s.clip || request.method !== "GET") return json(404, { error: "not found" });
    const id = url.searchParams.get("id") || "";
    const o = await env.RATINGS.get(`rate-seed/${set}.clip.json`);
    if (!o) return json(404, { error: "no clip map" });
    let map; try { map = JSON.parse(await o.text()); } catch { return json(500, { error: "clip map unreadable" }); }
    const c = map[id];
    if (!c || typeof c.k !== "string" || !Number.isInteger(c.i) || c.i < 0 || c.i > 5000) return json(404, { error: "no clip for this id" });
    const parts = c.k.split("/");
    if (parts.length !== 4 || parts.some((p) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(p))) return json(500, { error: "clip map invalid" });   // ONE alphabet with make_calib30 (no dots anywhere: window ids never carry them; ".." is unreachable by construction); /api/window re-validates via windowKey->parseKey
    const t0 = Number(c.t0), t1 = Number(c.t1);
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 < 0 || t1 <= t0 || t1 > 4 * 3600) return json(500, { error: "clip map times invalid" });
    let gloss = null;
    if (s.clip === "gloss") {
      const go = await env.RATINGS.get(`rate-seed/${set}.gloss.json`);
      if (go) { try { const gm = JSON.parse(await go.text()); const gv = gm[id]; if (typeof gv === "string" && gv.length) gloss = gv.slice(0, 6000); } catch { gloss = null; } }   // a missing or broken gloss map simply means no toggle; never an error
    }
    return json(200, { k: c.k, i: c.i, t0, t1, ...(gloss ? { gloss } : {}) });
  }
  if (part === "rows") {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET" } });
    const rows = await seedRows(env, set);
    return rows ? json(200, { set, rows }) : json(404, { error: "no rows loaded for this set" });
  }
  const h = await raterHash(who.email), key = `rate/${set}/${h}.json`;
  if (request.method === "GET") {
    const o = await env.RATINGS.get(key);
    return json(200, o ? JSON.parse(await o.text()) : { rater: who.email, schema: 1, set, t: {} });
  }
  if (request.method !== "PUT") return new Response("method not allowed", { status: 405, headers: { ...HDRS, allow: "GET, PUT" } });
  // a same-site page only: a cross-site request never carries both of these
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return json(415, { error: "application/json only" });
  const site = request.headers.get("sec-fetch-site"); if (site && site !== "same-origin") return refuse();
  const text = await request.text();
  if (text.length > 200000) return json(413, { error: "too large" });
  let body; try { body = JSON.parse(text); } catch { return json(400, { error: "not json" }); }
  const t = body?.t;
  if (!t || typeof t !== "object" || Array.isArray(t)) return json(422, { error: "t must be an object {id: answer}" });
  const ids = Object.keys(t);
  if (ids.length > s.maxIds) return json(422, { error: "too many ids" });
  const rows = await seedRows(env, set);
  if (!rows) return json(409, { error: "no rows loaded for this set" });
  const known = new Set(rows.map((r) => r.id)), byId = new Map(rows.map((r) => [r.id, r])), clean = {};
  for (const id of ids) {
    if (!known.has(id)) return json(422, { error: "unknown id" });
    const v = s.value(t[id], byId.get(id));
    if (!v) return json(422, { error: "answer not allowed", id });
    clean[id] = v;
  }
  const now = new Date();
  const doc = JSON.stringify({ rater: who.email, schema: 1, set, t: clean, updated: now.toISOString() });
  await env.RATINGS.put(`rate-history/${set}/${h}/${now.getTime()}.json`, doc, { httpMetadata: { contentType: "application/json" } });   // every version kept
  await env.RATINGS.put(key, doc, { httpMetadata: { contentType: "application/json" } });
  return json(200, { ok: true, saved: ids.length });
}
