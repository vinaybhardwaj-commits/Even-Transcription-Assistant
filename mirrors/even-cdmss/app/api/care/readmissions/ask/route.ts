/**
 * POST /api/care/readmissions/ask — R4.3 "ask the agent" (CDMSS-READMISSIONS-R4.3-PRD v1.0,
 * R43-1..R43-8): a care manager's question about ONE case, answered by Opus 4.6 on Bedrock from
 * that case's STORED material only — the evidence ledger, the agent's account, the judgements,
 * the coverage, the two bills — with every citation checked by code before it is shown.
 *
 * THE FENCE (the memo's rule): this route re-audits nothing and stores nothing on the finding. It
 * reads exactly what the case route reads (the pinned finding row + the two bill breakdowns) —
 * no new db13 read beyond that set — and the conversation is EPHEMERAL: the last ≤ 6 turns come
 * back from the client as context (token-capped, oldest drop first) and nothing is persisted. Cost
 * / usage ride the trace ledger like every other model call (auditability of spend, not of chat).
 *
 * Gates: identical to the case route (both env flags + care / admin unlock). Body:
 *   { dedup_key, question (≤ 500 chars), history?: [{question, answer}] }
 * Response: { ok:true, answer, citedIds, answerable, cost } · { ok:true, withheld:true, reason,
 * copy } when the answer failed its citation check (never rendered unchecked, never silently
 * retried) · 4xx on a bad request. Never a 500 for a model fault: that is a withheld answer too.
 *
 * PHI (R43-8): the material is de-identified by construction; this route passes NO identity — no
 * name, no UHID, no encounter id — to the model (toFinding is called without an Identity).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { fetchFindingForSurface, READMIT_ENGINE_VERSION } from '@/lib/readmission/store';
import { fetchStayBillBreakdown, type StayBillBreakdown } from '@/lib/readmission/db13';
import { asJson, toFinding } from '@/lib/readmission/surface-row';
import { probeReachable } from '@/lib/lab-override';
import { returnBillFor, toFindingClass, type FindingBlob } from '@/lib/readmission-surface-core';
import type { CaseArtefacts } from '@/lib/readmission-narrative-core';
import { askMaterialFrom, answerCaseQuestion } from '@/lib/readmission/ask';
import { capHistory, normaliseQuestion, ASK_WITHHELD_COPY } from '@/lib/readmission-ask-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function enabled(): boolean {
  return process.env.CCB_ENABLED === '1' && process.env.READMISSIONS_SURFACE_ENABLED === '1';
}
async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}
const isDedupKey = (s: string) => s.length >= 3 && s.length <= 200 && /^[A-Za-z0-9/_:|.-]+$/.test(s);

export async function POST(req: NextRequest) {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { return NextResponse.json({ ok: false, error: 'bad body' }, { status: 400 }); }
  const key = String(body.dedup_key ?? '').trim();
  if (!key || !isDedupKey(key)) return NextResponse.json({ ok: false, error: 'bad key' }, { status: 400 });
  const q = normaliseQuestion(body.question);
  if (!q.ok) return NextResponse.json({ ok: false, error: q.error }, { status: 400 });
  const history = capHistory(body.history);
  if (!probeReachable('bedrock')) return NextResponse.json({ ok: false, error: 'the agent is not reachable in this deployment' }, { status: 503 });

  // The SAME reads the case route makes: the pinned finding row, then the two bills. Nothing else.
  const r = await fetchFindingForSurface(key, READMIT_ENGINE_VERSION);
  if (!r) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const blob = asJson<FindingBlob & CaseArtefacts>(r.finding);
  const findingClass = toFindingClass(r.finding_class);
  const indexId = String(r.index_encounter_id);
  const readmitId = r.readmit_encounter_id == null ? null : String(r.readmit_encounter_id);
  const [indexBill, readmitBill] = await Promise.all([
    fetchStayBillBreakdown(indexId),
    findingClass === 'out_of_network' || readmitId == null ? Promise.resolve<StayBillBreakdown | null>(null) : fetchStayBillBreakdown(readmitId),
  ]);
  const returnBill = returnBillFor({
    findingClass, readmitEncounterId: readmitBill == null ? null : readmitId, ok: readmitBill == null ? true : readmitBill.ok,
    total: readmitBill && readmitBill.ok && readmitBill.lines > 0 ? { netRs: readmitBill.totalRs, lines: readmitBill.lines } : null,
  });
  const surfaceRow = toFinding(r, undefined, null, returnBill);   // no Identity: the model never sees a name
  const material = askMaterialFrom(surfaceRow, blob, indexBill, readmitBill);

  const a = await answerCaseQuestion({ dedupKey: key, material, history, question: q.question });
  if (a.outcome === 'withheld') {
    return NextResponse.json({ ok: true, withheld: true, reason: a.reason ?? 'unresolved', invalidIds: a.verdict?.invalidIds ?? [], copy: ASK_WITHHELD_COPY, cost: a.cost });
  }
  return NextResponse.json({ ok: true, answer: a.verdict!.answer, citedIds: a.verdict!.citedIds, answerable: a.answerable !== false, cost: a.cost });
}
