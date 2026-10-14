// W49 P3 (Fable 28 Sep, named order): the Room Evidence Bundle panel in the /#/win/<key> inspector, real Chromium under the
// production CSP. Two fixtures, both shaped from REAL reb/ manifest+track structure on the box (field names, id conventions,
// engine list, statuses) - never real transcript text: fixture 1 mirrors a real DEV30 window (~/eta-data/reb/2026-09-09/
// room_2qe955hy/L037 - 9 stt engines, box + box-twin machines, 5 indic-ctc engines empty) with invented segment text (that
// window is a real-room sub-clip - real patient audio - so its actual transcript text never appears here, per this lab's
// PHI rule); fixture 2 mirrors a real suite-clinical1 window (~/eta-data/reb/2026-09-27/suite-clinical1/
// clin_en_1__babble_snr5 - stt+terms layers) with clearly-invented text (that suite is synthetic benchmark audio, no PHI
// concern, but invented text is used anyway for a clean fixture rather than copying real ASR-noisy output).
// Stubs the API (no real R2/audio needed). Run: node kit/lab-viewer/test/render_reb.mjs
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

const RUN = "hist-bulk-20260909T0000-dev30xxx";

// fixture 1: DEV30-shaped (real structure, invented text) - room_2qe955hy/2026-09-09/L037. t0_ms is the REAL tape_utc value
// from that manifest (eta-refuter-2 #5266 F2 asked for this specifically); segments are shown ALREADY OFFSET into that
// absolute frame, i.e. this is the shape rebModel() itself is expected to hand the UI, not the raw clip-local track file.
const ROOM1 = "room_2qe955hy", DAY1 = "2026-09-09", WID1 = "L037", KEY1 = `${RUN}/${ROOM1}/${DAY1}/${WID1}`;
const T0 = 1788953127000;
const rebDev30 = { loaded: true, t0_ms: T0, t1_ms: T0 + 30000, tracks: [
  { layer: "stt", engine: "whisper-auto", model: "whisper-large-v3-turbo", version: "v1", config_hash: "4b67551a", machine: "box", status: "ok", reason: null, lang: "en", superseded_by: null,
    segments: [{ t0_ms: T0 + 0, t1_ms: T0 + 4000, text: "invented line one" }, { t0_ms: T0 + 4000, t1_ms: T0 + 9000, text: "invented line two" }] },
  { layer: "stt", engine: "whisper-forced-en", model: "whisper-large-v3-turbo", version: "v1", config_hash: "a2131b2d", machine: "box", status: "ok", reason: null, lang: "en", superseded_by: null,
    segments: [{ t0_ms: T0 + 0, t1_ms: T0 + 4000, text: "invented forced-en line" }] },
  // superseded_by demo (eta-refuter-2 #5266 F1): the SAME config got a later re-run that failed - this good run is still "ok", not hidden, with the failure attached
  { layer: "stt", engine: "whisper-cap2", model: "whisper-large-v3-turbo", version: "v1", config_hash: "c7bd317b", machine: "box", status: "ok", reason: null, lang: "en",
    superseded_by: { status: "failed", reason: "later rerun: CUDA OOM on box", machine: "box", finished_at: "2026-09-27T14:00:00Z" },
    segments: [{ t0_ms: T0 + 0, t1_ms: T0 + 4000, text: "invented cap2 line" }] },
  { layer: "stt", engine: "sravaani", model: "ARTPARK-IISc/SraVaani-1.0", version: "v1", config_hash: "cee5af35", machine: "box-twin", status: "ok", reason: null, lang: null, superseded_by: null, segments: [{ t0_ms: T0 + 0, t1_ms: T0 + 4000, text: "invented sravaani line" }] },
  { layer: "stt", engine: "indic-ctc-kn", model: "ai4bharat/indic-conformer-600m-multilingual", version: "v1", config_hash: "eaff21cc", machine: "box-twin", status: "empty", reason: "empty text from box-twin indic-ctc-kn", lang: "kn", superseded_by: null, segments: [] },
  { layer: "stt", engine: "indic-ctc-hi", model: "ai4bharat/indic-conformer-600m-multilingual", version: "v1", config_hash: "eaff21cc", machine: "box-twin", status: "empty", reason: "empty text from box-twin indic-ctc-hi", lang: "hi", superseded_by: null, segments: [] },
  { layer: "stt", engine: "indic-ctc-ta", model: "ai4bharat/indic-conformer-600m-multilingual", version: "v1", config_hash: "eaff21cc", machine: "box-twin", status: "empty", reason: "empty text from box-twin indic-ctc-ta", lang: "ta", superseded_by: null, segments: [] },
  { layer: "stt", engine: "indic-ctc-te", model: "ai4bharat/indic-conformer-600m-multilingual", version: "v1", config_hash: "eaff21cc", machine: "box-twin", status: "empty", reason: "empty text from box-twin indic-ctc-te", lang: "te", superseded_by: null, segments: [] },
  { layer: "stt", engine: "indic-ctc-ml", model: "ai4bharat/indic-conformer-600m-multilingual", version: "v1", config_hash: "eaff21cc", machine: "box-twin", status: "failed", reason: "CUDA OOM on box-twin", lang: "ml", superseded_by: null, segments: [] },
] };
const windowDoc1 = { schema: "eta-lab-result/1", window_id: WID1, room_id: ROOM1, start: "2026-09-09T09:00:00+05:30",
  segments: [{ start_s: 0, end_s: 4, lang: "en", engine: "whisper", text: "invented line one" }], provenance: { run_id: RUN } };
