/**
 * lib/freescript/flag.ts — the FreeScript door is off unless ETA_FREESCRIPT is on.
 *
 * Unset is off. parseFlag throws on a value it does not recognise; that is a misconfiguration, never a quiet off.
 */
import { parseFlag } from "@/lib/flags";

export const ETA_FREESCRIPT = "ETA_FREESCRIPT";

export const freescriptEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  parseFlag(ETA_FREESCRIPT, env);
