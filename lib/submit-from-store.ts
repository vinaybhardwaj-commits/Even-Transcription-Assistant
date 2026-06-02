"use client";

import { getChunksForEncounter, purgeEncounter } from "@/lib/chunk-store";

/**
 * Upload a recovered encounter's audio straight from IndexedDB through the
 * real pipeline (upload-url → R2 PUT → finalize-upload → status=processing).
 * Used by RecoveryModal after a tab reload/crash, when the live transcript
 * state is gone but the recorded chunks survive in IDB. The canonical note is
 * rebuilt server-side from the audio at /process, so the live transcripts are
 * passed as null here. Mirrors lib/use-encounter-submit.ts (kept separate so
 * the live submit path is untouched). Purges IDB only on full success.
 */
export type RecoverySubmitResult =
  | { ok: true; encounterId: string }
  | { ok: false; error: string };

export async function submitRecoveredEncounter(opts: {
  slug: string;
  encounterId: string;
  durationSeconds: number | null;
}): Promise<RecoverySubmitResult> {
  const { slug, encounterId, durationSeconds } = opts;
  try {
    let chunks: Blob[] = [];
    try {
      chunks = await getChunksForEncounter(encounterId);
    } catch {
      /* IDB read failed (Private Browsing etc.) — nothing recoverable here */
    }
    if (chunks.length === 0) return { ok: false, error: "no_audio_chunks" };
    const mime = chunks[0].type || "audio/webm";
    const blob = new Blob(chunks, { type: mime });

    const urlRes = await fetch(`/${slug}/api/encounters/${encounterId}/upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: mime }),
    });
    if (!urlRes.ok) {
      const t = await urlRes.text().catch(() => "");
      return { ok: false, error: `upload_url_${urlRes.status}: ${t.slice(0, 80)}` };
    }
    const urlJson = (await urlRes.json()) as { url: string; key: string; content_type: string };

    const putRes = await fetch(urlJson.url, {
      method: "PUT",
      body: blob,
      headers: { "Content-Type": urlJson.content_type },
    });
    if (!putRes.ok) return { ok: false, error: `r2_put_${putRes.status}` };

    const finRes = await fetch(`/${slug}/api/encounters/${encounterId}/finalize-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: urlJson.key,
        duration_seconds: durationSeconds,
        deepgram_transcript: null,
        whisper_transcript: null,
        sarvam_codemix: null,
        sarvam_language: null,
      }),
    });
    if (!finRes.ok) {
      const t = await finRes.text().catch(() => "");
      return { ok: false, error: `finalize_${finRes.status}: ${t.slice(0, 80)}` };
    }

    // Success — drop the local copy so it stops showing as "unfinished".
    try { await purgeEncounter(encounterId); } catch { /* non-fatal */ }
    return { ok: true, encounterId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
