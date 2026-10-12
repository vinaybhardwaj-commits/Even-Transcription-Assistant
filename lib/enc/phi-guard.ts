/**
 * lib/enc/phi-guard.ts — the write-side guard for the steward's prose (body_md, title, result text).
 * The steward writes ids and counts only. Same intent as tools/eta2freescript phi_guard (box side); this is the server-side second check. Pure.
 *
 * Exempt: uuids and IST dates only.
 * Refused: emails; "phone"/"mob"/"mobile" before digits; uhid/mrn/ip-number keywords before digits; a letter prefix glued to 6 or more digits
 * (EH12345678); 7 or more consecutive digits in ANY token, letters attached or not; and spaced or dashed digit groups that read as a phone number.
 * Names cannot be caught by a regex; the box-side guard carries that.
 */
export type PhiHit = "email" | "phone" | "digit_run";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const IST_DATE_TOKEN = /\b\d{4}-\d{2}-\d{2}\b/g;
const PHONE_WORD = /(?:phone|mob(?:ile)?)\W{0,4}\d/i;
const ID_WORD = /(?:uhid|mrn|ip\s?no|ip\s?number|reg\s?no)\W{0,4}[A-Za-z]{0,4}\d{4,}/i;
const LETTER_PREFIX_DIGITS = /[A-Za-z]{1,6}[-/]?\d{6,}/;
const SEPARATED_NUMBER = /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]\d{3,5}(?!\d)/;

export function phiHits(text: string): PhiHit[] {
  const hits: PhiHit[] = [];
  if (EMAIL.test(text)) hits.push("email");
  if (PHONE_WORD.test(text)) hits.push("phone");
  const t = text.replace(UUID, " ").replace(IST_DATE_TOKEN, " ");
  const joined = t.replace(/(?<=\d)[\s.-](?=\d)/g, "");
  if (!hits.includes("phone") && (/\+\d{8,}/.test(t) || /(?<!\d)\d{10,}(?!\d)/.test(joined) || (SEPARATED_NUMBER.test(t) && /\d{7,}/.test(joined)))) hits.push("phone");
  if (ID_WORD.test(t) || LETTER_PREFIX_DIGITS.test(t) || /\d{7,}/.test(joined)) {
    if (!hits.includes("phone")) hits.push("digit_run");
  }
  return hits;
}

/** Returns the first hit, or null when the text is clean. */
export function phiGuard(text: string): PhiHit | null {
  return phiHits(text)[0] ?? null;
}

/** Walks a JSON value and checks every string in it. */
export function phiGuardJson(v: unknown): PhiHit | null {
  if (typeof v === "string") return phiGuard(v);
  if (Array.isArray(v)) {
    for (const x of v) { const h = phiGuardJson(x); if (h) return h; }
    return null;
  }
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) { const h = phiGuardJson(x); if (h) return h; }
  }
  return null;
}
