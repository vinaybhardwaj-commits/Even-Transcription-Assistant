/**
 * lib/doctor-slug.ts — generate doctor URL slugs + tokens per PRD §4.14.
 *
 * Format: dr-{firstname}-{lastname}-{4-char-token}
 *
 * Token alphabet: 32 URL-safe chars excluding ambiguous 0/O/l/1/I:
 *   abcdefghjkmnpqrstuvwxyz23456789 (~20 bits entropy, ~1M combinations).
 *
 * Slug is stable across the doctor's lifetime. Token is rotatable
 * (admin can regen if compromise is suspected).
 */

import { randomBytes } from "crypto";

const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function generateToken(length = 4): string {
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < length; i++) {
    const ch = TOKEN_ALPHABET[bytes[i]! % TOKEN_ALPHABET.length];
    if (ch) out += ch;
  }
  return out;
}

export function slugifyName(fullName: string): string {
  // Lowercase, ASCII-normalize, replace non-alphanumeric with hyphen, collapse
  return (
    "dr-" +
    fullName
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // drop diacritics
      .toLowerCase()
      .replace(/dr\.?\s+/g, "") // strip leading title
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
  );
}

export function buildDoctorSlug(fullName: string): { slug: string; token: string; full: string } {
  const base = slugifyName(fullName);
  const token = generateToken(4);
  return { slug: base, token, full: `${base}-${token}` };
}

/**
 * Parse a URL path slug into base + token components.
 * Returns null if the pattern doesn't match.
 */
export function parseDoctorSlug(urlPath: string): { base: string; token: string } | null {
  const m = /^(dr-[a-z0-9-]+)-([a-z2-9]{4})$/.exec(urlPath);
  if (!m) return null;
  return { base: m[1]!, token: m[2]! };
}