const inspect1 = { room_id: ROOM1, date: DAY1, window: { k: KEY1, t0: "09:00", t1: "09:15", status: "text", n_words: 3 },
  rx: [], speakers: [], acoustics: null, reb: rebDev30 };

// fixture 2: suite-clinical1-shaped (real structure, invented text) - suite-clinical1/2026-09-27/clin_en_1__babble_snr5.
// t0_ms is genuinely 0 for this one (suite_synthetic, clock:"clip_local" in the real manifest - no tape origin at all).
const ROOM2 = "suite-clinical1", DAY2 = "2026-09-27", WID2 = "clin_en_1__babble_snr5", KEY2 = `${RUN}/${ROOM2}/${DAY2}/${WID2}`;
const rebClinical1 = { loaded: true, t0_ms: 0, t1_ms: 24144, tracks: [
  { layer: "stt", engine: "whisper-auto", model: "whisper-large-v3-turbo", version: "v1", config_hash: "4b67551a", machine: "box", status: "ok", reason: null, lang: "en", superseded_by: null,
    segments: [{ t0_ms: 0, t1_ms: 3000, text: "Good morning." }, { t0_ms: 3000, t1_ms: 10000, text: "invented clinical line two" }] },
  { layer: "terms", engine: "medasr", model: "google/medasr", version: "v1", config_hash: "e2b69f8a", machine: "j-vrbeven-6ab966ce52d0dbd7f1d9d7eb", status: "ok", reason: null, lang: null, superseded_by: null,
    segments: [{ t0_ms: 0, t1_ms: 24144, text: "invented medication line: metformin 500 mg twice a day" }] },
] };
const windowDoc2 = { schema: "eta-lab-result/1", window_id: WID2, room_id: ROOM2, start: "2026-09-27T00:00:00+05:30",
  segments: [{ start_s: 0, end_s: 3, lang: "en", engine: "whisper", text: "Good morning." }], provenance: { run_id: RUN } };
const inspect2 = { room_id: ROOM2, date: DAY2, window: { k: KEY2, t0: "00:00", t1: "00:00", status: "text", n_words: 2 },
  rx: [], speakers: [], acoustics: null, reb: rebClinical1 };

const srv = http.createServer((q, res) => {
  const p = new URL(q.url, "http://x").pathname; const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (p === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp }); res.end(shell("testnonce")); return; }
  if (p === "/api/me") return json({});
  if (p === "/api/view-index") { res.writeHead(200, { "content-type": "application/x-ndjson", "x-vault-key": "index/view-1.jsonl" }); res.end(""); return; }
  if (p === "/api/manifests") return json({ runs: [] });
  if (p === `/api/window/${KEY1}`) return json(windowDoc1);
  if (p === `/api/window/${KEY2}`) return json(windowDoc2);
  if (p === `/api/corrections/${ROOM1}/${DAY1}` || p === `/api/corrections/${ROOM2}/${DAY2}`) return json({ windows: {} });
  if (p === `/api/inspect/${ROOM1}/${DAY1}/${RUN}/${WID1}`) return json(inspect1);
  if (p === `/api/inspect/${ROOM2}/${DAY2}/${RUN}/${WID2}`) return json(inspect2);
  res.writeHead(404); res.end("no");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const browser = await chromium.launch();
let fails = 0; const check = (n, ok) => { if (!ok) { fails++; console.log("FAIL " + n); } else console.log("ok " + n); };

