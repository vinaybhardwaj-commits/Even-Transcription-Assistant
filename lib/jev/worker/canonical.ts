/**
 * lib/jev/worker/canonical.ts — the canonical JSON and the hash every Jev decision pins (PRD §4).
 *
 * Objects are written with SORTED keys, no whitespace; arrays keep their order. So the hash is the same for any key order
 * or whitespace in the source file, and changes with any change of wording. A Choice's options are ORDER-SIGNIFICANT, so
 * `hashableQuestion` turns the criteria object into an ordered array of [option, text] pairs before it is hashed.
 */
import { createHash } from "node:crypto";

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
export const hashOf = (v: unknown): string => sha256Hex(canonicalJson(v));
