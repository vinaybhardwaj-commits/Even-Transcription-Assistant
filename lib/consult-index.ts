/**
 * lib/consult-index.ts — S8C: CONSULT's index mirror. R2 eta-lab-results consult/index/latest.jsonl (one row per consult_uid; status cut and r2-mirrored only; held-out pairs excluded upstream; names and box
 * paths dropped) + consult/index/manifest.json { generated_at, rows, sha256 of latest.jsonl, code_commit }. GET only through the guarded lab store, whose allowlist names exactly those two keys.
 *
 * INTEGRITY. sha256(latest.jsonl) must equal the manifest's sha256, else consult_index_integrity and NO rows. A missing store / object is consult_index_unavailable.
 * VP-ACC-01 FAILED. The cutter's voiceprint output is not identity: doctor_uid and doctor_identified are dropped HERE (publicRow is a whitelist), so no caller can surface them; the warehouse doctor_uid is the only
 * doctor truth. voice_isolated rows are never sent to Sarvam (the tools refuse them), and are shown as such.
 * HELD-OUT. Our own check on (room_id, ist_date) of every row: a held-out or unplaced row is excluded and counted, never returned.
 * The clip: R2 eta-audio consult-clips/<ist_date>/<room_slug>/<consult_uid>/consult.flac, built from validated fields only.
 */
import { createHash } from "node:crypto";
import { labStore, CONSULT_INDEX_KEYS } from "@/lib/sarvam-lab";
import { isBlindRoomDay } from "@/lib/rubrics/blind-room-days";

export type ConsultIndexRow = Record<string, unknown> & { consult_uid: string; ist_date: string; room_id: string };
export type PublicClipRow = {
  consult_uid: string; window_id: string | null; ist_date: string; room_id: string; room_slug: string | null; span_start: unknown; span_end: unknown; span_end_epoch: unknown; t_open: unknown; t_close: unknown;
  minutes: number | null; bytes: number | null; quality: unknown; flags: unknown; coverage: unknown; voice_isolated: boolean; cut_at: unknown; code_commit: unknown;
  r2: { bucket: unknown; prefix: unknown; files: unknown; at: unknown } | null;
};
export type ConsultIndex = { ok: true; rows: ConsultIndexRow[]; manifest: { generated_at: unknown; rows: unknown; code_commit: unknown } } | { ok: false; error: "consult_index_unavailable" | "consult_index_integrity" };

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Read and verify the mirror. A fresh read per call: callers hold the result for the length of one request. */
export async function readConsultIndex(): Promise<ConsultIndex> {
  const store = labStore();
  if (!store) return { ok: false, error: "consult_index_unavailable" };
  let latest, man;
  try {
    latest = await store.get(CONSULT_INDEX_KEYS[0]);
    man = await store.get(CONSULT_INDEX_KEYS[1]);
  } catch {
    return { ok: false, error: "consult_index_unavailable" };
  }
  if (!latest || !man) return { ok: false, error: "consult_index_unavailable" };
  let manifest: { sha256?: unknown; generated_at?: unknown; rows?: unknown; code_commit?: unknown };
  try { manifest = JSON.parse(man.body); } catch { return { ok: false, error: "consult_index_integrity" }; }
  const want = typeof manifest?.sha256 === "string" ? manifest.sha256.toLowerCase() : "";
  if (!want || createHash("sha256").update(latest.body, "utf8").digest("hex") !== want) return { ok: false, error: "consult_index_integrity" };
  const rows: ConsultIndexRow[] = [];
  for (const line of latest.body.split("\n")) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line); } catch { return { ok: false, error: "consult_index_integrity" }; }
    if (typeof r.consult_uid === "string" && UID_RE.test(r.consult_uid)) rows.push(r as ConsultIndexRow);
  }
  return { ok: true, rows, manifest: { generated_at: manifest.generated_at ?? null, rows: manifest.rows ?? null, code_commit: manifest.code_commit ?? null } };
}

