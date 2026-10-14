import { portalJson } from "@/lib/portal/forbidden-keys";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { sql } from "@/lib/db";
import { portalFlags } from "@/lib/portal-flags";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Portal home: What's new / Coming soon (R5 PRD §4) + feature flags.
 * Content managed via governance MCP tools — see /api/mcp portal-announcement tools.
 */
export async function GET() {
  const p = await getCurrentPhysician();
  if (!p) return portalJson({ ok: false, error: "Unauthorized" }, { status: 401 });
  const rows = (await sql`
    SELECT id, kind, title, body FROM portal_announcements
    WHERE active = true
      AND (starts_on IS NULL OR starts_on <= current_date)
      AND (ends_on IS NULL OR ends_on >= current_date)
    ORDER BY kind, sort ASC, created_at DESC
    LIMIT 20`) as unknown as Array<{ id: string; kind: string; title: string; body: string | null }>;
  return portalJson({
    ok: true,
    whats_new: rows.filter((r) => r.kind === "whats_new"),
    coming_soon: rows.filter((r) => r.kind === "coming_soon"),
    // WM2: the Findings flag is evaluated HERE and nowhere else — server-side, so the portal
    // bundle never carries the env name, and one fetch decides both panels' visibility.
    // A2: the same module gates the API routes, so UI visibility and endpoint access cannot drift.
    features: portalFlags(),
  });
}
