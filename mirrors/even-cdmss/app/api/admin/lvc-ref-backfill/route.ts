/**
 * GET/POST /api/admin/lvc-ref-backfill — one-shot re-stamp of rule_ref on EXISTING low-value findings
 * (RIGHT-CARE-INDICATOR-PRD §2.2 decision 14 companion). The 0.81.4 engine matcher stamps rule_ref on
 * NEW audits; this fills the ~684 stored signal_type='low_value_care' findings whose rule_ref is NULL,
 * by running the SAME deterministic keyword matcher over the stored findings jsonb. No re-audit, no
 * engine-version change, no scoring impact — an idempotent jsonb UPDATE. Auth: ADMIN_TOKEN or cookie.
 * No cron entry (Cowork drives it post-deploy).
 *
 * GET             = status (findings: lvc total / stamped / null_ref; cursor).
 * POST            = one batch of ≤200 candidate rows, oldest-first from the app_settings cursor.
 * POST ?reset=1   = rewind the cursor (re-sweep any rows still NULL).
 *
 * ⚠️ SQL INFERRED (no live DB here) — fail-safe: any error → 500 with a message, never a wrong write.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { matchLvcRule, classifyLvcCategory, LVC_CATEGORIES, type LvcRuleLite } from '@/lib/opd-lvc-classify-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const CURSOR_KEY = 'lvc_ref_backfill_cursor';
const EPOCH = '1970-01-01T00:00:00.000Z';
const BATCH = 200;

async function authed(req: NextRequest) {
  const denied = requireAdmin(req);
  return denied ? isAdminUnlocked().catch(() => false).then((ok) => (ok ? null : denied)) : Promise.resolve(null);
}
async function getCursor(): Promise<string> {
  const r = await run(`SELECT value FROM app_settings WHERE key = $1`, [CURSOR_KEY]).catch(() => []);
  const v = r[0]?.value ? String(r[0].value) : '';
  return v && !Number.isNaN(new Date(v).getTime()) ? v : EPOCH;
}
async function setCursor(v: string): Promise<void> {
  await run(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [CURSOR_KEY, v]).catch(() => {});
}

function parseKeywords(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string') {
    try { const j = JSON.parse(v); if (Array.isArray(j)) return j.map((x) => String(x)); } catch { /* not json */ }
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
async function loadRules(): Promise<LvcRuleLite[]> {
  const rows = await run(`SELECT id, keywords, category FROM lvc_recommendations WHERE status = 'active'`, []).catch(() => []);
  return (rows as Record<string, unknown>[]).map((r) => ({ id: String(r.id), keywords: parseKeywords(r.keywords), category: r.category == null ? null : String(r.category) }));
}

async function status(): Promise<Record<string, unknown>> {
  const rows = await run(
    `SELECT count(*) FILTER (WHERE e->>'signal_type' = 'low_value_care')::int AS lvc,
            count(*) FILTER (WHERE e->>'signal_type' = 'low_value_care' AND (e->>'rule_ref') IS NOT NULL)::int AS stamped,
            count(*) FILTER (WHERE e->>'signal_type' = 'low_value_care' AND (e->>'rule_ref') IS NULL)::int AS null_ref
     FROM opd_note_audits a
     CROSS JOIN LATERAL jsonb_array_elements(a.findings) e
     WHERE a.app_source = $1 AND jsonb_typeof(a.findings) = 'array'`, [APP]).catch(() => []);
  // 0.81.8 Part B — the lvc_category distribution (report-back: prove the sub-tags populated post-restamp).
  const dist = await run(
    `SELECT coalesce(e->>'lvc_category','(unstamped)') AS category, count(*)::int AS n
     FROM opd_note_audits a
     CROSS JOIN LATERAL jsonb_array_elements(a.findings) e
     WHERE a.app_source = $1 AND jsonb_typeof(a.findings) = 'array' AND e->>'signal_type' = 'low_value_care'
     GROUP BY 1 ORDER BY n DESC`, [APP]).catch(() => []);
  const categoryDist: Record<string, number> = {};
  for (const r of dist as Array<{ category: string; n: number }>) categoryDist[String(r.category)] = Number(r.n);
  return { ...(rows[0] || { lvc: 0, stamped: 0, null_ref: 0 }), categoryDist, cursor: await getCursor() };
}

