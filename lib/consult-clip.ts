/**
 * lib/consult-clip.ts — may this consult go to Sarvam, and where is its audio? ONE function for the tool's pre-flight and the job's prepare step.
 * Order (each step before the next, so a refusal costs the least):
 *   1. the consult_index row (0150): none -> consult_not_indexed
 *   2. sealed -> consult_sealed;  voice_isolated -> consult_voice_isolated (the cutter's isolation flag; that output is not identity and is not sent);  no positive minutes -> mirror_minutes_missing
 *   3. a result for THIS cut version and these options already exists -> returned as `existing` (idempotent: never sent, never billed twice)
 *   4. PALIMPSEST REUSE: the palimpsest already holds a live ok sarvam-saaras-v3 stt track for this consult AND THIS CUT (its config.clip_signature = the index row's signature) -> returned as
 *      `reuse` (source "palimpsest"); Sarvam is not called. A track of another cut does not count (the clip was re-cut). If the lookup cannot be made -> reuse_lookup_unavailable: a failure is never read as "none".
 *      A track the index lists as ok whose R2 object is MISSING -> track_missing (not "none"); only an explicit force:true goes on to Sarvam.
 *   5. voice_isolated -> consult_voice_isolated (that output is not identity and is not SENT; a reused track sends nothing, so reuse comes first);  no positive minutes -> mirror_minutes_missing
 *   6. the eta-audio object is probed with the existing R2 client: not readable -> audio_unreadable
 * O4: consult audio only. The held-out rule is LIFTED (V, 10 Oct): no placement is refused. The cutter's doctor_uid is stored but never read here.
 */
import { headObject } from "@/lib/r2";
import { signatureVersion } from "@/lib/consult-index/parse";
import { palimpsestAsResult, type PalimpsestAsResult } from "@/lib/consult-index/palimpsest-view";
import { findSarvamTracks, type SarvamTrack } from "@/lib/room-access/readers/reb-consult";
import { findResult, getIndexRow, type ConsultResult, type StoredIndexRow } from "@/lib/room-access/consult-index-store";

export type ClipRefusalCode = "consult_not_indexed" | "consult_sealed" | "consult_voice_isolated" | "mirror_minutes_missing" | "reuse_lookup_unavailable" | "track_missing" | "audio_unreadable";
export type ClipRefusal = { ok: false; error: ClipRefusalCode };
export type PalimpsestReuse = { source: "palimpsest"; stt: SarvamTrack; translate: SarvamTrack | null; view: PalimpsestAsResult };
export type ClipOk = { ok: true; existing: null; reuse: null; row: StoredIndexRow; key: string; content_type: string };
export type ClipExisting = { ok: true; existing: ConsultResult; reuse: null; row: StoredIndexRow };
export type ClipReuse = { ok: true; existing: null; reuse: PalimpsestReuse; row: StoredIndexRow };

/**
 * The palimpsest's Sarvam tracks of exactly this cut, in the normal result shape; { reuse: null } when there is none; { missing: true } when the index lists an ok stt track whose R2 object is gone (it cannot
 * be checked against the cut); { unavailable: true } when the lookup could not be made. Throws nothing.
 */
export async function palimpsestFor(row: StoredIndexRow): Promise<{ unavailable: true } | { missing: true } | { reuse: PalimpsestReuse | null }> {
  const r = await findSarvamTracks(row.consult_uid, row.room_id, row.room_slug, row.cut_version, signatureVersion);
  if ("unavailable" in r) return { unavailable: true };
  // a reusable answer needs the transcript itself; a translate track alone is not "this consult has been transcribed"
  if (r.found?.stt) return { reuse: { source: "palimpsest", stt: r.found.stt, translate: r.found.translate, view: palimpsestAsResult(row, r.found.stt, r.found.translate) } };
  if (r.missing.includes("stt")) return { missing: true };
  return { reuse: null };
}

export async function preflightClip(consultUid: string, opts: { mode: "transcribe" | "codemix"; english: boolean; force?: boolean }): Promise<ClipOk | ClipExisting | ClipReuse | ClipRefusal> {
  const row = await getIndexRow(consultUid);
  if (!row) return { ok: false, error: "consult_not_indexed" };
  if (row.sealed) return { ok: false, error: "consult_sealed" };
  const existing = await findResult(consultUid, row.cut_version, opts.mode, opts.english);
  if (existing) return { ok: true, existing, reuse: null, row };
  const pal = await palimpsestFor(row);
  if ("unavailable" in pal) return { ok: false, error: "reuse_lookup_unavailable" };
  // the index says the palimpsest HAS an ok track for this consult, but its object is gone from R2, so it cannot be checked against this cut: Sarvam is not silently paid for it. Only force:true goes on.
  if ("missing" in pal && !opts.force) return { ok: false, error: "track_missing" };
  if ("reuse" in pal && pal.reuse) return { ok: true, existing: null, reuse: pal.reuse, row };
  if (row.voice_isolated === true) return { ok: false, error: "consult_voice_isolated" };
  // the minutes are the duration floor the cap and the 30-minute limit rest on (max of container, size floor, index minutes x 60): without a positive figure that floor is gone
  if (!(typeof row.minutes === "number" && Number.isFinite(row.minutes) && row.minutes > 0)) return { ok: false, error: "mirror_minutes_missing" };
  const head = await headObject(row.clip_r2_key); // swallows its own errors: size null = missing, or not readable with this deployment's R2 credentials
  if (head.size === null) return { ok: false, error: "audio_unreadable" };
  return { ok: true, existing: null, reuse: null, row, key: row.clip_r2_key, content_type: head.content_type || "audio/flac" };
}
