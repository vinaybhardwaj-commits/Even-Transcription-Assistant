// Catalog C4: the admin-only columns (jev sets, clef/timbre affect, presence). Everything in it is OPTIONAL (C4M-2):
//   - the `catalog_c4` key is ABSENT for a non-admin caller (that is not an error),
//   - a key's value can be null,
//   - a failed read is c4_error:true on a search row, or layers.catalog_c4.status "error" on get.
// Values are guarded on the way in (objects, bounded arrays, finite numbers, short strings) and rendered as tokens, never as sentences. No DOM.
import { isObj, num, str } from "./util.js";

const C4_KEY = /^[A-Za-z0-9_.:+@-]{1,60}$/;
const C4_HEX64 = /^[0-9a-fA-F]{64}$/;       // a sha256 digest is the one string allowed past 60 characters
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const C4_TOKEN = /^[A-Za-z0-9_.:+@-]{1,60}$/;
export const c4Token = v => (typeof v === "string" && C4_TOKEN.test(v) ? v : null);

/** Keep plain objects, arrays (at most 200 items), booleans, finite numbers, null and strings up to 60 characters (64-hex digests too); drop everything else. */
export function guardC4(v, depth = 0) {
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") return v.length <= 60 || C4_HEX64.test(v) ? v : undefined;
  if (depth >= 6) return undefined;
  if (Array.isArray(v)) return v.slice(0, 200).map(x => guardC4(x, depth + 1)).filter(x => x !== undefined);
  if (isObj(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) { if (!C4_KEY.test(k) || BAD_KEYS.has(k)) continue; const g = guardC4(x, depth + 1); if (g !== undefined) o[k] = g; }
    return o;
  }
  return undefined;
}

/** The C4 state of a consult. state: "absent" (no key: needs an admin key) | "error" | "null" (key there, nothing stored) | "ok". */
export function c4Of({ layer, row }) {
  if (isObj(layer)) {
    if (layer.status === "error") return { state: "error", code: c4Token(layer.error) || c4Token(layer.code) || "c4_error", data: null };
    if (layer.status === "ok") return isObj(layer.data) ? { state: "ok", code: null, data: guardC4(layer.data) } : { state: "null", code: null, data: null };
    if (layer.status === "absent" || layer.status === "not_available") return { state: "null", code: null, data: null };
    return { state: "error", code: "unknown_status", data: null };
  }
  if (isObj(row) && row.catalog_c4 !== undefined) return isObj(row.catalog_c4) ? { state: "ok", code: null, data: guardC4(row.catalog_c4) } : { state: "null", code: null, data: null };
  if (isObj(row) && row.c4_error === true) return { state: "error", code: "c4_error", data: null };
  return { state: "absent", code: null, data: null };
}

const isoOf = v => (typeof v === "string" && v ? v : num(v) !== null ? new Date(v).toISOString() : null);
function c4SetRow(x) {
  if (!isObj(x)) return null;
  const st = str(x.state);
  return { set_id: c4Token(x.set_id), set_sha: typeof x.set_sha === "string" ? x.set_sha : null, band: c4Token(x.band), label: c4Token(x.label), model: c4Token(x.model), at: isoOf(x.at), state: st === "current" || st === "retired" ? st : null };
}
/** The list of jev set rows inside a value, or null when it is not one of the accepted shapes: [..] | {sets:[..]} | {sets:{sets:[..]}}. */
export function jevSetsIn(v) {
  const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.sets) ? v.sets : isObj(v) && isObj(v.sets) && Array.isArray(v.sets.sets) ? v.sets.sets : null;
  return list === null ? null : list.map(c4SetRow).filter(Boolean);
}

/** Clef/timbre affect: {lanes:[{lane, scores:{token:number}, model_rev, at}]} -> [{lane, scores:[[token, n]], model_rev, at}], or null for a bad shape. */
export function clefLanesIn(v) {
  if (!isObj(v) || !Array.isArray(v.lanes)) return null;
  return v.lanes.filter(isObj).map(l => ({
    lane: c4Token(l.lane), model_rev: c4Token(l.model_rev), at: isoOf(l.at),
    scores: isObj(l.scores) ? Object.entries(l.scores).filter(([k, x]) => C4_TOKEN.test(k) && num(x) !== null) : [],
  }));
}

/** Presence: {encounter_open, encounter_close (UTC ms or null), boundary_source, close_reason (tokens; boundary_source may contain "+")}. null for a bad shape. */
export function presenceIn(v) {
  if (!isObj(v)) return null;
  return { encounter_open: num(v.encounter_open), encounter_close: num(v.encounter_close), boundary_source: c4Token(v.boundary_source), close_reason: c4Token(v.close_reason) };
}
