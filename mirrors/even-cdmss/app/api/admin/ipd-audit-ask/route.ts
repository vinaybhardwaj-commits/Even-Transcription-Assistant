/**
 * /api/admin/ipd-audit-ask — the persisted conversation on an IPD discharge-audit case
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P1 / §3, O4 / O6 / O7 / O8).
 *
 * The parked IPD case page had no Ask box. This is the first one, on the same shared shell as the
 * OPD route — extracted from the R9 readmission pattern, importing no readmission file (O3).
 *
 *   GET  ?audit_id=…    the persisted thread (acceptance #1).
 *   POST { audit_id, question }
 *        · The SERVER is the thread's truth; any `history` in the body is IGNORED.
 *        · O7 — over 40 agent turns on this thread in one IST day, the refusal is STORED as a
 *          withheld turn and no model call is made (acceptance #3).
 *        · An uncited claim about the case is WITHHELD by code (acceptance #5).
 *
 * §3.3 / acceptance #2 — WHAT THIS ROUTE CANNOT DO. It reads `ipd_discharge_audits` and writes
 * `case_ask_turns`. It never writes `care_value_index`, `band`, `completeness_pct`,
 * `ipd_audit_feedback`, EpisodeState or MemberState; it never triggers a run (O11 — that is P3's
 * job, under its own named engine version, and never from a chat turn). `ip_uid`, `document_id` and
 * `member_id` are deliberately NOT in the SELECT below: the material is de-identified because the
 * identifying columns are never read.
 *
 * O6 — the thread key is the audit ROW id plus the row's engine version, which for the parked rows
 * is 'ipd-discharge-audit/0.2'. Reading it from the row rather than pinning the literal is what
 * keeps this key valid after P3: P3 APPENDS rows under 'ipd-stay-audit/0.1', and those rows open
 * their own thread rather than inheriting an argument about the discharge-only numbers, while the
 * 0.2 rows and their threads stay exactly as they are.
 *
 * P3.1 (addendum A7) — THE MATERIAL IS THE READING THE PAGE LEADS WITH. One row is opened, by the
 * id in the URL, and everything the box says comes from that row: its findings, its numbers, and —
 * new here — the `stayCoverage` its own report stores, which is the same block the stay panel on
 * the page renders. Nothing is borrowed from the sibling row: a stay-level reading and a
 * discharge-only reading are two different audits with two different Care-Value Indices, and an
 * answer citing one while the page renders the other would be the same contradiction A7 caught,
 * moved rather than fixed. The thread key is untouched, so every thread stored before this ship
 * stays readable under its own (case, engine) key.
 *
 * ⚠️ INFERRED SQL: this sandbox has no live Neon. The one query below is listed verbatim in the
 * slice report for validation against the live system.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import type { StayAuditReport } from '@/lib/ipd-audit/assemble';
import { probeReachable } from '@/lib/lab-override';
import { normaliseQuestion } from '@/lib/case-ask-core';
import { ipdAskMaterial, type IpdAuditMaterialRow } from '@/lib/case-ask/ask';
import { serveCaseAskAnswer, serveCaseAskThread, type CaseAskLoad } from '@/lib/case-ask/serve';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** O6's fallback when the row's engine_version column is empty — the parked engine, named. */
const IPD_ENGINE_FALLBACK = 'ipd-discharge-audit/0.2';
/** O8 — role-only attribution; this ship does not invent a person. */
const ACTOR = 'admin';

/** The stored report. Typed as the STAY report — the superset that may carry `stayCoverage` — so
 *  a 0.2 row simply has none and the discharge-only reading is described honestly (P3.1). */
function parseReport(v: unknown): StayAuditReport | null {
  if (v == null) return null;
  if (typeof v !== 'string') return v as StayAuditReport;
  try { return JSON.parse(v) as StayAuditReport; } catch { return null; }
}

/** Load ONE IPD audit row and turn it into material. A miss is a 404 that never reaches the model
 *  or the store; a DB fault is a 503 rather than a thread opened against nothing. */
function loadIpdCase(auditId: string): () => Promise<CaseAskLoad> {
  return async () => {
    let rows: Record<string, unknown>[];
    try {
      rows = await run(
        `SELECT engine_version, care_value_index, band, completeness_pct, findings, report
           FROM ipd_discharge_audits WHERE id = $1 LIMIT 1`,
        [auditId],
      );
    } catch {
      return { ok: false, status: 503, error: 'the case could not be read' };
    }
    const r = rows[0] as (IpdAuditMaterialRow & { report?: unknown }) | undefined;
    if (!r) return { ok: false, status: 404, error: 'not found' };
    const engineVersion = String(r.engine_version ?? '') || IPD_ENGINE_FALLBACK;
    const report = parseReport(r.report);
    // P3.1 — this row's OWN coverage, or null. A 0.2 row has none and says so; a stay row has the
    // block the page renders beside this box.
    const coverage = report?.stayCoverage ?? null;
    return { ok: true, engineVersion, material: ipdAskMaterial(r, report, engineVersion, coverage) };
  };
}

async function authorised(req: NextRequest): Promise<NextResponse | null> {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  return null;
}

const isAuditId = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

export async function GET(req: NextRequest) {
  const denied = await authorised(req);
  if (denied) return denied;
  const id = String(req.nextUrl.searchParams.get('audit_id') ?? '').trim();
  if (!isAuditId(id)) return NextResponse.json({ ok: false, error: 'bad audit id' }, { status: 400 });
  const { status, body } = await serveCaseAskThread({ caseType: 'ipd', caseKey: id, actor: ACTOR, load: loadIpdCase(id) });
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
  const denied = await authorised(req);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }

  const id = String(body.audit_id ?? '').trim();
  if (!isAuditId(id)) return NextResponse.json({ ok: false, error: 'bad audit id' }, { status: 400 });
  const q = normaliseQuestion(body.question);
  if (!q.ok) return NextResponse.json({ ok: false, error: q.error }, { status: 400 });
  // F11 — unserved means withhold, never a quiet fallback to some other model.
  if (!probeReachable('bedrock')) return NextResponse.json({ ok: false, error: 'the agent is not reachable in this deployment' }, { status: 503 });

  const { status, body: payload } = await serveCaseAskAnswer({
    caseType: 'ipd', caseKey: id, actor: ACTOR, load: loadIpdCase(id), question: q.question,
  });
  return NextResponse.json(payload, { status });
}
