import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

/**
 * GET /api/health
 * Probes APP_DATABASE, KB_DATABASE, Ollama tunnel, Whisper tunnel.
 * Returns per-service { ok, latency_ms } + overall ok flag.
 * Sprint 0 exit gate: all four must be green from production.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function probe<T>(fn: () => Promise<T>): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    await fn();
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: String(e) };
  }
}

export async function GET() {
  const [db, kb, llm, whisper] = await Promise.all([
    probe(async () => {
      await sql`SELECT 1 AS ok`;
    }),
    probe(async () => {
      const url = process.env.KB_DATABASE_URL;
      if (!url) throw new Error("KB_DATABASE_URL not set");
      const { neon } = await import("@neondatabase/serverless");
      const kbSql = neon(url);
      await kbSql`SELECT 1 AS ok`;
    }),
    probe(async () => {
      const base = process.env.OLLAMA_BASE_URL;
      if (!base) throw new Error("OLLAMA_BASE_URL not set");
      const r = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY ?? "ollama"}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`Ollama probe failed: ${r.status}`);
    }),
    probe(async () => {
      const base = process.env.WHISPER_BASE_URL;
      if (!base) throw new Error("WHISPER_BASE_URL not set");
      // whisper.cpp returns 405/501 on GET (POST-only); any HTTP reply means alive.
      const r = await fetch(`${base}/inference`, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      });
      if (r.status >= 500 && r.status !== 501) throw new Error(`Whisper probe ${r.status}`);
    }),
  ]);

  const ok = db.ok && kb.ok && llm.ok && whisper.ok;

  return NextResponse.json(
    {
      ok,
      sha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      region: process.env.VERCEL_REGION ?? "local",
      now: new Date().toISOString(),
      services: { db, kb, llm, whisper },
    },
    { status: ok ? 200 : 503 }
  );
}
