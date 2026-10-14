/**
 * Self-declared author name for governed changes (PRD §12.4, decision 16 — V, 28 Jul 2026).
 *
 * ⚠️ THIS IS AN ATTESTATION, NOT AUTHENTICATION. CDMSS admin access is a shared token with no user
 * identity attached, so a name typed into a box is not proof of who typed it. It is still worth
 * capturing: it turns an anonymous log into an accountable one, and it is what a governance record
 * needs to be readable six months later. Every label that renders this must say so — never "Verified
 * by", never "Signed by" (§12.4).
 *
 * ⚠️ NO PREFILL, ANYWHERE (decision 17, V, 28 Jul — reverses the localStorage prefill shipped in
 * §12.4). The name is typed on every publish and every review note: no localStorage, no
 * sessionStorage, no default, no "last used" hint. On a shared browser a remembered name offers the
 * LAST person's name to the NEXT one, so someone publishes without re-reading the field and the
 * governance log confidently names the wrong person. A WRONG NAME IS WORSE THAN NO NAME — it reads
 * as authoritative and gets relied on, which defeats the entire reason Phase D exists. V accepted
 * the friction knowingly, over both the persistent and the session-scoped option.
 *
 * That is why this module exports no storage helper. If you are about to add one, read decision 17.
 *
 * No imports, no server dependencies — safe in any client component.
 */

/** Minimum length after trimming, enforced in the UI and again server-side. */
export const MIN_ATTRIBUTION_CHARS = 2;

/** Persist verbatim after trimming — no normalisation, no title-casing, no roster match. */
export const MAX_ATTRIBUTION_CHARS = 200;

/** The honest label and helper text, defined once so all three fields read identically (§12.4). */
export const ATTRIBUTION_LABEL = 'Your name';
export const ATTRIBUTION_HELP =
  'Recorded with this change. Self-declared — CDMSS admin access is a shared token.';

/** True when a candidate name is acceptable. Pure and total. */
export function isValidAttribution(name: unknown): boolean {
  return typeof name === 'string' && name.trim().length >= MIN_ATTRIBUTION_CHARS;
}

/**
 * Normalise for storage: trim and cap. Deliberately does NOT change case or spelling —
 * "Dr Binita Priyambada" and "binita" are both acceptable input; the point is a human-readable
 * record, not a foreign key.
 */
export function cleanAttribution(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const v = name.trim().slice(0, MAX_ATTRIBUTION_CHARS);
  return v.length >= MIN_ATTRIBUTION_CHARS ? v : null;
}

/** The server-side rejection message, shared by all three routes so the wording cannot drift. */
export const ATTRIBUTION_REQUIRED_ERROR =
  'Your name is required — it is recorded with this change. (Self-declared; admin access is a shared token.)';
