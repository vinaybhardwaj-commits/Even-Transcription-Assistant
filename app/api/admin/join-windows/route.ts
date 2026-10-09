/**
 * /api/admin/join-windows — the Nemotron clip cutter. Joins audio into a clip and does nothing else.
 *
 * WHY. `bench_window.clip_r2_key` was written only by the room STT drain, which stopped. The
 * Nemotron shadow worker needs clips. V approved cutting clips for Nemotron ONLY: no text, no
 * vendor STT, no turns, no jobs. Every room has transcript_enabled = false, and this path passes
 * `includeTranscriptDisabled` on purpose — joining audio is not transcribing it (V's ruling).
 * The only write anywhere on this path is `UPDATE bench_window SET clip_r2_key`.
 *
 * SHIPS DARK. Unless NEMOTRON_CLIP_JOIN_ENABLED and DIARIZE_NEMOTRON_SHADOW are both "1" this
 * returns `skipped: "flag_off"` having read nothing.
 *
 * QUIET WINDOW. 07:30-21:30 IST returns `skipped: "clinic_hours"` having read nothing.
 *
 * GET only, Bearer CRON_SECRET only. Ids and counts in the response; no room slugs.
 */
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { respondOk, respondError } from "@/lib/respond";
import { inClinicHours, joinOnlyWindow, listCliplessWindows } from "@/lib/stt/join-only";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_BATCH = 6;
const MAX_BATCH = 12;

/** D15: a live tape, or a bus we cannot read, ends the tick. Never compete with a recording. */
const STOP_STEPS = new Set(["room_recording", "recording_unknown", "join_service_not_configured"]);

/** Whole-header, constant-time. An empty or unset secret never authorises. */
function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "", "utf8");
  const want = Buffer.from(`Bearer ${secret}`, "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

function batchSize(): number {
  const n = Number(process.env.NEMOTRON_CLIP_JOIN_BATCH);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BATCH;
  return Math.max(1, Math.min(MAX_BATCH, Math.trunc(n)));
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return respondError("AUTH_REQUIRED", "cron secret required");
  if (process.env.NEMOTRON_CLIP_JOIN_ENABLED !== "1" || process.env.DIARIZE_NEMOTRON_SHADOW !== "1") {
    return respondOk({ skipped: "flag_off" });
  }
  // CLINIC HOURS, after the flags and before any DB read: the Mini serves the clinic 07:30-21:30 IST.
  if (inClinicHours(new Date())) return respondOk({ skipped: "clinic_hours" });

  const t0 = Date.now();
  const batch = batchSize();
  let windows;
  try {
    windows = await listCliplessWindows({ limit: batch, includeTranscriptDisabled: true });
  } catch (e) {
    return respondError("PIPELINE_FAILED", `listing failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }

  const steps: Record<string, number> = {};
  let joined = 0;
  let stoppedAt: string | null = null;
  for (const w of windows) {
    const r = await joinOnlyWindow(w.window_id, { includeTranscriptDisabled: true });
    const key = r.ok ? (r.joined ? "joined" : "already_joined") : r.step;
    steps[key] = (steps[key] ?? 0) + 1;
    if (r.ok) {
      if (r.joined) joined += 1;
      continue;
    }
    if (STOP_STEPS.has(r.step)) { stoppedAt = r.step; break; }
  }
  return respondOk({
    batch, listed: windows.length, joined, steps, stopped_at: stoppedAt, ms: Date.now() - t0,
  });
}
