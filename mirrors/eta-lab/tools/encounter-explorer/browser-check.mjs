// Real-Chromium check of dist pages against a mock window.claude. Fails on console error, page error, any network request, or 375px overflow.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || "/tmp/explorer-shots";
mkdirSync(join(out, "shots"), { recursive: true });
const rj = p => JSON.parse(readFileSync(join(root, p), "utf8"));
const P = { reb: rj("fixtures/synthetic/tools/reb_index.json"), fs: rj("fixtures/synthetic/tools/freescript.json"), rub: rj("fixtures/synthetic/tools/rubric.json"), jev: rj("fixtures/synthetic/tools/jev_decisions.json") };
const mockSrc = readFileSync(join(root, "test/mock-scribe.mjs"), "utf8").replace(/^export /gm, "");
const catSrc = readFileSync(join(root, "test/mock-catalog.mjs"), "utf8").replace(/^export /gm, "");

// caps: "all" -> mcp (current build only needs it), sample, db, user.  "none" -> every use() resolves null.
// build "catalog": the page talks to a mock scribe_catalog built from the mockup dataset; the clip is a WAV the page's mock serves in base64 chunks.
const catInit = () => `
${catSrc}
const CAT = ${JSON.stringify(rj("fixtures/synthetic/mockup.json").consults)};
const wavBytes = sec => { const len = Math.round(sec * 8000), b = new Uint8Array(44 + len).fill(128), v = new DataView(b.buffer); const w = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); v.setUint32(4, 36 + len, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, "data"); v.setUint32(40, len, true);
  return b; };
// 16 kHz 16-bit mono: 32 kB a second, so a few minutes pass the 8 MiB progressive-start mark
const wavBig = sec => { const len = Math.round(sec * 32000), b = new Uint8Array(44 + len), v = new DataView(b.buffer); const w = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); v.setUint32(4, 36 + len, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, len, true);
  return b; };
window.__wavBig = wavBig;
const catOpts = { clipBytes: c => wavBytes(c.lengthSec), contentType: "audio/wav" }; window.__catOpts = catOpts;
const mcpMock = makeMockCatalog(CAT, catOpts);
`;
const initScript = (mode, extra = "", build = "current") => `
${mockSrc}
window.__sample = []; window.__db = []; window.__mcp = []; window.__used = [];
const P = ${JSON.stringify(P)};
${build === "catalog" ? catInit() : "const mcpMock = makeMockMcp(P);"}
window.__created = []; window.__revoked = [];
{ const oc = URL.createObjectURL, orv = URL.revokeObjectURL; URL.createObjectURL = b => { const u = oc.call(URL, b); window.__created.push(u); return u; }; URL.revokeObjectURL = u => { window.__revoked.push(u); return orv.call(URL, u); }; }
const mcp = { async callTool(s, t, a, o) { window.__mcp.push({ s, t, a, cache: o && o.cache }); return mcpMock.callTool(s, t, a, o); }, ...(mcpMock.describeTool ? { describeTool: (...x) => mcpMock.describeTool(...x) } : {}) };
const store = new Map();
const db = { doc(path) { return { async get() { return { exists: store.has(path), data: () => store.get(path) }; }, async set(d) { window.__db.push({ path, data: d }); store.set(path, d); } }; } };
const sample = async (input, o) => { window.__sample.push(String(input)); for (const w of ["Synthetic ", "streamed ", "answer"]) { await new Promise(r => setTimeout(r, 20)); window.__acc = (window.__acc || "") + w; o && o.onText && o.onText({ text: window.__acc, delta: w }); } return { text: window.__acc, truncated: false }; };
sample.limits = async () => ({ maxPromptBytes: 1000000 });
const user = { async id() { return "u_syn_1"; }, async can() { return window.__canWrite === undefined ? true : window.__canWrite; }, async profiles(ids) { const o = {}; for (const i of [].concat(ids)) o[i] = { id: i, name: "User Synthetic", isMe: true }; return o; } };
const all = { mcp, sample, db, user };
window.claude = { use: async n => { window.__used.push(n); return ${mode === "none" ? "null" : "all[n] || null"}; } };
${extra}
`;

const configs = [
  ["phone-light", { viewport: { width: 375, height: 700 }, colorScheme: "light", hasTouch: true, isMobile: true }],
  ["phone-dark", { viewport: { width: 375, height: 700 }, colorScheme: "dark", hasTouch: true, isMobile: true }],
  ["desk-light", { viewport: { width: 1280, height: 850 }, colorScheme: "light" }],
  ["desk-dark", { viewport: { width: 1280, height: 850 }, colorScheme: "dark" }],
];
const failures = [];
const fail = (tag, msg) => { failures.push(tag + ": " + msg); console.log("FAIL", tag, msg); };
const check = (tag, cond, msg) => { if (!cond) fail(tag, msg); };

// The host publishes the page inside this skeleton (the dist itself has no doctype/html/head/body), so test it the same way.
const SKELETON_HEAD = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>';
function wrapped(name) {
  const f = join(out, "wrapped", name);
  mkdirSync(join(out, "wrapped"), { recursive: true });
  writeFileSync(f, SKELETON_HEAD + readFileSync(join(root, "dist", name), "utf8") + "</body></html>");
  return f;
}

