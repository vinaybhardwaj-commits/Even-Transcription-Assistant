"use client";

import * as React from "react";
import {
  getChunksForEncounter,
  purgeEncounter,
} from "@/lib/chunk-store";

/**
 * useEncounterSubmit — orchestrates the audio submit flow:
 *   1) Read all chunks for encounter_id from IndexedDB (sorted by idx)
 *   2) Concatenate into a single Blob (MediaRecorder's WebM stream)
 *   3) POST /upload-url to get a presigned R2 PUT URL
 *   4) PUT the blob directly to R2
 *   5) POST /finalize-upload to update the encounter row
 *   6) Purge the chunks from IndexedDB
 *
 * Each stage is exposed via `stage` so the UI can render a progress
 * indicator. On any failure we set state="error" and preserve the chunks
 * so the user can retry without losing audio.
 */

export type SubmitStage =
  | "idle"
  | "reading"
  | "requesting_url"
  | "uploading"
  | "finalizing"
  | "purging"
  | "done"
  | "error";

export type SubmitState = {
  stage: SubmitStage;
  progress: number; // 0-1 of overall flow
  bytesUploaded: number;
  totalBytes: number;
  error: string | null;
};

type Options = {
  slug: string;
  encounterId: string | null;
  durationSeconds: number | null;
  deepgramTranscript: string;
  whisperTranscript: string;
  // Multilingual (Sarvam) accumulated transcripts from the live rolling hook.
  sarvamOriginal?: string;
  sarvamEnglish?: string;
  sarvamLanguage?: string | null;
};

const STAGE_WEIGHTS: Record<SubmitStage, number> = {
  idle: 0,
  reading: 0.05,
  requesting_url: 0.1,
  uploading: 0.75, // big chunk of total time
  finalizing: 0.05,
  purging: 0.05,
  done: 1,
  error: 0,
};

export function useEncounterSubmit(opts: Options) {
  const [state, setState] = React.useState<SubmitState>({
    stage: "idle",
    progress: 0,
    bytesUploaded: 0,
    totalBytes: 0,
    error: null,
  });

  const optsRef = React.useRef(opts);
  React.useEffect(() => {
    optsRef.current = opts;
  }, [opts]);

  const submit = React.useCallback(async (): Promise<
    { ok: true; encounterId: string } | { ok: false; error: string }
  > => {
    const o = optsRef.current;
    if (!o.encounterId) {
      const err = "encounter_id_missing";
      setState((s) => ({ ...s, stage: "error", error: err }));
      return { ok: false, error: err };
    }
    const encId = o.encounterId;

    try {
      // 1. Read chunks
      setState({
        stage: "reading",
        progress: STAGE_WEIGHTS.reading,
        bytesUploaded: 0,
        totalBytes: 0,
        error: null,
      });
      const chunks = await getChunksForEncounter(encId);
      if (chunks.length === 0) {
        const err = "no_audio_chunks";
        setState((s) => ({ ...s, stage: "error", error: err }));
        return { ok: false, error: err };
      }
      const mime = chunks[0].type || "audio/webm";
      const blob = new Blob(chunks, { type: mime });

      // 2. Request URL
      setState({
        stage: "requesting_url",
        progress: STAGE_WEIGHTS.requesting_url,
        bytesUploaded: 0,
        totalBytes: blob.size,
        error: null,
      });
      const urlRes = await fetch(
        `/${o.slug}/api/encounters/${encId}/upload-url`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content_type: mime }),
        },
      );
      if (!urlRes.ok) {
        const text = await urlRes.text().catch(() => "");
        throw new Error(`upload_url_${urlRes.status}: ${text.slice(0, 120)}`);
      }
      const urlJson = (await urlRes.json()) as {
        url: string;
        key: string;
        method: "PUT";
        content_type: string;
      };

      // 3. PUT to R2 directly
      setState({
        stage: "uploading",
        progress: STAGE_WEIGHTS.requesting_url + STAGE_WEIGHTS.uploading / 2,
        bytesUploaded: 0,
        totalBytes: blob.size,
        error: null,
      });
      const putRes = await fetch(urlJson.url, {
        method: "PUT",
        body: blob,
        headers: { "Content-Type": urlJson.content_type },
      });
      if (!putRes.ok) {
        const text = await putRes.text().catch(() => "");
        throw new Error(`r2_put_${putRes.status}: ${text.slice(0, 120)}`);
      }

      // 4. Finalize
      setState({
        stage: "finalizing",
        progress:
          STAGE_WEIGHTS.requesting_url +
          STAGE_WEIGHTS.uploading +
          STAGE_WEIGHTS.finalizing / 2,
        bytesUploaded: blob.size,
        totalBytes: blob.size,
        error: null,
      });
      const finRes = await fetch(
        `/${o.slug}/api/encounters/${encId}/finalize-upload`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: urlJson.key,
            duration_seconds: o.durationSeconds,
            deepgram_transcript: o.deepgramTranscript || null,
            whisper_transcript: o.whisperTranscript || null,
            sarvam_original: o.sarvamOriginal || null,
            sarvam_english: o.sarvamEnglish || null,
            sarvam_language: o.sarvamLanguage || null,
          }),
        },
      );
      if (!finRes.ok) {
        const text = await finRes.text().catch(() => "");
        throw new Error(`finalize_${finRes.status}: ${text.slice(0, 120)}`);
      }

      // 5. Purge IDB
      setState({
        stage: "purging",
        progress: 0.95,
        bytesUploaded: blob.size,
        totalBytes: blob.size,
        error: null,
      });
      try {
        await purgeEncounter(encId);
      } catch {
        // non-fatal: chunks will be cleaned up by recovery modal eventually
      }

      setState({
        stage: "done",
        progress: 1,
        bytesUploaded: blob.size,
        totalBytes: blob.size,
        error: null,
      });
      return { ok: true, encounterId: encId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState((s) => ({ ...s, stage: "error", error: msg }));
      return { ok: false, error: msg };
    }
  }, []);

  const reset = React.useCallback(() => {
    setState({
      stage: "idle",
      progress: 0,
      bytesUploaded: 0,
      totalBytes: 0,
      error: null,
    });
  }, []);

  return { ...state, submit, reset };
}
