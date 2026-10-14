// Real-browser check of the rating pages (ruling 349): the real viewer Worker code + the tested pages, in headless Chromium, with a local
// Access stand-in (signed JWT per identity) and an in-memory bucket seeded with the REAL 200-row seed (label200) and the invented mock
// excerpts (rate20). Prints counts and states only, never text.
//   PW_DIR=<dir with node_modules/playwright-core> LD_LIBRARY_PATH=<libs> node rate_smoke.mjs
import http from "node:http";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import worker from "../worker/index.js";

const { chromium } = createRequire(join(process.env.PW_DIR, "/"))("playwright-core");
const SEED = process.env.RATE_SEED ?? join(homedir(), "eta-data/readability/r1/label-page-seed/seed_docs.json");
const MOCK = new URL("../../../tools/readability-rate/mock-excerpts/", import.meta.url).pathname;
const label = JSON.parse(readFileSync(SEED, "utf8"));
const excerpts = { excerpts: readdirSync(MOCK).filter((f) => /^X\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(MOCK, f), "utf8"))).map((x) => ({ id: x.id.replace("X", "R"), lines: x.lines })) };
const PAIRS = process.env.RATE_PAIRS ?? join(homedir(), "eta-data/pair-label/ba106/seed_docs.json");
const pairs = existsSync(PAIRS) ? JSON.parse(readFileSync(PAIRS, "utf8")) : { rows: Array.from({ length: 6 }, (_, i) => ({ id: "P00" + (i + 1), n: i + 1, lang: "kn", text_A: "invented A " + i, text_B: "invented B " + i })) };
const objs = new Map([["rate-seed/label200.json", JSON.stringify(label)], ["rate-seed/rate20.json", JSON.stringify(excerpts)], ["rate-seed/ba106.json", JSON.stringify(pairs)]]);
const bucket = { puts: [],
  async put(k, v) { this.puts.push(k); objs.set(k, String(v)); },
  async get(k) { const v = objs.get(k); return v === undefined ? null : { text: async () => v, body: new Response(v).body }; },
  async head(k) { return objs.has(k) ? { size: objs.get(k).length } : null },
  async list({ prefix }) { return { objects: [...objs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; } };
const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
const b64u = (b) => Buffer.from(b).toString("base64url");
const token = async (email) => { const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1" })), n = Math.floor(Date.now() / 1000), p = b64u(JSON.stringify({ iss: "https://team.test", aud: ["aud"], email, exp: n + 600, iat: n - 5 })); return `${h}.${p}.${b64u(Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, Buffer.from(`${h}.${p}`))))}`; };
const env = { ACCESS_TEAM_DOMAIN: "team.test", ACCESS_AUD: "aud", ALLOWED_EMAILS: "staff-redacted@even.in,staff-redacted@even.in,staff-redacted@even.in", RATERS: "staff-redacted@even.in,staff-redacted@even.in", __fetch: async () => new Response(JSON.stringify({ keys: [jwk] })), RESULTS: bucket, RATINGS: bucket, AUDIO: bucket };
const mk = (email) => http.createServer(async (req, res) => {
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, String(v));
  headers.set("cf-access-jwt-assertion", await token(email));
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : await new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });
  const r = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(0);
const servers = { v: mk("staff-redacted@even.in"), s: mk("staff-redacted@even.in"), ale: mk("staff-redacted@even.in") };
const base = (w) => `http://127.0.0.1:${servers[w].address().port}`;
const browser = await chromium.launch({ headless: true });
const out = { console_errors: [], csp_violations: [], external_requests: [], bad_responses: [] };
async function open(who, path, viewport = { width: 375, height: 800 }) {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on("console", (m) => { if (m.type() === "error") out.console_errors.push(m.text().slice(0, 140)); if (/content security policy/i.test(m.text())) out.csp_violations.push(m.text().slice(0, 140)); });
  page.on("response", (r) => { if (r.status() >= 400) out.bad_responses.push(r.status() + " " + new URL(r.url()).pathname.replace(/[0-9a-f]{16}/g, "<h>")); });
  page.on("pageerror", (e) => out.console_errors.push(String(e).slice(0, 140)));
  page.on("request", (r) => { if (!r.url().startsWith(base(who))) out.external_requests.push(r.url().slice(0, 80)); });
  const resp = await page.goto(base(who) + path); return { page, status: resp.status() };
}
try {
  // ---- label200: V labels three lines, reloads, sees them; Sandhya sees none of them; ale (viewer, not a rater) is refused
  const a = await open("v", "/rate/label200");
  await a.page.waitForFunction(() => /\/ 200/.test(document.body.innerText) && document.querySelector("#panel")?.innerText.length > 5, null, { timeout: 15000 });
  const r = { page_status: a.status, count_shown: /(\d+) \/ 200/.exec(await a.page.textContent("#prog"))?.[0] };
  r.first_line_has_text = (await a.page.textContent("#panel")).trim().length > 5;
  for (const k of ["1", "2", "3"]) { await a.page.keyboard.press(k); await a.page.keyboard.press("n"); }
  await a.page.waitForFunction(() => /Saved/.test(document.querySelector("#status")?.textContent ?? ""), null, { timeout: 8000 });
  r.saved_puts = bucket.puts.filter((k) => k.startsWith("rate/label200/")).length > 0;
  const mine = JSON.parse(objs.get(bucket.puts.filter((k) => /^rate\/label200\/[0-9a-f]{16}\.json$/.test(k)).at(-1)));
  r.stored = { rater: mine.rater, ids: Object.keys(mine.t).length, labels: Object.values(mine.t).map((x) => x.a) };
  r.horizontal_scroll = await a.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  const a2 = await open("v", "/rate/label200", { width: 1280, height: 900 });
  await a2.page.waitForFunction(() => /^3 \/ 200/.test(document.querySelector("#prog")?.textContent ?? ""), null, { timeout: 15000 });
  r.reload_shows_my_3 = true;
  const b = await open("s", "/rate/label200");
  await b.page.waitForFunction(() => /\/ 200/.test(document.querySelector("#prog")?.textContent ?? ""), null, { timeout: 15000 });
  r.other_rater_sees = (await b.page.textContent("#prog")).trim();
  r.non_rater_status = (await open("ale", "/rate/label200")).status; r.non_rater_api = (await (await fetch(base("ale") + "/api/rate/label200/rows")).status);
  r.no_engine_words_visible = !/engine|flag|SECRET/i.test(await a.page.evaluate(() => document.body.innerText));
  out.label200 = r;
  // ---- rate20: pick one answer per question for excerpt 1 with the real radios
  const c = await open("s", "/rate/rate20");
  await c.page.waitForSelector(".card", { timeout: 15000 });
  const radios = await c.page.locator("fieldset").count();
  for (let i = 0; i < radios; i++) await c.page.locator("fieldset").nth(i).locator("label.opt").first().click();
  await c.page.waitForFunction(() => /Saved/.test(document.querySelector("#status")?.textContent ?? ""), null, { timeout: 8000 });
  const key = bucket.puts.filter((k) => /^rate\/rate20\/[0-9a-f]{16}\.json$/.test(k)).at(-1);
  out.rate20 = { fieldsets: radios, stored_excerpts: Object.keys(JSON.parse(objs.get(key)).t).length, horizontal_scroll: await c.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1) };
  // ---- ba106: two texts per screen, keys 1-5 -> A_better, B_better, same, neither_readable, unsure
  const d = await open("v", "/rate/ba106");
  await d.page.waitForFunction(() => /\/ \d+/.test(document.querySelector("#prog")?.textContent ?? "") && document.querySelector("#panel")?.innerText.length > 5, null, { timeout: 15000 });
  for (const k of ["1", "2", "3", "4", "5"]) { await d.page.keyboard.press(k); await d.page.keyboard.press("n"); }
  await d.page.waitForFunction(() => /Saved/.test(document.querySelector("#status")?.textContent ?? ""), null, { timeout: 8000 });
  const bkey = bucket.puts.filter((k) => /^rate\/ba106\/[0-9a-f]{16}\.json$/.test(k)).at(-1);
  out.ba106 = { rows: pairs.rows.length, stored: Object.values(JSON.parse(objs.get(bkey)).t).map((x) => x.a), horizontal_scroll: await d.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1) };
  // ---- the SPA shows the rating links only to raters
  const home = await open("v", "/"); await home.page.waitForFunction(() => document.querySelectorAll("nav a").length >= 5, null, { timeout: 8000 });
  const homeAle = await open("ale", "/"); await homeAle.page.waitForTimeout(800);
  out.nav = { rater_links: await home.page.locator("nav a").count(), non_rater_links: await homeAle.page.locator("nav a").count() };
  out.history_files = bucket.puts.filter((k) => k.startsWith("rate-history/")).length;
} catch (e) { out.error = String(e).slice(0, 400); }
await browser.close(); Object.values(servers).forEach((s) => s.close());
console.log(JSON.stringify(out, null, 1));
process.exit(out.error ? 1 : 0);
