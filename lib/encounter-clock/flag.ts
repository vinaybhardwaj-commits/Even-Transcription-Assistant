/**
 * lib/encounter-clock/flag.ts — the encounter clock's on/off switch. DEFAULT OFF.
 *
 * Nothing reads this yet: the probe scheduler and the E-2 gate are pure modules with no caller.
 * The flag exists so that the first caller is gated from its first line, through the one parser
 * every flag in this repo uses (an unrecognised value throws; it never reads as off).
 */
import { parseFlag } from "@/lib/flags";

export const ENCOUNTER_CLOCK = "ENCOUNTER_CLOCK";

export function encounterClockEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseFlag(ENCOUNTER_CLOCK, env);
}
