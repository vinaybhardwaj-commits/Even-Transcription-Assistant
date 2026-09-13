/**
 * lib/flags.ts — ONE parser for every on/off environment flag.
 *
 * It began as ROOM_DIARIZE_ENABLED's parser (C2), where `=== "1"` read "true" and " 1" as OFF
 * without a word. The emotion flags need the same rule, and a second copy of a parser is how two
 * flags come to disagree about what "true" means.
 *
 *   enables:  1 | true | yes | on          (case-insensitive, surrounding whitespace trimmed)
 *   disables: 0 | false | no | off | ""   and unset
 *   anything else THROWS FlagValueError — never read as off.
 */
export const FLAG_TRUTHY = ["1", "true", "yes", "on"] as const;
export const FLAG_FALSY = ["", "0", "false", "no", "off"] as const;

/** Thrown for a value in neither set. Callers surface it as a failure; it never reads as "off". */
export class FlagValueError extends Error {}

export function parseFlag(name: string, env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[name];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if ((FLAG_TRUTHY as readonly string[]).includes(v)) return true;
  if ((FLAG_FALSY as readonly string[]).includes(v)) return false;
  // Length only: an env value is not something to echo into a response.
  throw new FlagValueError(
    `${name} has an unrecognised value (length ${raw.length}) — use one of ${FLAG_TRUTHY.join("|")} to enable or ${FLAG_FALSY.filter(Boolean).join("|")}/unset to disable. Refusing to guess.`,
  );
}
