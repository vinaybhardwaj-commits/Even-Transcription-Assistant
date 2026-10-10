/**
 * lib/room-access/jev-reads.ts — GUARD: the room-data SQL of Jev P2's STT state builders (lib/jev/worker/builders/stt.ts). A transcription run is room-data-adjacent
 * (its subject may be a bench window), so the lookup lives here and the builder refuses any run that is not a consult/encounter run (O4). Row text goes only
 * to the builder, which sends it to Jev under ZDR (V, 10 Oct 2026) and never stores it.
 */
import { sql } from "@/lib/db";

export type SttRunRow = { id: string; subject_type: string; subject_id: string; detected_language: string | null; transcript_original: string | null; transcript_english: string | null };

export async function readSttRunForJev(id: string): Promise<SttRunRow | null> {
  const r = (await sql`SELECT id, subject_type, subject_id, detected_language, transcript_original, transcript_english FROM transcription_run WHERE id = ${id}`) as SttRunRow[];
  return r[0] ?? null;
}
