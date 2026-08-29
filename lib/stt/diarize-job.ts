/**
 * lib/stt/diarize-job.ts — the room diarize pass and the first-ever speaker_cluster writer
 * (PRD §7, Build 4 §A and §B).
 *
 * ─── THE TABLE THIS WRITES HAS NEVER BEEN WRITTEN ─────────────────────────────────────────
 * `speaker_cluster` shipped in migration 0042 with a reader, grants, and a test asserting that
 * nothing writes it. That absence was enforced on purpose while the schema decision was open.
 * This module is the writer, and it is the only one.
 *
 * ─── EVERY CLUSTER IS kind='other' ────────────────────────────────────────────────────────
 * See speaker-clusters.ts. No identity evidence exists, so no cluster claims one.
 *
 * ─── ADMISSION CONTROL, AND WHAT IT DOES NOT COVER ────────────────────────────────────────
 * `runDiarize` already takes the depth-1 lease itself, and the lease key is the single global
 * slot `'diarize'` — not one slot per subject. So a room window and an encounter contend for the
 * SAME slot by construction, and two room windows serialise against each other, with no change
 * to the gate's mechanism at all. This module supplies the room label so the holder is legible
 * in `readDiarizeSlot()`.
 *
 * WHAT IS STILL UNGATED, FLAGGED RATHER THAN IMPLIED: Whisper. The slot covers the diarize
 * service only; `lib/whisper.ts` takes no lease, so a room drain and this pass can still put a
 * Whisper call and a pyannote call on the Mini's MPS at the same time. PRD §7 asks that "Whisper
 * and pyannote never contend uncontrolled"; this build delivers the pyannote half. Gating Whisper
 * means changing the drain and the encounter path, both outside this build's contract.
 *
 * ─── EVERY SQL STRING HERE IS INFERRED ────────────────────────────────────────────────────
 * No live database. Reads fail safe to empty with a logged reason and NEVER produce a written row
 * from a partial answer — a cluster written out of a failed read would be indistinguishable from
 * a real one for ever.
 */

import { sql } from "@/lib/db";
import { getObjectBytes } from "@/lib/r2";
import { runDiarize, type DiarizeSpeaker } from "@/lib/diarize";
import { roomDiarizeLabel } from "@/lib/diarize-gate";
import {
  decodeEmbedding,
  decodeCentroid,
  encodeCentroid,
  matchCluster,
  runningMean,
  parseDiarizeSegments,
  bindTurnsToSpeakers,
  clustersEnabled,
  readThreshold,
  type ClusterCandidate,
  type TurnSpan,
} from "./speaker-clusters";

/** Bounded so one pass fits a single invocation beside the Mini's serialised service. */
export const DIARIZE_BATCH_LIMIT = 4;

const clusterId = () => `sc_${Math.random().toString(36).slice(2, 12)}`;

type Logger = (msg: string) => void;

async function safeRead<T>(what: string, fallback: T, log: Logger, run: () => Promise<T>): Promise<{ ok: boolean; value: T }> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    log(`[room-diarize] read failed (${what}): ${String((e as Error)?.message ?? e).slice(0, 200)} — degraded to empty, nothing written`);
    return { ok: false, value: fallback };
  }
}

export type DiarizeWindowRow = {
  id: string;
  session_id: string;
  room_day_id: string | null;
  start_ms: string | number;
  end_ms: string | number;
  clip_r2_key: string | null;
};

export type DiarizeJobResult = {
  enabled: boolean;
  scanned: number;
  diarized: number;
  failed: number;
  clusters_created: number;
  clusters_updated: number;
  turns_bound: number;
  /** True when the caller asked for diarize results only — no cluster or binding writes. */
  dry: boolean;
  errors: string[];
};

/**
 * One pass. Never throws.
 *
 * `dry` diarizes and STORES the service's answer but writes no clusters and no bindings. That is
 * the sequence the threshold freeze needs: run dry once, read the calibration surface, set
 * SPEAKER_MATCH_THRESHOLD, then run for real — without a night of Mini time to re-diarize.
 */
