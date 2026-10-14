// Mock of lab-viewer's proposed /api/rate/* contract (r349, #2003) + GET /rate with the viewer's exact CSP. Invented mock docs only.
// node mock-server.mjs <port>   (rows: ../segment-label/mock-rows, excerpts: ../readability-rate/mock-excerpts, or MOCK_ROWS / MOCK_EXCERPTS)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
import {rateShell} from "./rate-ui.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const load = d => fs.readdirSync(d).filter(f => f.endsWith(".json")).sort().map(f => JSON.parse(fs.readFileSync(path.join(d, f), "utf8")));
const rows = load(process.env.MOCK_ROWS || path.join(here, "../segment-label/mock-rows"));
const exc = load(process.env.MOCK_EXCERPTS || path.join(here, "../readability-rate/mock-excerpts"));
const SETS = {
  label200: {docs: rows.map(d => ({id: d.id, n: d.n, lang: d.lang, dur_s: d.dur_s, text: d.text})), // whitelist, as the Worker does
    check: b => ["readable", "romanised_readable", "garbled", "wrong_language", "unsure"].includes(b.label)},
  rate20: {docs: exc.map(d => ({id: d.id, lines: d.lines.map(l => ({t: l.t, lang: l.lang, text: l.text, ...(l.en ? {en: l.en} : {})}))})),
    check: b => {const V = {readable: ["yes","partly","no"], useful: ["yes","little","no"], wrong_lang: ["no","some","most"], garbled: ["none","some","much"], english_right: ["yes","no"]};
      return Object.keys(b).every(k => k === "note" ? typeof b[k] === "string" : V[k] && V[k].includes(b[k]))}}};
const store = {label200: {}, rate20: {}}, puts = [];
const send = (res, code, obj, extra = {}) => {res.writeHead(code, {"content-type": "application/json", "cache-control": "private, no-store", ...extra}); res.end(JSON.stringify(obj))};
http.createServer((req, res) => {
  const url = new URL(req.url, "http://x"), p = url.pathname;
  if (p === "/rate") {
    const nonce = crypto.randomBytes(16).toString("base64");
    res.writeHead(200, {"content-type": "text/html; charset=utf-8", "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
    return res.end(rateShell(nonce));
  }
  if (p === "/__reset") {store.label200 = {}; store.rate20 = {}; puts.length = 0; return send(res, 200, {ok: true})}
  if (p === "/__state") return send(res, 200, {store, puts});
  if (p === "/api/rate/sets") return send(res, 200, Object.entries(SETS).map(([set, s]) => ({set, n: s.docs.length})));
  const m = /^\/api\/rate\/(label200|rate20)(?:\/([A-Za-z0-9_-]+))?$/.exec(p);
  if (!m) return send(res, 404, {error: "not found"});
  const [, set, id] = m, S = SETS[set];
  if (req.method === "GET" && !id) return send(res, 200, S.docs);
  if (req.method === "GET" && id === "mine") return send(res, 200, store[set]);
  if (req.method === "PUT" && id && id !== "mine" && S.docs.some(d => d.id === id)) {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      let b; try {b = JSON.parse(body)} catch (e) {return send(res, 400, {error: "bad json"})}
      if (!b || typeof b !== "object" || !S.check(b)) return send(res, 400, {error: "bad value"});
      store[set][id] = {id, ...b}; puts.push({set, id, keys: Object.keys(b).sort()}); send(res, 200, {ok: true});
    }); return;
  }
  send(res, 405, {error: "method"});
}).listen(+process.argv[2] || 0, "127.0.0.1", function () {console.log("listening " + this.address().port)});
