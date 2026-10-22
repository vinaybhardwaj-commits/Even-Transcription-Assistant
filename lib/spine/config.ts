/**
 * lib/spine/config.ts — spine_config modes. A missing, malformed or unknown value means OFF.
 * Keys: `kill_switch` (true => everything off), `ingest` (S1 signal ingest), `producers` (SPINE-P1 encounter-shadow cron), `jobs` (the queue), `mode.<stage>` (per stage). Value: "off"|"shadow"|"live" or {"mode": ...}.
 * ingest alone is read from a jsonb that the driver may hand back as text; kill_switch is never decoded (a string there is malformed, i.e. killed).
 */
import { sql } from "@/lib/db";

export type Mode = "off" | "shadow" | "live";
export type IngestMode = Mode;

/** Paid stages stay off until V rules on D4/D5/D9: never claimable, whatever the config says. */
export const PAID_STAGES: readonly string[] = ["sarvam", "gapfill", "role", "llm-roles", "parts"];
/** Every stage the queue knows; an unknown stage is never claimed. */
export const KNOWN_STAGES: readonly string[] = ["recut", "acoustics", "nemotron", "sarvam", "gapfill", "role", "llm-roles", "parts", "collector", "freescript"];

export function parseMode(v: unknown): Mode {
  const m = v && typeof v === "object" && !Array.isArray(v) ? (v as { mode?: unknown }).mode : v;
  return m === "shadow" || m === "live" ? m : "off";
}

/** A kill_switch row that is not exactly `false` / `{"on": false}` counts as KILLED (malformed fails toward killed). An absent row is not a kill (jobs still defaults off). */
export function isKilled(v: unknown): boolean {
  const x = v && typeof v === "object" && !Array.isArray(v) ? (v as { on?: unknown }).on : v;
  return x !== false;
}

const val = (v: unknown): unknown => { if (typeof v === "string") { try { return JSON.parse(v); } catch { return v; } } return v; };   // the driver may hand a jsonb back as text (ingest only)

/** S1 gate. spine_config has no seed rows. Pure: ingest mode from the config rows; kill_switch rules as isKilled, a missing or malformed ingest value means off. */
export function parseIngestMode(rows: ReadonlyArray<{ key: string; value: unknown }>): IngestMode {
  const m = new Map(rows.map((r) => [r.key, r.key === "ingest" ? val(r.value) : r.value] as const));
  if (m.has("kill_switch") && isKilled(m.get("kill_switch"))) return "off";
  return parseMode(m.get("ingest"));
}

/** SPINE-P1 gate (the producer cron). Same rules as parseIngestMode, key `producers`: kill_switch as isKilled, a missing or malformed value means off. */
export function parseProducersMode(rows: ReadonlyArray<{ key: string; value: unknown }>): Mode {
  const m = new Map(rows.map((r) => [r.key, r.key === "producers" ? val(r.value) : r.value] as const));
  if (m.has("kill_switch") && isKilled(m.get("kill_switch"))) return "off";
  return parseMode(m.get("producers"));
}

/** Pure: modes for `stages` from the config rows. */
export function modesFrom(rows: Array<{ key: string; value: unknown }>, stages: readonly string[]): { jobs: Mode; stages: Record<string, Mode> } {
  const by = new Map(rows.map((r) => [r.key, r.value]));
  if (by.has("kill_switch") && isKilled(by.get("kill_switch"))) return { jobs: "off", stages: Object.fromEntries(stages.map((s) => [s, "off" as Mode])) };
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
