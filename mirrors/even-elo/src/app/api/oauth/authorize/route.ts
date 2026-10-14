import { NextRequest, NextResponse } from "next/server";
import { mcpSecret, signAuthCode } from "@/lib/mcp-oauth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function validRedirect(u: string): boolean {
  try { const x = new URL(u); return x.protocol === "https:" || x.hostname === "localhost" || x.hostname === "127.0.0.1"; }
  catch { return false; }
}
function page(params: Record<string, string>, error?: string): string {
  const hidden = ["response_type","client_id","redirect_uri","code_challenge","code_challenge_method","scope","state","resource"]
    .map((k) => `<input type="hidden" name="${k}" value="${esc(params[k] ?? "")}">`).join("\n      ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Even Governance — Authorize</title>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;margin:0;display:grid;place-items:center;min-height:100vh}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;max-width:400px;width:90%;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.logo{width:40px;height:40px;border-radius:10px;background:#059669;color:#fff;display:grid;place-items:center;font-weight:700;font-size:11px;margin-bottom:14px}
h1{font-size:18px;margin:0 0 6px}p{color:#475569;font-size:14px;margin:0 0 18px}
label{display:block;font-size:13px;font-weight:600;margin-bottom:6px}
input[type=password]{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:9px;padding:10px 12px;font-size:14px}
button{width:100%;margin-top:16px;background:#059669;color:#fff;border:0;border-radius:9px;padding:11px;font-size:14px;font-weight:600;cursor:pointer}
.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;font-size:13px;border-radius:9px;padding:8px 10px;margin-bottom:14px}</style>
</head><body><form class="card" method="post" action="/api/oauth/authorize">
  <div class="logo">EVEN</div>
  <h1>Authorize Claude</h1>
  <p>Connect Claude to the Even Governance system. Enter the access secret to approve.</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ""}
  <label for="secret">Access secret</label>
  <input id="secret" name="secret" type="password" autocomplete="off" autofocus placeholder="Paste the governance MCP secret">
  ${hidden}
  <button type="submit">Approve &amp; connect</button>
</form></body></html>`;
}
function html(body: string, status = 200) {
  return new NextResponse(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(req.nextUrl.searchParams.entries()) as Record<string, string>;
  if ((p.code_challenge_method || "") !== "S256" || !p.code_challenge) return html(page(p, "This client must use PKCE (S256)."), 400);
  if (!validRedirect(p.redirect_uri || "")) return html(page(p, "Invalid redirect_uri."), 400);
  return html(page(p));
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const p: Record<string, string> = {};
  for (const k of ["response_type","client_id","redirect_uri","code_challenge","code_challenge_method","scope","state","resource","secret"]) {
    p[k] = String(form.get(k) ?? "");
  }
  const secret = mcpSecret();
  if (!secret) return html(page(p, "Server secret is not configured (MCP_BEARER_TOKEN). Set it in Vercel."), 500);
  if (!validRedirect(p.redirect_uri)) return html(page(p, "Invalid redirect_uri."), 400);
  if (p.code_challenge_method !== "S256" || !p.code_challenge) return html(page(p, "Missing PKCE challenge."), 400);
  if (p.secret !== secret) return html(page(p, "Incorrect access secret."), 401);

  const code = await signAuthCode({ redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, scope: p.scope || "mcp", client_id: p.client_id });
  const dest = new URL(p.redirect_uri);
  dest.searchParams.set("code", code);
  if (p.state) dest.searchParams.set("state", p.state);
  return NextResponse.redirect(dest.toString(), { status: 302, headers: { "Cache-Control": "no-store" } });
}
