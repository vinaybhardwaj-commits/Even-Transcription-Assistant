/**
 * lib/spine/config.ts — spine_config modes. A missing, malformed or unknown value means OFF.
 * Keys: `kill_switch` (true => everything off), `jobs` (the queue), `mode.<stage>` (per stage). Value: "off"|"shadow"|"live" or {"mode": ...}.
 */
import { sql } from "@/lib/db";

export type Mode = "off" | "shadow" | "live";

/** Paid stages stay off until V rules on D4/D5/D9: never claimable, whatever the config says. */
export const PAID_STAGES: readonly string[] = ["sarvam", "gapfill", "role", "llm-roles", "parts"];
/** Every stage the queue knows; an unknown stage is never claimed. */
export const KNOWN_STAGES: readonly string[] = ["recut", "acoustics", "nemotron", "sarvam", "gapfill", "role", "llm-roles", "parts", "collector", "freescript"];

export function parseMode(v: unknown): Mode {
  const m = v && typeof v === "object" && !Array.isArray(v) ? (v as { mode?: unknown }).mode : v;
  return m === "shadow" || m === "live" ? m : "off";
}

export function isTruthyKill(v: unknown): boolean {
  const x = v && typeof v === "object" && !Array.isArray(v) ? (v as { on?: unknown }).on : v;
  return x === true || x === "on" || x === "true" || x === 1;
}

/** Pure: modes for `stages` from the config rows. */
export function modesFrom(rows: Array<{ key: string; value: unknown }>, stages: readonly string[]): { jobs: Mode; stages: Record<string, Mode> } {
  const by = new Map(rows.map((r) => [r.key, r.value]));
  if (isTruthyKill(by.get("kill_switch"))) return { jobs: "off", stages: Object.fromEntries(stages.map((s) => [s, "off" as Mode])) };
  const jobs = parseMode(by.get("jobs"));
  const out: Record<string, Mode> = {};
  for (const s of stages) out[s] = jobs === "off" || PAID_STAGES.includes(s) || !KNOWN_STAGES.includes(s) ? "off" : parseMode(by.get(`mode.${s}`));
  return { jobs, stages: out };
}

export async function readModes(stages: readonly string[] = KNOWN_STAGES): Promise<{ jobs: Mode; stages: Record<string, Mode> }> {
  const keys = ["kill_switch", "jobs", "dead_alert", ...stages.map((s) => `mode.${s}`)];
  const rows = (await sql`SELECT key, value FROM spine_config WHERE key = ANY(${keys}::text[])`) as Array<{ key: string; value: unknown }>;
  return modesFrom(rows, stages);
}

export async function readMode(key: string): Promise<Mode> {
  const rows = (await sql`SELECT value FROM spine_config WHERE key = ${key}::text`) as Array<{ value: unknown }>;
  return parseMode(rows[0]?.value);
}
