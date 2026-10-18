/**
 * lib/mcp/oauth/blacklist-guard.ts — R5 (Fable ruling 18 Oct): with SCRIBE_MCP_IDENTITY=on the email sign-in routes (start, which also serves resend, and verify) refuse with 503 until the blacklist-file CLI
 * has written a marker row (mcp_blacklist_applied: file sha256, count, time; no address). Flag off: no check, no query. Every refusal is counted (auditOauthRefused, rate-limited with a suppressed
 * count) and the first one per instance is logged once. A database error is a refusal too: never an accept.
 */
import type { NextResponse } from "next/server";
import { auditOauthRefused } from "@/lib/mcp/audit";
import { blacklistApplied } from "@/lib/mcp/blacklist-file";
import { identityEnforced } from "./config";
import { htmlError } from "./http";

let logged = false;
export const resetBlacklistGuardLogForTests = () => { logged = false; };

/** null = carry on; otherwise the 503 to return. */
export async function blacklistGuard(): Promise<NextResponse | null> {
  if (!identityEnforced()) return null;
  let applied = false;
  try { applied = await blacklistApplied(); } catch { applied = false; }
  if (applied) return null;
  if (!logged) { logged = true; console.error("[mcp-oauth] SCRIBE_MCP_IDENTITY is on but no blacklist-applied marker row exists: email sign-in refused (run the blacklist-file CLI)"); }
  await auditOauthRefused(null, "blacklist_not_applied");
  return htmlError(503, "server_error");
}
