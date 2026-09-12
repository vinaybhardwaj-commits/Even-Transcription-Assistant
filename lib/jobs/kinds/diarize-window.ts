/**
 * lib/jobs/kinds/diarize-window.ts — C2 Part B, D4. Diarize a room window, ONE SLICE PER STEP.
 *
 * A 900 s window is ~1350 s of service time and a lease is 240 s, so a whole-window call could not
 * run at any lease value and the first version refused every production window at admission. It is
 * now a step machine: eight 120 s slices for a standard window, each ~225 s projected against a
 * 240 s lease, then one stitch step that gives the slices a shared notion of who is who.
 *
 * NOT the SPEAKER_CLUSTERS_ENABLED cron path, which still ships dark behind two env gates and is
 * neither revived nor read here.
 */
import { getObjectBytes } from "@/lib/r2";
import { sql } from "@/lib/db";
import { buildJoinRequest, callJoinService } from "@/lib/bench-join";
import { resolveRange, type RangeChunk } from "@/lib/bench-range";
import { diarizeSlice, applyStitch, applyClusterIds, loadClinicianCentroids, loadWindowTurns } from "@/lib/stt/diarize-window";
import { snappedSliceBounds, sliceFits, stitchSpeakers, SLICE_MS, type SliceSpeaker } from "@/lib/stt/diarize-slicing";
import { windowStart, windowEnd, sliceStart, sliceEnd, ms, type SliceStartMs, type SliceEndMs } from "@/lib/stt/window-bounds";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext } from "../types";
import { jobError } from "../errors";

export const DIARIZE_WINDOW_KIND = "diarize_window";

/** The frozen plan, as it rides on the job row: plain numbers, no brands over the wire. */
type PlanEntry = { index: number; start: number; end: number };
const writePlan = (slices: readonly { index: number; start: SliceStartMs; end: SliceEndMs }[]): PlanEntry[] =>
  slices.map((sl) => ({ index: sl.index, start: ms(sl.start), end: ms(sl.end) }));
/** Re-brand on the way back in — the one place these numbers are re-asserted as slice bounds. */
function readPlan(progress: Record<string, unknown>): Array<{ index: number; start: SliceStartMs; end: SliceEndMs }> | null {
  const raw = progress.slice_plan;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = raw.map((e) => {
    const o = e as PlanEntry;
    return { index: Number(o.index), start: sliceStart(Number(o.start)), end: sliceEnd(Number(o.end)) };
  });
  return out.every((o) => Number.isFinite(o.index) && Number.isFinite(o.start) && Number.isFinite(o.end)) ? out : null;
}
const STEPS = { slice: "slice", stitch: "stitch" } as const;

type WindowRow = { id: string; session_id: string; room_day_id: string | null; start_ms: string | number; end_ms: string | number; source_mic: string };

async function loadWindow(windowId: string): Promise<WindowRow | null> {
  const rows = (await sql`
    SELECT id, session_id, room_day_id, start_ms, end_ms, source_mic
      FROM bench_window WHERE id = ${windowId} LIMIT 1
  `) as WindowRow[];
  return rows[0] ?? null;
}

/** The audio for one slice: joined on demand, exactly as the language probe joins its first 30 s. */
async function sliceAudio(w: WindowRow, startMs: number, endMs: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; code: "no_audio_in_range" | "join_failed" | "clip_missing_in_r2" }> {
  const source = w.source_mic === "backup" ? "backup" : "primary";
  const chunks = (await sql`
    SELECT idx, source, r2_key, content_type, started_at, ended_at, upload_state
      FROM bench_chunk WHERE session_id = ${w.session_id} ORDER BY source, idx
  `) as RangeChunk[];
  const res = resolveRange(chunks, startMs, endMs, source);
  if (res.kind === "none") return { ok: false, code: "no_audio_in_range" };
  const covering = res.kind === "single" ? [res.covering] : res.covering;
  const join = await callJoinService(buildJoinRequest(w.session_id, covering, startMs, endMs, source));
  if (!join.ok) return { ok: false, code: "join_failed" };
  const bytes = await getObjectBytes(join.key);
  if (!bytes) return { ok: false, code: "clip_missing_in_r2" };
  return { ok: true, bytes };
}

