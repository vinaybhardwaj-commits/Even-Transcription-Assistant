// Real-browser check of tools/doctor-voice-check/page.html on a real batch (read-only on the page and the batch).
// Prints COUNTS AND STATES ONLY (no card text). The harness page, the copied audio and the screenshots stay in a 0700 dir on the box.
//   PW_DIR=<dir with node_modules/playwright-core> LD_LIBRARY_PATH=<libs> node voice_check_smoke.mjs <out_dir> <batch_dir> [before|after]
import http from "node:http";
import { createRequire } from "node:module";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const require = createRequire(join(process.env.PW_DIR, "/"));
const { chromium } = require("playwright-core");
const [outDir, , mode = "before"] = process.argv.slice(2);
const harness = `harness-${mode}.html`;
const MIME = { ".html": "text/html", ".mp3": "audio/mpeg", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const f = join(outDir, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, ""));
  if (!f.startsWith(outDir) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": MIME[extname(f)] ?? "application/octet-stream" }); res.end(readFileSync(f));
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const out = { mode, console_errors: [], csp_violations: [], external_requests: [], failed_requests: [], cards: {}, checks: {} };
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.addInitScript(() => { // record every Audio the page creates
  const Real = window.Audio; window.__audios = [];
  window.Audio = function (...a) { const el = new Real(...a); window.__audios.push(el); return el; };
  window.Audio.prototype = Real.prototype;
});
page.on("console", (m) => { if (m.type() === "error") out.console_errors.push(m.text().slice(0, 140)); if (/content security policy/i.test(m.text())) out.csp_violations.push(m.text().slice(0, 140)); });
page.on("pageerror", (e) => out.console_errors.push(String(e).slice(0, 140)));
page.on("request", (r) => { if (!r.url().startsWith(base) && !r.url().startsWith("blob:") && !r.url().startsWith("data:")) out.external_requests.push(r.url().slice(0, 80)); });
page.on("requestfailed", (r) => out.failed_requests.push(r.url().replace(base, "").slice(0, 60)));

const BAD = /\[object|undefined|NaN|\bnull\b/;
const LEAK = /\b(HIGH|MED|LOW)\b|\btier\b|pqm|cluster|confidence|true[_ ]doctor|batch1-key/i;
const shot = (n) => page.screenshot({ path: join(outDir, `shot-${mode}-${n}.png`), fullPage: true });
const prog = async () => (await page.textContent("#prog")).trim();
const playing = () => page.evaluate(() => { const a = window.__audios.at(-1); return a ? { src_kind: (a.src || "").startsWith("blob:") ? "blob" : "path", paused: a.paused, t: a.currentTime, err: a.error?.code ?? null, dur: a.duration } : null; });

try {
  await page.goto(`${base}/${harness}`); await page.waitForSelector("#panel .card", { timeout: 15000 });
  const total = Number((await prog()).split("/")[1].trim().split(" ")[0]);
  out.cards.total = total;

  // 1. walk every card
  const kinds = { link: 0, pair: 0 }, clipCounts = {}, evShown = { visible: 0, hidden_notice: 0, none: 0 };
  let bad = 0, leaks = 0, overflow = 0, wrongIdx = 0, badDur = 0;
  const minH = { opt: 999, pb: 999, btn: 999 };
  for (let i = 0; i < total; i++) {
    await page.waitForSelector("#panel .card");
    const txt = await page.textContent("#panel");
    const isPair = /same person\?/.test(await page.textContent("#panel .wh .tag"));
    kinds[isPair ? "pair" : "link"]++;
    if (BAD.test(txt)) bad++; if (LEAK.test(txt)) leaks++;
    if (!new RegExp(`Card ${i + 1} of ${total}`).test(txt)) wrongIdx++;
    const nClips = await page.locator("#panel .clip").count(); const key = `${isPair ? "pair" : "link"}:${nClips}`; clipCounts[key] = (clipCounts[key] ?? 0) + 1;
    if ((await page.locator("#panel .dur").allTextContents()).some((d) => !/^\d+:\d\d$/.test(d.trim()))) badDur++;
    if (!isPair) { const ev = (await page.locator("#panel .ev li").count()) > 0, hid = (await page.locator("#evhide").count()) > 0; if (ev) evShown.visible++; else if (hid) evShown.hidden_notice++; else evShown.none++; }
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) overflow++;
    for (const [k, sel] of [["opt", "#panel label.opt"], ["pb", "#panel .pb"], ["btn", "#next, #prev"]])
      for (const h of await page.locator(sel).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) minH[k] = Math.min(minH[k], Math.round(h));
    if (i === 0) await shot("card1"); if (isPair && !out.checks.pair_shot) { out.checks.pair_shot = true; await shot("pair"); }
    if (i < total - 1) await page.click("#next");
  }
  Object.assign(out.cards, { kinds, clips_per_card: clipCounts, bad_string_cards: bad, leaked_hidden_field_words: leaks, wrong_card_index: wrongIdx, bad_duration_labels: badDur, horizontal_overflow_cards: overflow, min_tap_height_px: minH, evidence: evShown });

  // 2. audio from Blob URLs on a sample (link: clip 1, contrast, play-all; pair: A and B)
  const play = { link: [], pair: [] };
  for (const [idx, kind] of [[0, "link"], [Math.floor(total / 2), "link"], [total - 2, "link"]]) {
    await page.selectOption("#jump", String(idx)).catch(() => page.evaluate((i) => document.getElementById("jump").dispatchEvent(new Event("change")), idx));
    await page.waitForTimeout(1500); // prefetch to Blob URLs
    const tag = await page.textContent("#panel .wh .tag");
    const pbs = page.locator("#panel .pb");
    for (const n of [0, (await pbs.count()) - 1]) {
      await pbs.nth(n).click(); await page.waitForFunction(() => { const a = window.__audios.at(-1); return a && !a.paused && a.currentTime > 0.2; }, null, { timeout: 8000 }).catch(() => {});
      play[/link/.test(tag) ? "link" : "pair"].push({ card: idx + 1, clip: n, ...(await playing()) }); await pbs.nth(n).click();
    }
  }
  // the pair card
  const pairIdx = await page.evaluate(() => [...document.querySelectorAll("#jump option")].findIndex((o) => /same person/.test(o.textContent)));
  if (pairIdx >= 0) { await page.selectOption("#jump", String(pairIdx)); await page.waitForTimeout(1500); const pbs = page.locator("#panel .pb");
    for (let n = 0; n < (await pbs.count()); n++) { await pbs.nth(n).click(); await page.waitForFunction(() => { const a = window.__audios.at(-1); return a && !a.paused && a.currentTime > 0.2; }, null, { timeout: 8000 }).catch(() => {}); play.pair.push({ card: pairIdx + 1, clip: n, ...(await playing()) }); await pbs.nth(n).click(); } }
  const ok = (x) => x.filter((p) => p.paused === false && p.t > 0.2 && p.err === null).length;
  out.checks.playback = { link_tried: play.link.length, link_ok: ok(play.link), pair_tried: play.pair.length, pair_ok: ok(play.pair), src_kinds: [...new Set([...play.link, ...play.pair].map((p) => p.src_kind))] };
  // play-all
  await page.selectOption("#jump", "0"); await page.waitForTimeout(1500); await page.click("#playall"); await page.waitForTimeout(2500);
  out.checks.play_all_started = (await playing())?.paused === false;

  // 3. answers, on link card 1 (fresh page state for a clean verdict record)
  await page.selectOption("#jump", "0"); await page.waitForTimeout(600);
  const id0 = null; const verdict = () => page.evaluate(() => Object.values(window.__verdicts ?? {})[0]?.v ?? {});
  const beforeEv = { li: await page.locator("#panel .ev li").count(), notice: await page.locator("#evhide").count() };
  await page.click("#panel label.opt >> nth=0"); // Agree
  await page.waitForTimeout(1200); const afterEv = { li: await page.locator("#panel .ev li").count(), notice: await page.locator("#evhide").count() };
  const v1 = Object.values(await verdict())[0] ?? {};
  out.checks.evidence_before_first_answer = { evidence_lines_visible: beforeEv.li > 0, hidden_notice_shown: beforeEv.notice > 0 };
  out.checks.evidence_after_first_answer = { evidence_lines_visible: afterEv.li > 0 };
  out.checks.first_verdict_record = { a: v1.a, a0: v1.a0, blind: v1.blind, saved: !!v1.a };
  await shot("answered");
  await page.click("#panel label.opt >> nth=1"); // Disagree
  const whoShown = (await page.locator("#whois").count()) > 0; const p1 = await prog();
  await page.selectOption("#whois", "unknown"); await page.waitForTimeout(1000); const p2 = await prog(); const v2 = Object.values(await verdict())[0] ?? {};
  out.checks.disagree_flow = { who_select_shown: whoShown, counted_before_who: p1, counted_after_who: p2, saved_who: v2.who, a0_kept: v2.a0 === "agree" };
  await page.click("#panel label.opt >> nth=2"); await page.waitForTimeout(900); const v3 = Object.values(await verdict())[0] ?? {};
  out.checks.not_sure = { a: v3.a, who_cleared: v3.who === undefined };
  await page.fill("#note", "smoke note"); await page.waitForTimeout(1000); out.checks.note_saved = (Object.values(await verdict())[0] ?? {}).note === "smoke note";
  // keyboard (desktop): 2 on the next card
  await page.click("#next"); await page.keyboard.press("2"); await page.waitForTimeout(300); out.checks.keyboard_2_selects_disagree = await page.locator("#panel input[name=a][value=disagree]").isChecked();
  // pair answers
  if (pairIdx >= 0) { await page.selectOption("#jump", String(pairIdx)); await page.waitForTimeout(400);
    out.checks.pair_radios = await page.locator("#panel input[name=a]").count();
    await page.click("#panel label.opt >> nth=0"); await page.waitForTimeout(900);
    const pv = (await verdict()); const pid = Object.keys(pv).at(-1); out.checks.pair_answer = { a: pv[pid]?.a, counted: await prog() }; }
  // results tab (owner)
  await page.click("#tab-res"); await page.waitForTimeout(800); const rt = await page.textContent("#view-res");
  out.checks.results_tab = { rows: await page.locator("#view-res tr").count(), bad_strings: BAD.test(rt) };
  await shot("results");
} catch (e) { out.error = String(e).slice(0, 300); }
await browser.close(); server.close();
console.log(JSON.stringify(out, null, 1));
process.exit(out.error ? 1 : 0);
