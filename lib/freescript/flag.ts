/**
 * lib/freescript/flag.ts — ETA_FREESCRIPT is a kill switch. The door is on unless it is turned off.
 *
 * Unset is on. 0 | false | no | off | "" is off. parseFlag throws on a value it does not recognise;
 * that is a misconfiguration, never a quiet off.
 */
import { parseFlag } from "@/lib/flags";

export const ETA_FREESCRIPT = "ETA_FREESCRIPT";

export const freescriptEnabled = (env: Record<string, string | undefined> = process.env): boolean => {
  if (env[ETA_FREESCRIPT] === undefined) return true;
  return parseFlag(ETA_FREESCRIPT, env);
};