export async function runRoomDiarizePass(
  opts: { limit?: number; log?: Logger; dry?: boolean; origin?: string } = {},
): Promise<DiarizeJobResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dry = opts.dry === true;
  const result: DiarizeJobResult = {
    enabled: false, scanned: 0, diarized: 0, failed: 0,
    clusters_created: 0, clusters_updated: 0, turns_bound: 0, dry, errors: [],
  };

  // ── The gate. Off is a clean no-op with a log line and NO database work at all. ────────────
  if (!clustersEnabled()) {
    log(`[room-diarize] SPEAKER_CLUSTERS_ENABLED is not "1" — skipping (this is the shipped state)`);
    return result;
  }
  result.enabled = true;

  // ── The threshold. LOUD when unset; the pass refuses rather than inventing a line. ────────
  // Skipped for a dry run: a dry run writes no clusters, so it needs no threshold — which is
  // what lets it produce the very data the threshold is chosen from.
  const th = readThreshold();
  if (!dry && !th.ok) {
    const msg = `[room-diarize] ${th.error}: SPEAKER_MATCH_THRESHOLD must be set before clusters are written (PRD §7 — the value is frozen from the calibration report, never defaulted)`;
    log(msg);
    result.errors.push(th.error);
    return result;
  }
  const threshold = th.ok ? th.threshold : Number.NaN;

  // INFERRED SQL #1 — closed windows with verified audio, a room_day, a joined clip, and no
  // diarize row yet. `clip_r2_key IS NOT NULL` is what "verified audio" means operationally here:
  // the clip exists because the drain joined it, and the drain only joins covering chunks.
  const windows = await safeRead<DiarizeWindowRow[]>("bench_window scan", [], log, async () =>
    (await sql`
      SELECT w.id, w.session_id, w.room_day_id, w.start_ms, w.end_ms, w.clip_r2_key
        FROM bench_window w
       WHERE w.state IN ('closed', 'transcribed')
         AND w.grid_aligned = TRUE
         AND w.room_day_id IS NOT NULL
         AND w.clip_r2_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM room_diarize_window d WHERE d.window_id = w.id)
       ORDER BY w.start_ms ASC
       LIMIT ${Math.max(1, Math.min(DIARIZE_BATCH_LIMIT, Math.trunc(opts.limit ?? DIARIZE_BATCH_LIMIT) || DIARIZE_BATCH_LIMIT))}
    `) as DiarizeWindowRow[]);
  if (!windows.ok) {
    result.errors.push("bench_window scan failed");
    return result;
  }
  result.scanned = windows.value.length;

  for (const w of windows.value) {
    const startMs = Number(w.start_ms);
    const endMs = Number(w.end_ms);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !w.clip_r2_key || !w.room_day_id) continue;

    const bytes = await getObjectBytes(w.clip_r2_key);
    if (!bytes) {
      await markWindow(w, "failed", `clip_missing:${w.clip_r2_key}`, null, null, null, log, result);
      result.failed++;
      continue;
    }

    // The encounter path's request format, mirrored: webm, the same form fields, the same client.
    // `encounterId` carries a bench_window id here — the wire field is named `encounter_id` and
    // this room call has no encounter. Flagged in the build report; widening lib/diarize.ts to
    // take a subject pair is out of this build's contract.
    const outcome = await runDiarize(Buffer.from(bytes), "audio/webm", {
      encounterId: roomDiarizeLabel(w.id),
    });

    if (!outcome.ok) {
      // A DIARIZE FAILURE IS NAMED, VISIBLE, AND DOES NOT BLOCK THE QUEUE. `retryable` (no slot)
      // is recorded as `skipped` so it is picked up next tick; a real failure is terminal for
      // this window rather than a clip that occupies the Mini's one slot all night.
      const state = outcome.retryable ? "skipped" : "failed";
      if (state === "failed") {
        await markWindow(w, "failed", outcome.error, null, null, outcome.timing, log, result);
        result.failed++;
      } else {
        log(`[room-diarize] ${w.id}: no slot (${outcome.error}) — left for the next tick, no row written`);
      }
      continue;
    }

    const speakers = outcome.result.speakers ?? [];
    const segments = parseDiarizeSegments(outcome.result.transcript_segments);

    if (speakers.length === 0) {
      await markWindow(w, "no_speakers", null, speakers, segments, outcome.timing, log, result);
      result.diarized++;
      continue;
    }

    await markWindow(w, "ok", null, speakers, segments, outcome.timing, log, result);
    result.diarized++;

    // A dry run stops here: the service's answer is stored, nothing is clustered or bound.
    if (dry) continue;

    const counts = await writeClusters(w, speakers, threshold, log, result);
    if (counts) await bindTurns(w, segments, startMs, endMs, counts.byIdx, log, result);
  }

  log(`[room-diarize] pass done: scanned=${result.scanned} diarized=${result.diarized} failed=${result.failed} created=${result.clusters_created} updated=${result.clusters_updated} bound=${result.turns_bound} dry=${dry}`);
  return result;
}