/** PURE — the row as a caller may see it. A whitelist: doctor_uid, doctor_identified, signature and every unlisted field are never copied. */
export function publicRow(r: ConsultIndexRow): PublicClipRow {
  const r2 = r.r2 && typeof r.r2 === "object" ? (r.r2 as Record<string, unknown>) : null;
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    consult_uid: r.consult_uid, window_id: typeof r.window_id === "string" ? r.window_id : null, ist_date: r.ist_date, room_id: r.room_id, room_slug: typeof r.room_slug === "string" ? r.room_slug : null,
    span_start: r.span_start ?? null, span_end: r.span_end ?? null, span_end_epoch: r.span_end_epoch ?? null, t_open: r.t_open ?? null, t_close: r.t_close ?? null, minutes: n(r.minutes), bytes: n(r.bytes),
    quality: r.quality ?? null, flags: r.flags ?? null, coverage: r.coverage ?? null, voice_isolated: r.voice_isolated === true, cut_at: r.cut_at ?? null, code_commit: r.code_commit ?? null,
    r2: r2 ? { bucket: r2.bucket ?? null, prefix: r2.prefix ?? null, files: r2.files ?? null, at: r2.at ?? null } : null,
  };
}

/** PURE — a row's place is usable and not held out: "ok", "blind" (held-out pair) or "unplaced" (no valid room or date). */
export function placeOf(r: Pick<ConsultIndexRow, "ist_date" | "room_id">): "ok" | "blind" | "unplaced" {
  if (typeof r.room_id !== "string" || !SLUG_RE.test(r.room_id) || typeof r.ist_date !== "string" || !DATE_RE.test(r.ist_date)) return "unplaced";
  return isBlindRoomDay(r.ist_date, r.room_id) ? "blind" : "ok";
}

/** PURE — the eta-audio key of a row's clip, or null when a field is not a clean id (nothing is ever concatenated from an unvalidated value). */
export function clipKeyOf(r: ConsultIndexRow): string | null {
  const slug = r.room_slug;
  if (typeof slug !== "string" || !SLUG_RE.test(slug) || !DATE_RE.test(r.ist_date) || !UID_RE.test(r.consult_uid)) return null;
  return `consult-clips/${r.ist_date}/${slug}/${r.consult_uid}/consult.flac`;
}

/** The mirror row of one consult, with the held-out check on its own pair. */
export async function findClip(consultUid: string): Promise<{ ok: true; row: ConsultIndexRow } | { ok: false; error: "consult_index_unavailable" | "consult_index_integrity" | "consult_not_in_index" | "blind_room_day" }> {
  if (!UID_RE.test(consultUid)) return { ok: false, error: "consult_not_in_index" };
  const idx = await readConsultIndex();
  if (!idx.ok) return idx;
  const row = idx.rows.find((r) => r.consult_uid === consultUid);
  if (!row) return { ok: false, error: "consult_not_in_index" };
  const p = placeOf(row);
  if (p === "blind") return { ok: false, error: "blind_room_day" };
  if (p === "unplaced") return { ok: false, error: "consult_not_in_index" };
  return { ok: true, row };
}

/** consult_clips: counts and rows of one IST date (and room), held-out and unplaced rows excluded and counted. status: the mirror holds cut clips only, so "cut" matches every row and any other status none. */
export async function listClips(opts: { date: string; room?: string | null; status?: string | null; limit?: number }): Promise<Record<string, unknown>> {
  if (!DATE_RE.test(opts.date)) return { ok: false, error: "invalid_date" };
  if (opts.room && !SLUG_RE.test(opts.room)) return { ok: false, error: "invalid_room" };
  const idx = await readConsultIndex();
  if (!idx.ok) return { ok: false, error: idx.error };
  let n_blind_excluded = 0, n_unplaced_excluded = 0;
  const mine: PublicClipRow[] = [];
  for (const r of idx.rows) {
    if (r.ist_date !== opts.date) continue;
    const p = placeOf(r);
    if (p === "blind") { n_blind_excluded += 1; continue; }
    if (p === "unplaced") { n_unplaced_excluded += 1; continue; }
    if (opts.room && r.room_id !== opts.room && r.room_slug !== opts.room) continue;
    mine.push(publicRow(r));
  }
  const rows = opts.status && opts.status !== "cut" ? [] : mine;
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
  return {
    ok: true, date: opts.date, count: rows.length, voice_isolated: rows.filter((r) => r.voice_isolated).length, sendable: rows.filter((r) => !r.voice_isolated).length,
    n_blind_excluded, n_unplaced_excluded, truncated: rows.length > limit, rows: rows.slice(0, limit), index: { generated_at: idx.manifest.generated_at, rows: idx.manifest.rows },
  };
}
