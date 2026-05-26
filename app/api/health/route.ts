import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

/**
 * GET /api/health
 * Probes APP_DATABASE, KB_DATABASE, Ollama tunnel, Whisper tunnel,
 * Resend (domains list), and R2 (HeadBucket on eta-audio).
 * Returns per-service { ok, latency_ms } + overall ok flag.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function probe(fn: () => Promise<unknown>): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    await fn();
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: String(e) };
  }
}

export async function GET() {
  const [db, kb, llm, whisper, resend, r2] = await Promise.all([
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
        headers: { Authorization: `Bearer ${process.env.LLM_API_KEY ?? "ollama"}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`Ollama probe failed: ${r.status}`);
    }),
    probe(async () => {
      const base = process.env.WHISPER_BASE_URL;
      if (!base) throw new Error("WHISPER_BASE_URL not set");
      const r = await fetch(`${base}/inference`, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      });
      if (r.status >= 500 && r.status !== 501) throw new Error(`Whisper probe ${r.status}`);
    }),
    probe(async () => {
      const key = process.env.RESEND_API_KEY;
      if (!key) throw new Error("RESEND_API_KEY not set");
      const r = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`Resend probe failed: ${r.status}`);
    }),
    probe(async () => {
      const acct = process.env.R2_ACCOUNT_ID;
      const akid = process.env.R2_ACCESS_KEY_ID;
      const sec  = process.env.R2_SECRET_ACCESS_KEY;
      const bkt  = process.env.R2_BUCKET ?? "eta-audio";
      if (!acct || !akid || !sec) throw new Error("R2 credentials not set");
      const { S3Client, HeadBucketCommand } = await import("@aws-sdk/client-s3");
      const client = new S3Client({
        region: "auto",
        endpoint: `https://${acct}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: akid, secretAccessKey: sec },
      });
      await client.send(new HeadBucketCommand({ Bucket: bkt }));
    }),
  ]);

  const ok = db.ok && kb.ok && llm.ok && whisper.ok && resend.ok && r2.ok;

  return NextResponse.json(
    {
      ok,
      sha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      region: process.env.VERCEL_REGION ?? "local",
      now: new Date().toISOString(),
      services: { db, kb, llm, whisper, resend, r2 },
    },
    { status: ok ? 200 : 503 }
  );
}
