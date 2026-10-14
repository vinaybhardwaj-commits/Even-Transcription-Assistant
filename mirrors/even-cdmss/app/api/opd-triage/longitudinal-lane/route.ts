/**
 * GET /api/opd-triage/longitudinal-lane — the Stage 3 LABEL-ONLY lane (PRD §6 / normative triage mockup).
 *
 * Corpus-wide informational longitudinal findings (the 5 non-routable `longitudinal_*` types), grouped by
 * signal_type, each overlaid with (a) its current CM validity label and (b) a promotion-gate meter fed from
 * the SAME signal-health FP-rate the /care/triage/health panel shows. Label-only: the CM marks a type
 * valid_signal | audit_bug to earn it promotion — no route, no response. The gate never auto-promotes.
 *
 * Reads ONLY opd_note_audits.longitudinal (own DB, existing column). All the lane logic is the shipped
 * opd-triage-core primitives (buildLabelLane / promotionGate / isRoutable) — imported, never re-implemented.
 * Soft-fails to an empty lane; never 500s. Dark: OPD_LONGITUDINAL_ENABLED !== '1' → empty lane (enabled:false).
 * Auth: care-manager session cookie OR admin.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { isCareUnlocked } from '@/lib/care-cookie';
import { OPD_ENGINE_VERSION, OPD_ENGINE_VERSIONS_CURRENT, type OpdFinding } from '@/lib/opd-note-audit-core';
import { parseJson } from '@/lib/opd-audit-ui';
import { buildLabelLane, type TriageFinding } from '@/lib/opd-triage-core';
import { loadTriageDecisions, loadTypeDecisions } from '@/lib/opd-triage-store';
import { computeSignalHealth } from '@/lib/signal-health-core';
import { buildLongitudinalGates } from '@/lib/opd-longitudinal-lane-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const APP = process.env.APP_SOURCE || 'standalone';
const ENGINE_FAMILY: string[] = [...OPD_ENGINE_VERSIONS_CURRENT];

async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}
function addDays(day: string, delta: number): string {
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10);
}

const EMPTY = (enabled: boolean, window: { from: string; to: string; days: number }) => NextResponse.json({
  ok: true, enabled, engine: OPD_ENGINE_VERSION, window,
  counts: { types: 0, instances: 0 }, types: [],
  advisory: 'Informational, context-aware longitudinal findings — they do not route to a doctor and do not affect the score. A validity label is how a type earns promotion to the scored plane (FP-rate < 20% over ≥ 50 labelled).',
});

export async function GET(req: NextRequest) {
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const days = Math.max(1, Math.min(30, Number(sp.get('days')) || 7));   // default: this week
  let day = sp.get('day') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const latest = await run(
      `SELECT to_char(max((note_date AT TIME ZONE 'Asia/Kolkata')::date),'YYYY-MM-DD') d
       FROM opd_note_audits WHERE app_source = $1 AND engine_version = ANY($2) AND longitudinal IS NOT NULL`,
      [APP, ENGINE_FAMILY]).catch(() => []);
    day = String(latest[0]?.d || new Date().toISOString().slice(0, 10));
  }
  const from = addDays(day, -(days - 1));
  const to = day;
  const window = { from, to, days };

  // Dark ship: flag off → empty lane (the board hides the tab, staying byte-identical to today).
  if (process.env.OPD_LONGITUDINAL_ENABLED !== '1') return EMPTY(false, window);

  try {
    // Read the window's longitudinal blocks (own DB, existing column). Findings inside the block already
    // carry the correct longitudinal signal_type + finding_ref from write-time stampLongitudinal — we do
    // NOT re-stamp (stampFindingIdentity would clobber the 5-type vocabulary back to the scored plane).
    const rows = await run(
      `SELECT id::text AS id, doctor_uid, to_char(note_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS note_date, longitudinal
       FROM opd_note_audits
       WHERE app_source = $1 AND engine_version = ANY($2) AND longitudinal IS NOT NULL
         AND (note_date AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $3 AND $4
       LIMIT 8000`,
      [APP, ENGINE_FAMILY, from, to]).catch(() => []);

    const findings: TriageFinding[] = [];
    const citedByRef = new Map<string, string>();       // finding_ref → the cited-date provenance line (evidence[0])
    const docByType = new Map<string, string>();         // signal_type → representative doctor_uid (first-seen; matches buildLabelLane)
    for (const r of rows as Record<string, unknown>[]) {
      const audit_id = String(r.id);
      const doctor_uid = r.doctor_uid ? String(r.doctor_uid) : '';
      const note_date = String(r.note_date || day);
      const block = parseJson<{ findings?: OpdFinding[] }>(r.longitudinal, {});
      const fs = Array.isArray(block?.findings) ? block!.findings! : [];
      for (const f of fs) {
        const signal_type = (f as { signal_type?: string }).signal_type || '';
        const finding_ref = (f as { finding_ref?: string }).finding_ref || '';
        if (!signal_type || !finding_ref) continue;
        if (!docByType.has(signal_type) && doctor_uid) docByType.set(signal_type, doctor_uid);
        const cited = Array.isArray(f.evidence) && f.evidence[0] ? String(f.evidence[0]) : '';
        if (cited) citedByRef.set(finding_ref, cited);
        findings.push({
          audit_id, doctor_uid, note_date,
          subject: f.subject, rationale: f.rationale, verdict: f.verdict, domain: f.domain,
          signal_type, finding_ref,
          informational: f.informational, citation_ids: f.citation_ids,
        });
      }
    }

    const doctorUids = [...new Set(findings.map((f) => f.doctor_uid).filter(Boolean))];
    const [decisions, typeDecisions] = await Promise.all([
      loadTriageDecisions(doctorUids).catch(() => []),
      loadTypeDecisions(365).catch(() => []),                         // corpus-wide labelled history for the gate
    ]);
    const health = computeSignalHealth(typeDecisions, { recentDays: 14 });
    const gates = buildLongitudinalGates(health);

    // The shipped primitive does all the work: partition non-routable by type, overlay the type label +
    // promotion gate. We only enrich the view model with the rep doctor_uid (for the label write) and the
    // cited-date line (which the LabelLaneInstance projection doesn't carry).
    const { types } = buildLabelLane(findings, decisions, { gates });
    const enriched = types.map((t) => ({
      ...t,
      doctor_uid: docByType.get(t.signal_type) || '',
      instances: t.instances.map((i) => ({ ...i, cited: citedByRef.get(i.finding_ref) || null })),
    }));
    const instanceTotal = enriched.reduce((n, t) => n + t.count, 0);

    return NextResponse.json({
      ok: true, enabled: true, engine: OPD_ENGINE_VERSION, window,
      counts: { types: enriched.length, instances: instanceTotal },
      types: enriched,
      advisory: 'Informational, context-aware longitudinal findings — they do not route to a doctor and do not affect the score. A validity label is how a type earns promotion to the scored plane (FP-rate < 20% over ≥ 50 labelled).',
    });
  } catch {
    return EMPTY(true, window);   // soft-fail to an empty (enabled) lane; never 500
  }
}
