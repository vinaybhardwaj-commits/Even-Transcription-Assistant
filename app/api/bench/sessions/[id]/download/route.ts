/**
 * GET /api/bench/sessions/{id}/download — D7 day download: a streaming
 * ZIP of all chunks in idx order plus manifest.json. Admin-gated.
 * K-B: the zip carries BOTH streams — chunk_{idx}.webm (primary) then
 * backup_chunk_{idx}.webm (second mic) — and the manifest lists them separately.
 *
 * Hand-rolled STORE-only zip (method 0 — WebM is already compressed; no new
 * npm deps): local file headers + central directory + EOCD via
 * lib/bench.ts's StoreZipWriter. CRC-32 computed per entry. No zip64:
 * totals ≥ 4 GB return 413 with a clear message (PRD §9.3).
 *
 * Chunks are pulled from R2 one at a time (a 5-min opus chunk is ~5–15 MB)
 * and streamed out as they are read. A mid-stream R2 read failure aborts
 * the stream — a truncated download is loud, never silently incomplete.
 * Nothing under bench/ is ever written or deleted here (D6).
 *
 * Kickoff D (decision D2): the zip also carries timeline.md next to manifest.json,
 * from the same generator as /timeline. Generated in-request; a generator failure
 * skips that entry (logged) and never breaks the zip.
 */
import { NextRequest, NextResponse } from "next/server";
import { respondError } from "@/lib/respond";
import {
  benchAdminGuard,
  findBenchSession,
  listBenchChunks,
  listBenchEvents,
  splitChunksBySource,
  StoreZipWriter,
} from "@/lib/bench";
import { getObjectBytes } from "@/lib/r2";
import { chunkBasename } from "@/lib/bench-dual";
import { renderBenchTimeline } from "@/lib/bench-timeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FOUR_GB = 4 * 1024 * 1024 * 1024;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await benchAdminGuard();
  if (!g.ok) return respondError(g.code, g.msg);
  if (!id.startsWith("bs_")) return respondError("VALIDATION_FAILED", "bad_session_id");

  const session = await findBenchSession(id);
  if (!session) return respondError("NOT_FOUND", "session_not_found");
  const all = await listBenchChunks(id); // primary first, then backup (K-B) — zip carries both
  const { primary: chunks, backup: backupChunks } = splitChunksBySource(all);
  if (all.length === 0) {
    return respondError("NOT_FOUND", "no_chunks_for_session");
  }
  let events: Array<{ id: string; kind: string; at: string; brain_status: string; payload: unknown }> = [];
  try {
    events = (await listBenchEvents(id)).map((e) => ({ id: e.id, kind: e.kind, at: new Date(e.at).toISOString(), brain_status: e.brain_status, payload: e.payload ?? null }));
  } catch {
    events = [];
  }

  const totalBytes = all.reduce((a, c) => a + Number(c.size_bytes ?? 0), 0);
  if (totalBytes >= FOUR_GB) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message:
            "Session exceeds 4 GB — the STORE-zip endpoint has no zip64 support. Download chunks individually via the manifest's presigned links.",
        },
      },
      { status: 413 },
    );
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    session: {
      id: session.id,
      room_name: session.room_name,
      room_slug: session.room_slug,
      label: session.label,
      mic_label: session.mic_label,
      started_at: new Date(session.started_at).toISOString(),
      ended_at: session.ended_at ? new Date(session.ended_at).toISOString() : null,
      status: session.status,
      notes: session.notes,
    },
    chunks: chunks.map((c) => ({
      idx: c.idx,
      source: "primary",
      zip_entry: chunkBasename(c.idx, "primary"),
      r2_key: c.r2_key,
      content_type: c.content_type,
      started_at: new Date(c.started_at).toISOString(),
      ended_at: new Date(c.ended_at).toISOString(),
      duration_ms: c.duration_ms,
      size_bytes: c.size_bytes === null ? null : Number(c.size_bytes),
      upload_state: c.upload_state,
      gap_before_ms: c.gap_before_ms,
    })),
    gaps: chunks
      .filter((c) => c.gap_before_ms >= 2000)
      .map((c) => ({ before_idx: c.idx, gap_ms: c.gap_before_ms })),
    // K-B: second-mic stream (backup_chunk_{idx}.webm) + the mic story
    backup_chunks: backupChunks.map((c) => ({
      idx: c.idx,
      source: "backup",
      zip_entry: chunkBasename(c.idx, "backup"),
      r2_key: c.r2_key,
      content_type: c.content_type,
      started_at: new Date(c.started_at).toISOString(),
      ended_at: new Date(c.ended_at).toISOString(),
      duration_ms: c.duration_ms,
      size_bytes: c.size_bytes === null ? null : Number(c.size_bytes),
      upload_state: c.upload_state,
      gap_before_ms: c.gap_before_ms,
    })),
    backup_gaps: backupChunks
      .filter((c) => c.gap_before_ms >= 2000)
      .map((c) => ({ before_idx: c.idx, gap_ms: c.gap_before_ms })),
    events,
  };

  const zip = new StoreZipWriter();
  const now = new Date();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const c of all) {
          const bytes = await getObjectBytes(c.r2_key);
          if (bytes === null) {
            // Object missing in R2 — abort loudly rather than emit a zip that
            // silently lacks a chunk (never wrong data).
            controller.error(new Error(`bench_chunk_missing_in_r2:${c.r2_key}`));
            return;
          }
          const entryName = chunkBasename(c.idx, c.source ?? "primary");
          controller.enqueue(zip.entry(entryName, bytes, new Date(c.started_at)));
        }
        const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
        controller.enqueue(zip.entry("manifest.json", manifestBytes, now));
        // D2: timeline.md — same generator as /timeline; renderBenchTimeline never throws,
        // but a defensive catch keeps the zip whole regardless.
        try {
          const { markdown } = await renderBenchTimeline(session.id, session);
          controller.enqueue(zip.entry("timeline.md", new TextEncoder().encode(markdown), now));
        } catch (e) {
          console.warn("[bench-download] timeline.md skipped", String((e as Error)?.message ?? e).slice(0, 200));
        }
        controller.enqueue(zip.finish());
        controller.close();
      } catch (e) {
        controller.error(e instanceof Error ? e : new Error(String(e)));
      }
    },
  });

  const dateYmd = new Date(session.started_at).toISOString().slice(0, 10);
  const filename = `${session.room_slug}_${dateYmd}_${session.id}.zip`;

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
