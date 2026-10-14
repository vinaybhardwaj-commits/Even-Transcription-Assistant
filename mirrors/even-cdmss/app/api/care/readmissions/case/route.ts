/**
 * GET /api/care/readmissions/case?dedup_key=… — the read behind the `Download case
 * brief · .md` button (CDMSS-READMISSIONS-R1-PRD v1.1 §6, decision 14).
 *
 * READ-ONLY, same env gates and unlock as the list route. Reads ONE finding row PINNED to
 * READMIT_ENGINE_VERSION — never "pick latest" — and the two extract subsets the brief
 * needs (index + readmit document, by the ids stored on the finding's provenance).
 * Unknown key → 404 { ok: false }. An extract-store fault → the extracts are null and the
 * brief is thinner; a finding-store fault reads as "no row" → 404. Never a 500.
 *
 * Identity is NOT re-joined here: the board already resolved it for the card (decision 13,
 * KX-first) and overlays it on this row before composing. The `row` this returns is the
 * pinned finding — the facts the brief must not get from anywhere else. No model call.
 *
 * R3 (READMISSIONS-R3 PRD v1.0 §3.4): the two stays' HOSPITAL BILLS, grouped by service_type,
 * read fresh from db13 kx_billing_records in the same Promise.all as the extracts —
 * `indexBill` / `readmitBill` (breakdown shape or null; OON: readmit skipped → null). The
 * row's own `returnBill` value object is derived from the readmit breakdown so card and brief
 * apply ONE state rule (returnBillFor). A db13 fault → ok:false → the brief prints
 * "not available" and the cell reads unknown. Never a 500. Encounter ids stay off the client.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { isCareUnlocked } from '@/lib/care-cookie';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { fetchFindingForSurface, READMIT_ENGINE_VERSION } from '@/lib/readmission/store';
import { fetchExtractedCases } from '@/lib/discharge-extract-store';
import { fetchStayBillBreakdown, type StayBillBreakdown } from '@/lib/readmission/db13';
import { asJson, indexDocumentIdOf, readmitDocumentIdOf, returnContextOf, toFinding, toIndexCaseSummary } from '@/lib/readmission/surface-row';
import { toExtractSubset } from '@/lib/readmission/brief';
import { returnBillFor, toFindingClass, whyFlaggedLines, type FindingBlob } from '@/lib/readmission-surface-core';
import { renderableNarrative, type CaseArtefacts } from '@/lib/readmission-narrative-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function enabled(): boolean {
  return process.env.CCB_ENABLED === '1' && process.env.READMISSIONS_SURFACE_ENABLED === '1';
}
async function authed(): Promise<boolean> {
  try { if (await isCareUnlocked()) return true; } catch { /* fall through */ }
  try { return await isAdminUnlocked(); } catch { return false; }
}

/** The dedup key shape (readmission-detect-core: `<index>|<readmit>` or `<index>|form:<uid>`). */
const isDedupKey = (s: string) => s.length >= 3 && s.length <= 200 && /^[A-Za-z0-9/_:|.-]+$/.test(s);

export async function GET(req: NextRequest) {
  if (!enabled()) return NextResponse.json({ ok: false, error: 'disabled' }, { status: 404 });
  if (!(await authed())) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const key = (req.nextUrl.searchParams.get('dedup_key') ?? '').trim();
  if (!key || !isDedupKey(key)) return NextResponse.json({ ok: false, error: 'bad key' }, { status: 400 });

  // Decision 14: pinned to the engine version. Absent row and unreachable store both 404 —
  // the board keeps the card and downloads the thinner brief.
  const r = await fetchFindingForSurface(key, READMIT_ENGINE_VERSION);
  if (!r) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const blob = asJson<FindingBlob>(r.finding);
  const indexDocId = indexDocumentIdOf(blob);
  const readmitDocId = readmitDocumentIdOf(blob);
  const findingClass = toFindingClass(r.finding_class);
  const indexId = String(r.index_encounter_id);
  const readmitId = r.readmit_encounter_id == null ? null : String(r.readmit_encounter_id);
  // R3 §3.4: extracts + the two bill breakdowns together; every member resolves rather than
  // rejects (empty map / null / ok:false). OON: no Even return stay → readmit breakdown skipped.
  const [extracts, indexBill, readmitBill] = await Promise.all([
    fetchExtractedCases([indexDocId, readmitDocId].filter((d): d is string => d != null)),
    fetchStayBillBreakdown(indexId),
    findingClass === 'out_of_network' || readmitId == null ? Promise.resolve<StayBillBreakdown | null>(null) : fetchStayBillBreakdown(readmitId),
  ]);
  const indexExtracted = indexDocId ? extracts.get(indexDocId)?.extracted ?? null : null;
  const readmitExtracted = readmitDocId ? extracts.get(readmitDocId)?.extracted ?? null : null;
  // The row's own value object, from the SAME breakdown the brief tabulates (one state rule):
  // ok:false → unknown · ok:true with no lines → not_finalised · lines → billed (R3-6).
  const returnBill = returnBillFor({
    findingClass,
    // null breakdown = nothing was looked up (no id / not id-shaped / OON) → unknown, never
    // not_finalised: "not finalised" is a claim about a stay we actually asked db13 about.
    readmitEncounterId: readmitBill == null ? null : readmitId,
    ok: readmitBill == null ? true : readmitBill.ok,
    total: readmitBill && readmitBill.ok && readmitBill.lines > 0 ? { netRs: readmitBill.totalRs, lines: readmitBill.lines } : null,
  });

  // R7: the same code-derived return context the card carries (immediate / staged markers).
  const surfaceRow = toFinding(r, undefined, toIndexCaseSummary(indexExtracted), returnBill, returnContextOf(r, blob, indexExtracted, readmitExtracted));
  // R4 (§3, additive): the stored case artefacts, RENDERED AS STORED — no model call on this
  // route, ever (R4-2). The narrative is emitted only when CODE marked it valid (R4-4); an invalid
  // one is reported by state so the page can say it was withheld and flagged. Why-flagged is
  // assembled by code from the row's detection facts.
  const art = (blob ?? {}) as CaseArtefacts;
  const narrative = renderableNarrative(art.caseNarrative ?? null);
  return NextResponse.json({
    ok: true,
    engineVersion: READMIT_ENGINE_VERSION,
    row: surfaceRow,
    indexExtract: toExtractSubset(indexExtracted),
    readmitExtract: toExtractSubset(readmitExtracted),
    /** R3: the two stays' bills by service_type (breakdown or null) — the brief's Part 2 tables. */
    indexBill,
    readmitBill,
    /** R4: code-assembled, no model. */
    whyFlagged: whyFlaggedLines(surfaceRow),
    /** R4: the ledger (every citable item), the VALID narrative or null + its state, the LVC section. */
    evidenceLedger: art.evidenceLedger ?? null,
    caseNarrative: narrative,
    narrativeState: !art.caseNarrative ? 'absent' : narrative ? 'valid' : 'invalid',
    narrativeMeta: art.caseNarrative ? { generatedAt: art.caseNarrative.generatedAt, model: art.caseNarrative.model, provider: art.caseNarrative.provider, version: art.caseNarrative.version, source: art.caseNarrative.source, invalidReason: art.caseNarrative.invalidReason ?? null } : null,
    relatedLvc: art.relatedLvc ?? null,
  });
}
