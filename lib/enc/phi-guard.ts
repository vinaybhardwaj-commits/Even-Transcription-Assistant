/**
 * lib/enc/phi-guard.ts — the write-side guard for the steward's prose (body_md, title, result text).
 * The steward writes ids and counts only. Reject long digit runs, emails and phone-shaped numbers.
 * Same intent as tools/eta2freescript phi_guard (box side); this is the server-side second check. Pure.
 *
 * Tokens that mix letters and digits (uuids, consult uids, room ids) are removed before the digit checks,
 * so ids pass. A bare run of 7 or more digits (spaces, dots and dashes between digits ignored) is refused.
 */
export type PhiHit = "email" | "phone" | "digit_run";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const MIXED_ID = /\b(?=[A-Za-z0-9_]*[A-Za-z])(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{6,}\b/g;
const IST_DATE_TOKEN = /\b\d{4}-\d{2}-\d{2}\b/g;
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,5}\)?[\s.-]?)?\d{3,5}[\s.-]\d{3,5}(?!\d)/;

export function phiHits(text: string): PhiHit[] {
  const hits: PhiHit[] = [];
  if (EMAIL.test(text)) hits.push("email");
  const t = text.replace(UUID, " ").replace(IST_DATE_TOKEN, " ").replace(MIXED_ID, " ");
  const compact = t.replace(/(?<=\d)[\s.-](?=\d)/g, "");
  const phoneShaped = /\+\d{8,}/.test(t) || /(?<!\d)\d{10,}(?!\d)/.test(compact) || (PHONE.test(t) && /\d{7,}/.test(compact));
  if (phoneShaped) hits.push("phone");
  else if (/\d{7,}/.test(compact)) hits.push("digit_run");
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
