/**
 * GET /api/admin/reasoning-registry — the reasoning-config research export (Reasoning
 * Observability Stage 0). Serves renderRegistryExport(): the generated prompt registry
 * (27 standing prompts + rubrics + user-message builders, sha256-hashed) merged with the
 * sidecar manifest metadata. Prompt/rubric/metadata ONLY — no clinical data, no run/trace
 * content, no PHI (enforced structurally in registry-core + by test).
 *
 * ?format=json (default; served as a download) | html (readable, inline).
 * Auth: the cat_admin session cookie (isAdminUnlocked — the same fail-closed gate as the
 * observability surface this is linked from). Locked → 403.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { renderRegistryExport, renderRegistryHtml } from '@/lib/reasoning/registry-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked().catch(() => false))) {
    return NextResponse.json({ error: 'locked' }, { status: 403 });
  }
  const format = req.nextUrl.searchParams.get('format') === 'html' ? 'html' : 'json';
  const payload = renderRegistryExport();
  if (format === 'html') {
    return new NextResponse(renderRegistryHtml(payload), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="cdmss-reasoning-registry.json"',
    },
  });
}