export const diarizeWindowKind: JobKind = {
  name: DIARIZE_WINDOW_KIND,
  first: STEPS.slice,
  scope: "invoke",

  parseArgs(raw) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const window_id = typeof o.window_id === "string" ? o.window_id.trim() : "";
    if (!window_id) throw new JobArgsError("window_id is required");
    return { window_id };
  },

  async run(ctx: StepContext) {
    const windowId = String(ctx.args.window_id ?? "");
    const w = await loadWindow(windowId);
    if (!w) return failWith(jobError("progress_incomplete", "no such window"));
    if (!w.room_day_id) return failWith(jobError("progress_incomplete", "window has no room_day"));
    const win = { start: windowStart(Number(w.start_ms)), end: windowEnd(Number(w.end_ms)) };

    // ── THE PLAN IS COMPUTED ONCE AND FROZEN ON THE ROW ──────────────────────────────────────
    // It used to be recomputed from the turns on EVERY step, including the stitch — and the turns
    // move underneath it: a window re-drain DELETEs and re-INSERTs every stt_turn cue, and whisper
    // is explicitly non-deterministic about how many segments it finds. So a job could run nine
    // slices and then stitch against a freshly-computed plan of eight (proceeding at a geometry
    // that no longer matched what it had measured), or run all eight it was told to and then be
    // refused for "missing" a ninth that only existed in the recomputation. Derived state that
    // changes under a multi-step job is not derived state; it is a race.
    let slices = readPlan(ctx.progress);
    if (!slices) {
      const allTurns = await loadWindowTurns(w.room_day_id, win);
      slices = snappedSliceBounds(ms(win.start), ms(win.end), allTurns);
      if (slices.length === 0) return failWith(jobError("progress_incomplete", "window has no duration"));
    }

    if (ctx.step === STEPS.stitch) {
      // The speakers every slice saw, read back from where the slice steps put them — NOT from
      // `progress`, which scribe_job_status returns to a READ-scope token. A speaker embedding is
      // a voiceprint; it belongs in the database beside the enrolled ones, not in a column an
      // operator can list.
      const rows = (await sql`
        SELECT speakers_json FROM room_diarize_window WHERE window_id = ${windowId} LIMIT 1
      `) as Array<{ speakers_json: unknown }>;
      const stored = (rows[0]?.speakers_json ?? null) as { slices?: Array<{ index: number; speakers: SliceSpeaker[] }> } | null;
      const entries = stored?.slices ?? [];

      // ── THE STITCH VERIFIES ITS OWN INPUTS ─────────────────────────────────────────────────
      // Completeness used to live only in step ordering — every failing slice returns failWith,
      // which is terminal — so nothing checked it HERE, and the result reported `slices: 8` read
      // from the plan while stitching six slices' data. A stitch over a partial window produces
      // identities that are quietly wrong (a voice absent from the missing slices looks like a
      // different speaker), so it refuses rather than guesses, and names what is missing.
      // SET EQUALITY, not presence. Presence alone let an index that was never planned (99) and a
      // DUPLICATED index (0,0) both proceed while inflating the count — and uniqueness is exactly
      // the invariant the slice write's strip-then-append exists to maintain, so this is also the
      // only thing that tests that statement worked.
      const observedIdx = entries.map((e) => Number(e.index));
      const planned = slices.map((sl) => sl.index);
      const present = new Set(observedIdx);
      const missing = planned.filter((i2) => !present.has(i2));
      const unplanned = [...new Set(observedIdx)].filter((i2) => !planned.includes(i2));
      const duplicated = [...new Set(observedIdx.filter((i2, n) => observedIdx.indexOf(i2) !== n))];
      if (missing.length || unplanned.length || duplicated.length) {
        // D7 — the OBSERVED count is reported in the failure too, not only the planned denominator.
        const why = [
          missing.length ? `missing ${missing.join(",")}` : "",
          unplanned.length ? `unplanned ${unplanned.join(",")}` : "",
          duplicated.length ? `duplicated ${duplicated.join(",")}` : "",
        ].filter(Boolean).join("; ");
        return failWith(jobError("diarize_failed",
          `stitch refused: observed ${entries.length} of ${slices.length} planned slices (${why})`));
      }

      const all: SliceSpeaker[] = [];
      for (const sl of entries) {
        for (const sp of sl.speakers ?? []) all.push({ ...sp, slice: Number(sl.index) });
      }
      const identities = stitchSpeakers(all);
      // ORDER IS LOAD-BEARING. applyStitch matches on the PER-SLICE cluster key (`s<slice>:<idx>`)
      // that diarizeSlice wrote; applyClusterIds REPLACES that key with the stitched `rsc_N`. Run
      // the other way round — as this did — and the stitch searches for a key that no longer
      // exists, matches nothing, and reports rows_stitched: 0 for ever. The cross-slice
      // propagation, the entire point of this step, was inert.
      const updated = await applyStitch(windowId, identities);
      await applyClusterIds(windowId, identities);
      return doneWith({
        window_id: windowId,
        // OBSERVED, never planned. The count that is reported is the count that was stitched.
        slices: entries.length,
        slices_planned: slices.length,
        speakers_seen: all.length,
        identities: new Set([...identities.values()].map((i) => i.cluster_id)).size,
        rows_stitched: updated,
        turns_named: Number(ctx.progress.turns_named ?? 0),
        turns_straddled: Number(ctx.progress.turns_straddled ?? 0),
        turns_seam_skipped: (Array.isArray(ctx.progress.seam_refs) ? ctx.progress.seam_refs.length : 0),
        turns_total: (Array.isArray(ctx.progress.turn_refs) ? ctx.progress.turn_refs.length : 0),
      });
    }

    if (ctx.step !== STEPS.slice) return failWith(jobError("unknown_step", ctx.step));

    void SLICE_MS;
    const i = Number(ctx.progress.slice_index ?? 0);
    const slice = slices[i];
    if (!slice) return nextStep(STEPS.stitch, { ...ctx.progress, slice_plan: writePlan(slices) });

    // The refusal still exists — it now guards the SLICE, which is a size we choose, so it fires
    // only if someone sets an absurd ETA_DIARIZE_REALTIME_FACTOR rather than on every real window.
    const seconds = (ms(slice.end) - ms(slice.start)) / 1000;
    if (!sliceFits(seconds)) {
      return failWith(jobError("diarize_would_exceed_budget", `slice ${i} of ${seconds}s does not fit a lease`));
    }

    const audio = await sliceAudio(w, ms(slice.start), ms(slice.end));
    if (!audio.ok) return failWith(jobError(audio.code === "join_failed" ? "join_failed" : audio.code));

    const centroids = await loadClinicianCentroids();
    const res = await diarizeSlice({ windowId, roomDayId: w.room_day_id, window: win, slice, audio: audio.bytes, centroids });
    if (!res.ok) {
      console.error("[jobs] diarize slice failed", JSON.stringify({ window: windowId, slice: i, err: String(res.error).slice(0, 200), retryable: res.retryable }));
      return failWith(jobError(res.retryable ? "diarize_unavailable" : "diarize_failed"));
    }

    // Park this slice's speakers where the stitch can find them, and where a read token cannot.
    await sql`
      INSERT INTO room_diarize_window (window_id, room_day_id, state, speakers_json, diarized_at)
      VALUES (${windowId}, ${w.room_day_id}, 'ok',
              ${JSON.stringify({ slices: [{ index: i, speakers: res.speakers }] })}::jsonb, NOW())
      ON CONFLICT (window_id) DO UPDATE
        SET state = 'ok',
            -- KEYED BY INDEX, REPLACING, NOT APPENDING. A slice that loses its lease at 225 s of a
            -- 240 s budget re-runs from the same slice_index, and the previous version appended a
            -- second entry for the same index: two voices under one map key, the winner chosen by
            -- array order, and the two-enrolled-ids guard bypassed because they sat in different
            -- groups. Strip index i, then add it back.
            speakers_json = jsonb_set(
              COALESCE(room_diarize_window.speakers_json, '{"slices":[]}'::jsonb), '{slices}',
              COALESCE((
                SELECT jsonb_agg(e)
                  FROM jsonb_array_elements(COALESCE(room_diarize_window.speakers_json->'slices', '[]'::jsonb)) e
                 WHERE (e->>'index')::int <> ${i}
              ), '[]'::jsonb) || ${JSON.stringify([{ index: i, speakers: res.speakers }])}::jsonb),
            diarized_at = NOW()
    `;

    const progress = {
      ...ctx.progress,
      slice_plan: writePlan(slices),
      slice_index: i + 1,
      turns_named: Number(ctx.progress.turns_named ?? 0) + res.outcome.named,
      turns_straddled: Number(ctx.progress.turns_straddled ?? 0) + res.outcome.straddled,
      // DISTINCT, not summed. A turn crossing a slice edge is loaded by BOTH slices by design and
      // each counts it, so the naive sum reported one turn as two. The rows were always right —
      // ON CONFLICT collapses them — but a counter that double-counts is a counter nobody can use.
      seam_refs: [...new Set([...(Array.isArray(ctx.progress.seam_refs) ? ctx.progress.seam_refs as string[] : []), ...res.outcome.seam_source_refs])],
      turn_refs: [...new Set([...(Array.isArray(ctx.progress.turn_refs) ? ctx.progress.turn_refs as string[] : []), ...res.outcome.turn_source_refs])],
    };
    return nextStep(i + 1 >= slices.length ? STEPS.stitch : STEPS.slice, progress);
  },
};
