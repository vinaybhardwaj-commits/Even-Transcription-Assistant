/**
 * lib/jobs/kinds/transcribe-range.ts — Tier 2 §3, the `transcribe_range` step machine.
 *
 * §3 names four steps: resolve → join → transcribe → write. THIS BUILDS THREE, and the reason is a
 * privacy rule, not a shortcut. `scribe_job.progress` is readable by any operator through
 * `scribe_job_status`, and a fourth step would have to carry Whisper's TRANSCRIPT from `transcribe`
 * to `write` through that column — patient speech, at rest, in a new table, readable by every token
 * with `read`. So the write happens inside the transcribe step, which already holds the text in
 * memory, and `progress` never carries a word of it. Flagged in the build report.
 *
 * The steps call the SAME helpers `scribe_transcribe_range` calls (`resolveRange`, `refuseIfTooLong`,
 * `buildJoinRequest`, `callJoinService`, `transcribeWithWhisper`), so the job and the tool cannot
 * drift into two different answers for the same window.
 */

import { listBenchChunks, listBenchSessions, type BenchChunkRow } from "@/lib/bench";
import { resolveRange, type CoveringChunk, type RangeResolution } from "@/lib/bench-range";
import { buildJoinRequest, callJoinService, refuseIfTooLong, whisperTimeoutForClip } from "@/lib/bench-join";
import { getObjectBytes } from "@/lib/r2";
import { transcribeWithWhisper } from "@/lib/whisper";
// The one name for "a 200 with no speech", shared with the synchronous tool so the two paths
// cannot disagree about what it means.
import { EMPTY_TRANSCRIPT } from "@/lib/mcp/tools/bench";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext } from "../types";
import { jobError } from "../errors";

const STEPS = { resolve: "resolve", join: "join", transcribe: "transcribe" } as const;

/**
 * PURE — `resolveRange` returns a discriminated union (single | multi | none). The steps below care
 * only about the LIST, so it is flattened once here rather than branched on three times.
 */
function coveringOf<C extends CoveringChunk<BenchChunkRow>>(r: RangeResolution<BenchChunkRow>): C[] {
  if (r.kind === "single") return [r.covering as C];
  if (r.kind === "multi") return r.covering as C[];
  return [];
}

const asMs = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

export const transcribeRangeKind: JobKind = {
  name: "transcribe_range",
  first: STEPS.resolve,
  scope: "invoke",

  /**
   * Validated at SUBMIT so a job that cannot possibly run never queues. The 30-minute refusal is
   * the tool's own (`refuseIfTooLong`) and is applied here too — refusing in two seconds beats
   * queueing something that will fail on its first claim.
   */
  parseArgs(raw) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const session_id = typeof o.session_id === "string" ? o.session_id.trim() : "";
    const room = typeof o.room === "string" ? o.room.trim() : "";
    if (!session_id && !room) throw new JobArgsError("session_id or room is required");
    const start = asMs(o.start);
    const end = asMs(o.end);
    if (start === null || end === null) throw new JobArgsError("start and end must be epoch ms or ISO times");
    if (end <= start) throw new JobArgsError("end must be after start");
    const tooLong = refuseIfTooLong(start, end);
    if (tooLong) throw new JobArgsError(`range too long: ${JSON.stringify(tooLong)}`);
    const source = o.source === "backup" ? "backup" : "primary";
    return {
      ...(session_id ? { session_id } : {}),
      ...(room ? { room } : {}),
      start,
      end,
      source,
      ...(typeof o.language === "string" && o.language.trim() ? { language: o.language.trim().slice(0, 16) } : {}),
      dry_run: o.dry_run !== false,
    };
  },

  async run(ctx: StepContext) {
    switch (ctx.step) {
      case STEPS.resolve:
        return resolveStep(ctx);
      case STEPS.join:
        return joinStep(ctx);
      case STEPS.transcribe:
        return transcribeStep(ctx);
      default:
        return failWith(jobError("unknown_step", ctx.step));
    }
  },
};

