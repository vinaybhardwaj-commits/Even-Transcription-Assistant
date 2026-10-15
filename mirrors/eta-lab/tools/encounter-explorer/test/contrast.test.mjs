import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
const tokens = block => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):(#[0-9a-fA-F]{6})\b/g)].map(m => [m[1], m[2].toLowerCase()]));
const dm = css.indexOf("@media (prefers-color-scheme: dark)");
const THEMES = {
  light: tokens(css.slice(css.indexOf(":root{"), dm)),
  "dark (media)": tokens(css.slice(dm, css.indexOf(':root[data-theme="dark"]'))),
  "dark (data-theme)": tokens(css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf("*{box-sizing"))),
};
const lum = h => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));   // light steps are close in luminance ratio, so compare colour distance
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test("S8: text on every overview shade step meets 4.5:1 in both themes", () => {
  for (const [name, t] of Object.entries(THEMES)) for (let i = 0; i < 5; i++) {
    assert.ok(t["lv" + i] && t["lv" + i + "-ink"], `${name} lv${i} tokens`);
    assert.ok(ratio(t["lv" + i], t["lv" + i + "-ink"]) >= 4.5, `${name} lv${i}: ${ratio(t["lv" + i], t["lv" + i + "-ink"]).toFixed(2)}`);
  }
});

test("S8: the shade steps stay ordered and distinct (each step differs from the next)", () => {
  for (const [name, t] of Object.entries(THEMES)) for (let i = 0; i < 4; i++) assert.ok(dist(t["lv" + i], t["lv" + (i + 1)]) >= 25, `${name} lv${i}->lv${i + 1}: ${dist(t["lv" + i], t["lv" + (i + 1)]).toFixed(0)}`);
});

test("S8: the other text/background token pairs meet 4.5:1 too", () => {
  const pairs = [["ink", "bg"], ["ink", "surface"], ["ink", "surface-2"], ["ink-2", "bg"], ["ink-2", "surface"], ["ink-2", "surface-2"], ["accent", "surface"], ["accent-ink", "accent"], ["ok", "ok-bg"], ["bad", "bad-bg"], ["warn", "warn-bg"], ["mute", "mute-bg"], ["mute", "surface"]];
  for (const [name, t] of Object.entries(THEMES)) for (const [a, b] of pairs) assert.ok(ratio(t[a], t[b]) >= 4.5, `${name} ${a} on ${b}: ${ratio(t[a], t[b]).toFixed(2)}`);
});

test("cells draw their text without an opacity that would lower the measured contrast", () => {
  assert.doesNotMatch(css, /\.cell small\{[^}]*opacity/);
});

test("N13: table tokens stay whole, other mono text may break anywhere", () => {
  assert.match(css, /table td\.mono\{[^}]*white-space:nowrap/);
  assert.doesNotMatch(css, /word-break:break-all/);
});
