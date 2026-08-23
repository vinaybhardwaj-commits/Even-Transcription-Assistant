/**
 * /api/admin/bench/windows — inspect and re-evaluate a session's bench_window rows.
 *
 * WHY THIS EXISTS. The writer (lib/bench-window.ts) runs in an after() hook on chunk arrival,
 * which is right for a live tape and leaves no way at all to reach a session that has already
 * ended. That matters immediately: bs_g3dwud4p holds nine hours of verified audio recorded
 * before the writer existed, and every session recorded before K4a is in the same position.
 *
 * GET  ?session_id=bs_…   the rows, with a per-window verdict from the same pure evaluator, so
 *                         an OPEN window can be asked WHY it is open rather than guessed at.
 * POST { session_id }     re-run the evaluation. Idempotent by construction (0057's unique span
 *                         index + ON CONFLICT, and the close is guarded by `state = 'open'`), so
 *                         this is also the backfill for any historical session.
 *
 * Admin-gated, read-mostly, and it touches NO chunk: the POST writes bench_window rows and
 * nothing else. It cannot transcribe, join, or delete anything.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import {
  evaluateAndWriteWindows,
  evaluateWindows,
  WINDOW_MS,
  type WindowChunk,
} from "@/lib/bench-window";
import type { MicEventRow } from "@/lib/bench-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function guard(): Promise<string | null> {
  const cookie = await readAdminCookie();
  if (!cookie) return null;
  try {
    const c = await verifyAdminJwt(cookie);
    return String(c.admin_id ?? "");
  } catch {
    return null;
  }
}

const ms = (d: string | Date): number => (d instanceof Date ? d.getTime() : Date.parse(d));

export async function GET(req: NextRequest) {
  if ((await guard()) === null) return respondError("AUTH_REQUIRED", "Sign in required");
  const sessionId = new URL(req.url).searchParams.get("session_id") ?? "";
  if (!sessionId.startsWith("bs_")) return respondError("VALIDATION_FAILED", "session_id_required");

  const rows = (await sql`
    SELECT id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key,
           grid_aligned, state, closed_at, created_at
      FROM bench_window WHERE session_id = ${sessionId}
     ORDER BY start_ms ASC, source_mic ASC
  `) as Array<Record<string, unknown>>;

  // The same pure evaluator the writer uses, so "why is this still open" is answered from the
  // chunks rather than inferred from the row.
  const chunks = (await sql`
    SELECT idx, source, started_at, ended_at, upload_state
      FROM bench_chunk WHERE session_id = ${sessionId} ORDER BY source, idx
  `) as WindowChunk[];
  const events = (await sql`
    SELECT id, kind, at, payload FROM bench_event WHERE session_id = ${sessionId} ORDER BY at ASC, id ASC
  `) as MicEventRow[];
  const tapeEndMs = chunks.length ? Math.max(...chunks.map((c) => ms(c.ended_at))) : null;
  const verdicts = evaluateWindows({ chunks, events, tapeEndMs });
  const byStart = new Map(verdicts.map((v) => [`${v.start_ms}|${v.source_mic}`, v]));

  return respondOk({
    session_id: sessionId,
    window_ms: WINDOW_MS,
    chunks: chunks.length,
    // The tape's real span, from the CHUNKS — never from session.ended_at, which bs_g3dwud4p
    // proved can be six hours short of the truth.
    tape_start_at: chunks.length ? new Date(Math.min(...chunks.map((c) => ms(c.started_at)))).toISOString() : null,
    tape_end_at: tapeEndMs === null ? null : new Date(tapeEndMs).toISOString(),
    windows: rows.map((r) => {
      const v = byStart.get(`${r.start_ms}|${r.source_mic}`);
      return {
        ...r,
        start_at: new Date(Number(r.start_ms)).toISOString(),
        end_at: new Date(Number(r.end_ms)).toISOString(),
        verdict: v
          ? { complete: v.complete, covered_ms: v.covered_ms, gaps: v.gaps, unverified_idx: v.unverified_idx }
          : null,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const adminId = await guard();
  if (adminId === null) return respondError("AUTH_REQUIRED", "Sign in required");
  let body: { session_id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  if (!sessionId.startsWith("bs_")) return respondError("VALIDATION_FAILED", "session_id_required");

  const out = await evaluateAndWriteWindows(sessionId);
  return respondOk(out);
}
