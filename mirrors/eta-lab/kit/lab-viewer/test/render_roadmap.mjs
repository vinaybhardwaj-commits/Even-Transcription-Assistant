// 459.5 render test: real Chromium against the /roadmap page under the production CSP extracted from worker/index.js.
// Zero console errors, zero CSP violations, no <script> element at all, real DOM content (headings, the project table,
// nested lists, snapshot shas) and mobile-safe wrapping on phone width. Any miss -> FAIL. Run: node kit/lab-viewer/test/render_roadmap.mjs
import { createRequire } from "module";
import { existsSync } from "fs";
import http from "http";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || "";
if (!process.env.LD_LIBRARY_PATH?.includes("eta-browser-check")) {
  const lib = join(HOME, ".cache", "eta-browser-check", "libs", "usr", "lib", "x86_64-linux-gnu");
  if (existsSync(lib)) process.env.LD_LIBRARY_PATH = [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
}
const PW = process.env.PW_DIR || join(HOME, ".cache", "eta-browser-check");
const require = createRequire(join(PW, "node_modules", "x"));
const { chromium } = require("playwright-core");

const { roadmapPage } = await import(join(HERE, "..", "worker", "roadmap.js"));
const { DOCS } = await import(join(HERE, "..", "worker", "roadmap_docs.js"));
const html = roadmapPage().replaceAll("__NONCE__", "testnonce");

const idx = await import("fs").then((fs) => fs.readFileSync(join(HERE, "..", "worker", "index.js"), "utf8"));
const m = /const CSP = \(nonce\) => `([^`]+)`/.exec(idx);
if (!m) throw new Error("cannot extract CSP() from worker/index.js - fix the test with the Worker");
const cspHeader = m[1].replace(/\$\{nonce\}/g, "testnonce");

const srv = http.createServer((q, res) => {
  if (new URL(q.url, "http://x").pathname === "/roadmap") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": cspHeader });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end("no");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${srv.address().port}/roadmap`;

const browser = await chromium.launch({ args: ["--disable-background-timer-throttling"] });
let fails = 0;
const check = (name, ok) => { if (!ok) { fails++; console.log("FAIL " + name); } else console.log("ok " + name); };
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const errors = [];
  let violations = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => { window.__v = []; document.addEventListener("securitypolicyviolation", (e) => window.__v.push(e.blockedURI)); });
  await page.goto(url, { waitUntil: "load" });
  violations = await page.evaluate(() => window.__v || []);
  check("zero console errors", errors.length === 0);
  check("zero CSP violations", violations.length === 0);
  check("no script element", await page.evaluate(() => document.querySelectorAll("script").length === 0));
  check("style carries the nonce (on the wire; Chrome scrubs it from the DOM after use)", html.includes('<style nonce="testnonce">'));
  const txt = await page.evaluate(() => document.body.innerText);
  check("roadmap doc rendered", txt.includes("MASTER ROADMAP") && txt.includes("How to read this file"));
  check("decisions doc rendered", txt.includes("DECISIONS") && txt.includes("D-1"));
  const dom = await page.evaluate(() => ({
    h1: document.querySelectorAll("h1").length,
    sections: [...document.querySelectorAll("main section")].map((s) => s.id),
    table: document.querySelector("table") ? [...document.querySelector("table").querySelectorAll("th")].map((x) => x.innerText) : null,
    rows: document.querySelector("table") ? document.querySelector("table").querySelectorAll("tbody tr").length : 0,
    nested: document.querySelectorAll("ul ul").length,
    overflow: document.documentElement.scrollWidth <= 392,
  }));
  check("h1s: page header + 17 roadmap project H1s + decisions H1 = 19 (docs are sha-pinned snapshots)", dom.h1 === 19);
  check("both anchored sections", dom.sections.join(",") === "roadmap,decisions");
  check("project table: 5 cols + >=10 rows", dom.table?.length === 5 && dom.rows >= 10);
  check("nested lists render", dom.nested >= 1);
  check("phone width: no horizontal overflow", dom.overflow);
  check("snapshot shas shown", txt.includes(DOCS.roadmap.sha256.slice(0, 16)) && txt.includes(DOCS.decisions.sha256.slice(0, 16)));
  check("escaped text stays text (no raw tag in source html)", !/<(script|img|iframe)\b/i.test(html));
} finally {
  await browser.close(); srv.close();
}
console.log(fails ? `${fails} FAILURES` : "ALL PASS");
process.exit(fails ? 1 : 0);
