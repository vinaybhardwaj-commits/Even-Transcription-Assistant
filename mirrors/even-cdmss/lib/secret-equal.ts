/**
 * Constant-time string compare for request credentials.
 *
 * Equal-length inputs run a full XOR so the result does not depend on the first
 * differing byte. A length mismatch returns false immediately — `timingSafeEqual`
 * throws on unequal lengths, and every existing gate in this repo pre-checks length
 * the same way. An empty presented value never matches, including when the expected
 * secret is also empty: an unset secret is not a credential.
 */
export function secretEqual(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const enc = new TextEncoder();
  const ab = enc.encode(presented);
  const bb = enc.encode(expected);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