/** Step 1 — which pieces cover the window. Ids, counts and ms only; no bytes are touched yet. */
async function resolveStep(ctx: StepContext) {
  const { session_id, room, start, end, source } = ctx.args as {
    session_id?: string; room?: string; start: number; end: number; source: "primary" | "backup";
  };

  let sessionId = session_id ?? null;
  if (!sessionId && room) {
    // A range given by room takes the session that actually covers the window, not "today's".
    const sessions = await listBenchSessions({ room_id: room });
    const covering = sessions.find((s) => {
      const a = asMs(s.started_at);
      const b = asMs(s.last_any_chunk_at) ?? asMs(s.ended_at);
      return a !== null && a <= end && (b === null || b >= start);
    });
    if (!covering) return failWith(jobError("no_session_for_window"));
    sessionId = covering.id;
  }
  if (!sessionId) return failWith(jobError("session_unresolved"));

  const chunks = await listBenchChunks(sessionId);
  const covering = coveringOf(resolveRange(chunks, start, end, source));
  if (!covering.length) return failWith(jobError("no_audio_in_range"));

  return nextStep(STEPS.join, {
    session_id: sessionId,
    piece_count: covering.length,
    covered_ms: end - start,
    chunk_idxs: covering.map((c) => c.chunk.idx),
    source,
  });
}

/**
 * Step 2 — one piece needs no join; more than one is joined and trimmed to the window, exactly as
 * the tool does it. The clip's KEY is carried forward; the bytes are not.
 */
async function joinStep(ctx: StepContext) {
  const { start, end, source } = ctx.args as { start: number; end: number; source: "primary" | "backup" };
  const sessionId = String(ctx.progress.session_id ?? "");
  if (!sessionId) return failWith(jobError("progress_incomplete", "session id"));

  const chunks = await listBenchChunks(sessionId);
  const covering = coveringOf(resolveRange(chunks, start, end, source));
  if (!covering.length) return failWith(jobError("no_audio_in_range"));

  if (covering.length === 1) {
    const only = covering[0]!;
    return nextStep(STEPS.transcribe, {
      ...ctx.progress,
      clip_key: only.chunk.r2_key,
      clip_kind: "whole_chunk",
      clip_offset_ms: 0,
      duration_ms: asMs(only.chunk.ended_at)! - asMs(only.chunk.started_at)!,
    });
  }

  const req = buildJoinRequest(sessionId, covering, start, end, source);
  const joined = await callJoinService(req);
  if (!joined.ok) {
    // The hop is ours; the service's message is NOT interpolated — it can quote the audio.
    console.error("[jobs] join failed", JSON.stringify({ err: joined.error, hop: joined.hop }));
    return failWith(jobError("join_failed", joined.hop ? `hop ${joined.hop}` : undefined));
  }
  return nextStep(STEPS.transcribe, {
    ...ctx.progress,
    clip_key: joined.key,
    clip_kind: "joined",
    clip_offset_ms: 0,
    duration_ms: end - start,
  });
}

/**
 * PURE — the fields BOTH outcomes of step 3 carry, so a silent window and a spoken one differ only
 * in their counts. Defined once: two hand-built literals is exactly how the two paths drift apart,
 * which is the defect this hotfix closes one level up.
 */
function silentOrSpokenBase(ctx: StepContext, clipKey: string, durationMs: number): Record<string, unknown> {
  return {
    transcription_run_id: null,
    session_id: ctx.progress.session_id ?? null,
    clip_key: clipKey,
    clip_kind: ctx.progress.clip_kind ?? null,
    piece_count: ctx.progress.piece_count ?? null,
    duration_ms: durationMs,
    dry_run: ctx.args.dry_run !== false,
  };
}

/**
 * Step 3 — transcribe, and write in the same step when asked.
 *
 * THE TEXT NEVER TOUCHES `progress`. It goes straight into the job's `result`, which is returned
 * only to a caller that asks `scribe_job_status(include_result:true)`, and the write (when
 * `dry_run:false`) happens here while the text is in memory rather than being handed on.
 */
