// Deep links. The artifact viewer passes only a plain #anchor (letters, digits, . _ ~ -), so a link is ONE bare token, never key=value.
//   #c-<consult_uid>              a consult
//   #d-<hex of doctor_uid>~<date> a doctor-day (hex: the id may contain : or @)
//   #p-<hex of individual_uid>    a patient (admin lookup)
//   #layer-N                      an in-page jump (not a route)
// Pure: no DOM, no state. scribe-mcp mirrors explorerAnchor in scribe_catalog action=explorer_link.
import { MIN_DATE } from "./types.js";
import { isDate } from "./util.js";

const CONSULT = /^[A-Za-z0-9_-]{6,64}$/;
const PLAIN_ID = /^[\x21-\x7e]{1,128}$/;   // printable ASCII, no spaces: a doctor or individual id once decoded

export function hexOf(s) {
  if (typeof s !== "string" || !s) return null;
  return [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function unhex(h) {
  if (typeof h !== "string" || !/^(?:[0-9a-fA-F]{2}){1,256}$/.test(h)) return null;
  try {
    const bytes = Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
    const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return PLAIN_ID.test(s) ? s : null;
  } catch { return null; }
}

/** {consult_uid} | {doctor_uid, date} | {individual_uid} -> "#token", or null when the input cannot make a valid link. */
export function explorerAnchor(a) {
  if (a === null || typeof a !== "object") return null;
  if (typeof a.consult_uid === "string") return CONSULT.test(a.consult_uid) ? "#c-" + a.consult_uid : null;
  // a date before the data floor is clamped to it; an invalid date makes no link
  if (typeof a.doctor_uid === "string") return PLAIN_ID.test(a.doctor_uid) && isDate(a.date) ? "#d-" + hexOf(a.doctor_uid) + "~" + (a.date < MIN_DATE ? MIN_DATE : a.date) : null;
  if (typeof a.individual_uid === "string") return PLAIN_ID.test(a.individual_uid) ? "#p-" + hexOf(a.individual_uid) : null;
  return null;
}

/** The text after "#" -> a route. Never throws. kind "unknown" for anything that does not parse. */
export function parseAnchor(token) {
  const t = typeof token === "string" ? token : "";
  if (t === "") return { kind: "overview" };
  if (t === "overview" || t === "list" || t === "detail") return { kind: t };
  let m;
  if ((m = /^layer-(\d{1,2})$/.exec(t))) return { kind: "layer", n: Number(m[1]) };
  if ((m = /^c-(.+)$/.exec(t))) return CONSULT.test(m[1]) ? { kind: "consult", consult_uid: m[1] } : { kind: "unknown" };
  if ((m = /^d-([0-9a-fA-F]+)~(\d{4}-\d{2}-\d{2})$/.exec(t))) {
    const id = unhex(m[1]);
    return id !== null && isDate(m[2]) && m[2] >= MIN_DATE ? { kind: "doctor", doctor_uid: id, date: m[2] } : { kind: "unknown" };
  }
  if ((m = /^p-([0-9a-fA-F]+)$/.exec(t))) {
    const id = unhex(m[1]);
    return id !== null ? { kind: "patient", individual_uid: id } : { kind: "unknown" };
  }
  return { kind: "unknown" };
}
