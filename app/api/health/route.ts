import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { probeWhisperTranscription } from "@/lib/health/whisper-probe";

/**
 * GET /api/health
 * Probes APP_DATABASE, KB_DATABASE, Ollama tunnel, Whisper tunnel,
 * Resend (domains list), and R2 (HeadBucket on eta-audio).
 * Returns per-service { ok, latency_ms } + overall ok flag.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProbeDetail = Record<string, unknown>;
type ProbeResult = { ok: boolean; latency_ms: number; error?: string } & ProbeDetail;

/**
 * Runs one service check and times it.
 *
 * THE CALLBACK'S RETURN IS PART OF THE ANSWER. This used to `await fn()` and discard the value,
 * assembling `{ok, latency_ms}` on its own — so the whisper callback built `checked_at`, `age_s`,
 * `cached`, `probe_ms` and `reason` and this function threw them away. The payload then could not
 * distinguish a fresh verdict from one served out of a sixty-second cache, which is the single
 * thing those fields exist to say. Whatever a callback returns is now merged into its block.
 *
 * `ok` and `latency_ms` are spread LAST, and deliberately. They are the PROBE's facts — did the
 * check throw, and how long did it take — not the probed service's, and a callback must not be
 * able to declare itself healthy by returning an `ok` of its own.
 */
async function probe(fn: () => Promise<ProbeDetail | void>): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    const extra = detail !== null && typeof detail === "object" && !Array.isArray(detail) ? detail : {};
    return { ...extra, ok: true, latency_ms: Date.now() - t0 };
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
    // Hotfix defect 2 — this used to be a GET that the Mini's shim answered with a static 404
    // without contacting whisper.cpp, so it could not have failed if transcription were dead.
    // It now POSTs a half-second WAV and requires a parseable 200: the same request shape
    // transcribeWithWhisper makes. The reason is carried through so `false` says WHICH way.
    probe(async () => {
      const r = await probeWhisperTranscription();
      if (!r.ok) throw new Error(`whisper_probe_${r.reason ?? "failed"}${r.status ? `_${r.status}` : ""}`);
      // The verdict is cached (one real inference a minute at most), so the payload says WHEN it
      // was measured and how old that is. An `ok` that does not carry its age invites a reader to
      // assume it is fresh, which on a cached probe it usually is not.
      //
      // `reason` SURVIVES ON SUCCESS, not only on failure. A failing probe throws, and its reason
      // reaches the payload inside `error`; a succeeding one returns here, and a plain fresh pass
      // has no reason at all. So on an `ok: true` block the PRESENCE of `reason` is the signal:
      // this success is qualified. Today the only such reason is `busy_recent_ok` — the probe
      // timed out and we are standing on a recent real inference instead — and it arrives with
      // `last_ok_age_s` saying how old that evidence is. Without this a rescued busy server and a
      // genuinely fresh pass are the same two keys, and the rescue is invisible.
      return {
        transcription: true,
        probe_ms: r.elapsed_ms,
        checked_at: r.checked_at,
        age_s: r.age_s,
        cached: r.cached,
        ...(r.reason ? { reason: r.reason } : {}),
        ...(r.last_ok_age_s !== undefined ? { last_ok_age_s: r.last_ok_age_s } : {}),
      };
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
