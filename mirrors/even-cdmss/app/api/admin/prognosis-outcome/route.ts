export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/prognosis-outcome — record (or correct) a real outcome against a stored
 * prognosis block. PX Phase 2 PRD §5.3 / P-3 (manual entry only) / P-7 (supersede, never update).
 *
 * The CLASSIFICATION IS DERIVED HERE, server-side, from the form state — never read from the body.
 * A client that typed one is ignored: deriving removes a class of entry error, and the derivation
 * (lib/prognosis-outcomes-core.ts) also FORCES matched_complication_hash to NULL on
 * no_adverse_outcome, whatever the form held.
 *
 * With `supersedesId` present the store runs the one-statement atomic supersede (P-7): the old row
 * gets `superseded = TRUE`, the new one carries `supersedes_id`, and a raced/foreign/vanished old
 * row refuses rather than dangling. Without it, a plain append.
 *
 * Auth: ADMIN_TOKEN (Bearer / ?token=) OR a logged-in admin session cookie — the review-route
 * pattern. Attribution (P-9) is required and validated server-side as well as in the UI.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { cleanAttribution, ATTRIBUTION_REQUIRED_ERROR } from '@/lib/admin-attribution';
import { deriveClassification, isOutcomeSource, isComplicationHash } from '@/lib/prognosis-outcomes-core';
import {
  insertOutcome, supersedeOutcome, isOutcomeSourceTable, type PrognosisOutcomeInput,
} from '@/lib/prognosis-outcomes-store';

const bad = (error: string) => NextResponse.json({ ok: false, error }, { status: 400 });

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) {
    return NextResponse.json({ ok: false, error: 'admin required' }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try { body = (await req.json()) as Record<string, unknown>; }
  catch { return bad('invalid JSON body'); }

  const sourceTable = body.sourceTable;
  if (!isOutcomeSourceTable(sourceTable)) return bad('bad sourceTable');
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim().slice(0, 200) : '';
  if (!sourceId) return bad('bad sourceId');
  const sourceEngine = typeof body.sourceEngine === 'string' && body.sourceEngine.trim()
    ? body.sourceEngine.trim().slice(0, 100) : null;

  const source = body.source;
  if (!isOutcomeSource(source)) return bad('bad source — complaint|readmission|revisit|reoperation|call|other');

  const observedOutcome = typeof body.observedOutcome === 'string' ? body.observedOutcome.trim().slice(0, 4000) : '';
  if (!observedOutcome) return bad('Describe the outcome — an empty observation is not an observation.');

  const observedAt = typeof body.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.observedAt)
    ? body.observedAt : null;

  // §5.3 defines no horizon field on the form; the column exists for later channels. NULL in v1.
  const horizonDays = null;

  const rawHash = body.matchedComplicationHash;
  const matchedComplicationHash = rawHash == null || rawHash === '' ? null
    : isComplicationHash(rawHash) ? rawHash : undefined;
  if (matchedComplicationHash === undefined) return bad('bad matchedComplicationHash');
  const rawIdx = body.matchedComplication;
  const matchedComplication = rawIdx == null ? null
    : Number.isInteger(rawIdx) && (rawIdx as number) >= 0 ? (rawIdx as number) : null;

  const reviewedByName = cleanAttribution(body.reviewedByName);
  if (!reviewedByName) return bad(ATTRIBUTION_REQUIRED_ERROR);

  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 4000) : null;

  // Derived, never typed (§5.3). no_adverse_outcome forces the hash to NULL — and the advisory
  // integer goes with it, so the two columns cannot disagree about whether anything was matched.
  const derived = deriveClassification({
    noAdverseOutcome: body.noAdverseOutcome === true,
    benefitFailure: body.benefitFailure === true,
    matchedComplicationHash,
  });
  const input: PrognosisOutcomeInput = {
    sourceTable, sourceId, sourceEngine, source,
    observedOutcome, observedAt, horizonDays,
    matchedComplication: derived.matchedComplicationHash == null ? null : matchedComplication,
    matchedComplicationHash: derived.matchedComplicationHash,
    classification: derived.classification,
    reviewedByName, notes,
  };

  const supersedesRaw = body.supersedesId;
  const supersedesId = supersedesRaw == null ? null : Number(supersedesRaw);
  if (supersedesId != null && (!Number.isInteger(supersedesId) || supersedesId <= 0)) return bad('bad supersedesId');

  const result = supersedesId != null
    ? await supersedeOutcome(input, supersedesId)
    : await insertOutcome(input);

  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true, id: result.id, classification: derived.classification });
}
