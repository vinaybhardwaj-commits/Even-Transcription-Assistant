/**
 * app/api/admin/lvc-merge-compare/route.ts — LVC RULEBOOK REPAIR PRD v1.1 §3.1 (D-12, D-19).
 *
 * READ-ONLY. THE IMPACT PANEL'S DATA. It writes NOTHING — no INSERT, no UPDATE, no DDL, and there
 * is no POST handler. It is a pure read (a findings sample + the live rulebook) plus a pure
 * function, which is why it can be run before migration 0041 has been applied.
 *
 * ADVISORY (D-19). The panel is collapsed by default and this endpoint never gates an accept.
 *
 * §6.11 — IT MAY FAIL, AND IT SAYS SO. The sample read unnests a jsonb column over the audit table
 * and can time out. It then returns `available: false` with the reason, and the screen shows
 * "impact not available". It never returns a partial comparison presented as complete: the count of
 * findings actually compared is always reported alongside the counts.
 *
 *   GET /api/admin/lvc-merge-compare?section=R7          → one rule's before/after
 *   GET /api/admin/lvc-merge-compare                     → the whole record set at once
 *   ...&notes=200        how many recent audits to read (capped)
 *   ...&engine=<version> which engine version to sample (defaults to the live one)
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { getRecordSet } from '@/lib/lvc-ratify-surface-core';
import { compareSample, summarise, type SampleFinding } from '@/lib/lvc-merge-compare';
import { parseKeywordColumn, type SqlRunner } from '@/lib/lvc-rule-merge';
import { OPD_ENGINE_VERSION } from '@/lib/opd-note-audit-core';
import type { LvcRuleLite } from '@/lib/opd-lvc-classify-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const run = sql as unknown as SqlRunner;

/** ⚠️ INFERRED. The live matcher pool, byte-for-byte the read getLvcRules performs. */
const LIVE_RULES_SQL = `SELECT id, keywords, category
  FROM lvc_recommendations
 WHERE status = 'active'`;

/** ⚠️ INFERRED. The most recent audits at one engine version. `findings` is jsonb; the low-value
 *  filter happens in JS so the SQL stays a plain indexed read and cannot be the thing that times
 *  out on a jsonb predicate. */
const SAMPLE_SQL = `SELECT uid, findings
  FROM opd_note_audits
 WHERE engine_version = $1
   AND findings IS NOT NULL
 ORDER BY audited_at DESC
 LIMIT $2`;

/** The findings worth comparing: low-value, not neutralised to informational. Exactly the set the
 *  engine stamps a rule_ref onto, so the comparison is over the population the merge affects. */
function toSample(rows: Record<string, unknown>[]): SampleFinding[] {
  const out: SampleFinding[] = [];
  for (const row of rows ?? []) {
    const noteId = String(row.uid ?? '');
    const raw = row.findings;
    let findings: unknown[];
    if (Array.isArray(raw)) findings = raw;
    else if (typeof raw === 'string') { try { const j = JSON.parse(raw); findings = Array.isArray(j) ? j : []; } catch { findings = []; } }
    else findings = [];
    for (const f of findings) {
      const fi = (f ?? {}) as Record<string, unknown>;
      if (fi.verdict !== 'low-value') continue;
      if (fi.informational === true) continue;
      out.push({
        note_id: noteId,
        subject: String(fi.subject ?? ''),
        rationale: fi.rationale == null ? null : String(fi.rationale),
        stored_rule_ref: fi.rule_ref == null ? null : String(fi.rule_ref),
      });
    }
  }
  return out;
}

export async function GET(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }

  const params = req.nextUrl.searchParams;
  const set = getRecordSet(params.get('set'));
  const section = String(params.get('section') ?? '').trim();
  const records = section ? set.records.filter((r) => r.section === section) : set.records;
  if (section && !records.length) {
    return NextResponse.json({ available: false, reason: `no rule '${section}' in record set '${set.key}'` }, { status: 404 });
  }

  const noteLimit = Math.max(10, Math.min(1000, Number(params.get('notes')) || 300));
  const engine = String(params.get('engine') ?? '').trim() || OPD_ENGINE_VERSION;

  // Both reads are fail-safe together: either we have a real comparison or we say we do not.
  let liveRules: LvcRuleLite[];
  let sample: SampleFinding[];
  try {
    const ruleRows = await run(LIVE_RULES_SQL, []);
    liveRules = ruleRows.map((r) => ({
      id: String(r.id), keywords: parseKeywordColumn(r.keywords), category: r.category == null ? null : String(r.category),
    }));
  } catch (e) {
    return NextResponse.json({
      available: false, section: section || null, engine,
      reason: `the live rulebook could not be read: ${String((e as Error).message).slice(0, 200)}`,
    });
  }
  try {
    sample = toSample(await run(SAMPLE_SQL, [engine, noteLimit]));
  } catch (e) {
    return NextResponse.json({
      available: false, section: section || null, engine,
      reason: `the findings sample could not be read: ${String((e as Error).message).slice(0, 200)}`,
    });
  }

  if (!sample.length) {
    return NextResponse.json({
      available: false, section: section || null, engine, notes_read: noteLimit,
      reason: `no low-value findings in the ${noteLimit} most recent audits at ${engine} — nothing to compare`,
    });
  }

  const compared = compareSample(sample, liveRules, records);
  return NextResponse.json({
    available: true,
    section: section || null,
    record_set: set.key,
    engine,
    notes_read: noteLimit,
    live_rules: liveRules.length,
    ...summarise(compared, Math.max(1, Math.min(25, Number(params.get('examples')) || 5))),
  });
}
