/**
 * POST /api/admin/fleet/commands — queue ONE catalogued, signed command for ONE device (TS-H4 #41). ADMIN COOKIE ONLY (no bearer secret, no cron, no MCP door).
 * Body: { device_id, verb, params?, approval_ref?, ttl_s? } and nothing else. `verb` must be one of the 13 in lib/fleet/verbs.ts and `params` its closed shape; there is no
 * free-form command text. A privileged verb in clinic hours (07:30-21:30 IST), or restart_recorder with force, needs `approval_ref`. The server signs envelope v2 with the key in
 * FLEET_COMMAND_SIGNING_KEY; every enqueue writes a fleet_audit row. It queues; the helper fetches it on its next poll. Nothing is sent to a Mac from here.
 * 200 {ok, cmd_id, expires_at} · 400 bad body / verb_not_allowed / bad_params / bad_ttl / bad_approval_ref / approval_required · 401 admin_required · 404 unknown_device ·
 * 409 device_revoked | outstanding | duplicate | session_open · 429 rate_limited · 503 signer_not_configured | db.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { issueCommand } from "@/lib/fleet/commands";
import { fleetError, fleetReply, readCapped } from "@/lib/fleet/http";
import { loadSigner } from "@/lib/fleet/signing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const BODY_KEYS = new Set(["device_id", "verb", "params", "approval_ref", "ttl_s"]);
const STATUS: Record<string, number> = { unknown_device: 404, device_revoked: 409, outstanding: 409, duplicate: 409, session_open: 409, rate_limited: 429 };

export async function POST(req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return fleetError(401, "admin_required");
  let adminId: string;
  try {
    const claims = await verifyAdminJwt(cookie);
    adminId = String(claims.admin_id ?? "").slice(0, 64);
    if (!adminId) return fleetError(401, "admin_required");
  } catch {
    return fleetError(401, "admin_required");
  }
  const signer = loadSigner();
  if (!signer) return fleetError(503, "signer_not_configured");

  const text = await readCapped(req, 4096);
  if (text === null) return fleetError(413, "too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fleetError(400, "bad_json");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fleetError(400, "bad_body");
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !BODY_KEYS.has(k))) return fleetError(400, "bad_body"); // no other field exists, ever
  if (typeof b.device_id !== "string" || !/^dev_[a-f0-9]{24}$/.test(b.device_id)) return fleetError(400, "bad_device_id");

  try {
    const r = await issueCommand(sql as never, signer, {
      device_id: b.device_id, verb: b.verb, params: b.params, approval_ref: b.approval_ref, ttl_s: b.ttl_s, issuer: { kind: "operator", id: adminId },
    });
    return r.ok ? fleetReply(200, { ok: true, cmd_id: r.cmd_id, expires_at: r.expires_at }) : fleetError(STATUS[r.reason] ?? 400, r.reason);
  } catch (e) {
    console.error("[admin-fleet-commands] database fault:", e instanceof Error ? e.message.slice(0, 200) : "error");
    return fleetError(503, "db");
  }
}
