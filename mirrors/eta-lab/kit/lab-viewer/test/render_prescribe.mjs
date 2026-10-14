// W27.4a: the "Prescription check" cards in the Consult view, real Chromium on the EMBEDDED shell under the production CSP.
// Invented terms only. The API is a stub with one fixture consult. Run: node kit/lab-viewer/test/render_prescribe.mjs
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
const { shell } = await import(join(HERE, "..", "worker", "ui.js"));
const m = /const CSP = \(nonce\) => `([^`]+)`/.exec(readFileSync(join(HERE, "..", "worker", "index.js"), "utf8"));
const csp = m[1].replace(/\$\{nonce\}/g, "testnonce");
const T0 = Date.parse("2026-09-25T09:00:00+05:30");
const seg = (i, sec, text) => ({ t: T0 + sec * 1000, e: T0 + sec * 1000 + 3000, w: 0, i, lang: "en", engine: "whisper", text, refused: false, why: null, en: null, enq: null, enerr: null, flag: null, sp: null, re: null });
const it = (id, type, term, cls, matched, tm = false) => ({ id, type, term, cls, score: 0.5, matched, tm });
const consult = {
  room_id: "room_x", room_name: "Room X", date: "2026-09-25", view_key: "index/view-x.jsonl", hidden: [],
  windows: [{ k: "r/room_x/2026-09-25/w0", t0: "09:00", t1: "09:15", s: T0, e: T0 + 800000, status: "text", n_words: 9, run_id: "r", partial: false }],
  segments: [seg(0, 1, "before the consult"), seg(1, 620, "after the consult")],
  rx: [{ id: "C1", s: T0 + 300000, e: T0 + 600000, basis: "time+voice", items: [
    it("a", "drug", "TESTDRUG <b>5MG</b>", "CAPTURED", "testdrug five"), it("b", "drug", "OTHERDRUG", "MISHEARD", "other drag"),
    it("c", "dose", "twice daily", "ABSENT", null), it("d", "advice", "rest", "LOST-IN-TRANSLATION", null, true), it("e", "drug", "GAPDRUG", "ABSENT-SPEECH-GAP", null)] }],
  counts: { windows: 1, hidden_windows: 0, segments: 2, words: 6, non_english: 0, with_english: 0, annotation_files: {} },
};
const srv = http.createServer((q, res) => {
  const p = new URL(q.url, "http://x").pathname;
  if (p === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp }); res.end(shell("testnonce")); return; }
  if (p.startsWith("/api/consult/")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(consult)); return; }
  if (p === "/api/me") { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
  res.writeHead(404); res.end("no");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const browser = await chromium.launch();
let fails = 0; const check = (n, ok) => { if (!ok) { fails++; console.log("FAIL " + n); } else console.log("ok " + n); };
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } }); const errors = [];
  page.on("console", (x) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => { window.__v = []; document.addEventListener("securitypolicyviolation", (e) => window.__v.push(e.blockedURI)); });
  await page.goto(`http://127.0.0.1:${srv.address().port}/#/consult/room_x/2026-09-25`);
  await page.waitForSelector(".rxcard");
  const d = await page.evaluate(() => { const k = [...document.querySelector("#app, main, body").querySelectorAll(".cline, .rxcard")].map((n) => n.classList.contains("rxcard") ? "RX" : n.textContent); const c = document.querySelector(".rxcard"); return { order: k, sum: c.querySelector("summary").textContent, open: c.open, items: [...c.querySelectorAll(".rxi")].map((n) => [n.querySelector(".rxb").textContent, n.querySelector(".rt").textContent, n.querySelector(".rm")?.textContent ?? null, !!n.querySelector(".why")]), bold: document.querySelectorAll(".rxcard b").length } });
  check("card sits between the two lines, at the consult start", d.order.length === 3 && d.order[1] === "RX");
  check("summary counts", /09:05–09:10/.test(d.sum) && /5 items/.test(d.sum) && /1 captured/.test(d.sum) && /1 misheard/.test(d.sum) && /1 lost in translation/.test(d.sum) && /1 absent, /.test(d.sum) && /1 absent \(audio gap\)/.test(d.sum));
  check("collapsed until opened", d.open === false);
  await page.click(".rxcard summary");
  const shown = await page.evaluate(() => document.querySelector(".rxcard").open);
  check("opens", shown);
  check("item badges and text (term shown, heard span shown, English-missing said)", d.items[0][0] === "captured" && d.items[0][2] === "heard: testdrug five" && d.items[1][0] === "misheard" && d.items[3][0] === "lost in translation" && d.items[3][3] === true && d.items[4][0] === "absent (audio gap)");
  check("item text is text, never markup", d.items[0][1] === "TESTDRUG <b>5MG</b>" && d.bold === 0);
  check("zero console errors", errors.length === 0); check("zero CSP violations", (await page.evaluate(() => window.__v)).length === 0);
  check("no horizontal scroll on a phone", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
} finally { await browser.close(); srv.close(); }
console.log(fails ? `FAILED ${fails}` : "ALL PASS"); process.exit(fails ? 1 : 0);
