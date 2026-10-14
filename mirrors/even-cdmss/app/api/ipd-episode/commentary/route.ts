import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-gate';
import { isAdminUnlocked } from '@/lib/admin-cookie';
import { commentaryInputsFor, saveCommentary } from '@/lib/ipd-episode/store';
import { runCommentaryPass, judgeModel } from '@/lib/ipd-episode/judge';
import { outcomeLineFrom } from '@/lib/ipd-episode/judge-core';
import type { EpisodeFinding } from '@/lib/ipd-episode/judge-core';
import { summariseEventsForPrompt, EPISODE_CHECKPOINT_ID } from '@/lib/ipd-episode/assemble-core';
import { renderExpectedCourse } from '@/lib/ipd-episode/checkpoint-core';
import { checkpointsForAudit } from '@/lib/ipd-episode/store';
import type { EpisodeEvent } from '@/lib/ipd-episode/assemble-core';

export const runtime = 'nodejs';
/** One model call on a prompt whose ceiling is 10 000 tokens. Measured: 49–58 s on IPNO-416. */
export const maxDuration = 300;

/** What is left to do after pass B returns: one UPDATE and the response. */
const COMMENTARY_RESERVE_MS = 15 * 1000;

/**
 * ON-DEMAND COMMENTARY — PRD decision 35 (V, 2026-09-03), amending decision 2.
 *
 * Pass B used to be stage 6 of the audit pipeline. It cost 107 s of IPNO-416's 314 s for output
 * that scores nothing, failed on both of the last two episodes, and is only ever read by someone
 * who has drilled into one episode. So the pipeline now ends at the fidelity pass and this route
 * generates the commentary the first time a detail page is opened, caching it to the row.
 *
 * The three properties this route must have, and where each is enforced:
 *   idempotent  — `saveCommentary` writes under `WHERE commentary IS NULL`, so two concurrent page
 *                 opens cannot produce two different commentaries; the loser reports `already`.
 *                 A row that already has one never reaches the model at all (the early return).
 *   admin-gated — the same ADMIN_TOKEN / admin-session pair as every other admin route here.
 *   never fatal — a failure returns 200 with `commentary: null` and a reason. A NULL commentary is
 *                 a normal state of a complete, scorable episode (decision 35), so a failure here
 *                 must not read to the caller as a broken episode.
 *
 * ⚠️ BLINDING IS NOT AT STAKE HERE and must not be re-argued into one. Pass B is the outcome-AWARE
 * pass by design (§3.6): it is the only one that may read how the admission ended. What it may not
 * do is invent findings, and that is enforced where it always was — `validateCommentary` against
 * the finding ids, below.
 */
export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const denied = requireAdmin(req);
  if (denied && !(await isAdminUnlocked().catch(() => false))) return denied;

  const id = new URL(req.url).searchParams.get('id') ?? '';
  const row = await commentaryInputsFor(id);
  if (!row) return NextResponse.json({ ok: false, error: 'no such episode audit' }, { status: 404 });

  // Already generated: return it untouched. This is the cheap half of the idempotency guarantee —
  // the write-side guard below is the half that survives two simultaneous first opens.
  if (row.commentary != null) {
    return NextResponse.json({ ok: true, status: 'cached', commentary: row.commentary });
  }

  const findings = Array.isArray(row.findings) ? (row.findings as EpisodeFinding[]) : [];
  const events = Array.isArray(row.realCourse) ? (row.realCourse as EpisodeEvent[]) : [];
  const checkpoints = await checkpointsForAudit(row.auditId);
  const expectedCourses = checkpoints
    .filter((c) => c.expected_course)
    .map((c) => {
      const type = String(c.checkpoint_type) === 'episode' ? 'episode' as const : 'daily' as const;
      const dayIndex = Number(c.day_index ?? 0);
      const checkpointId = type === 'episode' ? EPISODE_CHECKPOINT_ID : `cp-d${dayIndex}`;
      const ids = Array.isArray(c.citation_ids) ? (c.citation_ids as number[]) : [];
      return renderExpectedCourse(checkpointId, dayIndex, type,
        c.expected_course as Parameters<typeof renderExpectedCourse>[3], ids);
    });

  const b = await runCommentaryPass({
    traceId: undefined,
    // ROUND 13 ITEM 1. This route has its own, smaller box (300 s), and the same rule holds in it:
    // pass B is never started without room to finish. A refusal here is already a normal outcome —
    // the page shows the honest absence and the next open retries.
    deadlineAt: startedAt + maxDuration * 1000 - COMMENTARY_RESERVE_MS,
    // Persisted at audit time precisely so this call cannot drift from the pipeline's view (§35).
    // A row audited BEFORE decision 35 has no stored context. Say so plainly rather than
    // reconstructing one from db13 here: this route reads the audit row, not the source.
    admissionContext: row.admissionContext ?? 'The admission context was not recorded for this audit.',
    events: summariseEventsForPrompt(events),
    // ⚠️ ROUND 12 ITEM 3: THE FULL LIST, RESOLVER FINDINGS INCLUDED, WITH THEIR REAL IDS.
    // IPNO-416 had both attempts rejected for annotating 'r-13' — which was not an invented id but
    // a TRUNCATED one: resolver ids used to read `r-13-cp-d1/diagnostics/3`, and the model cut them
    // at the natural break. The ids are short now, and validation still checks every annotation
    // against exactly this list, so a genuinely invented id is still refused.
    findings,
    outcomeLine: outcomeLineFrom(events, row.losDays),
    expectedCourses,
    model: judgeModel(process.env),
  });

  if (!b.commentary) {
    // NOT an error status: a null commentary is a legitimate state of a complete episode.
    return NextResponse.json({ ok: true, status: 'failed', commentary: null, error: b.error });
  }
  const wrote = await saveCommentary(row.auditId, b.commentary);
  return NextResponse.json({
    ok: true,
    status: wrote === 'saved' ? 'generated' : wrote === 'already' ? 'cached' : 'not_stored',
    commentary: b.commentary,
  });
}
