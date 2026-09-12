/**
 * lib/jobs/kinds/stitch.ts — Tier 2 §3, the `stitch` step machine: resolve → join × N → manifest.
 *
 * THIS IS WHY JOBS EXIST. A range longer than one clip cannot be joined in a single call — the join
 * service is given ≤ 30-minute pieces by contract — so an hour is several joins, each taking real
 * seconds, and no request-shaped tool can hold that. As a job it is one piece per claim: the plan is
 * computed once in `resolve`, and every later claim joins exactly ONE piece and writes its key down.
 * A runner killed after the fourth piece resumes at the fifth.
 *
 * `progress.pieces` is the plan and `progress.done` is how far it got. Keys and ms only; no bytes.
 */

import { listBenchChunks } from "@/lib/bench";
import { resolveRange, type CoveringChunk, type RangeResolution } from "@/lib/bench-range";
import { buildJoinRequest, callJoinService } from "@/lib/bench-join";
import type { BenchChunkRow } from "@/lib/bench";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext } from "../types";
import { jobError } from "../errors";

/** §4.3's contract: the join service is never asked for more than half an hour at once. */
export const STITCH_PIECE_MS = 30 * 60_000;

const STEPS = { resolve: "resolve", join: "join" } as const;

/**
 * PURE — split [start, end) into ≤ 30-minute pieces. The boundary cases are the whole test: 30 min
 * exactly is ONE piece (not two, and not one-plus-an-empty-one), 31 min is two, 61 is three.
 */
export function planPieces(startMs: number, endMs: number, pieceMs = STITCH_PIECE_MS): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let a = startMs; a < endMs; a += pieceMs) out.push({ start: a, end: Math.min(a + pieceMs, endMs) });
  return out;
}

const asMs = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

function coveringOf(r: RangeResolution<BenchChunkRow>): CoveringChunk<BenchChunkRow>[] {
  if (r.kind === "single") return [r.covering];
  if (r.kind === "multi") return r.covering;
  return [];
}

export const stitchKind: JobKind = {
  name: "stitch",
  first: STEPS.resolve,
  scope: "invoke",

  parseArgs(raw) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const session_id = typeof o.session_id === "string" ? o.session_id.trim() : "";
    if (!session_id) throw new JobArgsError("session_id is required");
    const start = asMs(o.start);
    const end = asMs(o.end);
    if (start === null || end === null) throw new JobArgsError("start and end must be epoch ms or ISO times");
    if (end <= start) throw new JobArgsError("end must be after start");
    const format = o.format === "wav" ? "wav" : "webm";
    const source = o.source === "backup" ? "backup" : "primary";
    return { session_id, start, end, source, format };
  },

  async run(ctx: StepContext) {
    if (ctx.step === STEPS.resolve) return resolveStep(ctx);
    if (ctx.step === STEPS.join) return joinStep(ctx);
    return failWith(jobError("unknown_step", ctx.step));
  },
};

/** Step 1 — the plan, computed once. Every later claim reads it rather than recomputing it. */
async function resolveStep(ctx: StepContext) {
  const { start, end } = ctx.args as { start: number; end: number };
  const pieces = planPieces(start, end);
  if (!pieces.length) return failWith(jobError("empty_range"));
  return nextStep(STEPS.join, { pieces, done: [], total_ms: end - start });
}

/**
 * Step 2 — ONE piece per claim, then hand back. Returning `next` with the same step name is how a
 * loop is expressed in a step machine: the runner releases the lease and the next claim continues,
 * so N pieces cost N claims and no single invocation approaches the route ceiling.
 */
async function joinStep(ctx: StepContext) {
  const { session_id, source } = ctx.args as { session_id: string; source: "primary" | "backup" };
  const pieces = (ctx.progress.pieces as Array<{ start: number; end: number }>) ?? [];
  const done = (ctx.progress.done as Array<Record<string, unknown>>) ?? [];
  const i = done.length;

  if (i >= pieces.length) {
    // POINTERS ONLY (Refuter item 2): {start, end, clip_key} per piece. Bytes and durations stay
    // out; a presigned URL is minted on demand by scribe_job_status, never stored on the row.
    return doneWith({
      session_id,
      pieces: done.map((d) => ({ start: d.start, end: d.end, clip_key: d.clip_key ?? null })),
      total_ms: ctx.progress.total_ms ?? null,
      piece_count: done.length,
    });
  }

  const piece = pieces[i]!;
  const chunks = await listBenchChunks(session_id);
  const covering = coveringOf(resolveRange(chunks, piece.start, piece.end, source));
  if (!covering.length) {
    // A hole in the tape is a FACT about the day, not a failure of the stitch: record it and carry
    // on, so one missing stretch does not throw away the pieces either side of it.
    const next = [...done, { start: piece.start, end: piece.end, clip_key: null, error: "no_audio_in_range" }];
    return nextStep(STEPS.join, { ...ctx.progress, done: next });
  }

  const joined = await callJoinService(buildJoinRequest(session_id, covering, piece.start, piece.end, source));
  if (!joined.ok) {
    console.error("[jobs] stitch join failed", JSON.stringify({ piece: i, err: joined.error, hop: joined.hop }));
    return failWith(jobError("join_failed", `piece ${i}${joined.hop ? ` hop ${joined.hop}` : ""}`));
  }

  const next = [...done, { start: piece.start, end: piece.end, clip_key: joined.key, bytes: joined.bytes, duration_ms: joined.duration_ms }];
  return nextStep(STEPS.join, { ...ctx.progress, done: next });
}
