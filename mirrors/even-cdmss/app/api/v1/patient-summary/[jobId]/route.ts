export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/v1/patient-summary/{jobId} — the poll half of the 202 contract (see ../route.ts).
 *
 *   202 { status: 'running' }              → keep polling
 *   200 { status: 'done', package }        → the namespaced package
 *   200 { status: 'error', error }         → terminal failure; do NOT render a summary
 *   404                                    → unknown job id
 *
 * ⚠️ PULSE IS REQUIRED TO RENDER A DEGRADED PACKAGE DIFFERENTLY. `envelope.degraded` is true
 * whenever the package was produced on a fallback path, when the serving model could not be
 * established, or when part of the assembly failed and is null; `envelope.degraded_reason` says
 * which. Between 26 and 30 Jul 2026 this system served confident output from a fallback model
 * while every dashboard reported gemini-2.5-pro (register T-5) — rendering a degraded package as
 * ordinary chart is the exact failure this field exists to prevent.
 *
 * ⚠️ AUTH IS V1/PILOT-SCOPED — shared CRON_SECRET. Split before live clinical traffic (see ../route.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '@/lib/patient-summary';
import { isJobId } from '@/lib/patient-summary-core';

function authed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get('authorization') || '';
  if (auth === `Bearer ${secret}`) return true;
  return req.nextUrl.searchParams.get('secret') === secret;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  if (!authed(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { jobId } = await ctx.params;
  if (!isJobId(jobId)) return NextResponse.json({ error: 'bad job id' }, { status: 400 });

  const job = await getJob(jobId);
  if (!job) return NextResponse.json({ error: 'unknown job id' }, { status: 404 });

  const status = String(job.status || '');
  if (status === 'running') {
    return NextResponse.json({ job_id: jobId, status: 'running' }, { status: 202 });
  }
  if (status === 'error') {
    return NextResponse.json({ job_id: jobId, status: 'error', error: job.error ?? 'unknown error' });
  }
  return NextResponse.json({ job_id: jobId, status: 'done', ...(job.package as Record<string, unknown> ?? {}) });
}
