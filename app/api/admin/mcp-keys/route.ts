/**
 * /api/admin/mcp-keys — issue / rotate / revoke per-email MCP keys and revoke or blacklist an identity. V ONLY (admin session whose email is SCRIBE_MCP_OAUTH_APPROVER); same-origin form posts.
 * The plain key is shown ONCE, in the response to the issuing POST (no-store), and stored nowhere (mcp_key keeps its sha256). Each action mails V (best-effort) with ids and addresses, never the key.
 * A blacklisted address cannot be issued a key here; lifting a blacklist is an edit of mcp_identity by V.
 */
import { NextRequest, NextResponse } from "next/server";
import { issueKey, listIdentities, listKeys, revokeKey, rotateKey, setIdentityStatus, setSelfApproved, type KeyScope } from "@/lib/mcp/identity";
import { alertSelfApproval, alertIdentityChanged, alertKeyIssued, alertKeyRevoked } from "@/lib/mcp/notify";
import { ownerFromRequest } from "@/lib/mcp/owner-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function GET(req: NextRequest) {
  if (!(await ownerFromRequest(req))) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  try {
    return NextResponse.json({ identities: await listIdentities(), keys: await listKeys() }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}

export async function POST(req: NextRequest) {
  const owner = await ownerFromRequest(req);
  if (!owner) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== req.nextUrl.origin) return NextResponse.json({ error: "bad_origin" }, { status: 403, headers: NO_STORE });
  let f: URLSearchParams;
  try { f = new URLSearchParams(await req.text()); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE }); }
  const action = f.get("action");
  const back = () => new NextResponse(null, { status: 303, headers: { location: "/admin/mcp-keys", ...NO_STORE } });
  try {
    if (action === "issue" || action === "rotate") {
      const issued = action === "issue"
        ? await issueKey(f.get("email") ?? "", (f.get("scope") === "admin" ? "admin" : "read") as KeyScope, owner)
        : await rotateKey(f.get("key_id") ?? "", owner);
      await alertKeyIssued(issued.email, issued.key_id, issued.scope, owner);
      if (action === "rotate") await alertKeyRevoked(issued.email, f.get("key_id") ?? "", owner);
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Key issued</title></head><body><h1>Key issued</h1><p>${esc(issued.email)} · ${esc(issued.scope)} · ${esc(issued.key_id)}</p><p>Copy it now. It is not stored and will not be shown again:</p><pre>${esc(issued.key)}</pre><p><a href="/admin/mcp-keys">Back</a></p></body></html>`;
      return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer", ...NO_STORE } });
    }
    if (action === "revoke") {
      const r = await revokeKey(f.get("key_id") ?? "");
      if (r.revoked) await alertKeyRevoked(r.email, f.get("key_id") ?? "", owner);
      return back();
    }
    if (action === "identity") {
      const status = f.get("status") === "blacklisted" ? "blacklisted" : "revoked";
      await setIdentityStatus(f.get("email") ?? "", status, owner);
      await alertIdentityChanged((f.get("email") ?? "").trim().toLowerCase(), status, owner);
      return back();
    }
    if (action === "self_approve" || action === "self_withdraw") {
      const approve = action === "self_approve";
      const email = (f.get("email") ?? "").trim().toLowerCase();
      if (await setSelfApproved(email, approve, owner)) await alertSelfApproval(email, approve, owner);
      return back();
    }
    return NextResponse.json({ error: "bad_action" }, { status: 400, headers: NO_STORE });
  } catch (e) {
    const m = String((e as Error)?.message ?? "");
    const known = ["blacklisted", "identity_revoked", "bad_email", "bad_scope", "unknown_key_id", "already_revoked"].find((k) => m === k);
    return NextResponse.json({ error: known ?? "unavailable" }, { status: known ? 409 : 503, headers: NO_STORE });
  }
}