async function run(browser, build, mode, cfgName, cfg, scenario, extra = "") {
  const tag = `${build}/${mode}/${cfgName}`;
  if (process.env.BC_FILTER && !new RegExp(process.env.BC_FILTER).test(tag + " " + scenario.name)) return;   // development aid: BC_FILTER='mockup/all/desk-dark' runs only matching flows
  const file = pathToFileURL(wrapped(build === "mockup" ? "encounter-explorer-mockup.html" : build === "catalog" ? "encounter-explorer.html" : "encounter-explorer-current.html")).href;
  const ctx = await browser.newContext(cfg);
  await ctx.addInitScript(initScript(mode, extra, build));
  const page = await ctx.newPage();
  const errs = [], reqs = [];
  page.on("pageerror", e => errs.push("pageerror " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("console " + m.text()); });
  page.on("request", r => { const u = r.url(); if (u !== file && !u.startsWith("blob:") && !u.startsWith("data:") && u !== "about:blank") reqs.push(u); });
  const phone = cfg.viewport.width <= 400;
  const vw = cfg.viewport.width;   // the fixed viewport width, not innerWidth (which grows with the content on a mobile viewport)
  const overflows = () => page.evaluate(w => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > w, vw);
  const overflow = async where => {
    check(tag, !(await overflows()), "horizontal overflow at " + vw + "px on " + where);
    // every text node, not the concatenated textContent (where "transcript" + "null" has no word boundary)
    const stray = await page.evaluate(() => { const w = document.createTreeWalker(document.getElementById("view"), NodeFilter.SHOW_TEXT), bad = []; for (let n = w.nextNode(); n; n = w.nextNode()) if (/^\s*(null|undefined|NaN)\s*$/.test(n.data) || /\[object|\bundefined\b|\bNaN\b/.test(n.data)) bad.push(n.data.slice(0, 30)); return bad; });
    check(tag, stray.length === 0, "stray null/undefined/NaN text on " + where + ": " + stray.join("|"));
  };
  const shot = n => page.screenshot({ path: join(out, "shots", `${build}-${mode}-${cfgName}-${n}.png`) });
  const hash = async () => page.evaluate(() => location.hash);
  await page.goto(file);
  check(tag, (await page.evaluate(() => innerWidth)) === cfg.viewport.width, "layout width equals the viewport (the skeleton viewport meta is in effect)");
  // positive control: the overflow check must be able to fail
  await page.evaluate(() => { const d = document.createElement("div"); d.id = "__ctl"; d.style.cssText = "width:520px;height:4px"; document.body.append(d); });
  check(tag, (await overflows()) === (vw < 520), "positive control: a 520px element " + (vw < 520 ? "is" : "is not") + " detected as overflow");
  await page.evaluate(() => document.getElementById("__ctl").remove());
  check(tag, !(await overflows()), "control removed, no overflow");
  await scenario({ page, tag, check, overflow, shot, hash, phone });
  // the "first URL is bad" flow provokes exactly one resource-load error on purpose
  const expected = extra.includes("__badFirst") ? /Not allowed to load local resource: blob:http:\/\/invalid\.invalid/ : null;
  const real = errs.filter(e => !(expected && expected.test(e)));
  check(tag, real.length === 0, "console/page errors: " + real.join(" | "));
  check(tag, reqs.length === 0, "network requests: " + reqs.join(", "));
  await ctx.close();
}

// ------------------------------------------------------------ scenario: full flow on the mockup (rich synthetic data)
const M = rj("fixtures/synthetic/mockup.json").consults;
const comp = c => { const v = Object.values(c.stages).filter(x => x.state !== "na"); return v.filter(x => x.state === "done").length / v.length; };
const FULL = M.find(c => comp(c) === 1 && c.transcript && c.rx && c.rx.signedText);
const GAP = M.find(c => c.transcript === null && c.clip);   // clipped only, with a clip (no transcript)
const NOCLIP = M.find(c => c.clip === null);
const istClock = ms => new Date(ms + 5.5 * 3600000).toISOString().slice(11, 16);
async function openConsult(page, c) {
  await page.locator(`button.cell[aria-label$="${c.doctor_name} ${c.ist_date}"]`).click();
  await page.waitForSelector("tr.row-click");
  await page.locator("tr.row-click", { hasText: istClock(c.t_open) + " IST" }).first().locator("button.link-btn").click();
  await page.waitForSelector("#notes");
}
async function flowMockup({ page, tag, check, overflow, shot, hash, phone }) {
  await page.waitForSelector("table.grid");
  check(tag, (await page.locator(".banner").textContent()) === "Mockup: synthetic data", "mockup banner");
  check(tag, (await page.evaluate(() => window.__used)).join() === "sample,db,user", "mockup asks only for sample, db, user: " + (await page.evaluate(() => window.__used)));
  check(tag, (await page.locator("table.grid tbody tr").count()) === 4, "4 doctor rows");
  check(tag, (await page.locator("table.grid thead th").count()) === 11, "hide-empty default leaves 10 date columns + doctor");
  await page.uncheck("#f-hide"); await page.waitForTimeout(150);
  check(tag, (await page.locator("table.grid thead th").count()) === 36, "35 days when empty days are shown");
  await page.check("#f-hide"); await page.waitForTimeout(150);
  const shades = await page.locator("button.cell").evaluateAll(es => new Set(es.map(e => e.getAttribute("data-lv"))).size);
  check(tag, shades === 5, "overview uses all 5 shade steps (" + shades + ")");
  const bgs = await page.locator("button.cell").evaluateAll(es => { const m = {}; for (const e of es) m[e.getAttribute("data-lv")] = getComputedStyle(e).backgroundColor; return Object.values(m); });
  check(tag, new Set(bgs).size === 5, "P1: the 5 shade steps have 5 distinct backgrounds");
  check(tag, (await page.locator(".legend i").count()) === 5, "P1: legend shows the 5 steps");
  check(tag, (await page.getAttribute("#f-from", "min")) === "2026-09-09", "date min enforced in UI");
  await page.fill("#f-from", "2026-09-01"); await page.dispatchEvent("#f-from", "change");
  await page.waitForTimeout(150);
  check(tag, (await page.inputValue("#f-from")) === "2026-09-09", "from below floor clamps to 2026-09-09");
  await page.selectOption("#f-room", FULL.room_id); await page.waitForTimeout(150);
  check(tag, (await page.locator("table.grid tbody tr").count()) === 1, "room filter leaves one doctor");
  await page.selectOption("#f-room", ""); await page.selectOption("#f-spec", "ENT"); await page.waitForTimeout(150);
  check(tag, (await page.locator("table.grid tbody tr").count()) === 1, "specialty filter leaves one doctor");
  await page.selectOption("#f-spec", ""); await page.check("#f-rx"); await page.waitForTimeout(150);
  const rxCells = new Set(M.filter(c => c.prescription_uid).map(c => c.doctor_uid + c.ist_date)).size;
  check(tag, (await page.locator("button.cell").count()) === rxCells, "has-Rx filter leaves " + rxCells + " doctor-days");
  await page.uncheck("#f-rx"); await page.waitForTimeout(100);
  await overflow("overview"); await shot("overview");

  await page.locator(`button.cell[aria-label$="${FULL.doctor_name} ${FULL.ist_date}"]`).click();
  await page.waitForSelector("tr.row-click");
  check(tag, /^#d-[0-9a-f]+~\d{4}-\d{2}-\d{2}$/.test(await hash()), "clicking through writes the doctor-day token: " + (await hash()));
  const n = M.filter(c => c.doctor_uid === FULL.doctor_uid && c.ist_date === FULL.ist_date).length;
  check(tag, (await page.locator("tr.row-click").count()) === n, "list has " + n + " consults");
  check(tag, (await page.locator("tr.row-click").first().locator(".chip").count()) === 8, "8 stage chips");
  const stacked = await page.evaluate(() => ({ tr: getComputedStyle(document.querySelector("table.list tbody tr")).display, th: getComputedStyle(document.querySelector("table.list thead")).display, w: document.querySelector("table.list").getBoundingClientRect().width, vw: innerWidth }));
  if (phone) check(tag, stacked.tr === "flex" && stacked.th === "none" && stacked.w <= stacked.vw, "P3: phone list is stacked rows, not columns " + JSON.stringify(stacked));
  else check(tag, stacked.tr === "table-row" && stacked.th !== "none", "P3: desktop list stays a table");
  await overflow("list"); await shot("list");
  await page.locator("tr.row-click", { hasText: istClock(FULL.t_open) + " IST" }).first().locator("button.link-btn").click();
  await page.waitForSelector("ol.tx");
  check(tag, (await hash()) === "#c-" + FULL.consult_uid, "clicking through writes the consult token: " + (await hash()));
  check(tag, (await page.textContent("h2")) !== "", "header");
  const head = await page.textContent("#view section.card");
  check(tag, head.includes(FULL.patient_name) && head.includes(FULL.doctor_name), "header shows patient and doctor names");
  check(tag, (await page.locator("ol.tx .line").count()) === FULL.transcript.length, "all transcript lines");
  const txt = await page.textContent("#view");
  check(tag, FULL.transcript.some(l => l.lang !== "en") && /[\u0900-\u097F\u0C80-\u0CFF]/.test(txt), "native-script lines shown beside English");
  const extraStages = Object.keys(FULL.stages).filter(k => !["detected", "sealed", "stt", "translate", "diar_nemotron", "diar_sarvam", "role", "bundle", "freescript"].includes(k)).length;
  check(tag, (await page.locator("#ledger tbody tr").count()) === 9 + extraStages, "ledger: nine fixed rows plus the other named stages (" + (9 + extraStages) + ")");
  check(tag, (await page.locator("#ledger tbody tr[data-step=translate] .chip").first().textContent()) === "missing" && (await page.locator("#ledger tbody tr[data-step=translate]").textContent()).includes("not_in_catalog"), "a stage the catalog does not name is missing / not_in_catalog");
  check(tag, (await page.locator("table.items tr").count()) === 9, "PDQI-9 shows 9 items");
  const pw = await page.evaluate(() => { const t = document.querySelector("table.items"); return t.getBoundingClientRect().width; });
  check(tag, pw < 300, "P2: PDQI label, value and bar sit in a tight row (table width " + Math.round(pw) + ")");
  const lts = await page.locator("#ledger tbody tr td:nth-child(5)").allTextContents();
  check(tag, lts.some(x => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(x)), "N9: ledger time shown as IST stamp, got " + lts.join("|"));
  const split = await page.evaluate(() => [...document.querySelectorAll("table td.mono")].filter(td => { const r = document.createRange(); r.selectNodeContents(td); return r.getClientRects().length > 1; }).length);
  check(tag, split === 0, "N13: no ledger token is split across lines (" + split + ")");
  check(tag, (await page.locator("pre.note").count()) >= 2, "FreeScript note and signed Rx both shown");
  const a = page.locator("a", { hasText: "Open in Pulse" });
  check(tag, (await a.getAttribute("href")) === `https://pulse.even.in/prescription?prescription_uid=${FULL.prescription_uid}&individual_uid=${FULL.individual_uid}`, "pulse link");
  check(tag, (await a.getAttribute("target")) === "_blank" && /noopener/.test(await a.getAttribute("rel")), "pulse link target/rel");
  await audioReady(page);   // the audio panel fills in after the page renders
  check(tag, (await page.locator("#synth-audio").count()) === 1, "synthetic audio label");
  // audio sync (the track is rendered at runtime with WebAudio)
  await page.waitForFunction(() => document.querySelector("audio") && document.querySelector("audio").readyState >= 1, null, { timeout: 30000 });
  const dur = await page.evaluate(() => document.querySelector("audio").duration);
  check(tag, Math.abs(dur - Math.min(900, FULL.lengthSec)) < 1, `audio length ${dur} vs ${FULL.lengthSec}`);
  const k = Math.floor(FULL.transcript.length / 2), t0 = FULL.transcript[k].t0;
  await page.locator("ol.tx .line").nth(k).click();
  await page.waitForFunction(t => Math.abs(document.querySelector("audio").currentTime - t) < 1.5, t0, { timeout: 5000 }).catch(() => {});
  const cur = await page.evaluate(() => document.querySelector("audio").currentTime);
  check(tag, Math.abs(cur - t0) < 1.5, `click line seeks audio (wanted ${t0}, got ${cur})`);
  check(tag, (await page.locator(".line").nth(k).getAttribute("class")).includes("now"), "clicked line highlighted");
  const j = FULL.transcript.length - 2, t1 = FULL.transcript[j].t0;
  await page.evaluate(t => { document.querySelector("audio").currentTime = t + 0.5; }, t1);
  await page.waitForFunction(i => document.querySelectorAll(".line")[i].classList.contains("now"), j, { timeout: 5000 }).catch(() => {});
  check(tag, (await page.locator(".line").nth(j).getAttribute("class")).includes("now") && (await page.locator(".line.now").count()) === 1, "current line follows audio time");
  await overflow("detail"); await shot("detail");
  // notes
  await page.waitForFunction(() => !document.getElementById("note-text").disabled);
  await page.fill("#note-text", "synthetic note one");
  await page.waitForTimeout(1300);
  const w = await page.evaluate(() => window.__db);
  check(tag, w.length === 1 && w[0].path === "notes/" + FULL.consult_uid, "one debounced write to notes/<uid>, got " + JSON.stringify(w.map(x => x.path)));
  check(tag, w[0] && w[0].data.text === "synthetic note one" && w[0].data.updated_by === "u_syn_1" && !!w[0].data.updated_at && Object.keys(w[0].data).length === 3, "note fields");
  // ask
  await page.fill("#ask-q", "What is the plan?");
  await page.click("#ask-go");
  await page.waitForFunction(() => document.getElementById("ask-out").textContent.includes("Synthetic streamed answer"), null, { timeout: 5000 }).catch(() => {});
  const s = await page.evaluate(() => window.__sample);
  check(tag, s.length === 1 && s[0].includes(FULL.consult_uid) && s[0].includes("What is the plan?"), "payload has this consult and the question");
  check(tag, s[0] && new Set(s[0].match(/syn_c\d{4}/g)).size === 1, "payload has no other consult uid");
  check(tag, (await page.textContent("#ask-out")).includes("Synthetic streamed answer"), "answer streamed into page");
  await overflow("detail+ask");

  // a clipped-only consult: every panel falls back to its designed state
  await page.goto(page.url().split("#")[0]); await page.waitForSelector("table.grid");
  await openConsult(page, GAP);
  const t = await page.textContent("#view");
  for (const m of ["Transcript not available yet", "Audio not available yet", "Signed Rx not available yet", "No Jev decisions for this consult", "CDMSS audit not available yet", "FreeScript note not available yet"]) check(tag, t.includes(m), "NA state: " + m);
  check(tag, (await page.locator("section.slot").count()) === 11, "a clipped-only consult still shows all 11 slots");
  check(tag, (await page.locator("#first-gap").count()) === 1, "first gap shown");
  check(tag, (await page.locator("a", { hasText: "Open in Pulse" }).count()) === 0, "no pulse link without both ids");
  await overflow("detail gaps"); await shot("detail-gap");
  // a consult whose Jev step failed: the copy must agree with the chip
  const JF = M.find(c => c.stages.jev.state === "failed" && c.jev === null);
  await page.goto(page.url().split("#")[0]); await page.waitForSelector("table.grid");
  await openConsult(page, JF);
  const jt = await page.textContent("#view");
  check(tag, jt.includes("No Jev decisions for this consult") && jt.includes(JF.stages.jev.reason) && !jt.includes("could not be read"), "N8: jev-null copy agrees with the failed chip");
  await overflow("detail jev failed");
  await flowInspection({ page, tag, check, overflow, shot, phone });
}

// ------------------------------------------------------------ the inspection page (M4a): 11 fixed slots, each with a state chip, in the mockup (rich synthetic data)
const slotStates = page => page.evaluate(() => [...document.querySelectorAll("section.slot")].map(s => ({ n: Number(s.dataset.slot), state: s.dataset.state, reason: s.dataset.reason || null, id: s.id })));
const chipTexts = page => page.evaluate(() => [...document.querySelectorAll("nav.jump a")].map(a => a.textContent.trim()));
const slotAt = (arr, n) => arr.find(x => x.n === n);
const openByHash = async (page, token) => { await page.evaluate(t => { location.hash = t; }, token); await page.waitForSelector("section.slot#layer-11", { timeout: 15000 }); await page.waitForSelector("#notes"); };
// a consult for each state the mockup is meant to show
const pick = p => M.find(c => c.transcript && p(c));
const C4_RICH = pick(c => c.catalog_c4 && c.catalog_c4.jev && c.catalog_c4.clef_affect && c.catalog_c4.presence && c.narrative);
const C4_ABSENT = pick(c => !("catalog_c4" in c) && !c.c4_error && !c.jev);
const C4_NULL = pick(c => c.catalog_c4 && c.catalog_c4.jev === null && c.catalog_c4.clef_affect === null && c.catalog_c4.presence === null && !c.jev);
const C4_ERROR = pick(c => c.c4_error && !c.jev);
const NO_NARR = pick(c => !c.narrative && c.catalog_c4 && c.catalog_c4.presence);
async function flowInspection({ page, tag, check, overflow, shot, phone }) {
  const vw = await page.evaluate(() => innerWidth);
  const slotShots = async (label, ns) => { for (const n of ns) await page.locator("#layer-" + n).screenshot({ path: join(out, "shots", `mockup-slot-${n}-${label}-${tag.split("/").at(-1)}.png`) }); };
  // every slot in its own card, none wider than the viewport, the page never scrolls sideways
  const checkFit = async where => {
    const w = await page.evaluate(() => [...document.querySelectorAll("section.slot")].map(s => ({ n: s.dataset.slot, r: s.getBoundingClientRect().right, w: s.getBoundingClientRect().width })));
    check(tag, w.length === 11 && w.every(x => x.r <= vw + 0.5), "every slot fits the viewport on " + where + ": " + JSON.stringify(w.filter(x => x.r > vw + 0.5)));
    await overflow(where);
  };

  // RICH: every slot has data (6 jev from both sources, 7 clef, 8 presence, 9 voice, 10 topics all from the synthetic v0 shapes)
  await openByHash(page, "c-" + C4_RICH.consult_uid);
  let st = await slotStates(page);
  check(tag, st.length === 11 && st.map(x => x.n).join() === "1,2,3,4,5,6,7,8,9,10,11", "11 slots in order");
  check(tag, st.every(x => ["present", "missing", "notbuilt"].includes(x.state) && (x.state !== "missing" || /^[A-Za-z0-9_.:+@-]+$/.test(x.reason))), "every slot has one valid state: " + JSON.stringify(st));
  check(tag, [1, 3, 4, 6, 7, 8, 9, 10].every(n => slotAt(st, n).state === "present"), "rich consult: slots 1, 3, 4, 6-10 present " + JSON.stringify(st.map(x => x.n + ":" + x.state)));
  const chips = await chipTexts(page);
  check(tag, chips.length === 11 && chips[0].startsWith("1") && chips[10].startsWith("11"), "jump index shows 11 chips: " + chips.join("|"));
  const hrefs = await page.evaluate(() => [...document.querySelectorAll("nav.jump a")].map(a => a.getAttribute("href")));
  check(tag, hrefs.every((x, i) => x === "#layer-" + (i + 1)), "jump chips link to bare #layer-N anchors");
  for (const n of [9, 10]) check(tag, (await page.locator("#layer-" + n + " .mock-badge").textContent()) === "mock · draft shape v0", "slot " + n + " carries the mock badge");
  check(tag, (await page.locator("#layer-2 .mock-badge").count()) >= 1 && (await page.locator("#who-table").count()) === 1, "slot 2 shows 'who' from the mock layer, badged");
  check(tag, (await page.locator("#layer-6 table#jev-decisions").count()) === 1 && (await page.locator("#layer-6 table#jev-sets").count()) === 1, "slot 6 shows both sources");
  const toks = await page.locator("#layer-6 code.tok, #layer-7 code.tok, #layer-8 code.tok").allTextContents();
  check(tag, toks.length > 8 && toks.every(x => !/\s/.test(x)), "slots 6-8 render enum values as tokens (code, no spaces): " + toks.slice(0, 6).join(","));
  const cal = await page.locator("#layer-7 [data-state=notbuilt]").count();
  check(tag, cal >= 1, "slot 7: the calibrated 1-5 column is 'not yet built'");
  check(tag, (await page.locator("#layer-8 [data-row]").count()) === 3 && (await page.locator("#layer-8 [data-row] [data-state=notbuilt]").count()) === 3, "slot 8: extension, Start Consult and link status are each 'not yet built'");
  check(tag, /IST/.test(await page.locator("#presence").textContent()), "slot 8: times in IST");
  check(tag, (await page.locator("#role-source").textContent()).includes("llm-roles") || (await page.locator("#role-source").textContent()).includes("text-judge") || (await page.locator("#role-source").textContent()).includes("caa-labels"), "slot 2: the role source is a role-layer token");
  await checkFit("inspection rich"); await shot("inspection-rich");
  await slotShots("rich", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  // the timeline: a bar of turns coloured by role; clicking a turn seeks the player and marks it
  const segs = page.locator("#layer-2 .timeline .seg");
  check(tag, (await segs.count()) === C4_RICH.transcript.length, "one timeline turn per transcript turn");
  const tl = await page.evaluate(() => { const t = document.querySelector("#layer-2 .timeline").getBoundingClientRect(); return { w: t.width, r: t.right, vw: innerWidth }; });
  check(tag, tl.r <= tl.vw + 0.5 && tl.w > 100, "timeline scales to the viewport, no sideways scroll " + JSON.stringify(tl));
  const roles = await page.locator("#layer-2 .timeline .seg").evaluateAll(es => new Set(es.map(e => [...e.classList].find(c => c.startsWith("r-")))).size);
  check(tag, roles >= 2, "turns are coloured by role (" + roles + " roles)");
  await page.waitForFunction(() => document.querySelector("audio") && document.querySelector("audio").readyState >= 1, null, { timeout: 30000 });
  const k = Math.floor(C4_RICH.transcript.length / 2), t0 = C4_RICH.transcript[k].t0;
  await segs.nth(k).click();
  await page.waitForFunction(x => Math.abs(document.querySelector("audio").currentTime - x) < 1.5, t0, { timeout: 5000 }).catch(() => {});
  const cur = await page.evaluate(() => document.querySelector("audio").currentTime);
  check(tag, Math.abs(cur - t0) < 1.5, "clicking a timeline turn seeks the player (wanted " + t0 + ", got " + cur + ")");
  check(tag, (await segs.nth(k).getAttribute("class")).includes("now") && (await page.locator(".line").nth(k).getAttribute("class")).includes("now"), "the turn and its transcript line are marked");
  // a jump chip scrolls to its slot and does not change the route; a #layer-N hash does the same without re-rendering the consult
  const hashBefore = await page.evaluate(() => location.hash);
  await page.locator("nav.jump a[data-n='8']").click();
  await page.waitForTimeout(150);
  check(tag, (await page.evaluate(() => location.hash)) === hashBefore, "a jump chip leaves the consult route alone");
  const top8 = await page.evaluate(() => document.getElementById("layer-8").getBoundingClientRect().top);
  check(tag, top8 < 120 && top8 > -5, "the chip scrolled slot 8 into view (top " + Math.round(top8) + ", scrollY " + (await page.evaluate(() => scrollY)) + ")");
  await page.evaluate(() => { window.__same = document.getElementById("layer-1"); location.hash = "layer-6"; });
  await page.waitForTimeout(200);
  check(tag, await page.evaluate(() => window.__same === document.getElementById("layer-1") && document.querySelectorAll("section.slot").length === 11), "#layer-N is an in-page jump: the consult is not re-rendered");
  const top6 = await page.evaluate(() => document.getElementById("layer-6").getBoundingClientRect().top);
  check(tag, top6 < 120 && top6 > -5, "#layer-6 scrolled slot 6 into view (top " + Math.round(top6) + ")");

  // C4 absent (a non-admin caller): 6, 7, 8 say needs_admin, with the copy; nothing is hidden
  await openByHash(page, "c-" + C4_ABSENT.consult_uid);
  st = await slotStates(page);
  check(tag, [6, 7, 8].every(n => slotAt(st, n).state === "missing" && slotAt(st, n).reason === "needs_admin"), "C4 absent: slots 6-8 missing/needs_admin " + JSON.stringify(st.slice(5, 8)));
  check(tag, (await page.textContent("#layer-7")).includes("Needs an admin key in your Scribe MCP connector"), "needs_admin copy");
  check(tag, st.length === 11, "all 11 slots still render");
  await checkFit("inspection needs_admin"); await slotShots("needs_admin", [6, 7, 8]);
  // C4 present but every column null
  await openByHash(page, "c-" + C4_NULL.consult_uid);
  st = await slotStates(page);
  check(tag, [6, 7, 8].every(n => slotAt(st, n).state === "missing" && slotAt(st, n).reason === "c4_null"), "C4 null columns: c4_null " + JSON.stringify(st.slice(5, 8)));
  check(tag, (await page.textContent("#layer-6")).includes("Not yet populated (catalog C4 sync is off)") && (await page.textContent("#layer-8")).includes("No presence row for this consult"), "c4_null copy (the presence feed is live, so its copy differs)");
  await checkFit("inspection c4_null"); await slotShots("c4_null", [6, 7, 8]);
  // C4 read failed
  await openByHash(page, "c-" + C4_ERROR.consult_uid);
  st = await slotStates(page);
  check(tag, [6, 7, 8].every(n => slotAt(st, n).state === "missing" && slotAt(st, n).reason === "c4_error"), "C4 read failed: c4_error " + JSON.stringify(st.slice(5, 8)));
  await checkFit("inspection c4_error"); await slotShots("c4_error", [6, 7, 8]);
  // no narrative layers: 9 and 10 are 'not yet built'
  await openByHash(page, "c-" + NO_NARR.consult_uid);
  st = await slotStates(page);
  check(tag, [9, 10].every(n => slotAt(st, n).state === "notbuilt"), "no narrative data: slots 9 and 10 are not yet built");
  check(tag, (await page.textContent("#layer-9")).includes("not yet built") && (await page.locator("#layer-9 .mock-badge").count()) === 0, "not-built slots carry no mock badge");
  check(tag, (await page.textContent("#role-source")).includes("role source: not yet in catalog") && (await page.textContent("#who-row")).includes("not yet built"), "slot 2: role source and who are called out as missing / not built");
  await slotShots("notbuilt", [9, 10]);
  // a consult with no clip: missing / no_clip, with the sealed reason, no player
  await openByHash(page, "c-" + NOCLIP.consult_uid);
  const nc = await page.textContent("#no-clip");
  check(tag, nc.includes("No audio: the room was not recording during this consult (" + NOCLIP.stages.sealed.reason + ")") && (await page.locator("#no-clip [data-state=missing]").textContent()).includes("no_clip") && (await page.locator("audio").count()) === 0, "no clip: missing/no_clip with the sealed reason and no player: " + nc);
  await checkFit("inspection no clip"); await slotShots("no_clip", [2]);
  // the audio panel of a consult with a clip still plays
  await page.evaluate(() => { location.hash = "overview"; });
  await page.waitForSelector("table.grid");
}

// ------------------------------------------------------------ scenario: the current-tools build (no transcript, audio, names, signed Rx)
async function flowCurrent({ page, tag, check, overflow, shot, hash }) {
  await page.waitForSelector("#f-from");   // default range is "last 7 days"; the mock data sits in Sep 2026
  await page.fill("#f-from", "2026-09-09"); await page.fill("#f-to", "2026-09-11"); await page.dispatchEvent("#f-to", "change");
  await page.waitForSelector("table.grid");
  const src = await page.textContent(".top .src");
  check(tag, /Scribe MCP connected/.test(src) && /data as of/.test(src), "source line shows connection and freshness: " + src);
  check(tag, (await page.textContent("#view")).includes("name not available yet"), "doctor names flagged not available");
  const mc = await page.evaluate(() => window.__mcp);
  check(tag, mc.length > 0 && mc.every(c => c.s === "Scribe MCP" && c.a !== undefined), "all calls go to Scribe MCP");
  check(tag, mc.every(c => !c.a.ist_date || c.a.ist_date >= "2026-09-09"), "no call before the floor");
  await page.locator("button.cell").first().click();
  await page.waitForSelector("tr.row-click");
  await page.locator("tr.row-click button.link-btn").first().click();
  await page.waitForSelector("#notes");
  const txt = await page.textContent("#view");
  for (const m of ["Transcript not available yet", "Audio not available yet", "Signed Rx not available yet", "CDMSS audit not available yet"]) check(tag, txt.includes(m), "NA: " + m);
  check(tag, (await page.locator("audio").count()) === 0, "no audio element");
  await overflow("detail"); await shot("detail");
  await page.waitForFunction(() => !document.getElementById("note-text").disabled);
  await page.fill("#note-text", "synthetic note");
  await page.waitForTimeout(1300);
  const w = await page.evaluate(() => window.__db);
  check(tag, w.length === 1 && /^notes\/syn_c\d{3}$/.test(w[0].path), "notes write path");
  const uid = w[0].path.slice(6);
  await page.fill("#ask-q", "Summarise");
  await page.click("#ask-go");
  await page.waitForFunction(() => document.getElementById("ask-out").textContent.includes("answer"), null, { timeout: 5000 });
  const s = (await page.evaluate(() => window.__sample))[0];
  const others = ["syn_c001", "syn_c002", "syn_c003", "syn_c004", "syn_c005", "syn_c006"].filter(u => u !== uid);
  check(tag, s.includes(uid) && others.every(u => !s.includes(u)), "ask payload carries only " + uid);
}

// ------------------------------------------------------------ scenario: every capability null
async function flowNone({ page, tag, check, overflow, shot, build }) {
  await page.waitForSelector("#view > *");
  const src = await page.textContent(".top .src");
  if (build !== "mockup") {
    await page.waitForSelector(".na");
    check(tag, /not connected/i.test(src) && (await page.textContent("#view")).includes("Scribe MCP not connected"), "not-connected state shown");
    await shot("overview");
    await overflow("overview");
  } else {
    await page.waitForSelector("table.grid");
    await page.locator("button.cell").first().click(); await page.waitForSelector("tr.row-click");
    await page.locator("tr.row-click button.link-btn").first().click(); await page.waitForSelector("#notes");
    const t = await page.textContent("#view");
    check(tag, t.includes("Shared notes unavailable"), "notes read-only state");
    check(tag, (await page.locator("#ask").count()) === 0 || (await page.locator("#ask").isHidden()), "Ask Claude hidden without sample");
    check(tag, (await page.locator("#note-text").count()) === 0, "no editable note");
    await overflow("detail"); await shot("detail");
  }
}

// ------------------------------------------------------------ hostile scenarios (refute round 1: B1, S3, S4, S6)
const SET_RANGE = async page => { await page.waitForSelector("#f-from"); await page.fill("#f-from", "2026-09-09"); await page.fill("#f-to", "2026-09-11"); await page.dispatchEvent("#f-to", "change"); };
const FAIL_EXTRA = code => `window.__fail = ${JSON.stringify(code)}; window.__failCount = 0; { const orig = mcp.callTool; mcp.callTool = async (...a) => { if (window.__fail) { window.__failCount++; throw { code: window.__fail, message: "synthetic failure" }; } return orig(...a); }; }`;

async function flowHugeT0({ page, tag, check, overflow }) {
  await SET_RANGE(page);
  await page.waitForSelector("table.grid");
  await page.locator('button.cell[aria-label$="Room room_syn01 2026-09-09"]').click();
  await page.waitForSelector("tr.row-click", { timeout: 5000 }).catch(() => {});
  const body = await page.textContent("#view");
  check(tag, !/Loading consults/.test(body), "B1: the list does not stay on Loading");
  check(tag, (await page.locator("tr.row-click").count()) >= 1, "B1: list rows render");
  const hug = page.locator("tr.row-click", { hasText: "–" });
  check(tag, (await hug.count()) >= 1, "B1: the consult with the garbage time shows an unknown time");
  await hug.first().locator("button.link-btn").click();
  await page.waitForSelector("#notes", { timeout: 5000 }).catch(() => {});
  check(tag, (await page.locator("#notes").count()) === 1, "B1: detail renders for a garbage time");
  await overflow("detail hostile");
}
const HUGE_EXTRA = `P.reb.rows.push({ id: 99001, window_id: "consult-syn_h1", ist_date: "2026-09-09", room_id: "room_syn01", t0_ms: 9e15, t1_ms: 9.1e15, layer: "stt", status: "ok", shadow: false });`;

async function flowApproval({ page, tag, check }) {
  await SET_RANGE(page);
  await page.waitForSelector(".na.err");
  let t = await page.textContent("#view");
  check(tag, t.includes("Needs your approval") && (await page.locator("button", { hasText: "Approve and load" }).count()) === 1, "S3: approval_required has its own state and a button");
  const n1 = await page.evaluate(() => window.__failCount);
  await page.waitForTimeout(800);
  check(tag, (await page.evaluate(() => window.__failCount)) === n1, "S3: no unattended retry of approval_required (" + n1 + " calls)");
  await page.evaluate(() => { window.__fail = null; });
  await page.click("button:has-text('Approve and load')");
  await page.waitForSelector("table.grid", { timeout: 5000 });
  check(tag, true, "");
}
async function flowNotInManifest({ page, tag, check }) {
  await SET_RANGE(page);
  await page.waitForSelector(".na.err");
  const t = await page.textContent("#view");
  check(tag, t.includes("not allowed for this view") && (await page.locator(".na.err button").count()) === 0, "S3: not_in_manifest says not allowed, offers no retry");
  const n1 = await page.evaluate(() => window.__failCount);
  await page.waitForTimeout(600);
  check(tag, (await page.evaluate(() => window.__failCount)) === n1, "S3: no loop on not_in_manifest");
}
async function flowReauth({ page, tag, check }) {
  await SET_RANGE(page);
  await page.waitForSelector(".na.err");
  check(tag, (await page.textContent("#view")).includes("Reconnect Scribe MCP in claude.ai Settings"), "S3: needs_reauth shows the documented reconnect copy");
}

const SLOW_SAMPLE = `all.sample = async (input, o) => {
  window.__sample.push(String(input));
  if (window.__refuse) { o.onText({ text: "partial-1", delta: "partial-1" }); o.onText({ text: "partial-2", delta: "-2" }); throw { code: "refused", message: "dev english" }; }
  if (window.__sampleErr) throw { code: window.__sampleErr, message: "dev english", text: "partial words" };
  await new Promise((res, rej) => { o.signal.addEventListener("abort", () => { window.__aborted = (window.__aborted || 0) + 1; rej({ code: "cancelled", message: "x" }); }); setTimeout(res, 4000); });
  return { text: "done", truncated: false };
}; all.sample.limits = async () => ({ maxPromptBytes: 1000000 });`;
async function flowAsk({ page, tag, check }) {
  await page.waitForSelector("table.grid");
  await openConsult(page, FULL);
  await page.fill("#ask-q", "first question");
  await page.press("#ask-q", "Enter"); await page.press("#ask-q", "Enter"); await page.press("#ask-q", "Enter");
  await page.waitForTimeout(300);
  check(tag, (await page.evaluate(() => window.__sample.length)) === 1, "S4: Enter while an answer is streaming starts no second call");
  check(tag, await page.locator("#ask-go").isDisabled(), "S4: Ask is disabled while in flight");
  await page.click("#ask-stop");
  await page.waitForFunction(() => document.getElementById("ask-out").textContent.includes("Stopped"), null, { timeout: 3000 });
  check(tag, (await page.evaluate(() => window.__aborted)) === 1 && !(await page.locator("#ask-go").isDisabled()), "S4: Stop aborts the (only) call and re-enables Ask");
  await page.evaluate(() => { window.__sampleErr = "rate_limited"; });
  await page.click("#ask-go");
  await page.waitForFunction(() => /Too many questions/.test(document.getElementById("ask-out").textContent), null, { timeout: 3000 });
  const out = await page.textContent("#ask-out");
  check(tag, out.includes("(rate_limited)") && out.includes("partial words") && !out.includes("dev english"), "S4: error copy is mapped from the code and keeps the partial text: " + out);
  await page.evaluate(() => { window.__sampleErr = null; window.__refuse = true; });
  await page.click("#ask-go");
  await page.waitForFunction(() => /declined/.test(document.getElementById("ask-out").textContent), null, { timeout: 3000 });
  const ref = await page.textContent("#ask-out");
  check(tag, ref.includes("(refused)") && !ref.includes("partial"), "S7: refused withdraws the streamed partial: " + ref);
  await page.evaluate(() => { window.__refuse = false; });
  await page.click("#ask-go");
  await page.waitForTimeout(200);
  await page.goBack(); await page.waitForSelector("tr.row-click");
  await page.waitForTimeout(200);
  check(tag, (await page.evaluate(() => window.__aborted)) === 2, "S4: leaving the consult aborts a call in flight");
}

const CANT_WRITE = `window.__canWrite = false;`;
async function flowReadOnlyNotes({ page, tag, check }) {
  await page.waitForSelector("table.grid");
  await openConsult(page, FULL);
  await page.waitForFunction(() => /read-only/.test(document.querySelector("#notes .status").textContent), null, { timeout: 5000 });
  check(tag, await page.evaluate(() => document.getElementById("note-text").readOnly), "S6: textarea is read-only without data.write");
  await page.focus("#note-text"); await page.keyboard.type("x"); await page.waitForTimeout(1200);
  check(tag, (await page.evaluate(() => window.__db.length)) === 0, "S6: no write attempted without data.write");
}
const DENY_WRITE = `db.doc = path => ({ async get() { return { exists: false, data: () => undefined }; }, async set() { window.__dbTries = (window.__dbTries || 0) + 1; throw { code: "invalid_argument", message: "x" }; } });`;
async function flowDeniedNotes({ page, tag, check }) {
  await page.waitForSelector("table.grid");
  await openConsult(page, FULL);
  await page.waitForFunction(() => !document.getElementById("note-text").disabled);
  await page.fill("#note-text", "attempt");
  await page.waitForTimeout(1300);
  await page.locator("#layer-11 h2").click(); await page.locator("#note-text").focus(); await page.locator("#layer-11 h2").click();
  await page.waitForTimeout(300);
  check(tag, (await page.evaluate(() => window.__dbTries)) === 1, "S6: a denied write is not retried on every blur (" + (await page.evaluate(() => window.__dbTries)) + ")");
  check(tag, /read-only/.test(await page.textContent("#notes .status")), "S6: the note goes read-only after invalid_argument");
}

// ------------------------------------------------------------ the live (catalog) page over the mock scribe_catalog
const CAT_FULL = M.find(c => c.transcript && c.note && c.pdqi && c.jev && c.cdmss && c.prescription_uid && c.lengthSec < 400);
const IDS = { prescription: CAT_FULL.prescription_uid, link: `https://pulse.even.in/prescription?prescription_uid=${CAT_FULL.prescription_uid}&individual_uid=${CAT_FULL.individual_uid}` };
// the page defaults to the last 30 days; the synthetic data sits in Sep-Oct 2026
const SET_FULL = async page => { await page.waitForSelector("#f-from"); await page.fill("#f-from", "2026-09-09"); await page.fill("#f-to", "2026-10-13"); await page.dispatchEvent("#f-to", "change"); };
const audioReady = page => page.waitForFunction(() => document.querySelector("audio") && document.querySelector("audio").readyState >= 1, null, { timeout: 30000 });
const chunkCalls = page => page.evaluate(() => window.__mcp.filter(c => c.a.action === "clip_audio_chunk"));
async function flowCatalog({ page, tag, check, overflow, shot }) {
  await SET_FULL(page);
  await page.waitForSelector("table.grid");
  const src = await page.textContent(".top .src");
  check(tag, /Scribe MCP connected/.test(src) && /catalog generated/.test(src), "source line shows the catalog generation time: " + src);
  check(tag, (await page.locator("table.grid tbody tr").count()) === 4, "4 doctors from search");
  check(tag, (await page.textContent("#view")).includes(CAT_FULL.doctor_name), "doctor names from include_identity");
  check(tag, !(await page.locator("#f-rx").isDisabled()) && await page.locator("#f-spec").isDisabled(), "has-prescription filter enabled (v2), specialty disabled (not in the catalog)");
  const calls = await page.evaluate(() => window.__mcp);
  check(tag, calls.length > 0 && calls.every(c => c.t === "scribe_catalog" && ["search", "get", "clip_audio_chunk"].includes(c.a.action)), "only scribe_catalog search/get/clip_audio_chunk are called");
  check(tag, calls.every(c => c.a.action !== "search" || c.a.include_identity === true), "search asks for identity");
  check(tag, calls.every(c => (!c.a.from || c.a.from >= "2026-09-09")), "nothing before the floor");
  // the has-prescription filter: the server filters; a range over 31 days is refused with guidance before any call
  const n0 = calls.length;
  await page.check("#f-rx"); await page.waitForTimeout(250);
  check(tag, (await page.textContent("#view")).includes("Narrow the date range") && (await page.evaluate(() => window.__mcp.length)) === n0, "35-day range + has-prescription: guidance, no call");
  await page.fill("#f-to", "2026-10-09"); await page.dispatchEvent("#f-to", "change"); await page.waitForTimeout(300);
  const rxCells = new Set(M.filter(c => c.prescription_uid && c.ist_date <= "2026-10-09").map(c => c.doctor_uid + c.ist_date)).size;
  check(tag, (await page.locator("button.cell").count()) === rxCells, "has-prescription filter leaves " + rxCells + " doctor-days");
  await page.uncheck("#f-rx"); await page.fill("#f-to", "2026-10-13"); await page.dispatchEvent("#f-to", "change"); await page.waitForSelector("table.grid");
  await overflow("overview"); await shot("overview");

  await openConsult(page, CAT_FULL);
  check(tag, (await page.locator("ol.tx .line").count()) === CAT_FULL.transcript.length, "transcript from the get layer");
  const t = await page.textContent("#view");
  check(tag, t.includes(CAT_FULL.transcript[0].textEn) && t.includes(CAT_FULL.note.noteText.split("\n")[0]), "native/English text and note text shown");
  check(tag, t.includes(CAT_FULL.patient_name) && t.includes(CAT_FULL.doctor_name), "names from the identity layer");
  check(tag, t.includes("Signed prescription opens in Pulse") && t.includes(CAT_FULL.prescription_uid) && t.includes("signed"), "Rx panel: id, state and the Pulse hint, no prescription content");
  const a = page.locator("a", { hasText: "Open in Pulse" });
  check(tag, (await a.getAttribute("href")) === IDS.link && (await a.getAttribute("target")) === "_blank" && /noopener/.test(await a.getAttribute("rel")), "Pulse link is the tool's pulse_url");
  check(tag, t.includes("CDMSS audit not available yet") && t.includes("Source: consult-audit S5 (pending)"), "cdmss layer: not available with its source");
  check(tag, (await page.locator("#ledger tbody tr[data-step]").count()) >= 9 && (await page.locator("#ledger tbody tr[data-step=detected] .chip").first().textContent()) === "missing", "ledger lists the nine fixed steps, an unnamed one is missing");
  const times = await page.locator("#ledger tbody tr td:nth-child(5)").allTextContents();
  check(tag, times.filter(x => /^\d{4}-\d{2}-\d{2} /.test(x)).length === 2 && times.filter(x => x === "–").length === times.length - 2, "N14: only the rubric and jev layers have a time; every other row is blank: " + times.join("|"));
  check(tag, (await page.locator("table.items tr").count()) === 9, "PDQI-9 from the rubric layer");
  const jt = await page.textContent("#view");
  check(tag, jt.includes("calibrated") && jt.includes("raw"), "jev rows say whether the probability is calibrated or raw");
  // audio: assembled from chunks into a Blob, opened at the start of the consult span
  await audioReady(page);
  const chunks = await chunkCalls(page);
  check(tag, chunks.length >= 1 && chunks.every(c => c.cache === false && Object.keys(c.a).sort().join() === "action,consult_uid,length,offset"), "audio came from clip_audio_chunk calls (cache off), exact args");
  check(tag, (await page.evaluate(() => document.querySelector("audio").src.startsWith("blob:"))), "the player plays a Blob URL, never the tool's");
  check(tag, (await page.textContent("#audio-checksum")).includes("Audio checksum matches catalog"), "ledger shows the audio checksum result (sha256 of the assembled clip)");
  check(tag, !(await page.evaluate(() => window.__mcp.some(c => c.a.action === "clip_audio_url"))), "clip_audio_url is never called");
  check(tag, (await page.locator("#span-note").count()) === 1 && (await page.locator(".line.out").count()) >= 1, "consult span marked on the transcript, outside lines dimmed");
  await page.waitForFunction(() => Math.abs(document.querySelector("audio").currentTime - 8) < 0.6, null, { timeout: 5000 }).catch(() => {});
  const c0 = await page.evaluate(() => document.querySelector("audio").currentTime);
  check(tag, Math.abs(c0 - 8) < 0.6, "the player opens at the consult span start (8 s), got " + c0);
  const k = Math.floor(CAT_FULL.transcript.length / 2), t0 = CAT_FULL.transcript[k].t0;
  check(tag, Math.abs(Number(await page.locator("ol.tx .line").nth(k).getAttribute("data-t0")) - t0) < 0.001, "line time = t0_ms / 1000 (ms from clip start)");
  await page.locator("ol.tx .line").nth(k).click();
  await page.waitForFunction(x => Math.abs(document.querySelector("audio").currentTime - x) < 1.5, t0, { timeout: 5000 }).catch(() => {});
  const cur = await page.evaluate(() => document.querySelector("audio").currentTime);
  check(tag, Math.abs(cur - t0) < 1.5, `click line seeks the clip (wanted ${t0}, got ${cur})`);
  await overflow("detail"); await shot("detail");
  // leaving frees the Blob URL
  const created = await page.evaluate(() => window.__created.filter(u => u.startsWith("blob:")).at(-1));
  await page.goBack(); await page.waitForSelector("tr.row-click");
  check(tag, (await page.evaluate(u => window.__revoked.includes(u), created)), "the Blob URL is revoked on leave");

  // a clipped-only consult: layers absent / not available, designed states; no prescription
  const GAPC = M.find(c => !c.transcript && !c.prescription_uid);
  await page.goto(page.url().split("#")[0]); await SET_FULL(page); await page.waitForSelector("table.grid");
  await openConsult(page, GAPC);
  const g = await page.textContent("#view");
  check(tag, g.includes("Transcript not recorded") && g.includes("Source: reb/"), "absent transcript layer: not recorded, with its source");
  check(tag, g.includes("FreeScript note not recorded"), "absent freescript layer");
  check(tag, g.includes("No prescription linked") && (await page.locator("a", { hasText: "Open in Pulse" }).count()) === 0, "no Rx: designed state, no link");
  check(tag, (await page.locator("#audio-host").count()) === 1, "the audio panel is present");
  await overflow("detail gaps");
  // a layer that errors: only that panel shows the error
  const JF = M.find(c => c.stages.jev.state === "failed" && c.jev === null && c.transcript);
  await page.goto(page.url().split("#")[0]); await SET_FULL(page); await page.waitForSelector("table.grid");
  await openConsult(page, JF);
  const jf = await page.textContent("#view");
  check(tag, jf.includes("Jev decisions could not be read") && jf.includes("db_error:08006") && (await page.locator("ol.tx .line").count()) > 0, "layer error stays inside its panel");
}

const SLOW_EXTRA = `catOpts.slowMs = 250; catOpts.maxChunk = 262144;`;
async function flowAudioProgress({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await openConsult(page, CAT_FULL);
  await page.waitForFunction(() => /Loading audio/.test(document.getElementById("audio-progress")?.textContent || ""), null, { timeout: 5000 });
  check(tag, true, "");
  await page.waitForFunction(() => /\d+\.\d of \d+\.\d MB/.test(document.getElementById("audio-progress")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
  check(tag, (await page.locator("ol.tx .line").count()) === CAT_FULL.transcript.length, "the transcript is usable while the audio loads");
  // a click before the audio is ready is queued and applied when it is
  const k = Math.floor(CAT_FULL.transcript.length / 2), t0 = CAT_FULL.transcript[k].t0;
  await page.locator("ol.tx .line").nth(k).click();
  await audioReady(page);
  await page.waitForFunction(x => Math.abs(document.querySelector("audio").currentTime - x) < 1.5, t0, { timeout: 8000 }).catch(() => {});
  const cur = await page.evaluate(() => document.querySelector("audio").currentTime);
  check(tag, Math.abs(cur - t0) < 1.5, `a click during loading is queued and applied (wanted ${t0}, got ${cur})`);
  check(tag, (await chunkCalls(page)).length >= 2, "more than one chunk was fetched");
}
async function flowAudioAbort({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await openConsult(page, CAT_FULL);
  await page.waitForFunction(() => window.__mcp.filter(c => c.a.action === "clip_audio_chunk").length >= 1, null, { timeout: 5000 });
  await page.goBack(); await page.waitForSelector("tr.row-click");
  const n = (await chunkCalls(page)).length;
  await page.waitForTimeout(1200);
  check(tag, (await chunkCalls(page)).length <= n + 1 && (await page.locator("audio").count()) === 0, "leaving aborts the audio load: no more chunk calls (" + n + " then " + (await chunkCalls(page)).length + ")");
}
const NOCHUNK_EXTRA = `catOpts.noChunk = true;`;
async function flowNoChunk({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await openConsult(page, CAT_FULL);
  const t = await page.textContent("#view");
  check(tag, t.includes("Audio isn't playable inside the artifact yet") && t.includes("Transcript timing still works"), "no chunk action: the designed state");
  check(tag, (await page.locator("audio").count()) === 0 && (await chunkCalls(page)).length === 0, "no player, no chunk call (decided from the schema)");
  check(tag, (await page.locator("ol.tx .line").count()) === CAT_FULL.transcript.length, "transcript still works");
  await page.locator("ol.tx .line").nth(2).click();
  check(tag, (await page.locator(".line.now").count()) === 1, "clicking a line still marks it");
}
const NODESCRIBE_EXTRA = `catOpts.noChunk = true; delete mcp.describeTool;`;
async function flowNoChunkProbe({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await openConsult(page, CAT_FULL);
  await page.waitForFunction(() => /isn't playable/.test(document.getElementById("audio-host")?.textContent || ""), null, { timeout: 5000 });
  check(tag, (await chunkCalls(page)).length === 1, "without describeTool, one probe decides");
}
const BIG_EXTRA = `catOpts.totalBytes = 257 * 1048576;`;
async function flowAudioTooBig({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await openConsult(page, CAT_FULL);
  await page.waitForFunction(() => /too large/i.test(document.getElementById("audio-host")?.textContent || ""), null, { timeout: 5000 });
  check(tag, (await chunkCalls(page)).length === 1 && (await page.locator("audio").count()) === 0, "size cap: stopped after the first chunk, no player");
  const t = await page.textContent("#audio-host");
  check(tag, t.includes("257 MB") && t.includes("longer than this page loads (limit 256 MB)") && t.includes("The transcript still works"), "the cap message states the size and the limit: " + t);
  check(tag, (await page.locator("ol.tx .line").count()) === CAT_FULL.transcript.length, "the transcript still works when the cap binds");
}
const CORRUPT_EXTRA = `catOpts.corrupt = true;`;
async function flowAudioCorrupt({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await openConsult(page, CAT_FULL);
  await page.waitForFunction(() => /could not be loaded/i.test(document.getElementById("audio-host")?.textContent || ""), null, { timeout: 5000 });
  check(tag, (await page.locator("audio").count()) === 0, "a damaged chunk: designed error, no player");
}
const JUNK_EXTRA = `catOpts.clipBytes = () => new Uint8Array(6000).fill(9); catOpts.contentType = "audio/flac";`;
async function flowAudioUndecodable({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await openConsult(page, CAT_FULL);
  await page.waitForFunction(() => /could not be played/i.test(document.getElementById("audio-host")?.textContent || ""), null, { timeout: 15000 });
  check(tag, (await page.locator("audio").count()) === 0, "S11: bytes the browser cannot decode leave no dead player, only the message");
  check(tag, (await page.locator("ol.tx .line").count()) === CAT_FULL.transcript.length, "transcript still works");
}
const CLIPERR_EXTRA = `catOpts.errors = { clip: "bad_clip_key" };`;
const CLIPERR_COPY = { bad_range: /Audio clip ended early/, read_failed: /Audio could not be read/, clip_not_found: /Audio clip not found/ };
async function flowClipKeyError({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await openConsult(page, CAT_FULL);
  await page.waitForFunction(() => /Audio clip location refused/.test(document.getElementById("audio-host")?.textContent || ""), null, { timeout: 5000 });
  check(tag, (await page.locator("audio").count()) === 0, "bad_clip_key: designed copy, no audio element");
  check(tag, (await page.locator("ol.tx .line").count()) === CAT_FULL.transcript.length, "the transcript still renders without audio");
}
const ADMIN_EXTRA = `catOpts.requireAdmin = true;`;
async function flowNeedsAdmin({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  check(tag, (await page.textContent("#view")).includes("Names are not shown: the catalog needs an admin token"), "overview says why names are missing");
  check(tag, (await page.textContent("#view")).includes("name not available yet"), "doctor names flagged not available");
  const s = await page.evaluate(() => window.__mcp.filter(c => c.a.action === "search").map(c => !!c.a.include_identity));
  check(tag, s[0] === true && s.slice(1).every(x => x === false), "asked once with identity, then plain: " + s.join());
  await page.locator("button.cell").first().click(); await page.waitForSelector("tr.row-click");
  const rxCol = await page.locator("tr.row-click td.c-rx").allTextContents();
  const yesRow = rxCol.findIndex(x => /yes/.test(x));
  await page.locator("tr.row-click").nth(yesRow >= 0 ? yesRow : 0).locator("button.link-btn").click(); await page.waitForSelector("#notes");
  const t = await page.textContent("#view");
  check(tag, t.includes("Patient (name not available yet)"), "patient name not shown without identity");
  if (yesRow >= 0) check(tag, t.includes("Prescription on file") && t.includes("admin token") && !t.includes("No prescription linked"), "S14: ids withheld but a prescription exists -> 'Prescription on file', not 'No prescription linked'");
  check(tag, yesRow >= 0, "the admin run found a consult with a prescription");
  check(tag, (await page.locator("#ledger-no-times").count()) === 1 && (await page.textContent("#ledger-no-times")).includes("catalog has no per-stage times yet"), "N17: ledger time caption shown when a row has no time");
}
const NOJOIN_EXTRA = `catOpts.noJoin = true;`;
async function flowNoJoin({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await page.locator("button.cell").first().click(); await page.waitForSelector("tr.row-click");
  const col = await page.locator("tr.row-click td.c-rx").allTextContents();
  check(tag, col.length > 0 && col.every(x => /not joined yet/.test(x) && !/\bno\b(?! )/i.test(x.replace("Rx linked:", ""))), "B1: unjoined prescription data reads 'not joined yet', never 'no': " + col.join("|"));
}
const ERR_EXTRA = `catOpts.errors = { search: "catalog_unavailable" };`;
async function flowCatalogError({ page, tag, check }) {
  // the page retries search and get on its own (1 s, 3 s, 6 s); the fake clock makes that instant here
  await page.clock.install();
  await SET_FULL(page);
  await page.waitForFunction(() => /Catalog is refreshing, retrying/.test(document.getElementById("retry-status").textContent) && !document.getElementById("retry-status").hidden, null, { timeout: 5000 });
  await page.clock.runFor(15000);
  await page.waitForSelector(".na.err");
  const t = await page.textContent("#view");
  check(tag, t.includes("Catalog unavailable") && t.includes("The catalog is being rebuilt. Try again in a minute.") && (await page.locator("button", { hasText: "Try again" }).count()) === 1, "catalog_unavailable has its own copy and a retry button");
  check(tag, (await page.evaluate(() => window.__mcp.filter(c => c.a.action === "search").length)) >= 4 && (await page.locator("#retry-status").isHidden()), "three retries after the first call, then the status line is cleared");
  await page.evaluate(() => { window.__catOpts.errors = null; });
  await page.click("button:has-text('Try again')");
  await page.waitForSelector("table.grid", { timeout: 5000 });
}
const REJECT_EXTRA = `catOpts.rejectEnvelopes = true; catOpts.errors = { search: "blind_room_day" };`;
async function flowRejectedEnvelope({ page, tag, check }) {
  await page.waitForSelector(".na.err");
  const t = await page.textContent("#view");
  check(tag, t.includes("Blind room-day") && !t.includes("Could not load"), "S10: a tool_error rejection keeps the catalog code and its copy");
}
const BLIND = M[0].room_id + "|" + M[0].ist_date;
const BLIND_EXTRA = `catOpts.blind = ${JSON.stringify([BLIND])};`;
async function flowBlind({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  check(tag, (await page.textContent("#view")).includes("Blind room-days left out"), "blind room-days are reported as left out");
}
const CLOCK_EXTRA = `catOpts.degraded = {}; catOpts.degraded[${JSON.stringify(CAT_FULL.consult_uid)}] = ["translate:clock_mismatch"];`;
async function flowDegraded({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await openConsult(page, CAT_FULL);
  await page.waitForSelector("#tx-degraded");
  check(tag, /translate track \(clock_mismatch\)/.test(await page.textContent("#tx-degraded")), "a degraded track is named, the transcript stays");
}


// ------------------------------------------------------------ M4a: the live page's inspection slots, over the mock catalog
const LIVE_RICH = M.find(c => c.transcript && c.catalog_c4 && c.catalog_c4.jev && c.catalog_c4.clef_affect && c.catalog_c4.presence && c.clip && !c.jev);   // jev only through C4 (the catalog-12 fallback)
const LIVE_BOTH = M.find(c => c.transcript && c.catalog_c4 && c.catalog_c4.jev && c.catalog_c4.clef_affect && c.catalog_c4.presence && c.clip && c.jev && c.narrative);   // jev from both sources; the mockup has narrative data the live page must ignore
const LIVE_NULL = M.find(c => c.transcript && c.catalog_c4 && c.catalog_c4.jev === null && c.catalog_c4.clef_affect === null && c.catalog_c4.presence === null && c.clip && !c.jev);
const LIVE_ERR = M.find(c => c.transcript && c.c4_error && c.clip && !c.jev);
const openLive = async (page, uid) => { await page.evaluate(t => { location.hash = t; }, "c-" + uid); await page.waitForSelector("section.slot#layer-11", { timeout: 15000 }); await page.waitForSelector("#notes"); };
async function flowLiveSlots({ page, tag, check, overflow, shot }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  // A1: jev only in C4 -> layers.jev = {origin: catalog_c4, sets: {sets}} -> the table reads data.sets.sets
  await openLive(page, LIVE_RICH.consult_uid);
  let st = await slotStates(page);
  check(tag, st.length === 11 && [1, 3, 4, 6, 7, 8].every(n => slotAt(st, n).state === "present"), "live: slots 1, 3, 4, 6, 7, 8 present " + JSON.stringify(st.map(x => x.n + ":" + x.state + (x.reason ? "/" + x.reason : ""))));
  check(tag, (await page.locator("#layer-6 table#jev-sets tbody tr").count()) === LIVE_RICH.catalog_c4.jev.sets.length && (await page.locator("#layer-6 table#jev-decisions").count()) === 0, "A1: the C4 sets list (data.sets.sets) is shown, one row per set");
  check(tag, (await page.textContent("#layer-6")).includes("C4"), "the source is badged C4");
  check(tag, [9, 10].every(n => slotAt(st, n).state === "notbuilt") && (await page.locator(".mock-badge").count()) === 0, "live: slots 9 and 10 are not yet built, no mock badge anywhere");
  check(tag, (await page.textContent("#role-source")).includes("role source: not yet in catalog"), "live: role source not yet in catalog");
  const seen = await page.evaluate(() => window.__mcp);
  check(tag, seen.every(c => c.t === "scribe_catalog" && ["search", "get", "clip_audio_chunk"].includes(c.a.action)), "the live manifest is unchanged: only search, get, clip_audio_chunk");
  await overflow("live inspection rich"); await shot("live-inspection");
  // both sources, and a mockup consult that has narrative data: the live page must not show it
  await openLive(page, LIVE_BOTH.consult_uid);
  check(tag, (await page.locator("#layer-6 table#jev-decisions").count()) === 1 && (await page.locator("#layer-6 table#jev-sets").count()) === 1, "both sources shown, each badged");
  st = await slotStates(page);
  check(tag, [9, 10].every(n => slotAt(st, n).state === "notbuilt") && (await page.locator("#who-table").count()) === 0, "live ignores turns / voice_id / topics even when the catalog mock carries them");
  // C4 present, every column null
  await openLive(page, LIVE_NULL.consult_uid);
  st = await slotStates(page);
  check(tag, [6, 7, 8].every(n => slotAt(st, n).state === "missing" && slotAt(st, n).reason === "c4_null"), "live: c4_null " + JSON.stringify(st.slice(5, 8)));
  // read failed
  await openLive(page, LIVE_ERR.consult_uid);
  st = await slotStates(page);
  check(tag, [6, 7, 8].every(n => slotAt(st, n).state === "missing" && slotAt(st, n).reason === "c4_error"), "live: c4_error " + JSON.stringify(st.slice(5, 8)));
  await overflow("live inspection c4 error");
}
const NOC4_EXTRA = `catOpts.noC4 = true;`;
async function flowLiveNonAdmin({ page, tag, check, overflow }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await openLive(page, LIVE_RICH.consult_uid);
  const st = await slotStates(page);
  check(tag, [6, 7, 8].every(n => slotAt(st, n).state === "missing" && slotAt(st, n).reason === "needs_admin"), "no C4 key: slots 6-8 are needs_admin " + JSON.stringify(st.slice(5, 8)));
  check(tag, (await page.textContent("#layer-6")).includes("Needs an admin key in your Scribe MCP connector"), "needs_admin copy");
  check(tag, (await page.locator("section.slot").count()) === 11, "nothing hidden");
  check(tag, (await page.locator("#ro-banner").isHidden()), "an absent C4 key is not the read-only banner (names still work)");
  await overflow("live non-admin");
}
async function flowNoClipLive({ page, tag, check, overflow }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  const NC = M.find(c => c.clip === null);
  await openLive(page, NC.consult_uid);
  const t = await page.textContent("#no-clip");
  check(tag, t.includes("No audio: the room was not recording during this consult (" + NC.stages.sealed.reason + ")"), "no_clip copy with the sealed reason: " + t);
  check(tag, (await chunkCalls(page)).length === 0 && (await page.locator("audio").count()) === 0, "no clip_audio_chunk call and no player for a consult with no clip");
  check(tag, (await page.locator("#layer-2 [data-state=missing]").count()) >= 1, "slot 2 shows missing");
  // the server's own no_clip answer for a clip the page thought it had maps to the same copy
  await page.evaluate(() => { window.__catOpts.errors = null; });
  await overflow("live no clip");
}
// progressive start: a 22 MB clip, the player starts after 8 MiB and the full clip replaces it
const LONG = M.find(c => c.transcript && c.clip && c.lengthSec >= 600 && !c.jev) || M.find(c => c.transcript && c.clip && c.lengthSec >= 600);
const PROG_EXTRA = `catOpts.clipBytes = c => window.__wavBig(c.lengthSec); catOpts.slowMs = 60;`;
async function flowProgressive({ page, tag, check, overflow }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await openLive(page, LONG.consult_uid);
  await page.waitForFunction(() => document.querySelector("audio") && /Loading audio/.test(document.getElementById("audio-progress")?.textContent || ""), null, { timeout: 20000 });
  const early = await page.evaluate(() => ({ src: document.querySelector("audio").src, chunks: window.__mcp.filter(c => c.a.action === "clip_audio_chunk").length, prog: document.getElementById("audio-progress").textContent }));
  check(tag, early.src.startsWith("blob:") && early.chunks >= 16, "the player exists while the clip is still loading (after about 8 MiB): " + early.chunks + " chunks, " + early.prog);
  await page.waitForFunction(() => document.querySelector("audio").readyState >= 1, null, { timeout: 20000 });
  // position and a seek beyond the loaded part, while loading
  await page.evaluate(() => { document.querySelector("audio").currentTime = 3; });
  const late = LONG.transcript.at(-1);
  await page.locator("ol.tx .line").last().click();
  const msg = await page.evaluate(() => document.getElementById("audio-seek").textContent);
  const stillLoading = await page.evaluate(() => /Loading audio/.test(document.getElementById("audio-progress")?.textContent || ""));
  check(tag, !stillLoading || /Loading to \d+:\d\d/.test(msg), "a seek beyond the loaded part waits and says so: '" + msg + "'");
  // everything arrives: the source swaps to the full clip, the partial URL is revoked, the checksum is computed once over the full bytes
  await page.waitForFunction(() => !document.getElementById("audio-progress"), null, { timeout: 60000 });
  await page.waitForFunction(() => /checksum/i.test(document.getElementById("audio-checksum").textContent) && !/Checking/.test(document.getElementById("audio-checksum").textContent), null, { timeout: 30000 });
  const done = await page.evaluate(() => ({ src: document.querySelector("audio").src, revoked: window.__revoked.length, created: window.__created.filter(u => u.startsWith("blob:")).length, sum: document.getElementById("audio-checksum").textContent, chunks: window.__mcp.filter(c => c.a.action === "clip_audio_chunk").length }));
  check(tag, done.src.startsWith("blob:") && done.src !== early.src, "the source was swapped to the full clip");
  check(tag, done.created === 2 && done.revoked >= 1, "two object URLs were made (prefix, full) and the prefix one was revoked: " + JSON.stringify(done));
  check(tag, done.sum === "Audio checksum matches catalog", "the checksum is computed over the full bytes after the swap: " + done.sum);
  check(tag, done.chunks >= 17, "all chunks were read (" + done.chunks + ")");
  if (!stillLoading) return;
  await page.waitForFunction(x => Math.abs(document.querySelector("audio").currentTime - x) < 2, late.t0, { timeout: 15000 }).catch(() => {});
  const cur = await page.evaluate(() => document.querySelector("audio").currentTime);
  check(tag, Math.abs(cur - late.t0) < 2, "the queued seek is applied after the swap (wanted " + late.t0 + ", got " + cur + ")");
  await overflow("live progressive");
}
const RETRY2_EXTRA = `catOpts.failFirst = { search: 2 };`;
async function flowRetryRecovers({ page, tag, check }) {
  await page.clock.install();
  await SET_FULL(page);
  await page.waitForFunction(() => !document.getElementById("retry-status").hidden && /Catalog is refreshing, retrying/.test(document.getElementById("retry-status").textContent), null, { timeout: 5000 });
  check(tag, true, "");
  await page.clock.runFor(2000);   // the 1 s wait
  await page.clock.runFor(4000);   // the 3 s wait
  await page.waitForSelector("table.grid", { timeout: 5000 });
  check(tag, await page.locator("#retry-status").isHidden(), "the status line clears once the catalog answers");
  check(tag, (await page.evaluate(() => window.__mcp.filter(c => c.a.action === "search").length)) >= 3, "the search was retried until it worked");
}
const RETRYGET_EXTRA = `catOpts.failFirst = { get: 99 };`;
async function flowRetryAborts({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await page.clock.install();
  await page.evaluate(() => { location.hash = "c-" + window.__CAT0; });
  await page.waitForFunction(() => !document.getElementById("retry-status").hidden, null, { timeout: 5000 });
  const n0 = await page.evaluate(() => window.__mcp.filter(c => c.a.action === "get").length);
  await page.evaluate(() => { location.hash = "overview"; });
  await page.waitForSelector("table.grid");
  check(tag, await page.locator("#retry-status").isHidden(), "navigating away clears the retry line");
  await page.clock.runFor(30000);
  const n1 = await page.evaluate(() => window.__mcp.filter(c => c.a.action === "get").length);
  check(tag, n1 === n0, "no get call after navigating away during the backoff (" + n0 + " then " + n1 + ")");
}
const RETRYCHUNK_EXTRA = `catOpts.errors = { clip: "catalog_unavailable" };`;
async function flowChunkNotRetried({ page, tag, check }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  await openCatalog(page, CAT_FULL);
  await page.waitForFunction(() => /Catalog unavailable/.test(document.getElementById("audio-host")?.textContent || ""), null, { timeout: 5000 });
  check(tag, (await chunkCalls(page)).length === 1 && (await page.locator("#retry-status").isHidden()), "clip_audio_chunk is not retried as a rebuild: one call, no retry line");
}
const openCatalog = (page, c) => openLive(page, c.consult_uid);

// ------------------------------------------------------------ M4a: deep links (bare tokens only)
const hexOf = s => [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, "0")).join("");
async function flowDeepLinks({ page, tag, check, overflow }) {
  const file = page.url().split("#")[0];
  const go = async token => { await page.goto(file + "#" + token); await page.reload(); };
  // #c-<uid>
  await go("c-" + CAT_FULL.consult_uid);
  await page.waitForSelector("section.slot#layer-11", { timeout: 15000 });
  check(tag, (await page.locator("section.slot").count()) === 11, "#c-<uid> opens the consult directly");
  check(tag, (await page.textContent("nav.crumbs")).includes(CAT_FULL.consult_uid), "breadcrumb shows the uid");
  const crumb = await page.locator("nav.crumbs button").nth(1).textContent();
  check(tag, crumb.includes(CAT_FULL.ist_date), "the doctor-day crumb is filled in once the consult is known: " + crumb);
  await page.locator("nav.crumbs button").nth(1).click();
  await page.waitForSelector("tr.row-click");
  check(tag, /^#d-[0-9a-f]+~\d{4}-\d{2}-\d{2}$/.test(await page.evaluate(() => location.hash)), "the crumb link is a doctor-day token");
  // #d-<hex>~<date>
  await go("d-" + hexOf(CAT_FULL.doctor_uid) + "~" + CAT_FULL.ist_date);
  await page.waitForSelector("tr.row-click", { timeout: 15000 });
  const n = M.filter(c => c.doctor_uid === CAT_FULL.doctor_uid && c.ist_date === CAT_FULL.ist_date).length;
  check(tag, (await page.locator("tr.row-click").count()) === n, "#d-<hex>~<date> opens the doctor-day (" + n + " consults)");
  await overflow("deep link doctor-day");
  // clicking a consult writes the consult token and Back returns to the day
  await page.locator("tr.row-click button.link-btn").first().click();
  await page.waitForSelector("section.slot#layer-11");
  check(tag, /^#c-/.test(await page.evaluate(() => location.hash)), "clicking through writes #c-<uid>");
  await page.goBack(); await page.waitForSelector("tr.row-click");
  check(tag, /^#d-/.test(await page.evaluate(() => location.hash)), "Back returns to the doctor-day token");
  // #p-<hex>: the admin patient filter
  await go("p-" + hexOf(CAT_FULL.individual_uid));
  await page.waitForSelector("tr.row-click", { timeout: 15000 });
  check(tag, (await page.locator("tr.row-click").count()) >= 1 && (await page.evaluate(() => window.__mcp.some(c => c.a.individual_uid === window.__IND))) !== undefined, "#p-<hex> opens the patient list");
  const sp = await page.evaluate(() => window.__mcp.filter(c => c.a.individual_uid).map(c => ({ ind: c.a.individual_uid, id: c.a.include_identity })));
  check(tag, sp.length >= 1 && sp.every(x => x.ind === CAT_FULL.individual_uid && x.id === true), "the patient list uses the individual_uid filter with identity");
  await overflow("deep link patient");
  // an anchor that does not parse: overview + one line, no throw
  for (const bad of ["consult=" + CAT_FULL.consult_uid, "doctor=x&date=2026-10-13", "c-x", "d-zz~2026-10-13", "d-61~2026-13-40", "d-61~2026-09-31", "d-61~2027-02-29", "p-zz", "garbage", "layer-"]) {
    await go(bad);
    await page.waitForSelector("table.grid, .na.err", { timeout: 15000 });
    check(tag, (await page.locator("#link-notice").textContent().catch(() => "")) === "Link not recognised." && (await page.locator("#f-from").count()) === 1, "unparseable anchor #" + bad + " -> overview with 'Link not recognised.'");
  }
  // a plain empty hash and a known token raise no notice
  await go("overview");
  await page.waitForSelector("table.grid");
  check(tag, (await page.locator("#link-notice").count()) === 0, "a valid token shows no notice");
  // #layer-N with no consult open is not an error
  await go("layer-3");
  await page.waitForSelector("table.grid");
  check(tag, (await page.locator("#link-notice").count()) === 0, "#layer-N without a consult goes to the overview quietly");
}
const PATIENT_ADMIN_EXTRA = `catOpts.requireAdmin = true;`;
async function flowPatientNeedsAdmin({ page, tag, check }) {
  const file = page.url().split("#")[0];
  await page.goto(file + "#p-" + hexOf(CAT_FULL.individual_uid)); await page.reload();
  await page.waitForFunction(() => /Patient lookup needs an admin key/.test(document.getElementById("view").textContent), null, { timeout: 15000 });
  check(tag, (await page.locator("#view [data-state=missing]").first().textContent()).includes("needs_admin"), "patient lookup without admin: missing / needs_admin");
  check(tag, !(await page.locator("#ro-banner").isHidden()), "and the read-only banner explains it");
}

// ------------------------------------------------------------ M4a: connector copy and the read-only banner
async function flowConnectorCopy({ page, tag, check, overflow }) {
  await page.waitForSelector(".na.err");
  const t = await page.textContent("#view");
  check(tag, t.includes("This page needs a Claude connector named exactly Scribe MCP, set up with your own Scribe key. Ask V for a key. Never paste a key into this page or a chat."), "connector copy: " + t);
  check(tag, (await page.locator("#view .na b").allTextContents()).includes("Scribe MCP"), "Scribe MCP is bold in the copy");
  check(tag, (await page.locator("input[type=password], input[name*=key i], input[placeholder*=key i]").count()) === 0, "the page never shows a key input");
  await overflow("connector copy");
}
async function flowReadOnlyBanner({ page, tag, check, overflow }) {
  await SET_FULL(page); await page.waitForSelector("table.grid");
  const copy = "Your Scribe key is read-only. Names, prescription ids and layers 6-8 need an admin key from V.";
  check(tag, !(await page.locator("#ro-banner").isHidden()) && (await page.locator("#ro-banner").textContent()).includes(copy), "read-only banner with the exact copy");
  // persistent: it is still there on the list and on a consult
  await page.locator("button.cell").first().click(); await page.waitForSelector("tr.row-click");
  check(tag, !(await page.locator("#ro-banner").isHidden()), "the banner persists on the list");
  await page.locator("tr.row-click button.link-btn").first().click(); await page.waitForSelector("section.slot#layer-11");
  check(tag, !(await page.locator("#ro-banner").isHidden()), "the banner persists on a consult");
  await overflow("read-only banner");
  await page.click("#ro-dismiss");
  check(tag, await page.locator("#ro-banner").isHidden(), "dismiss hides it");
  await page.goBack(); await page.waitForSelector("tr.row-click"); await page.goBack(); await page.waitForSelector("table.grid");
  check(tag, await page.locator("#ro-banner").isHidden(), "and it stays hidden after navigating");
}

const browser = await chromium.launch();
for (const [name, cfg] of configs) {
  await run(browser, "mockup", "all", name, cfg, flowMockup);
  await run(browser, "current", "all", name, cfg, flowCurrent);
}
for (const [name, cfg] of [configs[0], configs[3]]) {
  await run(browser, "current", "none", name, cfg, ctx => flowNone({ ...ctx, build: "current" }));
  await run(browser, "mockup", "none", name, cfg, ctx => flowNone({ ...ctx, build: "mockup" }));
}
for (const [name, cfg] of configs) await run(browser, "catalog", "all", name, cfg, flowCatalog);
for (const [name, cfg] of [configs[0], configs[2]]) {
  await run(browser, "catalog", "all", name, cfg, flowAudioProgress, SLOW_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowAudioAbort, SLOW_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowNoChunk, NOCHUNK_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowNoChunkProbe, NODESCRIBE_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowAudioTooBig, BIG_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowAudioCorrupt, CORRUPT_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowAudioUndecodable, JUNK_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowClipKeyError, CLIPERR_EXTRA);
  for (const [code, re] of Object.entries(CLIPERR_COPY)) await run(browser, "catalog", "all", name, cfg, async ({ page, tag, check }) => {
    await SET_FULL(page); await page.waitForSelector("table.grid");
    await openConsult(page, CAT_FULL);
    await page.waitForFunction(src => new RegExp(src).test(document.getElementById("audio-host")?.textContent || ""), re.source, { timeout: 5000 });
    check(tag, (await page.locator("audio").count()) === 0 && !/isn't playable inside the artifact/.test(await page.textContent("#audio-host")), code + ": designed error copy, not the not-available state, no player");
  }, `catOpts.errors = { clip: "${code}" };`);
  await run(browser, "catalog", "all", name, cfg, flowNeedsAdmin, ADMIN_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowReadOnlyBanner, ADMIN_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowPatientNeedsAdmin, ADMIN_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowLiveSlots);
  await run(browser, "catalog", "all", name, cfg, flowLiveNonAdmin, NOC4_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowNoClipLive);
  await run(browser, "catalog", "all", name, cfg, flowProgressive, PROG_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowRetryRecovers, RETRY2_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowRetryAborts, RETRYGET_EXTRA + ` window.__CAT0 = ${JSON.stringify(CAT_FULL.consult_uid)};`);
  await run(browser, "catalog", "all", name, cfg, flowChunkNotRetried, RETRYCHUNK_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowDeepLinks);
  await run(browser, "catalog", "none", name, cfg, flowConnectorCopy);
  await run(browser, "catalog", "all", name, cfg, flowNoJoin, NOJOIN_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowCatalogError, ERR_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowRejectedEnvelope, REJECT_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowBlind, BLIND_EXTRA);
  await run(browser, "catalog", "all", name, cfg, flowDegraded, CLOCK_EXTRA);
  await run(browser, "catalog", "none", name, cfg, ctx => flowNone({ ...ctx, build: "catalog" }));
  await run(browser, "current", "all", name, cfg, flowHugeT0, HUGE_EXTRA);
  await run(browser, "current", "all", name, cfg, flowApproval, FAIL_EXTRA("approval_required"));
  await run(browser, "current", "all", name, cfg, flowNotInManifest, FAIL_EXTRA("not_in_manifest"));
  await run(browser, "current", "all", name, cfg, flowReauth, FAIL_EXTRA("needs_reauth"));
  await run(browser, "mockup", "all", name, cfg, flowAsk, SLOW_SAMPLE);
  await run(browser, "mockup", "all", name, cfg, flowReadOnlyNotes, CANT_WRITE);
  await run(browser, "mockup", "all", name, cfg, flowDeniedNotes, DENY_WRITE);
}
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : "\nbrowser-check: all green");
process.exit(failures.length ? 1 : 0);
