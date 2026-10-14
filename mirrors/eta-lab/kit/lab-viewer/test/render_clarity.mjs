// CLARITY page: real Chromium under the production CSP (extracted from worker/index.js). Invented fixture rows by default; set CLARITY_BUILD=<dir with clarity/>
// (the tools/clarity_seed.py build output) to ALSO render the real 200 clips and PLAY one real clip (nothing about the real text is printed).
// Zero console errors, zero CSP violations, no script element, filters are links, phone width has no horizontal scroll.
import { createRequire } from "module";
import { existsSync, readFileSync } from "fs";
import http from "http";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
const HERE = dirname(fileURLToPath(import.meta.url)), HOME = process.env.HOME || "";
if (!process.env.LD_LIBRARY_PATH?.includes("eta-browser-check")) {
  const lib = join(HOME, ".cache", "eta-browser-check", "libs", "usr", "lib", "x86_64-linux-gnu");
  if (existsSync(lib)) process.env.LD_LIBRARY_PATH = [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}
const PW = process.env.PW_DIR || join(HOME, ".cache", "eta-browser-check");
const { chromium } = createRequire(join(PW, "node_modules", "x"))("playwright-core");
const { clarityPage, clarityModel, parseFilters } = await import(join(HERE, "..", "worker", "clarity.js"));
const m = /const CSP = \(nonce\) => `([^`]+)`/.exec(readFileSync(join(HERE, "..", "worker", "index.js"), "utf8"));
const csp = m[1].replace(/\$\{nonce\}/g, "testnonce");

const eng = (t) => ({ st: "text", t });
const fixture = { rows: [
  { id: "L001", n: 1, tag: "en", dur_s: 12, lid: { name: "english", code: "en", p: 0.99, p_en: 0.99 }, whisper: eng("plain english"), sravaani: eng("plain english"), indic: { st: "skipped", why: "router tag en" } },
  { id: "L002", n: 2, tag: "kn", dur_s: 20, lid: { name: "kannada", code: "kn", p: 0.8, p_en: 0.01 }, whisper: eng("romanised words"), sravaani: eng("ಇದು ಕನ್ನಡ ಪಠ್ಯ"), indic: eng("ಇದು ಕನ್ನಡ") },
  { id: "L003", n: 3, tag: "kn", dur_s: 25, lid: { name: "hindi", code: "hi", p: 0.5, p_en: 0.2 }, whisper: eng("<b>tags</b> stay text"), sravaani: eng("romanised kannada here"), indic: { st: "empty", t: "" } },
  { id: "L004", n: 4, tag: "und", dur_s: 9, lid: null, whisper: eng("x"), sravaani: { st: "empty", t: "" }, indic: { st: "skipped", why: "und" } } ] };
const build = process.env.CLARITY_BUILD;
const realDoc = build ? JSON.parse(readFileSync(join(build, "clarity", "clips.json"), "utf8")) : null;
const fxd = { rows: { L002: { tag: "kn", conf: 0.9 }, L003: { tag: "hi", conf: 0.6, alt: ["kn"] } } };
const sc = { s1: { schema: 1, run_id: "rf", prereg_sha256: "ab12cd34ef56", old: "o", new: "n", suite_id: "st-1", rows: [
    { lang: "all", cond: "all", sig: true, n: 96, old: { wer: 0.42, cer: 0.2, hit: 55 }, new: { wer: 0.35, cer: 0.18, hit: 61 } }, { lang: "kn", cond: "fan10", sig: true, n: 8, old: { wer: 0.5, cer: 0.3, hit: 40 }, new: { wer: 0.6, cer: 0.35, hit: 30 } } ] },
  s2: { schema: 1, run_id: "cap", prereg_sha256: "0123456789ab", old: "o", new: "n", scorer: "efcc9c9", sample: { consults: 24, items: 169 }, rows: [{ scope: "overall", sig: true, n: 169, old: { captured_pct: 29.6, lo: 20, hi: 40 }, new: { captured_pct: 35, lo: 28, hi: 42 } }] },
  s3: { schema: 1, run_id: "lj", prereg_sha256: "ffff00001111", old: "o", new: "n", kept_error_pct: 12.5, kept_error_pct_diagnostic_note: "On the synthetic suite the kept-set error rises from 8.1% to 15.4% as the background gets louder.", judge: { model: "m", validated_on: "st-1", accuracy: { overall: 91, per_lang: { hi: 88 } }, usable: false }, rows: [{ lang: "hi", n: 30, kept_error_pct: 8, old: { wrong_pct: 20 }, new: { wrong_pct: 10 } }] } };
const env = (doc) => ({ RATINGS: { get: async (k) => (k === "clarity/clips.json" ? { text: async () => JSON.stringify(doc) } : k === "clarity/fixed.json" ? { text: async () => JSON.stringify(fxd) } : k === "clarity/scorecard.json" ? { text: async () => JSON.stringify(sc) } : null) } });

const srv = http.createServer(async (q, res) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/clarity" || u.pathname === "/real") {
    const model = await clarityModel(env(u.pathname === "/real" ? realDoc : fixture));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp });
    res.end(clarityPage(model, parseFilters(u.search)).replace(/__NONCE__/g, "testnonce")); return;
  }
  if (u.pathname.startsWith("/api/clarity/audio/") && build) {
    const f = join(build, "clarity", "audio", u.pathname.split("/").pop() + ".webm");
    if (existsSync(f)) { const b = readFileSync(f), r = /bytes=(\d+)-(\d*)/.exec(q.headers.range || ""); const s = r ? +r[1] : 0, e = r && r[2] ? +r[2] : b.length - 1;
      res.writeHead(r ? 206 : 200, { "content-type": "audio/webm", "accept-ranges": "bytes", ...(r ? { "content-range": `bytes ${s}-${e}/${b.length}` } : {}) }); res.end(b.subarray(s, e + 1)); return; }
  }
  res.writeHead(404); res.end("no");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
let fails = 0; const check = (n, ok) => { if (!ok) { fails++; console.log("FAIL " + n); } else console.log("ok " + n); };
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } }); const errors = [];
  page.on("console", (x) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => { window.__v = []; document.addEventListener("securitypolicyviolation", (e) => window.__v.push(e.blockedURI)); });
  await page.goto(base + "/clarity");
  const d = await page.evaluate(() => ({ clips: document.querySelectorAll(".clip").length, audio: document.querySelectorAll("audio").length, scripts: document.scripts.length, w: document.documentElement.scrollWidth <= innerWidth, bold: document.querySelectorAll(".col b").length, mm: [...document.querySelectorAll(".clip.mm")].map((n) => n.id), fixed: [...document.querySelectorAll(".clip")].map((n) => n.querySelectorAll(".col")[3].textContent.replace(/\s+/g, " ").trim()) }));
  check("4 clips, 4 audio players, no script element", d.clips === 4 && d.audio === 4 && d.scripts === 0);
  check("script mismatch marked only on L003 (romanised text under a kn tag)", JSON.stringify(d.mm) === '["L003"]');
  check("hostile-looking text stays text", !d.fixed.some((x) => /<b>/.test(x)) && (await page.evaluate(() => document.body.innerText.includes("<b>tags</b> stay text"))));
  check("fixed router column: empty message, filled row, changed row shows was", /not filled yet/.test(d.fixed[0]) && /^Fixed router\s*kn/.test(d.fixed[1]) && /hi.*was kn/.test(d.fixed[2]));
  check("no horizontal scroll at 390 px", d.w);
  const S = await page.evaluate(() => ({ h1: document.querySelector(".scorecard h1")?.textContent, panels: document.querySelectorAll(".sc").length, good: document.querySelectorAll(".sc .good").length, bad: document.querySelectorAll(".sc .bad").length,
    pending: [...document.querySelectorAll(".sc .none")].map((n) => n.textContent.slice(0, 8)), above: document.querySelector(".scorecard").compareDocumentPosition(document.querySelector(".clip")) & Node.DOCUMENT_POSITION_FOLLOWING, details: document.querySelectorAll(".sc details").length }));
  check("scorecard panel sits above the clips, 3 panels, none pending", /Scorecard/.test(S.h1) && S.panels === 3 && S.pending.length === 0 && S.above > 0);
  const s3text = await page.evaluate(() => document.body.innerText);
  check("S3 marked indicative-not-a-gate with the kept-set error rate shown", /INDICATIVE, NOT A GATE/.test(s3text) && /kept-set error on the synthetic validation suite: 12.5%/.test(s3text));
  check("S3 noise-degradation note shown, neutral (no colour span around it)", /rises from 8\.1% to 15\.4%/.test(s3text));
  check("deltas coloured (good and bad present), per-condition details folded", S.good >= 3 && S.bad >= 1 && S.details === 1);
  await page.click('a:has-text("script mismatch")');
  check("script-mismatch filter link works", (await page.evaluate(() => document.querySelectorAll(".clip").length)) === 1 && page.url().includes("mm=1"));
  await page.goto(base + "/clarity?tag=kn"); check("tag filter", (await page.evaluate(() => document.querySelectorAll(".clip").length)) === 2);
  await page.goto(base + "/clarity?lowen=1"); check("p(en) < 0.9 filter (kn, hi-LID and no-LID rows)", (await page.evaluate(() => document.querySelectorAll(".clip").length)) === 3);
  if (realDoc) {
    await page.goto(base + "/real");
    const r = await page.evaluate(() => ({ clips: document.querySelectorAll(".clip").length, w: document.documentElement.scrollWidth <= innerWidth }));
    check("REAL data: 200 clips render, no horizontal scroll", r.clips === 200 && r.w);
    const dur = await page.evaluate(async () => { const a = document.querySelector("#L001 audio"); a.preload = "auto"; a.load(); await new Promise((res) => { a.onloadedmetadata = res; a.onerror = res; setTimeout(res, 8000); }); return a.duration; });
    check("REAL data: L001 opus/webm loads and has a duration", Number.isFinite(dur) && dur > 5);
  }
  check("zero console errors", errors.length === 0); check("zero CSP violations", (await page.evaluate(() => window.__v)).length === 0);
} finally { await browser.close(); srv.close(); }
console.log(fails ? `FAILED ${fails}` : "ALL PASS"); process.exit(fails ? 1 : 0);