async function checkWindow(key, label, expectRows) {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } }); const errors = [];
  page.on("console", (x) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => { window.__v = []; document.addEventListener("securitypolicyviolation", (e) => window.__v.push(e.blockedURI)); });
  await page.goto(`http://127.0.0.1:${srv.address().port}/#/win/${key}`);
  await page.waitForTimeout(1200);
  await page.locator("summary", { hasText: /^Technical detail$/ }).click();   // <details> starts collapsed; "Technical detail" (singular, this panel) vs "Technical details" (the existing raw-JSON dump)
  const rowCount = await page.locator(".rebrow").count();
  check(`${label}: ${expectRows} track rows rendered`, rowCount === expectRows);
  check(`${label}: bars are real SVG (fill attribute, not a style attribute)`, (await page.locator(".rebbar rect[fill]").count()) > 0 && !(await page.locator(".rebbar [style]").count()));
  const html = await page.content();
  check(`${label}: no inline style attribute anywhere`, !html.includes('style="'));
  check(`${label}: zero console errors`, errors.length === 0);
  check(`${label}: zero CSP violations`, (await page.evaluate(() => window.__v)).length === 0);
  return page;
}

try {
  const page1 = await checkWindow(KEY1, "DEV30", 9);   // one row per (layer,engine,config_hash) group - the real 9 stt engines, none deduped away
  const txt1 = await page1.evaluate(() => document.body.textContent);
  check("DEV30: current whisper-auto row shows ok + its config hash", /whisper-auto v1 #4b67551a.*box.*ok.*en/.test(txt1.replace(/\s+/g, " ")));
  check("DEV30: a failed row shows its reason", /indic-ctc-ml.*failed.*CUDA OOM on box-twin/.test(txt1.replace(/\s+/g, " ")));
  check("DEV30: empty rows for the other 4 indic-ctc engines, each with its own derived language", ["kn", "hi", "ta", "te"].every((l) => new RegExp("indic-ctc-" + l + " v1 #eaff21cc · box-twin · empty · " + l + " \\(empty text from box-twin indic-ctc-" + l).test(txt1)));
  // eta-refuter-2 #5266 F1: a track that's "ok" but has a LATER failed re-run of the SAME config shows that as a superseded_by badge - still "ok", not a fake 5th status, not hidden
  check("DEV30: whisper-cap2 stays 'ok' and shows its later-failed-rerun badge (superseded_by), not a fake 'superseded' status", /whisper-cap2 v1 #c7bd317b.*box.*ok.*en/.test(txt1.replace(/\s+/g, " ")) && /Superseded by a later failed run \(later rerun: CUDA OOM on box\)/.test(txt1));
  check("DEV30: exactly one superseded_by badge shown", await page1.locator(".rebsup").count() === 1);
  // hover text: the <title> element inside a segment's <rect> carries the real segment text (native tooltip, CSP-safe)
  const titles1 = await page1.evaluate(() => [...document.querySelectorAll(".rebbar title")].map((t) => t.textContent));
  check("DEV30: segment bars carry their real text as a native tooltip", titles1.some((t) => t.includes("invented line one")) && titles1.some((t) => t.includes("invented cap2 line")));
  // click a bar -> detail box updates (no PHI text ever shown outside this page's own Access-gated view, but DOM-level check is enough here)
  await page1.locator(".rebrow", { hasText: "whisper-cap2" }).locator("rect").first().click();
  const detail1 = await page1.locator(".rebdetail").textContent();
  check("DEV30: clicking a segment bar fills the detail box with that track+segment's info", detail1.includes("whisper-cap2") && detail1.includes("invented cap2 line"));
  await page1.close();

  const page2 = await checkWindow(KEY2, "clinical1", 2);
  const txt2 = await page2.evaluate(() => document.body.textContent);
  check("clinical1: both layers present (stt and terms), each its own row", /stt\.whisper-auto/.test(txt2) && /terms\.medasr/.test(txt2));
  await page2.locator(".rebrow", { hasText: "terms.medasr" }).locator("rect").first().click();
  const detail2 = await page2.locator(".rebdetail").textContent();
  check("clinical1: terms layer's segment detail shows on click", detail2.includes("terms.medasr") && detail2.includes("metformin"));
  // the two windows' bars use a different fill color for stt vs terms (a real distinct color per layer, not a shared default)
  const sttFill = await page2.locator(".rebrow", { hasText: "stt.whisper-auto" }).locator("rect").first().getAttribute("fill");
  const termsFill = await page2.locator(".rebrow", { hasText: "terms.medasr" }).locator("rect").first().getAttribute("fill");
  check("clinical1: stt and terms layers render in different colors", !!sttFill && !!termsFill && sttFill !== termsFill);
  await page2.close();
} finally { await browser.close(); srv.close(); }
console.log(fails ? `FAILED ${fails}` : "ALL PASS"); process.exit(fails ? 1 : 0);
