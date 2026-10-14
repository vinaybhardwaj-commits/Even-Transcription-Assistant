// DRTPQMA page in real Chromium under the production CSP, fed test/drt_fake.json through the real drtOf. Screenshot to argv[2] if given.
import { createRequire } from "module";
import http from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, readFileSync } from "fs";
const HERE = dirname(fileURLToPath(import.meta.url)), HOME = process.env.HOME || "";
if (!process.env.LD_LIBRARY_PATH?.includes("eta-browser-check")) {
  const lib = join(HOME, ".cache", "eta-browser-check", "libs", "usr", "lib", "x86_64-linux-gnu");
  if (existsSync(lib)) process.env.LD_LIBRARY_PATH = [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}
const PW = process.env.PW_DIR || join(HOME, ".cache", "eta-browser-check");
const { chromium } = createRequire(join(PW, "node_modules", "x"))("playwright-core");
const { drtOf, DRT_PAGE } = await import(join(HERE, "..", "worker", "drt.js"));
const m = /const CSP = \(nonce\) => `([^`]+)`/.exec(readFileSync(join(HERE, "..", "worker", "index.js"), "utf8"));
const csp = m[1].replace(/\$\{nonce\}/g, "testnonce");
const html = DRT_PAGE.replaceAll("__DATE__", "2026-09-26").replaceAll("__NONCE__", "testnonce");
const doc = drtOf(readFileSync(join(HERE, "drt_fake.json"), "utf8"), "2026-09-26");
const tapeReqs = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/drt/2026-09-26") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp }); res.end(html); return; }
  if (u.pathname === "/api/drt/2026-09-26") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(doc)); return; }
  if (u.pathname === "/api/drt/2026-09-26/tape") { tapeReqs.push(u.searchParams.get("k")); res.writeHead(200, { "content-type": "audio/mp4" }); res.end(Buffer.alloc(16)); return; }
  res.writeHead(404); res.end();
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch();
let fails = 0; const check = (n, ok) => { if (!ok) { fails++; console.log("FAIL " + n); } else console.log("ok " + n); };
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } }); const errors = [];
  page.on("console", (x) => { if (x.type() === "error" && !/Failed to load resource|media/i.test(x.text())) errors.push(x.text()); }); page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => { window.__v = []; document.addEventListener("securitypolicyviolation", (e) => window.__v.push(e.blockedURI)); });
  await page.goto(base + "/drt/2026-09-26"); await page.waitForSelector("g.blk", { timeout: 5000 }).catch(async () => console.log("ERRORS", errors, "MSG", await page.locator("#msg").innerText(), await page.evaluate(() => window.__v)));
  check("4 encounter blocks", (await page.locator("g.blk").count()) === 4);
  check("3 room labels + 3 doctors in legend", (await page.locator("#legend span").count()) === 4);
  check("gaps listed", (await page.locator("#gaps li").count()) === 2);
  const txt = await page.evaluate(() => document.body.innerText);
  check("no patient-ish fields (only doctor/token/times)", !/uhid|patient/i.test(txt));
  check("schedule-only blocks are hatched (2 hatch overlays)", (await page.locator('rect[fill="url(#hatch)"]').count()) === 2);
  await page.locator("g.blk").nth(2).click(); await page.waitForTimeout(300);
  check("click opens player, first piece requested", !(await page.locator("#player").isHidden()) && tapeReqs[0] === "tapes/room_b2/2026-09-26/0900.m4a");
  check("no console errors / CSP violations", errors.length === 0 && (await page.evaluate(() => window.__v)).length === 0);
  check("no horizontal scroll", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });
  await page.setViewportSize({ width: 390, height: 800 });
  check("no horizontal scroll on a phone", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
} finally { await browser.close(); srv.close(); }
console.log(fails ? "FAILED " + fails : "ALL PASS"); process.exit(fails ? 1 : 0);
