/**
 * Reader emotion — S7-0. room_span_emotion rows (state scored) of one window: per diarized speaker span, the seven emotion scores and the top label. Numbers only.
 */
import { sql } from "@/lib/db";
import { blindGuardWindow, refuse, type ReadResult } from "@/lib/room-access/readers/common";

export type EmotionSpan = { speaker_idx: number; segment_start_ms: number; segment_end_ms: number; scores: Record<string, number>; top_label: string | null; top_score: number | null };
export type WindowEmotion = { window_id: string; spans: EmotionSpan[] };
const EMOTIONS = ["anger", "disgust", "enthusiasm", "fear", "happiness", "neutral", "sadness"] as const;

export async function readWindowEmotion(windowId: string): Promise<ReadResult<WindowEmotion>> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(windowId)) return refuse("bad_unit_key");
  const blind = await blindGuardWindow(windowId); // BEFORE any emotion row is read
  if (blind) return blind;
  const rows = (await sql`
    SELECT speaker_idx, segment_start_ms, segment_end_ms, anger, disgust, enthusiasm, fear, happiness, neutral, sadness, top_label, top_score
      FROM room_span_emotion WHERE window_id = ${windowId}::text AND state = 'scored' ORDER BY segment_start_ms, speaker_idx, chunk_idx
  `) as Array<Record<string, string | number | null>>;
  if (rows.length === 0) return refuse("no_data", "no scored emotion span");
  return {
    ok: true,
    data: {
      window_id: windowId,
      spans: rows.map((r) => ({
        speaker_idx: Number(r.speaker_idx), segment_start_ms: Number(r.segment_start_ms), segment_end_ms: Number(r.segment_end_ms),
        scores: Object.fromEntries(EMOTIONS.map((k) => [k, Number(r[k])])), top_label: (r.top_label as string | null) ?? null, top_score: r.top_score === null ? null : Number(r.top_score),
      })),
    },
  };
}