/** INFERRED SQL #2 — the per-window state row. Idempotent on the window primary key. */
async function markWindow(
  w: DiarizeWindowRow,
  state: "ok" | "failed" | "skipped" | "no_speakers",
  error: string | null,
  speakers: DiarizeSpeaker[] | null,
  segments: unknown[] | null,
  timing: unknown,
  log: Logger,
  result: DiarizeJobResult,
): Promise<void> {
  try {
    await sql`
      INSERT INTO room_diarize_window
        (window_id, room_day_id, state, speakers_json, segments_json, clip_r2_key, error, timing_json, diarized_at)
      VALUES
        (${w.id}, ${w.room_day_id}, ${state},
         ${speakers === null ? null : JSON.stringify(speakers)}::jsonb,
         ${segments === null ? null : JSON.stringify(segments)}::jsonb,
         ${w.clip_r2_key}, ${error === null ? null : error.slice(0, 300)},
         ${timing === null || timing === undefined ? null : JSON.stringify(timing)}::jsonb, NOW())
      ON CONFLICT (window_id) DO NOTHING
    `;
  } catch (e) {
    const msg = `[room-diarize] ${w.id}: state write failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
    log(msg);
    result.errors.push(msg);
  }
}

/**
 * §B — the cluster writer.
 *
 * Per speaker: decode the embedding, match against the room-day's existing clusters, and either
 * update the matched centroid by running mean or open a new one. The membership ledger is written
 * FIRST with ON CONFLICT DO NOTHING, and a conflict means this (window, speaker) was already
 * counted — so the centroid update is skipped entirely. That is what makes a re-run a true no-op
 * rather than a second application of the same voice to the same mean.
 */
async function writeClusters(
  w: DiarizeWindowRow,
  speakers: readonly DiarizeSpeaker[],
  threshold: number,
  log: Logger,
  result: DiarizeJobResult,
): Promise<{ byIdx: Map<number, string> } | null> {
  // INFERRED SQL #3 — the room-day's existing clusters, with their centroids and their sample
  // counts from the ledger. LEFT JOIN so a cluster with no ledger rows (an older writer, a merge)
  // still participates rather than vanishing from the match.
  const existing = await safeRead<Array<{ id: string; centroid: unknown; n: number }>>(
    `clusters for ${w.room_day_id}`, [], log, async () =>
      (await sql`
        SELECT c.id, c.centroid, COALESCE(m.n, 0)::int AS n
          FROM speaker_cluster c
          LEFT JOIN (
            SELECT cluster_id, COUNT(*)::int AS n
              FROM room_speaker_cluster_member GROUP BY cluster_id
          ) m ON m.cluster_id = c.id
         WHERE c.room_day_id = ${w.room_day_id}
      `) as Array<{ id: string; centroid: unknown; n: number }>);
  // A FAILED READ WRITES NOTHING. Proceeding on an empty list would open a fresh cluster for
  // every speaker and permanently fracture the day.
  if (!existing.ok) return null;

  const live = existing.value
    .map((r) => ({ id: r.id, centroid: decodeCentroid(r.centroid), n: Number(r.n) || 0 }))
    .filter((r): r is { id: string; centroid: Float32Array; n: number } => r.centroid !== null);

  const byIdx = new Map<number, string>();

  for (const sp of speakers) {
    const emb = decodeEmbedding(sp.embedding_base64);
    if (!emb) {
      log(`[room-diarize] ${w.id}: speaker ${sp.idx} has no usable embedding — not clustered`);
      continue;
    }
    const candidates: ClusterCandidate[] = live.map((c) => ({ id: c.id, centroid: c.centroid }));
    const decision = matchCluster(emb, candidates, threshold);

    try {
      if (decision.kind === "match") {
        // Claim the membership first. A conflict = already counted = do not touch the centroid.
        const claimed = (await sql`
          INSERT INTO room_speaker_cluster_member (window_id, speaker_idx, cluster_id, room_day_id, cosine, bound_at)
          VALUES (${w.id}, ${sp.idx}, ${decision.cluster_id}, ${w.room_day_id}, ${decision.cosine}, NOW())
          ON CONFLICT (window_id, speaker_idx) DO NOTHING
          RETURNING cluster_id
        `) as Array<{ cluster_id: string }>;
        byIdx.set(sp.idx, decision.cluster_id);
        if (claimed.length === 0) continue; // already counted — the mean must not move again

        const cl = live.find((c) => c.id === decision.cluster_id)!;
        const next = runningMean(cl.centroid, cl.n, emb);
        // INFERRED SQL #4.
        await sql`
          UPDATE speaker_cluster
             SET centroid = ${encodeCentroid(next)}, last_seen_at = NOW()
           WHERE id = ${decision.cluster_id}
        `;
        cl.centroid = next;
        cl.n += 1;
        result.clusters_updated++;
      } else {
        const id = clusterId();
        // INFERRED SQL #5 — the first INSERT INTO speaker_cluster this system has ever made.
        // kind is the literal 'other' and nothing computes it.
        await sql`
          INSERT INTO speaker_cluster (id, room_day_id, kind, centroid, first_seen_at, last_seen_at)
          VALUES (${id}, ${w.room_day_id}, 'other', ${encodeCentroid(emb)}, NOW(), NOW())
        `;
        await sql`
          INSERT INTO room_speaker_cluster_member (window_id, speaker_idx, cluster_id, room_day_id, cosine, bound_at)
          VALUES (${w.id}, ${sp.idx}, ${id}, ${w.room_day_id}, NULL, NOW())
          ON CONFLICT (window_id, speaker_idx) DO NOTHING
        `;
        live.push({ id, centroid: emb, n: 1 });
        byIdx.set(sp.idx, id);
        result.clusters_created++;
      }
    } catch (e) {
      const msg = `[room-diarize] ${w.id}/speaker ${sp.idx}: cluster write failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
      log(msg);
      result.errors.push(msg);
    }
  }
  return { byIdx };
}

