import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { CLINICAL_STATE_VERSION } from '@/lib/clinical-state/schema';
import { relookClass } from '@/lib/stay-library/build';
import {
  clinicalStateIdFor, countRemainingAbsences, listAbsenceRows, markAbsenceChecked,
  supersedeAbsenceRow, upsertClinicalState,
  parseRelookLimit, RELOOK_DEFAULT_LIMIT, RELOOK_MAX_LIMIT,
} from '@/lib/stay-library/store';

export const runtime = 'nodejs';

/**
 * POST /api/admin/relook-stay-library — look again for the documents a stay did not have
 * (CDMSS-STAY-LIBRARY-HARDENING-PRD-v1.0-29-AUG-2026, H3 / H-D8 / H-D9 / H-D10).
 *
 * `not_auditable` was forever. 32 of R10's 45 blind cases were rows that landed in db13 AFTER the
 * audit ran; IP-1472's absent OT row would never be looked at again, so a late-arriving operative
 * note never reaches the stay audit and never reaches the spine. This route walks absence rows
 * oldest-checked first and re-runs the class fetch for each stay.
 *
 * MANUAL TRIGGER THIS SHIP (H-D10). There is no cron. The orchestrator or V runs it; a schedule is
 * named in the PRD's open work and is a later ship's decision, not this one's.
 *
 * THE FOUR R10 §8 OPERATOR-LOOP RULES, OBEYED VERBATIM (H-D9):
 *
 *  1. A ROW IS WALKED WHOLE, OR THE CURSOR DOES NOT PASS IT. A stay whose OT class turns out to hold
 *     three notes stores all three and only then retires the absence row. If any one of them fails
 *     to store, the row is counted `failed`, is NOT stamped, and is walked again on the next pass —
 *     because the alternative is an absence row retired against a class we only half-wrote.
 *  2. THE COMPLETION SIGNAL COUNTS WORK, NOT POSITION. The response is counts of what happened:
 *     {rechecked, superseded, failed, remaining}. `remaining` is how many absence rows are still
 *     waiting, never a cursor. A full pass is done when it reports `superseded: 0` and `failed: 0`.
 *  3. EVERY PARAMETER IS A FINITE PARSE >= 1 OR THE FALLBACK. Absent, null, empty, zero, negative
 *     and junk are ONE case and get the default of 10; anything above 50 is capped at 50. The GET
 *     self-documentation prints the constants, never a degenerate value it just parsed.
 *  4. FAILURE COUNTS MEASURE PATIENCE, NOT THE SUBSTRATE. A faulted look stores NOTHING and does not
 *     stamp the row, so it retries. It is never recorded as absence — recording a timeout as "the
 *     document is not there" is how "the OT hop failed" becomes "there was no operation" (D13).
 *
 * AN ABSENCE ROW IS NEVER DELETED (H-D8). Substrate found ⇒ the real ClinicalState is stored as a
 * NEW row under its own real source uid, and the absence row is UPDATEd to point at it — an update,
 * so H1's snapshot keeps the retired reading on the trail. Substrate still absent ⇒ only
 * `last_checked_at` and `check_count` move.
 *
 * Auth: ADMIN_TOKEN (Bearer / ?token=) OR admin session, same as every sibling admin route.
 * ⚠️ INFERRED SQL: this sandbox has no live Neon. Every statement is in lib/stay-library/store.ts
 * and is listed verbatim in the slice report.
 */

export async function GET(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;
  // Self-documentation prints the CONSTANTS. It never echoes a parsed value, so it can never
  // advertise a degenerate one (H-D9 rule 3).
  return NextResponse.json({
    ok: true,
    what: 'Re-looks for the documents a stay did not have, oldest-checked first. POST to run a pass.',
    body: { limit: `optional, default ${RELOOK_DEFAULT_LIMIT}, max ${RELOOK_MAX_LIMIT}` },
    response: { rechecked: 'rows looked at again and still absent', superseded: 'absence rows retired by real documents', failed: 'looks that faulted and will be retried', remaining: 'absence rows still waiting' },
    notes: [
      'A row is walked whole or the cursor does not pass it.',
      'A faulted look stores nothing and is retried; it is never recorded as absence.',
      'Absence rows are never deleted.',
      'A full pass is complete when superseded and failed are both 0.',
    ],
    remaining: await countRemainingAbsences(),
  });
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const limit = parseRelookLimit((body as Record<string, unknown>)?.limit);

  let rechecked = 0, superseded = 0, failed = 0;
  const notes: string[] = [];

  const rows = await listAbsenceRows(limit);
  for (const row of rows) {
    if (row.docKind === 'discharge') {
      // Unreachable by the walk's own predicate (a discharge absence is keyed on the document id,
      // not the `absent:` sentinel), and refused here anyway rather than guessed at: re-reading a
      // discharge is an extraction, not a db13 look, and H3 owns neither.
      failed++;
      notes.push(`${row.sourceUid}: discharge absences are not re-lookable by this route`);
      continue;
    }

    const looked = await relookClass({ docKind: row.docKind, encounterRef: row.encounterRef });

    if (looked.outcome === 'failed') {
      // Rule 4 — store nothing, stamp nothing, retry next pass.
      failed++;
      notes.push(`${row.sourceUid}: ${looked.reason}`);
      continue;
    }

    if (looked.outcome === 'still_absent') {
      if (await markAbsenceChecked(row.id)) rechecked++;
      else { failed++; notes.push(`${row.sourceUid}: the look ran but the check could not be recorded — it will be looked at again`); }
      continue;
    }

    // Substrate found. Rule 1 — the WHOLE row, or none of it: every document of this class is
    // stored before the absence row is retired, and one failure abandons the row intact.
    let allStored = true;
    let firstRealId: string | null = null;
    for (const d of looked.documents) {
      const outcome = await upsertClinicalState({
        docKind: d.docKind, sourceUid: d.sourceUid, memberUid: row.memberUid,
        encounterRef: row.encounterRef, status: d.status, state: d.state,
        schemaVersion: row.schemaVersion || CLINICAL_STATE_VERSION,
      });
      if (outcome === 'skipped') { allStored = false; break; }
      if (!firstRealId) firstRealId = await clinicalStateIdFor(d.docKind, d.sourceUid, row.schemaVersion || CLINICAL_STATE_VERSION);
    }
    if (!allStored || !firstRealId) {
      failed++;
      notes.push(`${row.sourceUid}: found ${looked.documents.length} document(s) but could not store the whole class — the absence row is untouched and will be walked again`);
      continue;
    }
    if (await supersedeAbsenceRow(row.id, firstRealId)) superseded++;
    else { failed++; notes.push(`${row.sourceUid}: the documents stored but the absence row could not be retired — it will be walked again`); }
  }

  // Read AFTER the pass, so it answers "what is left" rather than "what was left when we started".
  const remaining = await countRemainingAbsences();
  return NextResponse.json({
    ok: true, limit, walked: rows.length,
    rechecked, superseded, failed, remaining,
    complete: superseded === 0 && failed === 0,
    ...(notes.length ? { notes: notes.slice(0, 50) } : {}),
  });
}
