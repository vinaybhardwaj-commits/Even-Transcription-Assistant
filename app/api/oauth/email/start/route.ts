/**
 * POST /api/oauth/email/start — the first half of the identity step. 404 while SCRIBE_MCP_OAUTH is off; 503 without the pepper or Resend.
 * Needs the signed pending cookie from /authorize. The address is lowercased and trimmed; it qualifies only when it ends @<domain> (even.in) AND has an ACTIVE mcp_person row.
 * Only then a 6-digit code is stored (sha256(pepper || pending_id || code), 10 min) and mailed to the APPROVER (SCRIBE_MCP_OAUTH_APPROVER), never to the requester; with SCRIBE_MCP_IDENTITY on the address must also hold an ACTIVE mcp_identity. The response is the SAME page, status and headers for a qualifying address, a non-qualifying
 * one, a rate-limited one and a failed send: nothing tells the caller which. Refusals write one mcp.oauth_refused row (wrong_domain / not_allowlisted / revoked / rate_limited / resend_failed).
 * TIMING: the send is deferred with next/server after() (Resend latency is off the response path); the one extra database round trip of the qualifying path is mirrored by a read for the others.
 * A failed send deletes the code row and writes the audit row; the page cannot change after the fact (a different page for a qualifying address would be the enumeration oracle).
 */
import { after, NextRequest } from "next/server";
import { codeRoute, identityEnforced, EMAIL_CODE_MAX_ATTEMPTS, EMAIL_CODE_TTL_S, EMAIL_RATE_PER_EMAIL, EMAIL_RATE_WINDOW_S, EMAIL_LOCK_S, mcpOauthDomain } from "@/lib/mcp/oauth/config";
import { emailCodeHash, codeEntryPage, newEmailCode, sendEmailCode } from "@/lib/mcp/oauth/email";
import { emailStartLimited } from "@/lib/mcp/oauth/email-limit";
import { originOk, readForm, readPending } from "@/lib/mcp/oauth/flow";
import { blacklistGuard } from "@/lib/mcp/oauth/blacklist-guard";
import { clientIp, htmlError, oauthGate } from "@/lib/mcp/oauth/http";
import { countRecentEmailCodes, deleteEmailCode, getPerson, insertEmailCode } from "@/lib/mcp/oauth/store";
import { identityStatus, selfApproved } from "@/lib/mcp/identity";
import { auditOauthRefused } from "@/lib/mcp/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** after() only exists inside a request scope; outside it (a unit test calling the handler directly) the work runs inline so nothing is lost. */
async function defer(work: () => Promise<void>): Promise<void> {
  try {
    after(work);
  } catch {
    await work();
  }
}

export async function POST(req: NextRequest) {
  const blocked = oauthGate({ email: true });
  if (blocked) return blocked.status === 404 ? blocked : htmlError(503, "server_error");
  const unguarded = await blacklistGuard();
  if (unguarded) return unguarded;

  const pending = readPending(req);
  if (!pending) {
    await auditOauthRefused(null, "pending_missing");
    return htmlError(400, "invalid_request");
  }
  const form = originOk(req) ? await readForm(req) : null;
  if (!form) return htmlError(400, "invalid_request");

  const email = (form.get("email") ?? "").trim().toLowerCase().slice(0, 300);
  if (emailStartLimited(clientIp(req))) {
    await auditOauthRefused(null, "rate_limited");
    return codeEntryPage();
  }

  try {
    if (!email.endsWith(`@${mcpOauthDomain()}`) || email.length > 254) {
      await getPerson(email.slice(0, 254)); // mirrors the lookup of the qualifying path
      await countRecentEmailCodes(email.slice(0, 254), EMAIL_RATE_WINDOW_S);
      await auditOauthRefused(null, "wrong_domain");
      return codeEntryPage();
    }
    const person = await getPerson(email);
    if (!person || person.status !== "active") {
      await countRecentEmailCodes(email, EMAIL_RATE_WINDOW_S);
      await auditOauthRefused(email, person ? "revoked" : "not_allowlisted");
      return codeEntryPage();
    }
    if (identityEnforced()) {
      const ident = await identityStatus(person.email);
      if (ident !== "active") {
        await auditOauthRefused(person.email, ident === null ? "no_identity" : ident);
        return codeEntryPage();
      }
    }
    const toSelf = codeRoute() === "self_after_approval" && (await selfApproved(person.email)); // V approved this address once; default route is the approver
    const code = newEmailCode();
    const id = await insertEmailCode({
      pending_id: pending.pid, email: person.email, code_hash: emailCodeHash(pending.pid, code),
      ttl_s: EMAIL_CODE_TTL_S, lock_s: EMAIL_LOCK_S, max_per_email: EMAIL_RATE_PER_EMAIL, window_s: EMAIL_RATE_WINDOW_S, max_attempts: EMAIL_CODE_MAX_ATTEMPTS,
    });
    if (!id) {
      await auditOauthRefused(person.email, "rate_limited");
      return codeEntryPage();
    }
    await defer(async () => {
      if (await sendEmailCode(person.email, code, toSelf)) return;
      try {
        await deleteEmailCode(id);
      } catch { /* the row expires on its own in 10 minutes */ }
      await auditOauthRefused(person.email, "resend_failed");
    });
    return codeEntryPage();
  } catch {
    return htmlError(503, "server_error");
  }
}
