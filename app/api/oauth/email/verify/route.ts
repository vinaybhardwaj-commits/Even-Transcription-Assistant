/**
 * POST /api/oauth/email/verify — the second half of the identity step. 404 while SCRIBE_MCP_OAUTH is off; 503 without the pepper or Resend.
 * Bound to the signed pending cookie: the code is looked up by the cookie's pending id and hashed with it, so a code issued to another pending flow cannot match. One attempt is spent
 * (atomically, before the compare) on the newest live code; 5 wrong tries across the pending flow kill it for good (every later verify, even with the right code, refuses and clears the cookie).
 * The compare is constant-time and the code is single use. Success does NOT mint anything: the person is re-checked (active), then the cookie is re-signed as a consent blob (5 min, CSRF token)
 * and the consent page names the client and the redirect host (R2 F2). Reasons audited: code_wrong, code_unavailable, revoked, not_allowlisted, code_reused.
 */
import { NextRequest } from "next/server";
import { CONSENT_PURPOSE, CONSENT_TTL_S, EMAIL_CODE_MAX_ATTEMPTS, EMAIL_PATH, PENDING_COOKIE } from "@/lib/mcp/oauth/config";
import { consentPage, describeClient, type Consent } from "@/lib/mcp/oauth/consent";
import { randomId, safeEqual, signBlob } from "@/lib/mcp/oauth/crypto";
import { codeDeadPage, codeWrongPage, emailCodeHash } from "@/lib/mcp/oauth/email";
import { done, originOk, readForm, readPending } from "@/lib/mcp/oauth/flow";
import { blacklistGuard } from "@/lib/mcp/oauth/blacklist-guard";
import { htmlError, oauthGate } from "@/lib/mcp/oauth/http";
import { consumeEmailCode, getPerson, takeEmailAttempt } from "@/lib/mcp/oauth/store";
import { auditOauthRefused } from "@/lib/mcp/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const code = (form?.get("code") ?? "").trim();
  if (!form || !/^[0-9]{6}$/.test(code)) return htmlError(400, "invalid_request"); // a malformed code spends no attempt

  try {
    const row = await takeEmailAttempt(pending.pid, EMAIL_CODE_MAX_ATTEMPTS);
    if (!row) {
      await auditOauthRefused(null, "code_unavailable");
      return done(codeDeadPage());
    }
    if (!safeEqual(row.code_hash, emailCodeHash(pending.pid, code))) {
      await auditOauthRefused(row.email, "code_wrong");
      return codeWrongPage();
    }
    if (!(await consumeEmailCode(row.id))) {
      await auditOauthRefused(row.email, "code_reused");
      return done(codeDeadPage());
    }
    const person = await getPerson(row.email);
    if (!person || person.status !== "active") {
      await auditOauthRefused(row.email, person ? "revoked" : "not_allowlisted");
      return done(codeDeadPage());
    }
    const consent: Consent = { cid: pending.cid, ru: pending.ru, cc: pending.cc, st: pending.st, res: pending.res, email: person.email, csrf: randomId(24), exp: Math.floor(Date.now() / 1000) + CONSENT_TTL_S };
    const who = await describeClient(pending.cid);
    const res = consentPage({ clientLabel: who.label, redirectHost: new URL(pending.ru).host, email: person.email, csrf: consent.csrf, action: `${EMAIL_PATH}/consent` });
    res.cookies.set(PENDING_COOKIE, signBlob(CONSENT_PURPOSE, consent), { httpOnly: true, secure: true, sameSite: "lax", path: EMAIL_PATH, maxAge: CONSENT_TTL_S });
    return res;
  } catch {
    return done(htmlError(503, "server_error"));
  }
}
