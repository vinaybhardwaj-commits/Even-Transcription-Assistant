/**
 * POST /api/admin/jev/bench — the Jev bench door. Runs ONE question set over a fixed list of subjects with the SERVER env (TYPESAFE_API_KEY lives only here) and
 * returns the bench summary. Bearer CRON_SECRET only.
 *
 * It does NOT read or change JEV_WORKER_ENABLED and does not touch the cron path. It refuses when ETA_JEV_ENABLED is off (409 jev_disabled) and, for a use that
 * sends text, when ETA_JEV_TEXT_LANE is off (409 text_lane_off); an open breaker or a spent daily cap stops the run (409 circuit_open / budget_exceeded when nothing ran).
 * Bench mode writes jev_call ledger rows and NEVER a jev_decision row. The response and the log hold ids, option keys and numbers: no state text, no transcript, no key.
 * Body: { use, set: "<id>@v<n>", subjects: string[1..20], labels?: { "<subject_id>|<question_id>": "<option key>" }, concurrency?: 1..3 }.
 */
import { NextRequest, NextResponse } from "next/server";
import { respondError } from "@/lib/respond";
import { parseFlag } from "@/lib/flags";
import { cronAuthorized } from "@/lib/jev/worker/cron-auth";
import { syncQuestionSets } from "@/lib/jev/worker/sync";
import { runBench, BenchRefused } from "@/lib/jev/worker/bench";
import type { SubjectOutcome } from "@/lib/jev/worker/bench-report";
import { REAL_USES, USE_SENDS_TEXT, textLaneOn, type GateVerdict, type RealUse } from "@/lib/jev/worker/flags";
import { getUse } from "@/lib/jev/worker/uses";
import "@/lib/jev/worker/register";
import { classifyDbError } from "@/lib/jev/worker/errors";
import { QUESTION_SET_FILES } from "@/jev/question-sets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 20 subjects x up to 2 option orders at concurrency 1 stays well under this at ~1-3 s a call; the platform ceiling for this plan is 300.
export const maxDuration = 300;

const MAX_SUBJECTS = 20;
const SUBJECT_RE = /^[A-Za-z0-9_.:@#-]{1,120}$/;
const SET_RE = /^([a-z][a-z0-9_-]{0,63})@(v[0-9]{1,4})$/;
const LABEL_KEY_RE = /^([A-Za-z0-9_.:@#-]{1,120})\|([A-Za-z0-9_.-]{1,80})$/;

const closed = (status: number, code: string): NextResponse => NextResponse.json({ error: { code } }, { status });
const bad = (code: string) => closed(400, code);

function registeredSetFile(id: string, version: string): boolean {
  return QUESTION_SET_FILES.some((f) => { const o = f as { id?: unknown; version?: unknown }; return o?.id === id && o?.version === version; });
}

export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "cron secret required");
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return bad("bad_body");
    body = parsed as Record<string, unknown>;
  } catch { return bad("bad_body"); }

  const use = body.use;
  if (typeof use !== "string" || !(REAL_USES as readonly string[]).includes(use)) return bad("unknown_use");
  const setM = typeof body.set === "string" ? SET_RE.exec(body.set) : null;
  if (!setM) return bad("bad_set");
  const [, setId, version] = setM as unknown as [string, string, string];
  if (!getUse(use, setId) || !registeredSetFile(setId, version)) return bad("unknown_set");
  const subjects = body.subjects;
  if (!Array.isArray(subjects) || subjects.length < 1 || subjects.length > MAX_SUBJECTS) return bad("bad_subjects");
  if (!subjects.every((s) => typeof s === "string" && SUBJECT_RE.test(s))) return bad("bad_subjects");
  const ids = subjects as string[];
  let labels: Array<{ subject_id: string; question_id: string; label: string }> | undefined;
  if (body.labels !== undefined) {
    if (typeof body.labels !== "object" || body.labels === null || Array.isArray(body.labels)) return bad("bad_labels");
    labels = [];
    for (const [k, v] of Object.entries(body.labels)) {
      const m = LABEL_KEY_RE.exec(k);
      if (!m || typeof v !== "string" || v.length < 1 || v.length > 80 || !ids.includes(m[1]!)) return bad("bad_labels");
      labels.push({ subject_id: m[1]!, question_id: m[2]!, label: v });
    }
  }
  let concurrency = 1;
  if (body.concurrency !== undefined) {
    if (typeof body.concurrency !== "number" || !Number.isInteger(body.concurrency) || body.concurrency < 1 || body.concurrency > 3) return bad("bad_concurrency");
    concurrency = body.concurrency;
  }

  // The door's own gate: ETA_JEV_ENABLED, and the text lane for a use that sends text. JEV_WORKER_ENABLED is deliberately not consulted.
  let gate: GateVerdict;
  try {
    if (!parseFlag("ETA_JEV_ENABLED")) return closed(409, "jev_disabled");
    gate = USE_SENDS_TEXT[use as RealUse] && !textLaneOn() ? { ok: false, reason: "text_lane_off" } : { ok: true };
  } catch { return closed(500, "flag_unrecognised"); }
  if (!gate.ok) return closed(409, gate.reason);

  let outcomes: ReadonlyArray<SubjectOutcome> = [];
  try {
    await syncQuestionSets();
    const report = await runBench(
      { use, setId, version, subjects: ids, labels, concurrency },
      { gate: () => ({ ok: true }), onOutcomes: (o) => { outcomes = o; } },
    );
    const asked = report.counts.asked + report.counts.abstained + report.counts.too_large;
    if (report.stopped && report.counts.calls === 0 && asked === 0) return closed(409, report.stopped);
    console.log(JSON.stringify({ tag: "jev-bench-door", use, set: `${setId}@${version}`, counts: report.counts, stopped: report.stopped ?? null }));
    return NextResponse.json({
      ...report,
      subjects: outcomes.map((o) => ({
        subject_id: o.subject_id, status: o.status, ...(o.reason ? { reason: o.reason } : {}), calls: o.calls,
        answers: o.rows.filter((r) => r.variant === "derived").map((r) => ({ question_id: r.question_id, value: r.value, confidence: r.confidence, ...(r.gated ? { gated: true } : {}) })),
      })),
    });
  } catch (e) {
    if (e instanceof BenchRefused) return closed(e.reason === "text_lane_off" ? 409 : 400, e.reason);
    console.error(JSON.stringify({ tag: "jev-bench-door", failed: classifyDbError(e) }));
    return respondError("PIPELINE_FAILED", `jev bench failed: ${classifyDbError(e)}`);
  }
}
