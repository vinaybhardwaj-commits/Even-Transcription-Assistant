// Drives the REAL viewer Worker code in headless Chromium against REAL vault-shaped files and REAL local audio.
// Stand-in for Cloudflare Access: a local proxy signs a valid Access JWT (local RSA key, JWKS via env.__fetch) and injects it.
// No network, no Cloudflare, nothing is written outside a temp dir. Patient text is never printed; only counts and states.
//
//   PW_DIR=<dir with node_modules/playwright-core> LD_LIBRARY_PATH=<extra libs> node browser_smoke.mjs
//   (index built first: build-index.py into $SMOKE_INDEX_DIR/index)
import http from "node:http";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import worker from "../worker/index.js";

const require = createRequire(join(process.env.PW_DIR, "/"));
const { chromium } = require("playwright-core");
const HOME = homedir();
const INDEX_DIR = process.env.SMOKE_INDEX_DIR;
const AUDIO_DIR = process.env.SMOKE_AUDIO_DIR ?? join(HOME, "eta-data/hist-mining/audio");

// ---- local "vault": every vault-layout file under the box roots + the temp index, keyed like R2
const roots = [["eta-data/hist", ["runs", "manifests"]], ["eta-data/hist-mining", ["runs", "manifests"]], ["eta-data/lab-vault/staged", ["runs", "manifests"]]].map(([r, t]) => [join(HOME, r), t]);
const files = new Map();
const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
for (const [root, tops] of roots) for (const t of tops) for (const f of walk(join(root, t))) if (/\.jsonl?$/.test(f)) files.set(relative(root, f), f);
for (const f of walk(join(INDEX_DIR, "index"))) files.set(relative(INDEX_DIR, f), f);
for (const f of walk(join(INDEX_DIR, "annotations"))) files.set(relative(INDEX_DIR, f), f);   // test fixtures: English for one line
const bucket = (lookup) => ({
  async head(k) { const f = lookup(k); return f ? { size: statSync(f).size } : null; },
  async get(k, o) {
    const f = lookup(k); if (!f) return null;
    const buf = readFileSync(f), part = o?.range ? buf.subarray(o.range.offset, o.range.offset + o.range.length) : buf;
    return { body: new Response(part).body, text: async () => buf.toString("utf8") };
  },
  async list({ prefix }) { return { objects: [...files.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; },
});

// ---- fake Access: local RSA key + JWKS
const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
const TEAM = "team.test", AUD = "aud-smoke", EMAIL = "staff-redacted@even.in";
const b64u = (b) => Buffer.from(b).toString("base64url");
async function token() {
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1" })), now = Math.floor(Date.now() / 1000);
  const p = b64u(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: now + 600, iat: now - 5 }));
  return `${h}.${p}.${b64u(Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, Buffer.from(`${h}.${p}`))))}`;
}
const env = {
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL,
  __fetch: async () => new Response(JSON.stringify({ keys: [jwk] })),
  RESULTS: bucket((k) => files.get(k)),
  AUDIO: bucket((k) => { const f = join(AUDIO_DIR, k.replaceAll("/", "__")); return existsSync(f) ? f : null; }),
};
const withAccess = process.env.SMOKE_NO_JWT !== "1";
const server = http.createServer(async (req, res) => {
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, String(v));
  if (withAccess) headers.set("cf-access-jwt-assertion", await token());
  const r = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

// ---- pick windows from the VIEW index: one with text (and local audio), one empty, one NO_SIGNAL, one parity record
const newest = (p) => files.get([...files.keys()].filter((k) => k.startsWith(p)).sort().pop());
const view = readFileSync(newest("index/view-"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const localAudio = (k) => existsSync(join(AUDIO_DIR, k.replaceAll("/", "__")));
const rec = (row) => JSON.parse(readFileSync(files.get(row.key), "utf8"));
const segsOf = (d) => (Array.isArray(d.segments) ? d.segments : Array.isArray(d.payload?.segments) ? d.payload.segments : []);
const chunkIdx = new Map(readFileSync(newest("index/chunks-"), "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.r2_key, r]; }));
let withText = null, empty = null, nosig = null, parity = null, refusedText = null, allRefused = null, untested = null;
for (const row of view) {
  if (!withText && row.status === "text" && row.n_lines >= 6 && row.t0) {
    const d = rec(row), keys = d.provenance?.source_chunks?.map((c) => c.r2_key) ?? d.cut?.chunk_keys ?? d.provenance?.source_audio_keys ?? [];
    if (keys.length && keys.every(localAudio) && (d.provenance?.source_chunks || keys.every((k) => chunkIdx.has(k)))) withText = row;
  }
  if (!refusedText && row.status === "text" && row.n_refused > 0 && row.n_lines >= 3) refusedText = row;
  if (!empty && row.status === "no_text") empty = row;
  if (!allRefused && row.status === "refused") allRefused = row;
  if (!untested && row.status === "untested") untested = row;
  if (!nosig && row.status === "no_signal") nosig = row;
  if (!parity && row.producer === "stt-parity" && row.status === "text") parity = row;
}
if (process.env.SMOKE_FORCE_UNTESTED_KEY) untested = { key: process.env.SMOKE_FORCE_UNTESTED_KEY, status: "untested" };
if (process.env.SMOKE_FORCE_NOSIG_KEY) nosig = { key: process.env.SMOKE_FORCE_NOSIG_KEY, status: "no_signal" }; // test the window even when the index does not list it
const out = { console_errors: [], csp_violations: [], external_requests: [], picks: { untested: !!untested, allRefused: !!allRefused, withText: !!withText, refusedText: !!refusedText, empty: !!empty, nosig: !!nosig, parity: !!parity }, viewports: {} };
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });

async function checkAt(name, viewport) {
  const page = await (await browser.newContext({ viewport })).newPage();
  const res = { days: {}, windows: {} };
  page.on("console", (m) => { if (m.type() === "error") out.console_errors.push(name + ": " + m.text().slice(0, 140)); if (/content security policy/i.test(m.text())) out.csp_violations.push(m.text().slice(0, 140)); });
  page.on("pageerror", (e) => out.console_errors.push(name + ": " + String(e).slice(0, 140)));
  page.on("request", (r) => { if (!r.url().startsWith(base) && !r.url().startsWith("blob:") && !r.url().startsWith("data:")) out.external_requests.push(r.url().slice(0, 80)); });
  // ---- Days
  await page.goto(base + "/#/days"); await page.waitForSelector(".cov", { timeout: 15000 });
  res.days.coverage_line = (await page.textContent(".cov")).replace(/\s+/g, " ").slice(0, 400);
  res.days.only_text_checked_by_default = await page.locator("input[type=checkbox]").isChecked();
  res.days.date_headers = await page.locator(".date").count();
  res.days.horizontal_scroll = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  res.days.newest_text_day_open_on_load = (await page.locator("a.win").count()) > 0;   // the page opens the newest day that has text
  if (!res.days.newest_text_day_open_on_load) { const n = await page.locator(".date a").count(); for (let i = 0; i < n && !(await page.locator("a.win").count()); i++) { await page.locator(".date a").nth(i).click(); await page.waitForTimeout(250); } }
  if (!(await page.locator("a.win").count())) { await page.locator(".roomrow a:not(.read)").first().click(); await page.waitForTimeout(300); }
  res.days.rows_first_date_text_only = await page.locator("a.win").count();
  res.days.rows_have_time_lang_words_firstwords = await page.locator("a.win").first().evaluate((a) => /\d\d:\d\d–\d\d:\d\d/.test(a.textContent) && /words/.test(a.textContent) && a.querySelector(".fw") !== null);
  res.days.room_headings = await page.locator(".room").count();
  res.days.room_headings_are_names_not_ids = await page.locator(".room").evaluateAll((els) => els.every((e) => !/^room_[a-z0-9]{8}/.test(e.textContent)));
  await page.locator("input[type=checkbox]").uncheck(); await page.waitForTimeout(300);
  res.days.rows_first_date_all = await page.locator("a.win").count();
  await page.locator("input[type=checkbox]").check();
  // ---- windows
  const seq = [["untested", untested], ["allRefused", allRefused], ["withText", withText], ["refusedText", refusedText], ["empty", empty], ["nosig", nosig], ["parity", parity]];
  for (const [label, row] of seq) {
    if (!row) { res.windows[label] = "no such window in the data"; continue; }
    const d = rec(row), segs = segsOf(d), wk = row.key.replace(/^runs\//, "").replace(/\.json$/, "");
    await page.goto(`${base}/#/win/${wk}`); await page.waitForSelector("h2", { timeout: 15000 }); await page.waitForTimeout(700);
    const w = {};
    w.h2_is_room_name = await page.locator("h2").first().evaluate((h) => h.textContent.trim().length > 0 && !/^room_[a-z0-9]{8}$/.test(h.textContent.trim()) && !/^bs_/.test(h.textContent.trim()));
    w.sub_has_ist_and_language = /IST|time not recorded/.test(await page.locator(".sub").textContent()) && /language/.test(await page.locator(".sub").textContent());
    w.segment_lines = await page.locator(".seg").count(); w.expected_segments = segs.filter((s) => s && typeof s === "object").length;
    w.line_format_ok = w.segment_lines === 0 ? null : await page.locator(".seg").first().evaluate((e) => /^(▶)?\s*\[\d+:\d\d–\d+:\d\d\]\s*\([^)]*\)/.test(e.textContent.replace(/\s+/g, " ").trim()) || /\[\d+:\d\d–\d+:\d\d\]/.test(e.textContent));
    w.refused_greyed = await page.locator(".seg.ref").count(); w.expected_refused = segs.filter((s) => s && s.refused).length;
    w.notext_message = (await page.locator(".notext").count()) ? (await page.locator(".notext").first().textContent()).slice(0, 90) : null;
    w.sub_says_no_signal = /no sound recorded \(microphone silent\)/.test(await page.locator(".sub").textContent());
    w.technical_details_closed_at_bottom = await page.evaluate(() => { const t = document.querySelector("details.tech"); const m = document.querySelector("main"); return !!t && !t.open && m.lastElementChild === t; });
    w.json_visible_outside_details = await page.evaluate(() => { const clone = document.querySelector("main").cloneNode(true); clone.querySelectorAll("details").forEach((x) => x.remove()); return /"provenance"|"payload"|"stack"|"schema"/.test(clone.textContent); });
    w.audio_line_or_player = (await page.locator(".noaudio").count()) ? (await page.locator(".noaudio").first().textContent()).slice(0, 40) : (await page.locator("#bar audio").count()) ? "player" : "none";
    res.windows[label] = w;
  }
  // ---- ▶ on a line of the text window through the Worker's Range route
  if (withText) {
    const d = rec(withText), segs = segsOf(d), wk = withText.key.replace(/^runs\//, "").replace(/\.json$/, ""), rangeSeen = [];
    page.on("response", (r) => { if (r.url().includes("/audio/")) rangeSeen.push(r.status()); });
    await page.goto(`${base}/#/win/${wk}`); await page.waitForSelector(".seg .play", { timeout: 15000 });
    await page.locator(".seg").nth(2).locator(".play").click();
    await page.waitForFunction(() => { const a = document.querySelector("audio"); return a && a.currentTime > 0.3 && !a.paused; }, null, { timeout: 20000 }).catch(() => {});
    const st = await page.evaluate(() => { const a = document.querySelector("audio"); return a ? { t: a.currentTime, paused: a.paused, err: a.error?.code ?? null } : null; });
    const chunkRows = d.provenance?.source_chunks ?? (d.cut?.chunk_keys ?? []).map((k) => chunkIdx.get(k));
    const abs = Date.parse(d.start) + segs[2].start_s * 1000, c = chunkRows.find((r) => r && abs >= Date.parse(r.started_at) && abs < Date.parse(r.ended_at ?? 0));
    const expected = c ? (abs - Date.parse(c.started_at)) / 1000 : null;
    res.play = { status_codes: [...new Set(rangeSeen)], playing: st && !st.paused, media_error: st?.err ?? null, expected_offset_s: expected && Math.round(expected * 10) / 10, current_time_s: st && Math.round(st.t * 10) / 10, offset_ok: expected != null && st && st.t >= expected - 0.5 && st.t < expected + 4 };
  }
  await page.goto(base + "/#/runs"); await page.waitForSelector(".card", { timeout: 15000 }); res.runs_cards = await page.locator(".card").count();
  out.viewports[name] = res;
}

// ---------------------------------------------------------------- consult view (ruling 337a)
async function consultChecks() {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(String(e).slice(0, 120))); page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 120)); });
  const res = { errors: errs };
  // choose the room-day with the most text windows that has some non-English speech
  const byRD = new Map();
  for (const r of view) if (r.status === "text" && r.start && r.producer !== "stt-parity") { const k = r.room_id + "|" + r.ist_date; (byRD.get(k) || byRD.set(k, []).get(k)).push(r); }
  const [rd] = [...byRD].filter(([, ws]) => ws.some((w) => w.lang && w.lang !== "en")).sort((a, b) => b[1].length - a[1].length).slice(0, 1);
  const [room, date] = rd[0].split("|");
  await page.goto(base + "/#/days"); await page.waitForSelector(".cov", { timeout: 15000 });
  res.days = { first_date_header_has_words: /words/.test(await page.locator(".date").first().textContent()), dates_listed: await page.locator(".date").count(),
    every_listed_date_has_speech: await page.evaluate(() => [...document.querySelectorAll(".dcov")].every((d) => !/^0 indexed|· 0 with text/.test(d.textContent))),
    room_rows_have_words_and_consult_link: await page.locator(".roomrow").count() > 0 && await page.locator(".roomrow").first().evaluate((r) => /words/.test(r.textContent) && !!r.querySelector("a.read")) };
  await page.goto(`${base}/#/consult/${room}/${date}`); await page.waitForSelector(".cline", { timeout: 20000 });
  const api = await page.evaluate(async (u) => (await fetch(u)).json(), `/api/consult/${room}/${date}`);
  res.header = { room_name_not_id: await page.locator("h2").first().evaluate((h) => !/^room_/.test(h.textContent)), sub: (await page.locator(".sub").textContent()).replace(/\s+/g, " ").slice(0, 120) };
  const linesText = await page.locator(".cline").evaluateAll((els) => els.map((e) => e.firstChild.textContent + "|" + e.children[1].textContent));
  res.lines_visible = linesText.length; res.line_format_ok = linesText.every((l) => /^\[\d\d:\d\d:\d\d\]\|\([^)]*\)$/.test(l));
  const times = linesText.map((l) => l.slice(1, 9)); res.times_nondecreasing = times.every((t, i) => i === 0 || t >= times[i - 1]);
  res.continuous_across_windows = api.windows.filter((w) => w.status === "text").length > 1;
  const kept = api.windows.filter((w) => !w.partial); res.no_overlapping_kept_windows = kept.every((w, i) => i === 0 || w.s >= kept[i - 1].e);
  res.api_segments_in_time_order = api.segments.every((s, i) => i === 0 || s.t >= api.segments[i - 1].t);
  res.hidden_overlaps_listed_as_lines = (api.hidden ?? []).length === 0 || (await page.locator(".cnote", { hasText: "hidden here because it overlaps" }).count()) === api.hidden.length;
  // spot-check 3 visible lines against the raw records: same absolute time and same text
  const shown = api.segments.filter((s) => !s.refused && s.text.trim());
  let exact = 0, checked = 0;
  for (const s of [shown[0], shown[Math.floor(shown.length / 2)], shown[shown.length - 1]]) {
    const w = api.windows[s.w], d = JSON.parse(readFileSync(files.get(`runs/${w.k}.json`), "utf8")), raw = d.segments[s.i];
    const abs = Date.parse(d.start) + raw.start_s * 1000; checked++;
    const ist = new Date(abs).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });
    if (raw.text === s.text && abs === s.t && ist.length === 8) exact++;
  }
  res.spot_checked_lines = checked; res.spot_checked_exact = exact;
  // unclear lines are collapsed behind a button and expand
  const grp = page.locator(".uncgroup button"); res.unclear_groups = await grp.count();
  res.unclear_collapsed_count_label = res.unclear_groups ? (await grp.first().textContent()) : null;
  if (res.unclear_groups) { const before = await page.locator(".cline").count(); const n = Number(/\((\d+)\)/.exec(await grp.first().textContent())[1]); await grp.first().click(); await page.waitForTimeout(250); res.unclear_expand_adds_lines = (await page.locator(".cline").count()) - before === n; res.unclear_lines_greyed = (await page.locator(".cline.unc").count()) >= n; }
  res.discarded_window_notes = await page.locator(".cnote").count();
  // search
  const word = (shown.find((s) => s.text.split(/\s+/).find((w) => w.length > 4)) ?? shown[0]).text.split(/\s+/).find((w) => w.length > 4) ?? "the";
  await page.fill("#cq", word); await page.press("#cq", "Enter"); await page.waitForTimeout(500);
  res.search = { matches_reported: /lines match/.test((await page.textContent("main")) ?? ""), highlighted_lines: await page.locator(".cline.hit").count(), marks: await page.locator("mark").count() };
  // English under a non-English line (fixture written by the test into the annotations dir)
  const non = api.segments.find((s) => s.lang && s.lang !== "en" && !s.refused && s.text.trim() && !isUncl(s));
  if (non) {
    const w = api.windows[non.w];
    const dir = join(INDEX_DIR, "annotations/translation", room, date); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "202609250900-smoke.json"), JSON.stringify({ items: [{ k: w.k, i: non.i, en: "SMOKE ENGLISH LINE", q: "ok", src_sha256: "a".repeat(64) }] }));
    files.set(`annotations/translation/${room}/${date}/202609250900-smoke.json`, join(dir, "202609250900-smoke.json"));
    await reloadConsult(page, room, date);
    const cache = await page.evaluate(async (u) => (await fetch(u)).json(), `/api/consult/${room}/${date}`);
    res.english = { api_merged: cache.segments.some((s) => s.en === "SMOKE ENGLISH LINE"), shown_under_line: await page.locator(".cline .en", { hasText: "SMOKE ENGLISH LINE" }).count(), no_flag_on_ok_translation: (await page.locator(".cline .en .why").count()) === 0, native_text_intact: cache.segments.find((s) => s.en === "SMOKE ENGLISH LINE")?.text === non.text, counts: cache.counts, stat_line: (await page.locator(".cstat").count()) ? (await page.locator(".cstat").first().textContent()).slice(0, 90) : null };
  }

  // measured readability flags: collapse only where the owner says so; otherwise just marked
  {
    const clean = api.segments.filter((s) => s.lang === "en" && !s.refused && s.text.trim().split(/\s+/).length >= 6 && !/(\b\w+\b)(\s+\1){4}/i.test(s.text)).slice(2, 4);
    if (clean.length === 2) {
      const [a, b] = clean, dirr = join(INDEX_DIR, "annotations/readability", room, date); mkdirSync(dirr, { recursive: true });
      writeFileSync(join(dirr, "202609250930-smoke.json"), JSON.stringify({ items: [{ k: api.windows[a.w].k, i: a.i, ok: false, score: 0.2, why: "smoke", collapse: true }, { k: api.windows[b.w].k, i: b.i, ok: false, score: 0.3, why: "smoke", collapse: false }] }));
      files.set(`annotations/readability/${room}/${date}/202609250930-smoke.json`, join(dirr, "202609250930-smoke.json"));
      await reloadConsult(page, room, date);
      const timeA = hms0(a.t), timeB = hms0(b.t), lines = await page.locator(".cline").evaluateAll((els) => els.map((e) => e.firstChild.textContent));
      const api2 = await page.evaluate(async (u) => (await fetch(u)).json(), `/api/consult/${room}/${date}`);
      res.readability_debug = { a_flag: api2.segments.find((x) => x.t === a.t && x.i === a.i)?.flag ?? null, b_flag: api2.segments.find((x) => x.t === b.t && x.i === b.i)?.flag ?? null, a_partial: api.windows[a.w].partial, b_partial: api.windows[b.w].partial, lines_with_b: lines.filter((l) => l === `[${hms0(b.t)}]`).length, lines_total: lines.length };
      res.readability_flags = { collapsed_line_not_in_main_flow: !lines.includes(`[${timeA}]`), marked_line_still_visible: lines.includes(`[${timeB}]`),
        marked_line_has_unclear_mark: (await page.locator(".cline", { hasText: `[${timeB}]` }).count()) ? await page.locator(".cline", { hasText: `[${timeB}]` }).first().evaluate((e) => /\[unclear\]/.test(e.textContent)) : null };
    }
  }
  {   // refuter-2 #2264: an addendum lowers completeness of records that still say complete (window page)
    const K = "hist-bulk-20260925T1033-1d1a40e/room_87frpus9/2026-09-24/c-2026-09-24_room_87frpus9_1745";
    if (files.has(`runs/${K}.json`) && files.has("manifests/hist-bulk-20260925T1033-1d1a40e.addendum.json")) {
      await page.goto(`${base}/#/win/${K}`); await page.waitForSelector("h2", { timeout: 15000 }); await page.waitForTimeout(800);
      await page.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));   // provenance is inside "Technical details"
      const txt = await page.evaluate(() => document.body.innerText);
      res.provenance_override_shown = /partial provenance: override evidence lost/.test(txt);
      if (!res.provenance_override_shown) res.provenance_override_debug = { has_vault_line: /Vault key:/.test(txt), partial_line: (/partial provenance[^\n]{0,60}/.exec(txt) ?? [null])[0], mf: await page.evaluate(async () => { const r = (await (await fetch("/api/manifests")).json()).runs.find((x) => x.run_id === "hist-bulk-20260925T1033-1d1a40e"); return r ? { has_addendum: !!r.addendum, keys: Object.keys(r.addendum ?? {}) } : null; }) };
    }
  }
  {   // hist-bulk's unverified_leaves addendum (window page, technical details): the record is complete, one leaf is unchecked
    const M = files.get("manifests/hist-bulk-20260925T1058-71a91ed.addendum.json");
    if (M) {
      const a = JSON.parse(readFileSync(M, "utf8")).addendum, wid = a.window_ids[0], k = [...files.keys()].find((f) => f.startsWith("runs/hist-bulk-20260925T1058-71a91ed/") && f.endsWith(`/${wid}.json`));
      if (k) {
        await page.goto(`${base}/#/win/${k.slice(5, -5)}`); await page.waitForSelector("h2", { timeout: 15000 }); await page.waitForTimeout(800);
        await page.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
        const t = await page.evaluate(() => document.body.innerText);
        res.unverified_leaf_shown = /unverified: stack\.whisper server binary sha256: not recorded/.test(t) && !/partial provenance/.test(t);
      }
    }
  }
  res.horizontal_scroll = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  return res;
}
// a reload starts a fresh SPA (drops the 60 s client cache); wait until the consult has actually rendered, not merely until a stale node exists
async function reloadConsult(page, room, date) {
  await page.goto("about:blank"); await page.goto(`${base}/#/consult/${room}/${date}`);
  try { await page.waitForFunction(() => document.querySelector(".cline") && !/Loading the consult/.test(document.body.innerText), null, { timeout: 30000 }); }
  catch (e) { throw new Error("consult did not render after reload: " + JSON.stringify(await page.evaluate(() => ({ url: location.href, cline: document.querySelectorAll(".cline").length, h2: !!document.querySelector("h2"), loading: /Loading the consult/.test(document.body.textContent), len: document.body.textContent.length, head: document.body.textContent.slice(0, 60).replace(/\d/g, "9") })))); }
  await page.waitForTimeout(300);
}
const hms0 = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
function isUncl(s) { return !!s.flag && s.flag.ok === false; }

try { out.consult = await consultChecks(); } catch (e) { out.consult_error = String(e).slice(0, 300); }
try { await checkAt("phone_390", { width: 390, height: 844 }); await checkAt("desktop_1280", { width: 1280, height: 900 }); } catch (e) { out.error = String(e).slice(0, 300); }
await browser.close(); server.close();
console.log(JSON.stringify(out, null, 1));
process.exit(out.error ? 1 : 0);
