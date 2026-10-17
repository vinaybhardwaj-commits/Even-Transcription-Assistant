/**
 * lib/mcp/oauth/consent.ts — R2 F2 (RFC 9700 §4.5, MCP security best practice on consent): the same-origin page shown AFTER Google sign-in succeeds and BEFORE any code is minted.
 * It names the client (the metadata-document host, or the registered client_name) and the host the code would go to, and offers Allow and Deny as a POST back to the callback.
 * The POST is bound to the signed consent cookie (HttpOnly, SameSite=Lax, path-scoped) AND a CSRF token that lives both in that cookie and in the form. Every value shown is escaped.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { NO_STORE } from "./http";
import { getClient } from "./store";

export type Consent = { cid: string; ru: string; cc: string; st: string | null; res: string; email: string; csrf: string; exp: number };

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** How the client is named on the page and in the success audit row. A metadata-document client is named by its host; a registered one by its client_name (or a fixed label) and the sha256 of its id. */
export async function describeClient(clientId: string): Promise<{ label: string; audit: { client_host: string } | { client_sha256: string } }> {
  if (clientId.startsWith("https://")) {
    const host = new URL(clientId).host;
    return { label: host, audit: { client_host: host } };
  }
  const row = await getClient(clientId);
  const name = row?.client_name?.trim();
  return { label: name ? `${name} (self-registered)` : "An unnamed self-registered application", audit: { client_sha256: createHash("sha256").update(clientId).digest("hex") } };
}

export function consentPage(p: { clientLabel: string; redirectHost: string; email: string; csrf: string; action: string }): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Allow access to EvenScribe</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}dt{font-weight:600}dd{margin:0 0 .75rem}button{font-size:1rem;padding:.5rem 1.25rem;margin-right:.75rem}</style></head>
<body><main><h1>Allow access to EvenScribe?</h1>
<p>You are signed in as <strong>${esc(p.email)}</strong>. An application is asking to use EvenScribe as you.</p>
<dl><dt>Application</dt><dd data-consent="client">${esc(p.clientLabel)}</dd><dt>Access will be sent to</dt><dd data-consent="redirect-host">${esc(p.redirectHost)}</dd></dl>
<p>Allow only if you started this connection yourself just now.</p>
<form method="post" action="${esc(p.action)}"><input type="hidden" name="csrf" value="${esc(p.csrf)}">
<button type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="deny">Deny</button></form></main></body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8", ...NO_STORE, "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
      // no form-action: browsers apply it to the redirect after the POST, which would block the hop back to the client
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
