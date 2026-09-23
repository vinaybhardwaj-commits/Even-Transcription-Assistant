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

/**
 * ENCOUNTER_FUSION_SHADOW — E-6, shadow-runner v2. DEFAULT OFF. When on, an operator's E-shadow run
 * also writes the FUSED run (Jev confirming, splitting or rejecting each encounter) beside the acoustic
 * one. Shadow only: both land in the E-5 store, nothing a clinician sees changes. The replay path
 * (`fusion: true` on scribe_encounter_shadow_run) runs v2 regardless, for E-7 scoring of past days —
 * an explicit per-call request, never a standing switch.
 */
export const ENCOUNTER_FUSION_SHADOW = "ENCOUNTER_FUSION_SHADOW";

export function encounterFusionShadowEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseFlag(ENCOUNTER_FUSION_SHADOW, env);
}
