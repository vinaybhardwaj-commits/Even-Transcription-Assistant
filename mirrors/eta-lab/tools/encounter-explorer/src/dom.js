// DOM helpers shared by the page (ui.js) and the layer registry (layers.js). Data reaches the DOM only as text nodes (textContent); markup is never built from strings.
import { STAGES } from "./types.js";
import { istTimeOf } from "./util.js";

export const clock = ms => istTimeOf(ms) || null;

export const GLYPH = { done: "✓", failed: "✗", pending: "…", missing: "–", na: "?" };
export const STATE_WORD = { done: "done", failed: "failed", pending: "pending", missing: "missing", na: "not available yet" };

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "css") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val));
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "hidden") el.hidden = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) { if (c === null || c === undefined || c === false) continue; el.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return el;
}

export const fmtLen = s => (s === null || s === undefined ? "–" : Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"));
export const fmtClock = s => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
export const mb = n => (n / 1048576).toFixed(1);
export const jsonText = v => (v === null || v === undefined ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Text with **bold** segments, as text nodes and <b> elements (never markup from a string). */
export function richText(s) {
  return String(s).split("**").map((part, i) => (i % 2 ? h("b", { text: part }) : part));
}

/** The designed "not available yet" block. */
export function na(title, body, kind) {
  return h("div", { class: "na" + (kind === "error" ? " err" : ""), role: kind === "error" ? "alert" : null }, h("span", { class: "dot" }), h("div", {}, h("b", { text: title }), body ? h("span", {}, richText(body)) : null));
}

export function chip(stage, info) {
  const state = STATE_WORD[info && info.state] ? info.state : "na", reason = info && info.reason;
  return h("span", { class: "chip s-" + state, title: stage + ": " + STATE_WORD[state] + (reason ? " (" + reason + ")" : "") }, h("span", { "aria-hidden": "true", text: GLYPH[state] }), stage, h("span", { class: "sr", text: " " + STATE_WORD[state] }));
}
/** One chip per stage in the stages map, canonical stages first (a stage the source cannot tell shows as not available yet). */
export function chips(stages) {
  const keys = [...STAGES, ...Object.keys(stages || {}).filter(k => !STAGES.includes(k))];
  return h("span", { class: "chips" }, keys.map(k => chip(k, stages && stages[k])));
}
/** "stt:reason" -> readable line */
export function gapLine(gap) { return gap ? "First gap: " + gap.replace(":", " — ") : null; }

/** An enum token (a code, a band, a model id): code-style, never a sentence. */
export const tok = (v, extra) => h("code", { class: "tok" + (extra ? " " + extra : "") }, v === null || v === undefined || v === "" ? "—" : String(v));
/** The mockup-only badge on data drawn from a draft shape. */
export const mockBadge = () => h("span", { class: "chip s-pending mock-badge", text: "mock · draft shape v0" });
/** Where a row came from. */
export const srcBadge = text => h("span", { class: "chip s-missing src-badge", text: text });

/** Slot states: present | missing (+ a reason token) | notbuilt ("not yet built"). */
export const SLOT_STATES = ["present", "missing", "notbuilt"];
export function slotChip(state, reason) {
  if (state === "present") return h("span", { class: "chip s-done slot-chip", "data-state": "present" }, h("span", { "aria-hidden": "true", text: "✓" }), "present");
  if (state === "notbuilt") return h("span", { class: "chip s-na slot-chip", "data-state": "notbuilt" }, "not yet built");
  return h("span", { class: "chip s-missing slot-chip", "data-state": "missing" }, "missing", reason ? [" ", tok(reason)] : null);
}
