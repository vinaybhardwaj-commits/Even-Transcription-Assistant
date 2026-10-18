/**
 * lib/mcp/oauth/email.ts — the identity step of the authorization server (V ruling 18 Oct 2026: no Google): a one-time code mailed through Resend.
 * The code is a 6-digit crypto-RNG number, stored only as sha256(pepper || pending_id || code), never logged, never in a URL, never in a response.
 * Resend is called with plain fetch like the rest of EvenScribe (no shared helper exists); RESEND_API_KEY and RESEND_FROM_EMAIL are the existing prod env.
 */
import { randomInt } from "node:crypto";
import { NextResponse } from "next/server";
import { RESEND_API_KEY_ENV, RESEND_FROM_ENV, EMAIL_CODE_TTL_S, EMAIL_PATH } from "./config";
import { hashSecret } from "./crypto";
import { NO_STORE } from "./http";

const RESEND_TIMEOUT_MS = 8000;

export const resendConfigured = (): boolean => Boolean(process.env[RESEND_API_KEY_ENV] && process.env[RESEND_FROM_ENV]);

/** Six digits, uniform, from the crypto RNG. */
export const newEmailCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");
/** sha256(pepper || pending_id || code), hex. A code is only valid for the pending flow it was issued to. */
export const emailCodeHash = (pendingId: string, code: string): string => hashSecret(pendingId + code);

export const EMAIL_SUBJECT = "Your EvenScribe sign-in code";
export const emailBody = (code: string): string => `Your EvenScribe sign-in code: ${code}. It expires in ${EMAIL_CODE_TTL_S / 60} minutes. If you did not ask for this, ignore it.`;

/** True when Resend accepted the message. Any failure is false, logged count-only with the status (never the address, the code or the body). */
export async function sendEmailCode(to: string, code: string): Promise<boolean> {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env[RESEND_API_KEY_ENV] ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env[RESEND_FROM_ENV], to: [to], subject: EMAIL_SUBJECT, text: emailBody(code) }),
      cache: "no-store",
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    if (!r.ok) console.warn(`mcp-oauth: email send failed (resend_${r.status}, count=1)`);
    return r.ok;
  } catch {
    console.warn("mcp-oauth: email send threw (count=1)");
    return false;
  }
}

// ─── the two sign-in pages ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const STYLE = "body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}input{font-size:1rem;padding:.5rem;margin:.5rem 0;width:100%;box-sizing:border-box}button{font-size:1rem;padding:.5rem 1.25rem}.note{color:#444}";

function page(status: number, title: string, body: string): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
  return new NextResponse(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8", ...NO_STORE, "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "strict-origin",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

/** Step 1, rendered by GET /authorize: ask for the address. Static: nothing from the request is echoed. */
export const emailEntryPage = (): NextResponse =>
  page(200, "EvenScribe sign-in", `<h1>EvenScribe sign-in - enter your even.in email</h1>
<form method="post" action="${EMAIL_PATH}/start"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required><button type="submit">Send me a code</button></form>`);

/** Step 2, the answer to email/start. IDENTICAL for every address (qualifying or not), for a rate-limited one and for a Resend failure. */
export const codeEntryPage = (): NextResponse =>
  page(200, "EvenScribe sign-in", `<h1>EvenScribe sign-in</h1><p>If that address is allowed, a code is on its way. Enter it here.</p>
<form method="post" action="${EMAIL_PATH}/verify"><label for="code">Code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required><button type="submit">Continue</button></form>`);

/** A wrong code: the same form again with one fixed line. */
export const codeWrongPage = (): NextResponse =>
  page(400, "EvenScribe sign-in", `<h1>EvenScribe sign-in</h1><p>That code was not right. Check it and try again.</p>
<form method="post" action="${EMAIL_PATH}/verify"><label for="code">Code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required><button type="submit">Continue</button></form>`);

/** The code is dead (expired, used, or too many wrong tries): start again from the application. */
export const codeDeadPage = (): NextResponse =>
  page(400, "Sign-in error", `<h1>Sign-in error</h1><p>This sign-in can no longer be completed. Go back to the application and start again.</p><p>Code: code_unavailable</p>`);
