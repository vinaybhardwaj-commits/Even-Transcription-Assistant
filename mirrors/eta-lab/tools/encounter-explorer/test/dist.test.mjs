import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPage, CAPABILITIES, CAPABILITIES_CURRENT, CAPABILITIES_MOCKUP, TOOLS_TXT } from "../build.mjs";
import { TOOLS } from "../src/adapter-current.js";
import { CATALOG_ACTIONS, CATALOG_TOOLS } from "../src/adapter-catalog.js";
import { scanText } from "../scripts/check-no-real-data.mjs";

const page = buildPage("catalog");   // the live page
const mock = buildPage("mockup");
const cur = buildPage("current");     // the older current-tools page, not handed over
const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

function stripBlocks(src, startRe) {   // removes balanced { } blocks whose selector matches startRe
  let out = "", i = 0;
  while (i < src.length) {
    const rest = src.slice(i), m = startRe.exec(rest);
    if (!m) { out += rest; break; }
    out += rest.slice(0, m.index);
    let j = i + m.index + m[0].length - 1, depth = 0;
    for (; j < src.length; j++) { if (src[j] === "{") depth++; else if (src[j] === "}" && --depth === 0) break; }
    i = j + 1;
  }
  return out;
}

test("page contract: starts with title + viewport meta, no document tags, no external requests", () => {
  assert.ok(page.startsWith('<title>Encounter Explorer</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>'));
  for (const bad of [/<!doctype/i, /<html/i, /<head/i, /<body/i]) assert.doesNotMatch(page, bad);
  assert.doesNotMatch(page, /https?:\/\/(?!pulse\.even\.in)/);
  for (const bad of [/\bfetch\s*\(/, /XMLHttpRequest/, /\balert\s*\(/, /\bconfirm\s*\(/, /\bprompt\s*\(/, /window\.print/, /\bdownload\b/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/])
    assert.doesNotMatch(page.replace(/<style>[\s\S]*?<\/style>/, ""), bad, String(bad));
});

test("capabilities only through claude.use, never window.claude.<cap>", () => {
  assert.doesNotMatch(page, /window\.claude\.(db|mcp|sample|user)\b/);
  assert.match(page, /window\.claude\.use\(/);
});

test("tokens: light on :root, dark twice, body has a token background, no literal colours in components", () => {
  assert.match(css, /^:root\{/m);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\{\s*:root:not\(\[data-theme="light"\]\)\{[^}]*color-scheme:dark/);
  assert.match(css, /:root\[data-theme="dark"\]\{/);
  assert.match(css, /body\{[^}]*background:var\(--bg\)/);
  const comp = stripBlocks(stripBlocks(css, /@media \(prefers-color-scheme: dark\)\s*\{/), /:root(\[data-theme="dark"\])?\s*\{/);
  assert.doesNotMatch(comp, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
});

test("phone rules: safe-area gutters, tabular numbers, focus-visible, reduced motion", () => {
  assert.match(css, /padding:12px max\(16px,env\(safe-area-inset-right,0px\)\) 72px max\(16px,env\(safe-area-inset-left,0px\)\)/);
  assert.match(css, /font-variant-numeric:tabular-nums/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test("capability manifest names exactly the tools the code calls", () => {
  const called = new Set([...readFileSync(new URL("../src/adapter-current.js", import.meta.url), "utf8").matchAll(/call\("(scribe_[a-z_]+)"/g)].map(m => m[1]));
  assert.deepEqual([...called].sort(), [...TOOLS].sort());
  assert.deepEqual(CAPABILITIES_CURRENT, { mcp: { servers: [{ server: "Scribe MCP", tools: TOOLS }] }, sample: {}, db: {}, user: { scopes: ["profile"] } });
  for (const t of TOOLS) assert.match(t, /^scribe_[a-z_]+$/);
});

test("both built pages are free of real-looking ids", () => {
  assert.deepEqual(scanText(page), []);
  assert.deepEqual(scanText(mock), []);
});

test("mockup page: same contract, under 2 MB, declares sample/db/user only, banner present", () => {
  assert.ok(mock.startsWith('<title>Encounter Explorer</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>'));
  for (const bad of [/<!doctype/i, /<html/i, /<head/i, /<body/i, /innerHTML/, /\bfetch\s*\(/]) assert.doesNotMatch(mock.replace(/const FIXTURE_DATA = [\s\S]*?\n/, ""), bad, String(bad));
  assert.ok(Buffer.byteLength(mock) < 2 * 1024 * 1024, "size " + Buffer.byteLength(mock));
  assert.deepEqual(CAPABILITIES_MOCKUP, { sample: {}, db: {}, user: { scopes: ["profile"] } });
  assert.match(mock, /const ADAPTER = "mockup"/);
  assert.match(mock, /Mockup: synthetic data/);
  assert.match(page, /const ADAPTER = "catalog"/);
  assert.match(page, /const FIXTURE_DATA = null/);
  assert.ok(Buffer.byteLength(page) < 200 * 1024, "live page carries no dataset");
});

test("the build writes pages equal to the in-memory build (dist is not committed: build it here)", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../build.mjs", import.meta.url))]);
  const d = f => readFileSync(new URL("../dist/" + f, import.meta.url), "utf8");
  assert.equal(d("encounter-explorer.html"), page);
  assert.equal(d("encounter-explorer-mockup.html"), mock);
  assert.equal(d("encounter-explorer-current.html"), cur);
  assert.equal(d("capabilities.current.json"), JSON.stringify(CAPABILITIES_CURRENT) + "\n");
  assert.equal(d("TOOLS.current.txt"), TOOLS.join("\n") + "\n");
  assert.equal(d("capabilities.json"), JSON.stringify(CAPABILITIES) + "\n");
  assert.equal(d("capabilities.mockup.json"), JSON.stringify(CAPABILITIES_MOCKUP) + "\n");
  assert.equal(d("TOOLS.txt"), TOOLS_TXT);
});

test("the real-data scanner flags what it should (strings built at runtime so this file stays clean)", () => {
  assert.deepEqual(scanText("id " + "a".repeat(26)), ["26-char base32 consult uid"]);
  assert.deepEqual(scanText("room_" + "ab12cd34"), ["room_ id other than room_syn*"]);
  assert.deepEqual(scanText("room_syn01 room_id room_slug"), []);
  assert.deepEqual(scanText("doc_" + "abcdef12 enc_" + "abcdef12"), ["doc_/enc_ id not prefixed syn"]);
  assert.deepEqual(scanText("call " + "9".repeat(10)), ["10+ digit run"]);
  assert.deepEqual(scanText("call " + "9".repeat(12)), ["10+ digit run"]);
  assert.deepEqual(scanText("t " + "1788926400000"), []);
  assert.deepEqual(scanText("mail x" + "@" + "y.example"), ["email address"]);
  assert.deepEqual(scanText("doc_syn_1 enc_syn_2 syn_c001"), []);
});

test("every build parses as one script (module-level names must not collide across the concatenated sources)", () => {
  for (const [name, html] of [["live", page], ["current", cur], ["mockup", mock]]) {
    const m = html.match(/<script>([\s\S]*)<\/script>/);
    assert.ok(m, name);
    assert.doesNotThrow(() => new Function(m[1]), name);
  }
});

test("live page is the catalog page: ONE tool, only search/get/clip_audio_chunk, no dataset, no URL path for audio", () => {
  assert.ok(page.startsWith('<title>Encounter Explorer</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>'));
  for (const bad of [/<!doctype/i, /<html/i, /<head/i, /<body/i, /innerHTML/, /\bfetch\s*\(/, /\balert\s*\(/]) assert.doesNotMatch(page, bad, String(bad));
  assert.match(page, /const ADAPTER = "catalog"/);
  assert.match(page, /const FIXTURE_DATA = null/);
  assert.deepEqual(CAPABILITIES, { mcp: { servers: [{ server: "Scribe MCP", tools: ["scribe_catalog"] }] }, sample: {}, db: {}, user: { scopes: ["profile"] } });
  assert.equal(TOOLS_TXT, "scribe_catalog search\nscribe_catalog get\nscribe_catalog clip_audio_chunk\n");
  const src = readFileSync(new URL("../src/adapter-catalog.js", import.meta.url), "utf8");
  assert.deepEqual([...new Set([...src.matchAll(/call\((TOOL|"[a-z_]+")/g)].map(m => m[1]))], ["TOOL"]);
  assert.match(src, /const TOOL = "scribe_catalog"/);
  const acts = [...new Set([...src.matchAll(/action: "([a-z_]+)"/g)].map(m => m[1]))].sort();
  assert.deepEqual(acts, [...CATALOG_ACTIONS].sort(), "every action the code names is declared, and none other");
  assert.doesNotMatch(src, /action: "clip_audio_url"/);
  assert.deepEqual(CATALOG_TOOLS, ["scribe_catalog"]);
  assert.deepEqual(scanText(page), []);
});

test("audio is never played from a URL the tool hands out: no <audio src> from tool data, only Blob object URLs", () => {
  const ui = readFileSync(new URL("../src/ui.js", import.meta.url), "utf8");
  assert.match(ui, /URL\.createObjectURL\(r\.data\.blob\)/);
  assert.doesNotMatch(ui, /expires_?At|refreshAudio|clip_audio_url/);
  for (const html of [page, cur, mock]) assert.doesNotMatch(html, /clip_audio_url/);
});
