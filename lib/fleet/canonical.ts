/**
 * lib/fleet/canonical.ts — the canonical JSON the command signature covers (PRD §5.3; the same rule as lib/steward/tickets.ts v1, written out for a non-JS verifier).
 *   - objects: keys sorted bytewise (all keys are ASCII, so UTF-16 and UTF-8 order agree), recursively; every key matches /^[a-z_][a-z0-9_]*$/ (integer-like keys forbidden)
 *   - no insignificant whitespace; UTF-8 output
 *   - numbers: integers only (|n| <= 2^53-1), decimal, no exponent, no "-0"; floats are refused, not rounded
 *   - strings: ECMAScript JSON.stringify escaping: `"` `\\` and control characters U+0000-U+001F as \b \f \n \r \t or \u00xx (lowercase hex); everything else, including
 *     non-ASCII, U+007F, U+2028 and U+2029, is emitted literally; lone surrogates are refused
 *   - true, false, null literal; arrays keep their order; `undefined` is refused
 */
export const KEY_RE = /^[a-z_][a-z0-9_]*$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new Error("canonical: integers only");
    return String(v);
  }
  if (typeof v === "string") {
    if (LONE_SURROGATE.test(v)) throw new Error("canonical: lone surrogate");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    for (const k of keys) if (!KEY_RE.test(k)) throw new Error("canonical: bad key");
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  throw new Error("canonical: unsupported value");
}
