export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { listFrozenAdhocSets, promotionDecisions, recordPromotion, AdhocNotMigrated } from '@/lib/proms/adhoc-store';
import { groupAdhocForReview, suggestSetName, PROMOTION_THRESHOLD } from '@/lib/proms/adhoc-review-core';

async function adminOk(req: NextRequest): Promise<boolean> {
  const denied = requireAdmin(req);
  return !denied || (await isAdminUnlocked().catch(() => false));
}

/**
 * GET — the Tier-3 adhoc review queue: frozen adhoc sets grouped by procedure with a promotion
 * candidate (recurring selection ≥ threshold) vs collecting verdict, overlaid with prior promote/dismiss
 * decisions. DARK behind TIER3_ENABLED. Admin only. Read-only, soft-fails to an empty queue.
 */
export async function GET(req: NextRequest) {
  if (process.env.TIER3_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await adminOk(req))) return NextResponse.json({ error: 'admin token required' }, { status: 401 });

  const [rows, decisions] = await Promise.all([listFrozenAdhocSets(), promotionDecisions()]);
  const candidates = groupAdhocForReview(rows).map((c) => ({
    ...c,
    suggestedName: suggestSetName(c.procedureLabel),
    decision: decisions[c.procedureKey]?.action ?? null,          // 'promote' | 'dismiss' | null
  }));
  return NextResponse.json({ ok: true, threshold: PROMOTION_THRESHOLD, candidates });
}

/**
 * POST — the ONLY review-queue write. { action:'promote'|'dismiss', procedure_key, proposed_name?,
 * item_ids?, recurrence_count? }. Promote PROPOSES a named set to V (a proposal row — NEVER a live
 * hs-sets change). Dismiss closes the candidate. Admin only. Table missing ⇒ 503.
 */
export async function POST(req: NextRequest) {
  if (process.env.TIER3_ENABLED !== '1') return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (!(await adminOk(req))) return NextResponse.json({ error: 'admin token required' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }

  const action = String(body.action ?? '').trim();
  const procedure_key = String(body.procedure_key ?? '').trim();
  if (action !== 'promote' && action !== 'dismiss') return NextResponse.json({ error: "action must be 'promote' or 'dismiss'" }, { status: 400 });
  if (!procedure_key) return NextResponse.json({ error: 'procedure_key required' }, { status: 400 });

  const item_ids = Array.isArray(body.item_ids) ? (body.item_ids as unknown[]).map((x) => String(x)) : [];
  const proposed_name = body.proposed_name ? String(body.proposed_name) : (action === 'promote' ? suggestSetName(procedure_key) : null);
  const recurrence_count = Number.isFinite(Number(body.recurrence_count)) ? Number(body.recurrence_count) : null;
  const id = `adhprom:${action}:${procedure_key}:${recurrence_count ?? 0}`;   // deterministic per decision

  try {
    await recordPromotion({ id, procedure_key, action, proposed_name, item_ids, recurrence_count });
    return NextResponse.json({ ok: true, action, procedure_key, proposed_name });
  } catch (e) {
    if (e instanceof AdhocNotMigrated) return NextResponse.json({ error: 'not migrated — run /api/admin/migrate-adhoc-sets' }, { status: 503 });
    return NextResponse.json({ ok: false, error: String((e as Error).message || e) }, { status: 500 });
  }
}
