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
