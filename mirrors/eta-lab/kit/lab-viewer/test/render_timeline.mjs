// /timeline (W49): real Chromium under the production CSP (extracted from worker/index.js). Zero console errors, zero CSP violations
// (proportional bars are inline SVG with fill/x/width attributes, not style=, so style-src is never touched), no script element,
// no inline style attribute, no horizontal scroll at phone width.
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
const { timelineDocOf, roomDayModel, hospitalPage, roomDayPage } = await import(join(HERE, "..", "worker", "timeline.js"));
const m = /const CSP = \(nonce\) => `([^`]+)`/.exec(readFileSync(join(HERE, "..", "worker", "index.js"), "utf8"));
const csp = m[1].replace(/\$\{nonce\}/g, "testnonce");

const rooms = [
  { room_id: "room_a", room_name: "OPD 3", n: 3, windows: [{ s: Date.parse("2026-09-26T09:00:00+05:30"), e: Date.parse("2026-09-26T09:15:00+05:30"), status: "text", n_words: 12, t0: "09:00", t1: "09:15" },
    { s: Date.parse("2026-09-26T10:00:00+05:30"), e: Date.parse("2026-09-26T10:15:00+05:30"), status: "no_signal", n_words: 0, t0: "10:00", t1: "10:15" }],
    talkMs: 900000, d: timelineDocOf({ fleet: [{ kind: "mic_missing", at_ms: Date.parse("2026-09-26T10:00:00+05:30"), message: "Mic not detected" }], cap_links: [{ start_ms: 1, end_ms: 2, items: 10, captured: 8 }] }) },
  { room_id: "room_b", room_name: "OPD 5", n: 0, windows: [], talkMs: 0, d: timelineDocOf(null) },
];
const listHtml = hospitalPage("2026-09-26", rooms, ["2026-09-26", "2026-09-25"]).replaceAll("__NONCE__", "testnonce");

const T0 = Date.parse("2026-09-26T09:00:00+05:30");
const consult = { room_id: "room_a", room_name: "OPD 3", date: "2026-09-26",
  windows: [{ k: "r/room_a/2026-09-26/w1", t0: "09:00", t1: "09:15", s: T0, e: T0 + 900000, status: "text", n_words: 12, run_id: "r" }],
  hidden: [], segments: [{ w: 0, t: T0 + 5000, e: T0 + 8000, sp: { l: "A", mixed: false, seq: null } }, { w: 0, t: T0 + 9000, e: T0 + 12000, sp: { l: "B", mixed: false, seq: null } }] };
const doc = { fleet: [{ kind: "mic_missing", at_ms: T0 + 60000, message: "Mic not detected" }],
  pqm_truth: [{ start_ms: T0, end_ms: T0 + 600000, token: "T-9", status: "confirmed" },
    { start_ms: T0 + 3600000, end_ms: T0 + 3600000 + 3600000, token: "T-10", status: "confirmed", suspect: true }],   // Fable 15:50: auto-timeout artifact, start-only tick
  cap_links: [{ start_ms: T0, end_ms: T0 + 60000, items: 5, captured: 4 }], acoustics: { missed_speech_pct: 3.2, missed: [{ start_ms: T0 + 200000, end_ms: T0 + 210000 }] },
  detected: { acoustic: [{ start_ms: T0 + 60000, end_ms: T0 + 120000, conf: 0.6 }], e6: [], jev_loop: [] } };
const pageHtml = roomDayPage(roomDayModel(consult, doc)).replaceAll("__NONCE__", "testnonce");

const srv = http.createServer((q, res) => {
  const p = new URL(q.url, "http://x").pathname;
  const html = p === "/timeline" ? listHtml : p.startsWith("/timeline/") ? pageHtml : null;
  if (html) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp }); res.end(html); return; }
  res.writeHead(404); res.end("no");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch();
let fails = 0; const check = (n, ok) => { if (!ok) { fails++; console.log("FAIL " + n); } else console.log("ok " + n); };
try {
  for (const [path, label] of [["/timeline", "hospital"], ["/timeline/room_a/2026-09-26", "room-day"]]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } }); const errors = [];
    page.on("console", (x) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e) => errors.push(String(e)));
    await page.addInitScript(() => { window.__v = []; document.addEventListener("securitypolicyviolation", (e) => window.__v.push(e.blockedURI)); });
    await page.goto(base + path);
    const d = await page.evaluate(() => ({ scripts: document.scripts.length, w: document.documentElement.scrollWidth <= innerWidth, styleAttrs: document.querySelectorAll("[style]").length, svgs: document.querySelectorAll("svg rect").length }));
    check(`${label}: no script element`, d.scripts === 0);
    check(`${label}: no inline style attribute`, d.styleAttrs === 0);
    check(`${label}: no horizontal scroll on a phone`, d.w);
    check(`${label}: proportional bars rendered as SVG rects (not style width)`, d.svgs > 0);
    check(`${label}: zero console errors`, errors.length === 0);
    check(`${label}: zero CSP violations`, (await page.evaluate(() => window.__v)).length === 0);
    await page.close();
  }
  const page2 = await browser.newPage(); await page2.goto(base + "/timeline/room_a/2026-09-26");
  const txt = await page2.evaluate(() => document.body.innerText);
  check("room-day: STT, missed speech tile, patient-queue and prescription lane labels shown", /STT windows/.test(txt) && /3.2%/.test(txt) && /Patient queue/.test(txt) && /Prescription/.test(txt) && /Detected encounters/.test(txt));
  const titles = await page2.evaluate(() => [...document.querySelectorAll("svg title")].map((t) => t.textContent));
  check("room-day: SVG tooltips carry the real values (queue token, capture count, acoustic tag)", titles.some((t) => t.includes("T-9")) && titles.some((t) => t.includes("captured")) && titles.some((t) => t.includes("Acoustic")));
  check("room-day: suspect pqm row (Fable 15:50) reads as an unknown-end tick, never a fabricated end time", titles.some((t) => t.includes("T-10") && t.includes("end time unknown") && t.includes("queue timer ran out")) && !titles.some((t) => t.includes("T-10") && /\d\d:\d\d–\d\d:\d\d/.test(t)));
  const queueRects = await page2.evaluate(() => [...document.querySelectorAll("svg title")].filter((t) => t.textContent.includes("T-10")).map((t) => t.closest("rect").getAttribute("width")));
  check("room-day: suspect row's rect is the narrow fixed tick width, not proportional to its (fake) span", queueRects.length === 1 && queueRects[0] === "0.4");
  check("room-day: tone always says not shown yet", /Tone[\s\S]*not.*valid/i.test(txt));
} finally { await browser.close(); srv.close(); }
console.log(fails ? `FAILED ${fails}` : "ALL PASS"); process.exit(fails ? 1 : 0);
