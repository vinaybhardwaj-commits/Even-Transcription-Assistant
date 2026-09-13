/**
 * lib/clinician-mint.ts — how a clinician's id and PIN are minted. ONE place.
 *
 * Lifted verbatim out of app/api/admin/doctors/route.ts, which now imports it, so the curated
 * voiceprint loader (app/api/admin/voiceprints/load) mints clinicians with the app's own functions
 * rather than a copy that could drift. The id alphabet deliberately omits the characters that read
 * ambiguously in a URL (i, l, o, 0, 1).
 *
 * NOT unified with app/api/admin/bootstrap/route.ts, which mints `doc_` ids from a different
 * alphabet (the full a-z0-9). That route is a one-time first-admin bootstrap and changing it is
 * outside this change; the divergence is recorded rather than silently resolved.
 */
import { randomInt } from "crypto";
import { customAlphabet } from "nanoid";

const idTail = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 8);

/** `doc_` + 8 unambiguous characters — the admin create path's format. */
export function mintClinicianId(): string {
  return `doc_${idTail()}`;
}

/** A 4-digit PIN from a crypto-strong source (B19 P2). */
export function generatePin(): string {
  const n = randomInt(0, 10_000);
  return String(n).padStart(4, "0");
}
