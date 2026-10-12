/**
 * lib/enc/auth.ts — doors of the ENC routes.
 *  - stewardAuth: Bearer ENC_STEWARD_TOKEN, compared by sha256 digest in constant time. Unset token: "not_configured" (503). Wrong or absent: "unauthorized" (401).
 *  - adminSession: the admin cookie, verified as an admin JWT. Returns the admin id, or null.
 *  - cronAuthorized / adminOrSecret: same doors as /api/cron/consult-index-sync (CRON_SECRET or MIGRATION_SECRET on GET; admin cookie or MIGRATION_SECRET on POST).
 */
import type { NextRequest } from "next/server";
import { bearerMatches } from "@/lib/consult-index/mirror-staleness";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";

export function stewardAuth(req: NextRequest): "ok" | "not_configured" | "unauthorized" {
  const token = process.env.ENC_STEWARD_TOKEN?.trim() ?? "";
  if (!token) return "not_configured";
  return bearerMatches(req.headers.get("authorization") ?? "", [token]) ? "ok" : "unauthorized";
}

export async function adminSession(): Promise<string | null> {
  const cookie = await readAdminCookie();
  if (!cookie) return null;
  try {
    const c = await verifyAdminJwt(cookie);
    return typeof c.admin_id === "string" && c.admin_id !== "" ? c.admin_id : "admin";
  } catch {
    return null;
  }
}

export const cronAuthorized = (req: NextRequest): boolean =>
  bearerMatches(req.headers.get("authorization") ?? "", [process.env.CRON_SECRET ?? "", process.env.MIGRATION_SECRET ?? ""]);

export async function adminOrSecret(req: NextRequest): Promise<boolean> {
  if (bearerMatches(req.headers.get("authorization") ?? "", [process.env.MIGRATION_SECRET ?? ""])) return true;
  return (await adminSession()) !== null;
}

/** Reads a JSON body up to maxBytes. */
export async function readJsonBody(req: NextRequest, maxBytes = 65_536): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 413 }> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };
  let text: string;
  try { text = await req.text(); } catch { return { ok: false, status: 400 }; }
  if (text.length > maxBytes) return { ok: false, status: 413 };
  try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: false, status: 400 }; }
}
