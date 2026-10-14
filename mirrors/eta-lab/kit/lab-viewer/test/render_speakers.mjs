// Speaker chips in the Consult view: real Chromium on the EMBEDDED shell under the production CSP (extracted from worker/index.js).
// Invented text only. The API is a stub that serves one fixture consult. Any miss -> FAIL. Run: node kit/lab-viewer/test/render_speakers.mjs
import { createRequire } from "module";
import { existsSync, readFileSync } from "fs";
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
const { chromium } = createRequire(join(PW, "node_modules", "x"))("playwright-core");
const { shell } = await import(join(HERE, "..", "worker", "ui.js"));
const m = /const CSP = \(nonce\) => `([^`]+)`/.exec(readFileSync(join(HERE, "..", "worker", "index.js"), "utf8"));
if (!m) throw new Error("cannot extract CSP() from worker/index.js");
const csp = m[1].replace(/\$\{nonce\}/g, "testnonce");

const T0 = Date.parse("2026-09-24T09:00:00+05:30");
const seg = (w, i, sec, text, sp) => ({ t: T0 + w * 900000 + sec * 1000, e: T0 + w * 900000 + sec * 1000 + 3000, w, i, lang: "en", engine: "whisper", text, refused: false, why: null, en: null, enq: null, enerr: null, flag: null, sp, re: null });
const at = (w, i, sec, text, sp) => ({ ...seg(w, i, sec, text, sp), t: T0 + 3600000 + sec * 1000, e: T0 + 3600000 + sec * 1000 + 3000 });
const A = { l: "A", mixed: false, seq: null }, B = { l: "B", mixed: false, seq: null }, Q = { l: "?", mixed: false, seq: null };
const consult = {
  room_id: "room_x", room_name: "Room X", date: "2026-09-24", view_key: "index/view-x.jsonl", hidden: [],
  windows: [0, 1, 2, 3, 4, 5].map((w) => ({ k: "r/room_x/2026-09-24/w" + w, t0: "09:0" + w, t1: "09:1" + w, s: T0 + w * 900000, e: T0 + w * 900000 + 800000, status: "text", n_words: 9, run_id: "r", partial: false })),
  segments: [
    seg(0, 0, 1, "line one", A), seg(0, 1, 5, "line two", A), seg(0, 2, 9, "line three", B), seg(0, 3, 13, "line four", Q), seg(0, 4, 17, "line five", { l: "A", mixed: true, seq: ["A", "B"] }),
    seg(1, 0, 1, "solo one", A), seg(1, 1, 5, "solo two", A),                       // one labelled speaker only: no chips
    seg(3, 0, 1, "gg one", A), seg(3, 1, 5, "gg two", { l: "G", mixed: false, seq: null }), seg(3, 2, 9, "gg three", { l: "A", mixed: true, seq: ["A", "G"] }),
    at(4, 0, 2, "w4 a", A), at(5, 0, 3, "w5 x", B), at(4, 1, 30, "w4 c", B), at(5, 1, 50, "w5 y", A),   // two windows interleaved in time
    seg(2, 0, 1, "nolabel one", null), seg(2, 1, 5, "nolabel two", null),           // no labels at all: no chips
  ],
  counts: { windows: 3, hidden_windows: 0, segments: 18, words: 36, non_english: 0, with_english: 0, annotation_files: {} },
};
const srv = http.createServer((q, res) => {
  const p = new URL(q.url, "http://x").pathname;
  if (p === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp }); res.end(shell("testnonce")); return; }
  if (p.startsWith("/api/consult/")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(consult)); return; }
  if (p === "/api/me") { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
  res.writeHead(404); res.end("no");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch();
let fails = 0;
const check = (name, ok) => { if (!ok) { fails++; console.log("FAIL " + name); } else console.log("ok " + name); };
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => { window.__v = []; document.addEventListener("securitypolicyviolation", (e) => window.__v.push(e.blockedURI)); });
  await page.goto(base + "/#/consult/room_x/2026-09-24");
  await page.waitForSelector(".cline");
  const lines = () => page.evaluate(() => [...document.querySelectorAll(".cline")].map((n) => ({ chip: n.querySelector(".spchip")?.textContent ?? null, div: !!n.querySelector(".spdiv"), brk: n.classList.contains("spbreak"), text: n.textContent })));
  const L = await lines();
  const by = (t) => L.find((x) => x.text.includes(t));
  check("window 0 chips A A B (none for ?) then mixed", JSON.stringify(["line one", "line two", "line three", "line four", "line five"].map((t) => by(t).chip)) === JSON.stringify(["Speaker A", "Speaker A", "Speaker B", null, "Speakers A→B"]));
  check("divider once per chipped window, on its first chipped line", L.filter((x) => x.div).length === 4 && by("line one").div && !by("line two").div);
  check("break only where the label changes (A->B, then after the unlabelled ? line B->mixed)", JSON.stringify(["line one", "line two", "line three", "line four", "line five"].map((t) => by(t).brk)) === JSON.stringify([false, false, true, false, true]));
  check("window with one labelled speaker: no chips", by("solo one").chip === null && by("solo two").chip === null);
  check("window with no labels: no chips", by("nolabel one").chip === null && by("nolabel two").chip === null);
  check("interleaved windows: each window keeps its own previous label (w4 A->B and w5 B->A both break)", by("w4 c").brk && by("w5 y").brk && !by("w4 a").brk && !by("w5 x").brk);
  check("chips exist only in the four windows with two labelled speakers", L.filter((x) => x.chip).length === 11);
  check("never says Doctor", !L.some((x) => /doctor/i.test(x.chip ?? "")));
  const cls = (t) => page.evaluate((t) => [...document.querySelectorAll(".cline")].find((n) => n.textContent.includes(t)).querySelector(".spchip").className, t);
  const [ga, gg, gm, la, lb] = [await cls("gg one"), await cls("gg two"), await cls("gg three"), await cls("line one"), await cls("line three")];
  check("A and G in one window get different colours (rank in window, not letter mod 6)", ga !== gg && /spc\d/.test(ga) && /spc\d/.test(gg));
  check("a mixed line is neutral", gm.includes("spmix") && !/spc\d/.test(gm));
  check("same letter, same colour within a window; A vs B differ", la === (await cls("line two")) && la !== lb);
  check("toggle present and checked by default", await page.evaluate(() => document.querySelector("#spt")?.checked === true));
  await page.uncheck("#spt");
  const hidden = await page.evaluate(() => ({ chip: getComputedStyle(document.querySelector(".spchip")).display, div: getComputedStyle(document.querySelector(".spdiv")).display, wrap: document.querySelector("#cwrap").classList.contains("nosp") }));
  check("toggle off hides chips and divider (CSS class, no re-render)", hidden.chip === "none" && hidden.div === "none" && hidden.wrap);
  await page.check("#spt");
  check("toggle on shows them again", await page.evaluate(() => getComputedStyle(document.querySelector(".spchip")).display !== "none"));
  check("zero console errors", errors.length === 0);
  check("zero CSP violations", (await page.evaluate(() => window.__v)).length === 0);
  check("no horizontal scroll on a phone", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
} finally { await browser.close(); srv.close(); }
console.log(fails ? `FAILED ${fails}` : "ALL PASS");
process.exit(fails ? 1 : 0);
