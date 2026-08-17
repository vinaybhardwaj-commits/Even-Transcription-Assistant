/**
 * GET /api/brain/health — Ambient Brain liveness (Kickoff A2, decision B10). Open (no auth).
 * Ported from brain/src/server.ts handleHealth: { ok, now, db:{ ok, latency_ms }, ... }.
 * Always HTTP 200 (the app is alive); `ok` carries the truth. Adds `config` so an unset
 * BRAIN_DATABASE_URL / BRAIN_SERVICE_TOKEN is named (env var NAMES only, never values) —
 * the app must keep working while V adds them in the Vercel dashboard.
 */
import { NextResponse } from "next/server";
import { brainConfigStatus, probe } from "@/lib/brain/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const config = brainConfigStatus();
  const db = config.db_env_set && config.ws_available
    ? await probe()
    : { ok: false, latency_ms: 0, error: !config.db_env_set ? "brain_db_not_configured" : "brain_ws_unavailable" };
  return NextResponse.json(
    {
      ok: db.ok && config.token_env_set,
      now: new Date().toISOString(),
      db,
      config,
      service: "even-scribe-brain",
      home: "vercel-app",
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
