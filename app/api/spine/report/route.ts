/**
 * POST /api/spine/report — the runner reports a claimed job. Bearer (SPINE_BEARER_TOKEN).
 * Body {job_id, owner, outcome: done|transient|permanent|budget|shadow|release|blocked (no consult_uid link: held, no tick, no attempt), error_code?, artefact? (done only)}.
 * A `shadow` report for a stage that is live NOW is stored as a re-queue (N3), not consumed. Owner-matched: 409 lease_lost when the caller no longer holds the lease.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkSpineBearer } from "@/lib/spine/auth";
import { readMode, readRoomMode } from "@/lib/spine/config";
import { parseArtefact } from "@/lib/spine/artefact";
import type { ArtefactReport } from "@/lib/spine/jobs";
import { opsAlertNotifier, reportJob, stubNotifier } from "@/lib/spine/jobs";
import type { Outcome } from "@/lib/spine/retry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUTCOMES: readonly string[] = ["done", "transient", "permanent", "budget", "shadow", "release", "blocked"];
const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export async function POST(req: NextRequest) {
  const bad = checkSpineBearer(req.headers);
  if (bad) return NextResponse.json({ ok: false, error: bad.error }, { status: bad.status });
  let b: { job_id?: unknown; owner?: unknown; outcome?: unknown; error_code?: unknown; artefact?: unknown };
  try { b = (await req.json()) as typeof b; } catch { return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 }); }
  if (!Number.isSafeInteger(b.job_id) || (b.job_id as number) < 1) return NextResponse.json({ ok: false, error: "bad_job_id" }, { status: 400 });
  if (typeof b.owner !== "string" || !TOKEN_RE.test(b.owner)) return NextResponse.json({ ok: false, error: "bad_owner" }, { status: 400 });
  if (typeof b.outcome !== "string" || !OUTCOMES.includes(b.outcome)) return NextResponse.json({ ok: false, error: "bad_outcome" }, { status: 400 });
  if (b.error_code != null && (typeof b.error_code !== "string" || !TOKEN_RE.test(b.error_code))) return NextResponse.json({ ok: false, error: "bad_error_code" }, { status: 400 });
  let artefact: ArtefactReport | null = null;
  if (b.artefact != null) {
    artefact = b.outcome === "done" ? parseArtefact(b.artefact) : null;
    if (!artefact) return NextResponse.json({ ok: false, error: "bad_artefact" }, { status: 400 });
  }
  try {
    const notifier = (await readMode("dead_alert")) === "live" ? opsAlertNotifier : stubNotifier;
    const r = await reportJob({ job_id: b.job_id as number, owner: b.owner, outcome: b.outcome as Outcome, error_code: (b.error_code as string | null | undefined) ?? null, artefact, now: new Date(), rng: Math.random }, notifier, readRoomMode);
    return r.ok ? NextResponse.json(r) : NextResponse.json(r, { status: 409 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `db:${(e as { code?: string }).code ?? "unknown"}` }, { status: 503 });
  }
}