/**
 * §C — bind Whisper's turns to diarize speakers by time overlap.
 *
 * The diarize segments are RELATIVE TO THE CLIP; the turns are on the wall clock. The window's
 * start is added here, in the one place that knows both.
 */
async function bindTurns(
  w: DiarizeWindowRow,
  segments: ReturnType<typeof parseDiarizeSegments>,
  startMs: number,
  endMs: number,
  byIdx: Map<number, string>,
  log: Logger,
  result: DiarizeJobResult,
): Promise<void> {
  if (segments.length === 0) return;

  // INFERRED SQL #6 — this window's turn cues. The ::bigint cast on both bounds is the house
  // pattern from lib/brain/state.ts (SQL_CUE_DELETE_WINDOW): the payload holds these as JSON
  // numbers, and comparing them as text would make 1755576000000 and 1.755576e12 different
  // windows. A row with no window in its payload yields NULL and is left alone.
  const turns = await safeRead<Array<{ source_ref: string; start_ms: string | number; end_ms: string | number }>>(
    `turn cues for ${w.id}`, [], log, async () =>
      (await sql`
        SELECT source_ref,
               (payload->>'start_ms')::bigint AS start_ms,
               (payload->>'end_ms')::bigint AS end_ms
          FROM cue
         WHERE room_day_id = ${w.room_day_id}
           AND type = 'stt_turn'
           AND (payload->'window'->>'start_ms')::bigint = ${startMs}
           AND (payload->'window'->>'end_ms')::bigint = ${endMs}
           AND source_ref IS NOT NULL
      `) as Array<{ source_ref: string; start_ms: string | number; end_ms: string | number }>);
  if (!turns.ok || turns.value.length === 0) return;

  const spans: TurnSpan[] = turns.value
    .map((t) => ({ source_ref: String(t.source_ref), start_ms: Number(t.start_ms), end_ms: Number(t.end_ms) }))
    .filter((t) => Number.isFinite(t.start_ms) && Number.isFinite(t.end_ms));

  // Clip-relative → wall clock, once, here.
  const onClock = segments.map((s) => ({ ...s, start_ms: startMs + s.start_ms, end_ms: startMs + s.end_ms }));
  void endMs;

  for (const b of bindTurnsToSpeakers(onClock, spans)) {
    try {
      // INFERRED SQL #7 — idempotent per (window, turn).
      await sql`
        INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, cluster_id, overlap_ms, room_day_id, created_at)
        VALUES (${w.id}, ${b.source_ref}, ${b.speaker_idx}, ${byIdx.get(b.speaker_idx) ?? null}, ${b.overlap_ms}, ${w.room_day_id}, NOW())
        ON CONFLICT (window_id, source_ref) DO NOTHING
      `;
      result.turns_bound++;
    } catch (e) {
      const msg = `[room-diarize] ${w.id}: turn binding failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
      log(msg);
      result.errors.push(msg);
    }
  }
}
