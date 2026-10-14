export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Briefs take 42–76s measured; the box must clear the slowest assembly with headroom.
export const maxDuration = 800;

/**
 * POST /api/v1/patient-summary — the Pulse Patient Summary API (V1). 30 Jul 2026.
 *
 * Pulse calls with a UHID; CDMSS returns the whole package as JSON and Pulse renders what it
 * wants. The engine is the PRESERVED Care Conversation Brief machinery — see the RETIRED-but-LIVE
 * header on lib/ccb-brief.ts.
 *
 *   POST                       → 202 Accepted { job_id }   (never synchronous — see below)
 *   GET  /{jobId}              → 202 while running · 200 with the package · 200 + error state
 *
 * WHY 202 + POLL, AND WHY IT MUST NOT BE "SIMPLIFIED" TO SYNCHRONOUS: briefs take 42–76s, which
 * hits Pulse's HTTP client timeout regardless of intent. More importantly, when V2 adds precompute
 * the POST returns 200 immediately and Pulse's integration DOES NOT CHANGE. A synchronous V1
 * would force them to rewrite.
 *
 * RENDERING OBLIGATIONS (31 Jul 2026) — the envelope carries three flags Pulse is REQUIRED to
 * honour, each meaning "do not render this package as a normal chart":
 *   · envelope.degraded    — produced on a fallback path / provider unestablished / partial.
 *   · envelope.ungrounded  — citation_coverage_pct is 0: NO clinical claim is corpus-backed.
 *     Measured 31 Jul: two of six briefs. Same obligation as degraded, same reasoning.
 *   · envelope.state_llm   — stage-2 finding normalisation (PATIENT_SUMMARY_STATE_LLM, default
 *     ON; set '0' to disable). rejected[] lists model assertions whose claimed span was not in
 *     the source — discarded, surfaced as a hallucination meter.
 *
 * PER-FINDING RENDERING OBLIGATION — `polaritySuspect` (31 Jul 2026). A finding inside
 * state.clinical_state may carry `polaritySuspect: true`, meaning its source span READS AS A
 * NEGATION while the model labelled it 'present' (e.g. "no PAH" arriving as a positive).
 * envelope.state_llm.polarity_marked_count is the per-package total.
 *   · Pulse MUST render a caution on such a finding and MUST NOT suppress, filter or reorder it.
 *     The identical detection was previously used to DROP these findings and removed "absent
 *     distal pulses" and "absent bowel sounds" — cannot-miss signs that trip the same cue. The
 *     mark exists because the deletion was unsafe; re-implementing the deletion in the client
 *     reintroduces exactly that harm.
 *   · The absence of the mark is NOT a guarantee of correct polarity. It is a prompt to check.
 *
 * ⚠️ AUTH IS V1/PILOT-SCOPED. This reuses the shared CRON_SECRET, by decision. That credential is
 * shared with every cron and admin endpoint in the system, so it carries no per-consumer identity,
 * cannot be rotated for Pulse alone, and cannot be revoked without breaking internal jobs.
 * SPLIT IT INTO A PER-CONSUMER KEY BEFORE PULSE SERVES LIVE CLINICAL TRAFFIC.
 *
 * PHI: the package carries identifiers in episode.keys for join-back only (same posture as CCB's
 * member_ref); they never enter a model payload. Nothing new is persisted beyond the job record.
 */

import { NextRequest, NextResponse } from 'next/server';
import { buildPatientSummary, putJob, type SummaryRequest } from '@/lib/patient-summary';
import { makeJobId } from '@/lib/patient-summary-core';

function authed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get('authorization') || '';
  if (auth === `Bearer ${secret}`) return true;
  return req.nextUrl.searchParams.get('secret') === secret;
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { body = {}; }
  const p = req.nextUrl.searchParams;
  const str = (k: string): string | undefined => {
    const v = typeof body[k] === 'string' ? String(body[k]).trim() : (p.get(k) || '').trim();
    return v || undefined;
  };
  const request: SummaryRequest = {
    uid: str('uid'), uhid: str('uhid'), individual_uid: str('individual_uid'),
    member_id: str('member_id'), date: str('date'),
  };
  if (!request.uid && !request.uhid && !request.individual_uid && !request.member_id) {
    return NextResponse.json({ error: 'supply one of uhid, individual_uid, member_id or uid' }, { status: 400 });
  }

  const now = new Date().toISOString();
  const jobId = makeJobId(now, Math.random().toString(36).slice(2));
  await putJob({ job_id: jobId, status: 'running', created_at: now, updated_at: now, request });

  // Assemble AFTER responding. The function stays warm for the duration under Fluid Compute; if
  // the invocation is reclaimed the job simply stays 'running' and Pulse re-POSTs — no queue, no
  // partial write, and never a half-built package presented as complete.
  const work = (async () => {
    try {
      const { package: pkg, error } = await buildPatientSummary(request);
      await putJob(pkg
        ? { job_id: jobId, status: 'done', created_at: now, updated_at: new Date().toISOString(), request, package: pkg }
        : { job_id: jobId, status: 'error', created_at: now, updated_at: new Date().toISOString(), request, error: error || 'unknown error' });
    } catch (e) {
      await putJob({ job_id: jobId, status: 'error', created_at: now, updated_at: new Date().toISOString(), request, error: String((e as Error).message).slice(0, 500) });
    }
  })();
  void work;

  return NextResponse.json(
    { job_id: jobId, status: 'running', poll: `/api/v1/patient-summary/${jobId}` },
    { status: 202 },
  );
}
