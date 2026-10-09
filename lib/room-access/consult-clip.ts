/**
 * lib/consult-clip.ts — S8C: may this consult clip go to Sarvam, and where is its audio? ONE function for the tool's pre-flight and the job's prepare step.
 * Order (each step before the next, so a refusal costs the least): (1) our held-out check on the consult's (room, IST date) from the database, BEFORE the mirror, any track or any audio is touched;
 * (2) the CONSULT index row (sha256-verified mirror; its own pair checked again); (3) voice_isolated rows are refused (VP-ACC-01 failed: that output is not identity and is not sent); (4) a palimpsest stt or
 * translate track already exists -> already_transcribed with the track reference (no double spend); (5) the eta-audio object is probed with the existing R2 client: not readable -> audio_unreadable.
 * O4: consult audio only. Doctor fields of the mirror are never read here.
 */
import { sql } from "@/lib/db";
import { headObject } from "@/lib/r2";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import { findRebTrack, type RebTrackRef } from "@/lib/rubrics/readers/reb-consult";
import { clipKeyOf, findClip, type ConsultIndexRow } from "@/lib/room-access/consult-index";

export type ClipRefusal = { ok: false; error: "blind_room_day" | "mirror_minutes_missing" | "consult_index_unavailable" | "consult_index_integrity" | "consult_not_in_index" | "consult_voice_isolated" | "already_transcribed" | "audio_unreadable"; track?: Omit<RebTrackRef, "segments"> };
export type ClipOk = { ok: true; row: ConsultIndexRow; key: string; content_type: string };

/**
 * (room, IST date) of a consult from eta_encounter_windows, or null when the database does not know the uid. A metadata lookup only. consult_uid is NOT unique (one row per machine): ALL rows are read and, if ANY is on
 * a held-out pair, THAT pair is returned (so the caller's held-out check fires whatever order the rows come in); otherwise the first row's. (S8C-1)
 */
export async function windowPairOf(consultUid: string): Promise<{ room_id: string; ist_date: string } | null> {
  const r = (await sql`
    SELECT room_id, (t_open AT TIME ZONE 'Asia/Kolkata')::date::text AS ist_date FROM eta_encounter_windows WHERE consult_uid = ${consultUid}::text AND room_id IS NOT NULL
  `) as Array<{ room_id: string; ist_date: string }>;
  return r.find((x) => isBlindRoomDay(x.ist_date, x.room_id)) ?? r[0] ?? null;
}

export async function preflightClip(consultUid: string): Promise<ClipOk | ClipRefusal> {
  const p = await windowPairOf(consultUid);
  if (p && isBlindRoomDay(p.ist_date, p.room_id)) return { ok: false, error: "blind_room_day" };
  const got = await findClip(consultUid);
  if (!got.ok) return { ok: false, error: got.error };
  const row = got.row;
  if (row.voice_isolated === true) return { ok: false, error: "consult_voice_isolated" };
  // B3-4: the mirror row's minutes are the duration floor the cap and the 30-minute limit rest on (max of container, bytes, mirror minutes x 60): without a positive figure that floor is gone
  if (!(typeof row.minutes === "number" && Number.isFinite(row.minutes) && row.minutes > 0)) return { ok: false, error: "mirror_minutes_missing" };
  const t = await findRebTrack(consultUid, row.room_id, row.ist_date);
  if (t.found) return { ok: false, error: "already_transcribed", track: { source: t.found.source, layer: t.found.layer, config_hash: t.found.config_hash, n_segments: t.found.n_segments } };
  const key = clipKeyOf(row);
  if (!key) return { ok: false, error: "consult_not_in_index" };
  const head = await headObject(key); // swallows its own errors: size null = missing, or not readable with this deployment's R2 credentials
  if (head.size === null) return { ok: false, error: "audio_unreadable" };
  return { ok: true, row, key, content_type: head.content_type || "audio/flac" };
}
