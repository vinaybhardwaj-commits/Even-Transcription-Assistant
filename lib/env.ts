/**
 * lib/env.ts — typed environment-variable access.
 *
 * Use env() to get a required string env var with a clear error message
 * if it's missing. Use envOptional() when a missing value is acceptable
 * (mostly for build-time imports where runtime checks happen later).
 *
 * See ETA-BUILD-PLAN.md §2 for the canonical list of vars.
 */

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Required env var ${name} is not set`);
  return v;
}

export function envOptional(name: string): string | undefined {
  return process.env[name];
}

export function envBool(name: string, defaultValue = false): boolean {
  const v = process.env[name];
  if (!v) return defaultValue;
  return v === "1" || v.toLowerCase() === "true";
}

// ── Slice J1 (ETA-JEV-ARM-D §4) — Jev provider client. The flags (ETA_JEV_ENABLED / ETA_JEV_MOCK)
//    are read via parseFlag in lib/jev/client.ts so an unrecognised value throws rather than reading
//    as off. These two are non-boolean and read at CALL TIME (never module-load cached) so tests can
//    set them. TYPESAFE_API_KEY is consumed by the even-jev MCP launcher, never by this process.

/** The Jev model id. Default `jev-latest` (spec §4). */
export function jevModel(): string {
  return process.env.ETA_JEV_MODEL || "jev-latest";
}

/** Per-call Jev timeout in ms. Default 15000 (spec §4); a non-positive/non-numeric value falls back. */
export function jevTimeoutMs(): number {
  const v = Number(process.env.ETA_JEV_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 15000;
}
