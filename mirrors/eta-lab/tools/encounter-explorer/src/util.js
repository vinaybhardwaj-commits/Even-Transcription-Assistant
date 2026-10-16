// Small pure helpers shared by adapters. No DOM.
import { MIN_DATE } from "./types.js";

export const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
export const str = v => (typeof v === "string" && v !== "" ? v : null);
export const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const arr = v => (Array.isArray(v) ? v : []);
export const get = (o, ...path) => { let c = o; for (const k of path) { if (c === null || c === undefined) return null; c = c[k]; } return c === undefined ? null : c; };

export const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

/** Clamp a range to the floor. Returns null when nothing is left. */
export function clampRange(from, to) {
  let f = isDate(from) ? from : MIN_DATE;
  let t = isDate(to) ? to : f;
  if (f < MIN_DATE) f = MIN_DATE;
  if (t < f) return null;
  return { from: f, to: t };
}

export function datesBetween(from, to, max = 92) {
  const out = [];
  let d = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (d <= end && out.length < max) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
  return out;
}

const IST_MS = 5.5 * 3600 * 1000;
export function istDateOf(ms) { return new Date(ms + IST_MS).toISOString().slice(0, 10); }
export function istTimeOf(ms) { const d = typeof ms === "number" ? new Date(ms + IST_MS) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(11, 16) : null; }
/** t0_ms may be epoch ms or an offset from IST midnight of the row's date; the offset reading is an assumption. */
export function toEpochMs(v, istDate) {
  const n = num(v); if (n === null || n < 0) return null;
  const day0 = isDate(istDate) ? Date.parse(istDate + "T00:00:00Z") - IST_MS : null;
  const ms = n > 1e11 ? n : day0 === null ? null : day0 + n;
  // a time that is not on the row's own IST day (give or take one) is garbage, not a time
  if (ms === null || !Number.isFinite(ms) || Math.abs(ms) > 8.6e15) return null;
  if (day0 !== null && Math.abs(ms - day0) > 2 * 86400000) return null;
  return ms;
}

const DONE = new Set(["ok", "done", "complete", "completed", "success", "succeeded", "passed", "pass"]);
const FAILED = new Set(["failed", "fail", "error", "errored"]);
export function stateOfStatus(s) {
  if (typeof s !== "string") return "pending";
  const k = s.toLowerCase();
  if (DONE.has(k)) return "done";
  if (FAILED.has(k)) return "failed";
  return "pending";
}

/** Overview shade, 5 steps from grey (mostly clipped only) to the darkest accent (transcribed, scored, Rx linked). Steps are spaced for doctor-day averages, which rarely fall below a quarter. */
export const SHADE_LABELS = ["under 35%", "35-55%", "55-70%", "70-85%", "85% and up"];
export function shadeLevel(c) { return !(c >= 0.35) ? 0 : c < 0.55 ? 1 : c < 0.7 ? 2 : c < 0.85 ? 3 : 4; }
/** ISO timestamp -> "YYYY-MM-DD HH:MM:SS" in IST; the input back if it is not a time. */
export function istStamp(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? iso : new Date(t + IST_MS).toISOString().slice(0, 19).replace("T", " ");
}

export const STAGE_ORDER = ["stt", "diar", "freescript", "validator", "rubrics", "jev", "cdmss", "rx"];
/** stages is {<stage>: {state, reason}}. State of one stage, "na" when the source cannot tell. */
export const stageState = (stages, k) => (stages && stages[k] && typeof stages[k].state === "string" ? stages[k].state : "na");
/** Share of known stage chips that are done. */
export function completeness(stages) {
  const known = Object.keys(stages || {}).map(k => stageState(stages, k)).filter(s => s !== "na");
  if (!known.length) return 0;
  return known.filter(s => s === "done").length / known.length;
}
/** "stage:reason" for the first stage (in pipeline order) that is not done and not unknown; null when none. */
export function firstGap(stages) {
  const keys = [...STAGE_ORDER.filter(k => stages && k in stages), ...Object.keys(stages || {}).filter(k => !STAGE_ORDER.includes(k))];
  for (const k of keys) { const st = stageState(stages, k); if (st !== "done" && st !== "na") return k + ":" + ((stages[k] && stages[k].reason) || st); }
  return null;
}
/** Grouping key for a doctor: the catalog doctor_uid, else the room (the live tools carry no doctor for some consults). */
export const docKey = c => c.doctor_uid || "room:" + (c.room_id || "unknown");
export const hasRx = c => c.has_prescription === true || !!(c.prescription_uid || (c.prescription && c.prescription.prescription_uid));

/** The part of "<uid>@<machine>" before the "@". */
export function uidOfUnitKey(k) { return typeof k === "string" ? k.split("@")[0] : null; }

/** Three states: "yes", "no", or "unknown" (the catalog has not joined prescription data for this consult: has_prescription null and no id). Never "no" for unknown. */
export const rxState = c => (hasRx(c) ? "yes" : c.has_prescription === null ? "unknown" : "no");

/** The reason token of the sealed stage (e.g. final_no_session), or null: why a consult has no clip. */
export const sealedReason = c => { const r = c && c.stages && c.stages.sealed && c.stages.sealed.reason; return typeof r === "string" && /^[A-Za-z0-9_.:-]{1,60}$/.test(r) ? r : null; };
