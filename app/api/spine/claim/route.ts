/**
 * POST /api/spine/claim — the box runner takes spine jobs. Bearer (SPINE_BEARER_TOKEN). Body {owner, limit?, live?}.
 * Returns {ok, jobs:[...]} — EMPTY when spine_config jobs is off, the kill switch is on, a stage is off (paid stages always are), or the stage's breaker is open.
 * live=true only returns jobs of stages whose mode is live, each with its consult_uid link (null when none; a would_run claim never sees it); a non-live claim only returns jobs of SHADOW stages. Each job carries its stage mode.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkSpineBearer } from "@/lib/spine/auth";
import { KNOWN_STAGES, readMode, readModes } from "@/lib/spine/config";
import { claimJobs, openBreakers, reapExhausted, opsAlertNotifier, stubNotifier } from "@/lib/spine/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OWNER_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export async function POST(req: NextRequest) {
  const bad = checkSpineBearer(req.headers);
  if (bad) return NextResponse.json({ ok: false, error: bad.error }, { status: bad.status });
  let body: { owner?: unknown; limit?: unknown; live?: unknown };
  try { body = (await req.json()) as typeof body; } catch { return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 }); }
  if (typeof body.owner !== "string" || !OWNER_RE.test(body.owner)) return NextResponse.json({ ok: false, error: "bad_owner" }, { status: 400 });
  const limit = Math.min(5, Math.max(1, Number.isInteger(body.limit) ? (body.limit as number) : 1));
  const now = new Date();
  try {
    const modes = await readModes();
    if (modes.jobs === "off") return NextResponse.json({ ok: true, jobs: [] });
    const want = body.live === true ? "live" : "shadow";   // a non-live (would_run) claim never takes a live-mode stage: it would consume the job as shadow
    const allowed = KNOWN_STAGES.filter((s) => modes.stages[s] === want);
    const open = new Set(await openBreakers(allowed, now));
    const stages = allowed.filter((s) => !open.has(s));
    const notifier = (await readMode("dead_alert")) === "live" ? opsAlertNotifier : stubNotifier;
    await reapExhausted(now, notifier);
    const jobs = await claimJobs(body.owner, stages, limit, now, undefined, want === "live");
    return NextResponse.json({ ok: true, jobs: jobs.map((j) => ({ ...j, mode: modes.stages[j.stage] })) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `db:${(e as { code?: string }).code ?? "unknown"}` }, { status: 503 });
  }
}
