/**
 * lib/mcp/notify.ts — mail to the approver (V) through the existing Resend setup (RESEND_API_KEY, RESEND_FROM_EMAIL). Used for the immediate alerts (a non-V sign-in, a key issued, a key or
 * identity revoked) and the 20:00 IST digest. The recipient is ALWAYS SCRIBE_MCP_OAUTH_APPROVER: there is no parameter for another address. Bodies carry colleague addresses, key ids, tool names
 * and counts. Never a key, a code, a token, a subject id, transcript text or a patient name. Best-effort: a mail failure is logged count-only and never fails the action that raised it.
 */
import { RESEND_API_KEY_ENV, RESEND_FROM_ENV, approverEmail } from "./oauth/config";

const TIMEOUT_MS = 8000;

export async function mailApprover(subject: string, text: string): Promise<boolean> {
  const to = approverEmail();
  if (!to || !process.env[RESEND_API_KEY_ENV] || !process.env[RESEND_FROM_ENV]) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env[RESEND_API_KEY_ENV] ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env[RESEND_FROM_ENV], to: [to], subject: subject.slice(0, 200), text: text.slice(0, 20_000) }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) console.warn(`mcp-notify: send failed (resend_${r.status}, count=1)`);
    return r.ok;
  } catch {
    console.warn("mcp-notify: send threw (count=1)");
    return false;
  }
}

export const alertSignIn = (email: string, clientHost: string, route: string = "approver") => mailApprover("EvenScribe MCP: sign-in", `${email} signed in to the EvenScribe MCP connector (client ${clientHost}). Code route: ${route}. The session lasts 30 days.`);
export const alertSelfApproval = (email: string, approved: boolean, by: string) => mailApprover("EvenScribe MCP: code route " + (approved ? "approved" : "withdrawn"), `${by} ${approved ? "approved" : "withdrew"} self-delivery of sign-in codes for ${email}.`);
export const alertKeyIssued = (email: string, keyId: string, scope: string, by: string) => mailApprover("EvenScribe MCP: key issued", `A ${scope} key (${keyId}) was issued for ${email} by ${by}.`);
export const alertKeyRevoked = (email: string | null, keyId: string, by: string) => mailApprover("EvenScribe MCP: key revoked", `Key ${keyId}${email ? ` of ${email}` : ""} was revoked by ${by}.`);
export const alertIdentityChanged = (email: string, status: string, by: string) => mailApprover("EvenScribe MCP: identity " + status, `${email} was set to ${status} by ${by}; every key of that address stopped working.`);
