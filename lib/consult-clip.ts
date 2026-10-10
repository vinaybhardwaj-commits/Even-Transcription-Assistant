/**
 * lib/consult-clip.ts — may this consult go to Sarvam, and where is its audio? ONE function for the tool's pre-flight and the job's prepare step.
 * Order (each step before the next, so a refusal costs the least):
 *   1. the consult_index row (0150): none -> consult_not_indexed
 *   2. sealed -> consult_sealed;  voice_isolated -> consult_voice_isolated (the cutter's isolation flag; that output is not identity and is not sent);  no positive minutes -> mirror_minutes_missing
 *   3. a result for THIS cut version and these options already exists -> returned as `existing` (idempotent: never sent, never billed twice)
 *   4. a palimpsest stt / translate track already exists -> already_transcribed with the track reference (no double spend)
 *   5. the eta-audio object is probed with the existing R2 client: not readable -> audio_unreadable
 * O4: consult audio only. The held-out rule is LIFTED (V, 10 Oct): no placement is refused. The cutter's doctor_uid is stored but never read here.
 */
import { headObject } from "@/lib/r2";
import { findRebTrack, type RebTrackRef } from "@/lib/room-access/readers/reb-consult";
import { findResult, getIndexRow, type ConsultResult, type StoredIndexRow } from "@/lib/room-access/consult-index-store";

export type ClipRefusalCode = "consult_not_indexed" | "consult_sealed" | "consult_voice_isolated" | "mirror_minutes_missing" | "already_transcribed" | "audio_unreadable";
export type ClipRefusal = { ok: false; error: ClipRefusalCode; track?: Omit<RebTrackRef, "segments"> };
export type ClipOk = { ok: true; existing: null; row: StoredIndexRow; key: string; content_type: string };
export type ClipExisting = { ok: true; existing: ConsultResult; row: StoredIndexRow };

export async function preflightClip(consultUid: string, opts: { mode: "transcribe" | "codemix"; english: boolean }): Promise<ClipOk | ClipExisting | ClipRefusal> {
  const row = await getIndexRow(consultUid);
  if (!row) return { ok: false, error: "consult_not_indexed" };
  if (row.sealed) return { ok: false, error: "consult_sealed" };
  if (row.voice_isolated === true) return { ok: false, error: "consult_voice_isolated" };
  // the minutes are the duration floor the cap and the 30-minute limit rest on (max of container, size floor, index minutes x 60): without a positive figure that floor is gone
  if (!(typeof row.minutes === "number" && Number.isFinite(row.minutes) && row.minutes > 0)) return { ok: false, error: "mirror_minutes_missing" };
  const existing = await findResult(consultUid, row.cut_version, opts.mode, opts.english);
  if (existing) return { ok: true, existing, row };
  const t = await findRebTrack(consultUid, row.room_id, row.ist_date);
  if (t.found) return { ok: false, error: "already_transcribed", track: { source: t.found.source, layer: t.found.layer, config_hash: t.found.config_hash, n_segments: t.found.n_segments } };
  const head = await headObject(row.clip_r2_key); // swallows its own errors: size null = missing, or not readable with this deployment's R2 credentials
  if (head.size === null) return { ok: false, error: "audio_unreadable" };
  return { ok: true, existing: null, row, key: row.clip_r2_key, content_type: head.content_type || "audio/flac" };
}
