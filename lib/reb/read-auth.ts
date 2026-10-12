/**
 * Bearer check for the box read routes that share the REB index tokens.
 *
 * GET /api/sarvam/consult-results and GET /api/reb/roles. Either REB_INDEX_READ_TOKEN or REB_INDEX_TOKEN.
 * Unset or blank on both is 503. A mismatch is 401. The comparison is hashed and constant-time.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const REB_READ_TOKEN_ENVS = ["REB_INDEX_READ_TOKEN", "REB_INDEX_TOKEN"] as const;

export type RebAuthFailure = { status: 401 | 503; error: "unauthorized" | "not_configured" };

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

export function checkRebReadBearer(
  authorization: string | null,
  env: Record<string, string | undefined> = process.env,
): RebAuthFailure | null {
  const expected = REB_READ_TOKEN_ENVS.map((n) => (env[n] ?? "").trim()).filter((t) => t !== "");
  if (expected.length === 0) return { status: 503, error: "not_configured" };
  const header = authorization ?? "";
  const presented = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const a = digest(presented);
  let ok = false;
  for (const t of expected) if (timingSafeEqual(a, digest(t)) && presented !== "") ok = true;
  return ok ? null : { status: 401, error: "unauthorized" };
}
