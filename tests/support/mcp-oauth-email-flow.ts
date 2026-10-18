/**
 * tests/support/mcp-oauth-email-flow.ts — drives the email-code identity step through the REAL route modules: start, the mailed code (captured from a Resend fetch stub), verify, and the consent POST.
 * The test file mocks "@/lib/db" and "@/lib/mcp/oauth/store" (the fake store); this module only imports the routes. Synthetic addresses only.
 */
import { expect } from "vitest";
import { NextRequest, type NextResponse } from "next/server";
import { POST as startPost } from "@/app/api/oauth/email/start/route";
import { POST as verifyPost } from "@/app/api/oauth/email/verify/route";
import { POST as consentRoutePost } from "@/app/api/oauth/email/consent/route";

export const SITE = "https://www.evenscribe.app";
export const CONSENT_URL = `${SITE}/api/oauth/email/consent`;
export const mailed: Array<{ to: string; subject: string; text: string; from: string }> = [];
export const resend = { mode: "ok" as "ok" | "down" | "hang" };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** The Resend fetch stub: returns a Response for api.resend.com/emails and null for any other URL. */
export function resendFetch(input: string | URL, init?: RequestInit): Promise<Response> | null {
  if (String(input) !== "https://api.resend.com/emails") return null;
  if (resend.mode === "hang") return new Promise<Response>(() => {});
  if (resend.mode === "down") return Promise.resolve(new Response("{}", { status: 500 }));
  const b = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; from: string };
  mailed.push({ to: b.to[0]!, subject: b.subject, text: b.text, from: b.from });
  return Promise.resolve(new Response(JSON.stringify({ id: "msg-synthetic" }), { status: 200 }));
}
export const resetMail = (): void => { mailed.length = 0; resend.mode = "ok"; };
/** The 6 digits in the most recent mail. */
export const lastCode = (): string => /sign-in code: (\d{6})\./.exec(mailed[mailed.length - 1]?.text ?? "")?.[1] ?? "";

const req = (path: string, cookie: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new NextRequest(`${SITE}/api/oauth/email/${path}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie: `mcp_oauth_pending=${cookie}` } : {}), ...headers }, body: form(fields),
  });
export const start = (cookie: string, email: string, headers: Record<string, string> = {}) => startPost(req("start", cookie, { email }, headers));
export const verify = (cookie: string, code: string, headers: Record<string, string> = {}) => verifyPost(req("verify", cookie, { code }, headers));
export const consentPost = (cookie: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  consentRoutePost(new NextRequest(CONSENT_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie: `mcp_oauth_pending=${cookie}` } : {}), ...headers }, body: form(fields),
  }));

/** The consent page a verify renders, with its re-signed cookie and CSRF token. */
export async function consentOf(page: Response) {
  const html = await page.text();
  const cookie = (page as NextResponse).cookies.get("mcp_oauth_pending")?.value ?? "";
  return { page, html, cookie, csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "" };
}

/** start + the mailed code + verify, from the cookie authorize set. Expects the mail to have been sent. */
export async function toConsentFrom(pendingCookie: string, email: string) {
  const before = mailed.length;
  const s = await start(pendingCookie, email);
  expect(s.status).toBe(200);
  expect(mailed.length).toBe(before + 1);
  const v = await verify(pendingCookie, lastCode());
  expect(v.status).toBe(200);
  return consentOf(v);
}
