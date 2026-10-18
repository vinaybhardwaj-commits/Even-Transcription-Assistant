/**
 * lib/mcp/owner-gate.ts — "V only" for /admin/mcp-audit, /admin/mcp-seclog, /admin/mcp-keys and /api/admin/mcp-keys. An admin session counts only when its email is the approver
 * (SCRIBE_MCP_OAUTH_APPROVER). Any other admin, and every request when no approver is configured, is refused. Returns the approver's email or null.
 */
import { ADMIN_COOKIE, verifyAdminJwt } from "@/lib/auth";
import { readAdminCookie } from "@/lib/cookie";
import { approverEmail } from "./oauth/config";

async function ownerOfToken(token: string | null | undefined): Promise<string | null> {
  const approver = approverEmail();
  if (!approver || !token) return null;
  try {
    const email = String((await verifyAdminJwt(token)).email ?? "").trim().toLowerCase();
    return email === approver ? email : null;
  } catch {
    return null;
  }
}

/** For server components (reads the admin cookie from the request scope). */
export async function ownerFromCookie(): Promise<string | null> {
  return ownerOfToken(await readAdminCookie());
}

/** For route handlers. */
export async function ownerFromRequest(req: { cookies: { get(name: string): { value: string } | undefined } }): Promise<string | null> {
  return ownerOfToken(req.cookies.get(ADMIN_COOKIE)?.value);
}
