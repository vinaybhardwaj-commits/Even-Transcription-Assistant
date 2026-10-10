/**
 * lib/diarize-nemotron/segments.ts — PURE. A Nemotron answer ([start_ms, end_ms, "spkN"] turns, clip-relative)
 * in the shape the room tables store: speaker indices, and segments carrying an `overlap` flag.
 *
 * SPEAKER INDICES are the position of each label among the distinct labels sorted by their number, so
 * `spk0, spk2` becomes idx 0, 1 (a gap in the labels must not leave a gap in `idx`, which `mergeEmbeddings` and
 * `rolesByIndex` match on). The original label is kept as the speaker's `label`.
 *
 * OVERLAP is derived from interval intersection, because Nemotron outputs no flag: a turn overlaps when another
 * speaker's turn shares any time with it (touching edges are not overlap).
 */
import type { DiarizeSegment } from "@/lib/stt/speaker-clusters";

export type NemotronTurn = readonly [number, number, string];
export type StoredSegment = DiarizeSegment & { overlap: boolean };

const labelNumber = (l: string): number => Number(l.slice(3));

export function nemotronToSegments(turns: ReadonlyArray<NemotronTurn>): { labels: string[]; segments: StoredSegment[] } {
  const labels = [...new Set(turns.map((t) => t[2]))].sort((a, b) => labelNumber(a) - labelNumber(b));
  const idxOf = new Map(labels.map((l, i) => [l, i] as const));
  const segments: StoredSegment[] = turns
    .filter((t) => t[1] > t[0])
    .map((t) => ({ start_ms: t[0], end_ms: t[1], speaker_idx: idxOf.get(t[2])!, overlap: false }));
  for (const a of segments) {
    a.overlap = segments.some((b) => b.speaker_idx !== a.speaker_idx && b.start_ms < a.end_ms && a.start_ms < b.end_ms);
  }
  return { labels, segments };
}
