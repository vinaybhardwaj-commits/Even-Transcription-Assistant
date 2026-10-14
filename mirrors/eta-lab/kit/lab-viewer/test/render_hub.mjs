// W27.4b: real Chromium on the rating hub under the production CSP (extracted from worker/index.js): zero console errors, zero CSP
// violations, no script, progress bars present, no horizontal scroll at phone width. Run: node kit/lab-viewer/test/render_hub.mjs
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
const { hubPage } = await import(join(HERE, "..", "worker", "hub.js"));
const m = /const CSP = \(nonce\) => `([^`]+)`/.exec(readFileSync(join(HERE, "..", "worker", "index.js"), "utf8"));
if (!m) throw new Error("cannot extract CSP()");
const csp = m[1].replace(/\$\{nonce\}/g, "testnonce");
const html = hubPage({ sets: [
  { set: "label200", loaded: 200, raters: [{ name: "Vinay", done: 200, updated: "2026-09-26T10:00:00.000Z" }, { name: "Sandhya", done: 37, updated: "2026-09-26T11:30:00.000Z" }] },
  { set: "ba106", loaded: 106, raters: [{ name: "Vinay", done: 0, updated: null }, { name: "Sandhya", done: null, updated: null }] },
  { set: "calib30", loaded: null, raters: [] } ] }).replaceAll("__NONCE__", "testnonce");
const srv = http.createServer((q, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp }); res.end(html); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const browser = await chromium.launch();
let fails = 0; const check = (n, ok) => { if (!ok) { fails++; console.log("FAIL " + n); } else console.log("ok " + n); };
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } }); const errors = [];
  page.on("console", (x) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => { window.__v = []; document.addEventListener("securitypolicyviolation", (e) => window.__v.push(e.blockedURI)); });
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  const d = await page.evaluate(() => ({ prog: [...document.querySelectorAll("progress")].map((p) => [p.value, p.max]), cards: document.querySelectorAll(".card").length, scripts: document.scripts.length, w: document.documentElement.scrollWidth <= innerWidth, txt: document.body.innerText }));
  check("3 cards", d.cards === 3); check("progress bars 200/200 and 37/200", d.prog.some(([v, m]) => v === 200 && m === 200) && d.prog.some(([v, m]) => v === 37 && m === 200));
  check("unreadable / not loaded / not started said", /unreadable/.test(d.txt) && /Not loaded yet/.test(d.txt) && /not started/.test(d.txt));
  check("no script element", d.scripts === 0); check("no horizontal scroll", d.w);
  check("zero console errors", errors.length === 0); check("zero CSP violations", (await page.evaluate(() => window.__v)).length === 0);
} finally { await browser.close(); srv.close(); }
console.log(fails ? `FAILED ${fails}` : "ALL PASS"); process.exit(fails ? 1 : 0);