/**
 * Run one ≤200-row batch, oldest-first from the cursor. Two modes (decision 23):
 *   'null'    (default POST)    — only FILL rule_ref where currently NULL (never overwrites a stamp).
 *   'restamp' (POST ?restamp=1) — re-evaluate ALL low_value_care findings with the CURRENT matcher and
 *                                 OVERWRITE rule_ref (including → null), fixing stale/wrong stamps.
 * Both idempotent (the matcher is deterministic). Cursor-reset mirrors the complexity backfill; run
 * `?reset=1` first to re-sweep the whole corpus.
 */
async function runBatch(mode: 'null' | 'restamp'): Promise<Record<string, unknown>> {
  const rules = await loadRules();
  const cursor = await getCursor();
  const existsPred = mode === 'restamp'
    ? `e->>'signal_type' = 'low_value_care'`
    : `e->>'signal_type' = 'low_value_care' AND (e->>'rule_ref') IS NULL`;
  const rows = await run(
    `SELECT id, note_date, findings FROM opd_note_audits
     WHERE app_source = $1 AND jsonb_typeof(findings) = 'array'
       AND note_date IS NOT NULL AND note_date > $2::timestamptz
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(findings) e
         WHERE ${existsPred}
       )
     ORDER BY note_date ASC, id ASC LIMIT ${BATCH}`, [APP, cursor]).catch(() => []) as Array<{ id: string; note_date: string; findings: unknown }>;

  const asCat = (v: unknown): string | null => (LVC_CATEGORIES as readonly string[]).includes(String(v)) ? String(v) : null;
  let processed = 0, updated = 0, stamped = 0, cleared = 0, recat = 0, lastDate = cursor;
  for (const r of rows) {
    processed++;
    lastDate = r.note_date ? new Date(r.note_date).toISOString() : lastDate;
    const findings = Array.isArray(r.findings) ? (r.findings as Array<Record<string, unknown>>) : [];
    let changed = false;
    const next = findings.map((f) => {
      if (!f || f.signal_type !== 'low_value_care') return f;
      const cur = f.rule_ref === undefined ? null : f.rule_ref;
      if (mode === 'null' && cur !== null) return f;   // null mode never touches an existing stamp
      const ref = matchLvcRule({ subject: f.subject as string, rationale: f.rationale as string | null }, rules); // may be null
      if (mode === 'null') {
        if (ref) { changed = true; stamped++; return { ...f, rule_ref: ref }; }
        return f;                                       // no match → stays null (retried on re-sweep)
      }
      // restamp (0.81.8 Part B): recompute BOTH rule_ref AND lvc_category with the current matcher/classifier
      // (the sub-tag taxonomy expanded, so a stored 'other' may now resolve to a specific overuse tag).
      const rule = ref ? rules.find((x) => x.id === ref) : null;
      const cat = (rule && asCat(rule.category)) ?? classifyLvcCategory(f.subject as string, f.rationale as string | null);
      const curCat = (f.lvc_category as string | undefined) ?? null;
      const refChanged = cur !== ref, catChanged = curCat !== cat;
      if (refChanged || catChanged) {
        changed = true;
        if (refChanged) { if (ref) stamped++; else cleared++; }
        if (catChanged) recat++;
        return { ...f, rule_ref: ref, lvc_category: cat };
      }
      return f;
    });
    if (changed) {
      await run(`UPDATE opd_note_audits SET findings = $1::jsonb WHERE id = $2`, [JSON.stringify(next), r.id]).catch(() => {});
      updated++;
    }
  }
  if (processed > 0) await setCursor(lastDate);
  const done = processed < BATCH;
  return { mode, processed, updated, stamped, cleared, recat, done, cursor: lastDate, note: done ? 'sweep drained; POST ?reset=1 to re-sweep' : `more remain — POST again${mode === 'restamp' ? ' ?restamp=1' : ''}` };
}

export async function GET(req: NextRequest) {
  const denied = await authed(req);
  if (denied) return denied;
  try { return NextResponse.json({ ok: true, ...(await status()) }); }
  catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}

export async function POST(req: NextRequest) {
  const denied = await authed(req);
  if (denied) return denied;
  try {
    if (req.nextUrl.searchParams.get('reset') === '1') { await setCursor(EPOCH); return NextResponse.json({ ok: true, reset: true, ...(await status()) }); }
    const mode = req.nextUrl.searchParams.get('restamp') === '1' ? 'restamp' : 'null';
    return NextResponse.json({ ok: true, ...(await runBatch(mode)) });
  } catch (e) { return NextResponse.json({ ok: false, error: String((e as Error).message) }, { status: 500 }); }
}
