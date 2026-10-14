// W49 P2: the Consult/#/win page's new Prescription / Sound & speakers / Technical detail panels, real Chromium under the
// production CSP. Stubs the API (no real R2/audio needed); invented text only. Run: node kit/lab-viewer/test/render_inspect.mjs
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

const RUN = "hist-bulk-20260924T1912-ab12cd3", ROOM = "room_x", DAY = "2026-09-24", WID = "w1", KEY = `${RUN}/${ROOM}/${DAY}/${WID}`;
const windowDoc = { schema: "eta-lab-result/1", window_id: WID, room_id: ROOM, start: "2026-09-24T09:00:00+05:30",
  segments: [{ start_s: 5, end_s: 9, lang: "en", engine: "whisper", text: "hello there" }], provenance: { run_id: RUN } };
const viewRow = { key: `runs/${KEY}.json`, run_id: RUN, room_id: ROOM, room_name: "OPD 5", ist_date: DAY, status: "text", complete: true, t0: "09:00", t1: "09:15" };
const inspect = { room_id: ROOM, date: DAY, window: { k: KEY, t0: "09:00", t1: "09:15", status: "text", n_words: 3 },
  rx: [{ id: "C1", s: 1, e: 2, basis: "time+voice", items: [{ id: "i1", type: "drug", term: "TESTDRUG 5MG", cls: "CAPTURED", score: 1, matched: "testdrug five", tm: false }] }],
  speakers: [{ l: "A", pct: 63 }, { l: "B", pct: 37 }], acoustics: { missed_speech_pct: 4.2, missed_in_window: 1 },
  reb: { loaded: false } };   // W49 P3: real REB Chromium checks (current/superseded/failed rows, cursor sync) live in test/render_reb.mjs

const srv = http.createServer((q, res) => {
  const p = new URL(q.url, "http://x").pathname; const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (p === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp }); res.end(shell("testnonce")); return; }
  if (p === "/api/me") return json({});
  if (p === "/api/view-index") { res.writeHead(200, { "content-type": "application/x-ndjson", "x-vault-key": "index/view-202609250800.jsonl" }); res.end(JSON.stringify(viewRow) + "\n"); return; }
  if (p === "/api/manifests") return json({ runs: [] });
  if (p === `/api/window/${KEY}`) return json(windowDoc);
  if (p === `/api/corrections/${ROOM}/${DAY}`) return json({ room_id: ROOM, date: DAY, windows: {} });
  if (p === `/api/inspect/${ROOM}/${DAY}/${RUN}/${WID}`) return json(inspect);
  res.writeHead(404); res.end("no");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const browser = await chromium.launch();
let fails = 0; const check = (n, ok) => { if (!ok) { fails++; console.log("FAIL " + n); } else console.log("ok " + n); };
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } }); const errors = [];
  page.on("console", (x) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => { window.__v = []; document.addEventListener("securitypolicyviolation", (e) => window.__v.push(e.blockedURI)); });
  await page.goto(`http://127.0.0.1:${srv.address().port}/#/win/${KEY}`);
  await page.waitForTimeout(1200);
  const txt = await page.evaluate(() => document.body.textContent);   // <details> panels are collapsed by default (like the existing Technical details section), so use textContent not innerText
  check("Prescription panel shows the linked item", /Prescription/.test(txt) && /CAPTURED/.test(txt) && /TESTDRUG 5MG/.test(txt) && /heard: testdrug five/.test(txt));
  check("Sound and speakers panel shows both speakers + acoustics line", /Sound and speakers/.test(txt) && /Speaker A: 63%/.test(txt) && /Speaker B: 37%/.test(txt) && /sampled, lower bound.*4\.2%/.test(txt));
  check("Technical detail panel present, says REB not available yet when reb.loaded is false", /Technical detail/.test(txt) && /REB engine tracks: not available yet for this window/.test(txt));
  const html = await page.content();
  check("no inline style attribute", !html.includes('style="'));
  check("zero console errors", errors.length === 0);
  check("zero CSP violations", (await page.evaluate(() => window.__v)).length === 0);
} finally { await browser.close(); srv.close(); }
console.log(fails ? `FAILED ${fails}` : "ALL PASS"); process.exit(fails ? 1 : 0);
