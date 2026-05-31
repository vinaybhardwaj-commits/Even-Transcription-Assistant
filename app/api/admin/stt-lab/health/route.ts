/** GET /api/admin/stt-lab/health — probe every registered STT engine via its adapter. */
import { NextRequest } from "next/server";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { listEngines, adapterFor } from "@/lib/stt/registry";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(_req: NextRequest) {
  const cookie = await readAdminCookie();
  if (!cookie) return respondError("AUTH_REQUIRED", "Sign in required");
  try { await verifyAdminJwt(cookie); } catch { return respondError("AUTH_EXPIRED", "Session invalid"); }

  const engines = await listEngines();
  const results = await Promise.all(engines.map(async (e) => {
    const adapter = adapterFor(e.adapter_key);
    let health: { ok: boolean; latencyMs: number; error?: string };
    if (!adapter) {
      health = { ok: false, latencyMs: 0, error: "no_adapter_registered" };
    } else {
      try { health = await adapter.health(); }
      catch (err) { health = { ok: false, latencyMs: 0, error: String(err).slice(0, 120) }; }
    }
    return {
      id: e.id,
      display_name: e.display_name,
      adapter_key: e.adapter_key,
      enabled: e.enabled,
      fanout_enabled: e.fanout_enabled,
      is_paid: e.is_paid,
      cost_per_min_usd: e.cost_per_min_usd,
      capabilities: e.capabilities_json,
      has_adapter: !!adapter,
      health,
    };
  }));
  return respondOk({ engines: results, checked_at: new Date().toISOString() });
}