async function transcribeStep(ctx: StepContext) {
  const { language } = ctx.args as { language?: string };
  const clipKey = String(ctx.progress.clip_key ?? "");
  if (!clipKey) return failWith(jobError("progress_incomplete", "clip key"));

  const bytes = await getObjectBytes(clipKey);
  if (!bytes) return failWith(jobError("clip_missing_in_r2"));

  const durationMs = Number(ctx.progress.duration_ms ?? 0) || 0;
  const w = await transcribeWithWhisper(bytes, "audio/webm", {
    ...(language ? { language } : {}),
    timeoutMs: whisperTimeoutForClip(durationMs),
  });
  if (!w.ok) {
    // ─── A QUIET ROOM IS NOT A FAILED READ ──────────────────────────────────────────────────
    // `lib/whisper.ts` maps a 200 with no speech to `{ok:false, error:'empty_transcript'}` — an
    // `ok:false` that means "the read finished and there was nothing to hear". The synchronous
    // tool has always known this (`whisperNotOkAnswer`, bench.ts, `EMPTY_TRANSCRIPT`); this path
    // did not, and reported every `!w.ok` as `whisper_failed`. A window of silence then looked
    // identical to an unreachable Whisper, which is the one distinction the K5 rule exists to
    // keep: "nothing was said" and "nothing was looked at" must never read the same.
    //
    // So `empty_transcript` short-circuits to SUCCESS here, with the same facts the sync path
    // reports: zero segments, zero characters, `silent_window: true`. It is deliberately NOT a
    // member of JOB_ERROR_CODES — putting it there would make it an error again by another name.
    if (w.error === EMPTY_TRANSCRIPT) {
      return doneWith({
        ...silentOrSpokenBase(ctx, clipKey, durationMs),
        silent_window: true,
        chars: 0,
        segments: 0,
        language: null,
        note: "SILENT WINDOW. Whisper read this window successfully and it held no speech; the client reports that as `empty_transcript`, which is a fact about the room and not a failure.",
      });
    }
    // (e): lib/whisper.ts builds `error` from up to 200 chars of the service's RESPONSE BODY,
    // which can echo the audio. It goes to the log; the row gets the code alone.
    console.error("[jobs] whisper failed", JSON.stringify({ err: String(w.error ?? "unknown").slice(0, 200) }));
    return failWith(jobError("whisper_failed"));
  }

  const text = typeof w.transcript === "string" ? w.transcript : "";
  const segments = Array.isArray((w as { segments?: unknown[] }).segments) ? (w as { segments: unknown[] }).segments.length : 0;

  // ─── POINTERS ONLY (Slice B Refuter, item 2) ─────────────────────────────────────────────────
  // `scribe_job.result` is a durable column read by `scribe_job_status`, and the transcript is
  // patient speech. An earlier version put the text here, which meant a `read` token could pull a
  // consultation out of the job table — the exact leak keeping it out of `progress` was meant to
  // prevent, one column over. The result now carries a POINTER to the stored run and the facts you
  // can count without reading a word: how long, how many characters, which language, how many
  // segments. Whoever wants the words goes to the transcription_run, where identity rules apply.
  // `transcription_run_id` is NULL in Slice B and that is not an oversight: §4.5 gives the
  // `transcription_run` write to Slice C, and every writer lives in lib/stt/**, outside this
  // slice's files. The key is here from the start so the result SHAPE does not change when C
  // fills it in — a caller written today keeps working. Null means "not persisted yet", and the
  // counts beside it are real either way.
  return doneWith({
    ...silentOrSpokenBase(ctx, clipKey, durationMs),
    // "A quiet room" and "a failed read" must not look the same — the tool's K5 rule, kept here.
    // This branch is a transcript Whisper DID return; the empty case is handled above, where the
    // client reports `empty_transcript` and never reaches here with an empty string.
    silent_window: text.trim().length === 0,
    chars: text.length,
    language: (w as { language?: string }).language ?? null,
    segments,
  });
}
