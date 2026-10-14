/**
 * app/api/admin/lvc-ratify/accept/route.ts — LVC RULEBOOK REPAIR PRD v1.1 §3.5 (D-18, D-20).
 *
 * ⚠️ THIS ROUTE WRITES PRODUCTION CLINICAL RULES AND THERE IS NO UNDO (§1.2, D-20).
 *
 * ONE RULE PER CALL. There is deliberately NO bulk path: the body names a single `section`, an
 * array is refused, and no "accept all" affordance exists anywhere in this build. 19 rules reviewed
 * one at a time is the point of the sitting (§3.5), so making it convenient would defeat it.
 *
 * WRITE SEQUENCE, in order (see lib/lvc-ratify-surface-core.ts for the detail):
 *   1. readback of the survivor + every absorbed id — a failure here writes NOTHING;
 *   2. UPDATE the survivor (guarded IS DISTINCT FROM);
 *   3. UPDATE each absorbed id → status='retired', merged_into=<survivor> (guarded);
 *   4. verification readback;
 *   5. INSERT the ledger anchor row — which carries the survivor's PREVIOUS statement,
 *      precondition, keywords, category and citation as JSON in `evidence_note` — then INSERT the
 *      lvc_ratifications row, which carries the ratifier, the rationale and the decision and none
 *      of the previous values. That split is forced by the schema: a ratification cannot exist
 *      without a proposal to point at. GET /api/admin/lvc-ratify/state reads the payload back
 *      (PRD A-1); before A-1 it was written and unreachable.
 * Step 5 is SKIPPED when steps 2–3 changed nothing, so pressing accept twice is genuinely inert
 * rather than filling an append-only ledger with identical rows.
 *
 * There are no transactions (Neon HTTP). A partial failure therefore returns exactly which rows
 * landed and which did not, with the rule reported as `partially_applied` — never a bare 500, and
 * never a success that hides a half-applied merge (§6.10).
 *
 * decision='reject' writes NOTHING to lvc_recommendations and appends a rejection with a required
 * reason. The cluster stays as it is.
 *
 * ?dry=1 plans the merge and writes nothing at all.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { sql } from '@/lib/db';
import { acceptRuleMerge, rejectRule, getRecordSet } from '@/lib/lvc-ratify-surface-core';
import type { MergedRule, SqlRunner } from '@/lib/lvc-rule-merge';

export const runtime = 'nodejs';
export const maxDuration = 60;

const run = sql as unknown as SqlRunner;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The on-screen values replace the draft's CONTENT only. `id` and `absorbs` come from the record
 *  set and are never taken from the request body: the merge topology is evidence V reviews, not a
 *  field the browser may rewrite, and accepting a body-supplied `absorbs` would let a malformed
 *  request retire arbitrary rules. */
function mergeEdits(draft: MergedRule, body: Record<string, unknown>): MergedRule {
  const kw = Array.isArray(body.keywords) ? body.keywords.map((k) => String(k).trim()).filter(Boolean) : draft.keywords;
  const citation = body.citation_url === null ? null : (str(body.citation_url) || draft.citation_url);
  return {
    section: draft.section,
    id: draft.id,
    statement: str(body.statement) || draft.statement,
    precondition: str(body.precondition) || draft.precondition,
    keywords: kw,
    category: str(body.category) || draft.category,
    citation_url: citation,
    absorbs: draft.absorbs,
  };
}

export async function POST(req: NextRequest) {
  if (!(await isAdminUnlocked())) { const denied = requireAdmin(req); if (denied) return denied; }

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return NextResponse.json({ ok: false, error: 'a JSON body is required' }, { status: 400 }); }

  // NO BULK. An array body, or a `sections` plural, is refused rather than quietly serialised.
  if (Array.isArray(body) || Array.isArray((body as Record<string, unknown>).sections)) {
    return NextResponse.json({
      ok: false,
      error: 'accept is per rule — there is no bulk accept and none will be added (§3.5). Send one `section`.',
    }, { status: 400 });
  }

  const section = str(body.section);
  if (!section) return NextResponse.json({ ok: false, error: '`section` is required — name the single rule being accepted' }, { status: 400 });

  const setKey = str(body.set) || undefined;
  const set = getRecordSet(setKey);
  const draft = set.records.find((r) => r.section === section);
  if (!draft) {
    return NextResponse.json({ ok: false, error: `no rule '${section}' in record set '${set.key}'` }, { status: 404 });
  }

  const record = mergeEdits(draft, body);
  const ratifiedBy = str(body.ratified_by);
  const rationale = str(body.rationale);
  const decision = str(body.decision) === 'reject' ? 'reject' : 'accept';

  try {
    if (decision === 'reject') {
      const result = await rejectRule(run, { record, ratifiedBy, rationale, reason: str(body.reason), recordSetKey: set.key });
      return NextResponse.json({ decision: 'reject', ...result }, { status: result.ok ? 200 : 400 });
    }
    const dryRun = req.nextUrl.searchParams.get('dry') === '1';
    const result = await acceptRuleMerge(run, { record, ratifiedBy, rationale, recordSetKey: set.key, dryRun });
    // A refusal (bad ratifier, invalid keyword) is a 400; a partial write is a 200 carrying ok:false
    // and the row-by-row detail, because the caller MUST be able to read what landed.
    const refused = !result.ok && result.ledger === 'not_attempted' && result.merge.rows.length === 0;
    return NextResponse.json({ decision: 'accept', ...result }, { status: refused ? 400 : 200 });
  } catch (e) {
    return NextResponse.json({
      ok: false, section, survivor_id: record.id, ledger: 'not_attempted',
      error: `accept failed before or during the write: ${String((e as Error).message).slice(0, 300)} — re-read /api/admin/lvc-ratify/state to see what landed`,
    }, { status: 200 });
  }
}
