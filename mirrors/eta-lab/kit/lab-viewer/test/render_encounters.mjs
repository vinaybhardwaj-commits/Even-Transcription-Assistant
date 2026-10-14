// /encounters (W44): real Chromium under the production CSP (extracted from worker/index.js). Fixture room-day list + one lane page.
// Zero console errors, zero CSP violations, no script element, no inline style, no horizontal scroll at phone width.
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
const { encounterModel, encountersListPage, encountersRoomDayPage } = await import(join(HERE, "..", "worker", "encounters.js"));
const m = /const CSP = \(nonce\) => `([^`]+)`/.exec(readFileSync(join(HERE, "..", "worker", "index.js"), "utf8"));
const csp = m[1].replace(/\$\{nonce\}/g, "testnonce");

const listHtml = encountersListPage([{ room_id: "room_x", room_name: "OPD 5", date: "2026-09-26", n: 40 }, { room_id: "room_y", room_name: "OPD 3", date: "2026-09-26", n: 12 }]).replaceAll("__NONCE__", "testnonce");
const T0 = Date.parse("2026-09-26T09:00:00+05:30");
const consult = { room_id: "room_x", room_name: "OPD 5", date: "2026-09-26",
  windows: [{ k: "r/room_x/2026-09-26/w1", t0: "09:00", t1: "09:15", s: T0, e: T0 + 900000, status: "text", n_words: 12, run_id: "r" }, { k: "r/room_x/2026-09-26/w2", t0: "09:30", t1: "09:45", s: T0 + 1800000, e: T0 + 2700000, status: "no_signal", n_words: 0, run_id: "r" }],
  hidden: [], segments: [{ w: 0, t: T0 + 5000, e: T0 + 8000, sp: { l: "A", mixed: false, seq: null } }, { w: 0, t: T0 + 9000, e: T0 + 12000, sp: { l: "B", mixed: false, seq: null } }] };
const detDoc = { source_sha256: "abc123", detected: { acoustic: [{ id: "e1", start_ms: T0 + 60000, end_ms: T0 + 120000, conf: 0.6 }], e6: [], jev_loop: [] }, pqm_truth: [{ start_ms: T0, end_ms: T0 + 600000, status: "confirmed" }], cap_links: [] };
const pageHtml = encountersRoomDayPage(encounterModel(consult, detDoc)).replaceAll("__NONCE__", "testnonce");

const srv = http.createServer((q, res) => {
  const p = new URL(q.url, "http://x").pathname;
  const html = p === "/encounters" ? listHtml : p.startsWith("/encounters/") ? pageHtml : null;
  if (html) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp }); res.end(html); return; }
  res.writeHead(404); res.end("no");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch();
let fails = 0; const check = (n, ok) => { if (!ok) { fails++; console.log("FAIL " + n); } else console.log("ok " + n); };
try {
  for (const [path, label] of [["/encounters", "list"], ["/encounters/room_x/2026-09-26", "room-day"]]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } }); const errors = [];
    page.on("console", (x) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript(() => { window.__v = []; document.addEventListener("securitypolicyviolation", (e) => window.__v.push(e.blockedURI)); });
    await page.goto(base + path);
    const d = await page.evaluate(() => ({ scripts: document.scripts.length, w: document.documentElement.scrollWidth <= innerWidth, styleAttrs: document.querySelectorAll("[style]").length }));
    check(`${label}: no script element`, d.scripts === 0);
    check(`${label}: no inline style attribute`, d.styleAttrs === 0);
    check(`${label}: no horizontal scroll on a phone`, d.w);
    check(`${label}: zero console errors`, errors.length === 0);
    check(`${label}: zero CSP violations`, (await page.evaluate(() => window.__v)).length === 0);
    await page.close();
  }
  const page2 = await browser.newPage(); await page2.goto(base + "/encounters/room_x/2026-09-26");
  const txt = await page2.evaluate(() => document.body.innerText);
  check("room-day: STT windows, acoustic detection, PQM truth, speaker turns all shown", /STT windows/.test(txt) && /acoustic/.test(txt) && /confirmed/.test(txt) && /Speaker A/.test(txt) && /Speaker B/.test(txt));
  check("room-day: acoustic detection time renders in IST (09:01), never UTC (03:31)", /09:01:00/.test(txt) && !/03:31/.test(txt));
  check("room-day: lanes with no data say so, not blank (E-6/Jev loop/CAP)", /E-6[\s\S]*none/.test(txt) && /Jev loop[\s\S]*none/.test(txt) && /CAP[\s\S]*none/.test(txt));
} finally { await browser.close(); srv.close(); }
console.log(fails ? `FAILED ${fails}` : "ALL PASS"); process.exit(fails ? 1 : 0);
