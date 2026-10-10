/**
 * lib/consult-index/parse.ts — PURE: CONSULT's name-free index (R2 eta-lab-results consult/index/latest.jsonl + manifest.json) to rows of the consult_index table (0146).
 *
 * THE FORMAT, as the cutter writes it (measured on the box 10 Oct, field NAMES only): one JSON object per line, append-only upstream (the latest line per consult_uid wins); the mirror keeps
 * rows with status "cut" whose r2.status is "mirrored". Fields read here: consult_uid, ist_date, room_id, room_slug, span_start / span_end ("YYYY-MM-DD HH:MM:SS.mmm" in IST, no zone),
 * span_end_epoch (UTC seconds), cut_at, code_commit, minutes, bytes (an object per file), quality, coverage, voice_isolated, doctor_uid, doctor_identified, r2 {status, bucket, prefix}.
 * It carries NO session_id, cut_version or sealed field today: this module reads them if consult-lead adds them (sealed === true; cut_version as a string), and otherwise derives
 *   cut_version = the row's cut_at (a re-cut changes it), and sealed = false. UNVERIFIED against a live mirror: the mirror object itself was not read from here.
 *
 * INTEGRITY: sha256(latest.jsonl) must equal the manifest's sha256, else NO row is read. A row that is not a clean cut clip is skipped and COUNTED by reason, never silently dropped.
 * NO NAMES: doctor_name and signature are never read.
 */
import { createHash } from "node:crypto";
import { consultClipKey } from "@/lib/room-access/keys";

export const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DOCTOR_RE = /^[A-Za-z0-9_-]{1,128}$/;
const IST_OFFSET_MS = 19_800_000;

export type IndexRow = {
  consult_uid: string;
  room_id: string;
  room_slug: string;
  ist_date: string;
  t0_ms: number;
  t1_ms: number;
  clip_r2_key: string;
  doctor_uid: string | null;
  doctor_identified: boolean | null;
  cut_version: string;
  code_commit: string | null;
  sealed: boolean;
  voice_isolated: boolean | null;
  minutes: number | null;
  bytes: number | null;
  quality: string | null;
  coverage: number | null;
  /** a bench session id when the upstream row names one; the store fills it from bench_session when it does not */
  session_id: string | null;
};

export type SkipReason = "not_json" | "no_uid" | "not_cut" | "not_mirrored" | "bad_place" | "bad_span" | "bad_prefix" | "no_cut_version";
export type ParsedIndex = { rows: IndexRow[]; read: number; skipped: Record<string, number> };

export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

const str = (v: unknown, max = 80): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** PURE: "2026-10-06 10:34:53.662" (IST wall clock, no zone) or an ISO string with a zone -> epoch ms; null when unparseable. */
export function istWallToMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s.replace(" ", "T"));
    return Number.isFinite(t) ? t : null;
  }
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/.exec(s);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}${(m[3] ?? ".000").padEnd(4, "0")}Z`);
  return Number.isFinite(t) ? t - IST_OFFSET_MS : null;
}

/** PURE: the absolute UTC span of a row. t1 = span_end_epoch when present (UTC seconds), else span_end as IST; t0 = t1 - (span_end - span_start). */
export function spanOf(r: Record<string, unknown>): { t0: number; t1: number } | null {
  const a = istWallToMs(r.span_start);
  const b = istWallToMs(r.span_end);
  if (a === null || b === null || b <= a) return null;
  const epoch = num(r.span_end_epoch);
  const t1 = epoch !== null && epoch > 1e9 && epoch < 4e9 ? Math.round(epoch * 1000) : b;
  return { t0: t1 - (b - a), t1 };
}

/** PURE: one upstream line to a row, or the reason it is not indexable. */
export function normalizeRow(r: Record<string, unknown>): { row: IndexRow } | { skip: SkipReason } {
  const uid = r.consult_uid;
  if (typeof uid !== "string" || !UID_RE.test(uid)) return { skip: "no_uid" };
  if (r.status !== "cut") return { skip: "not_cut" };
  const r2 = r.r2 && typeof r.r2 === "object" ? (r.r2 as Record<string, unknown>) : null;
  if (!r2 || r2.status !== "mirrored") return { skip: "not_mirrored" };
  const slug = r.room_slug, date = r.ist_date, roomId = r.room_id;
  if (typeof slug !== "string" || !SLUG_RE.test(slug) || typeof date !== "string" || !DATE_RE.test(date) || typeof roomId !== "string" || !SLUG_RE.test(roomId)) return { skip: "bad_place" };
  const span = spanOf(r);
  if (!span) return { skip: "bad_span" };
  // the clip key is built from validated parts only, and must be the prefix the cutter says it mirrored to
  const key = consultClipKey(date, slug, uid);
  if (typeof r2.prefix === "string" && `${r2.prefix.replace(/\/+$/, "")}/consult.flac` !== key) return { skip: "bad_prefix" };
  const cutVersion = str(r.cut_version, 120) ?? str(r.cut_at, 120);
  if (!cutVersion) return { skip: "no_cut_version" };
  const doctor = typeof r.doctor_uid === "string" && DOCTOR_RE.test(r.doctor_uid) ? r.doctor_uid : null;
  return {
    row: {
      consult_uid: uid, room_id: roomId, room_slug: slug, ist_date: date, t0_ms: span.t0, t1_ms: span.t1, clip_r2_key: key,
      doctor_uid: doctor, doctor_identified: typeof r.doctor_identified === "boolean" ? r.doctor_identified : null,
      cut_version: cutVersion, code_commit: str(r.code_commit, 40), sealed: r.sealed === true,
      voice_isolated: typeof r.voice_isolated === "boolean" ? r.voice_isolated : null,
      minutes: num(r.minutes), bytes: num(r.bytes_total), quality: str(r.quality, 40), coverage: num(r.coverage),
      session_id: typeof r.session_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.session_id) ? r.session_id : null,
    },
  };
}

export type IndexParse = { ok: true; parsed: ParsedIndex; manifest: { sha256: string; rows: number | null; generated_at: string | null } } | { ok: false; error: "consult_index_integrity" };

/**
 * PURE: the whole mirror. sha256(latest.jsonl) must equal the manifest's, else consult_index_integrity and NO rows. The latest line per consult_uid wins (upstream appends).
 * Every line that is not indexable is counted under its reason.
 */
export function parseIndex(latestBody: string, manifestBody: string): IndexParse {
  let m: { sha256?: unknown; rows?: unknown; generated_at?: unknown };
  try { m = JSON.parse(manifestBody); } catch { return { ok: false, error: "consult_index_integrity" }; }
  const want = typeof m?.sha256 === "string" ? m.sha256.toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(want) || sha256Hex(latestBody) !== want) return { ok: false, error: "consult_index_integrity" };
  const skipped: Record<string, number> = {};
  const bump = (k: string) => { skipped[k] = (skipped[k] ?? 0) + 1; };
  const latest = new Map<string, Record<string, unknown>>();
  let read = 0;
  for (const line of latestBody.split("\n")) {
    if (!line.trim()) continue;
    read += 1;
    let r: unknown;
    try { r = JSON.parse(line); } catch { bump("not_json"); continue; }
    if (!r || typeof r !== "object" || Array.isArray(r)) { bump("not_json"); continue; }
    const uid = (r as Record<string, unknown>).consult_uid;
    if (typeof uid !== "string" || !UID_RE.test(uid)) { bump("no_uid"); continue; }
    latest.set(uid, r as Record<string, unknown>);
  }
  const rows: IndexRow[] = [];
  for (const r of latest.values()) {
    const n = normalizeRow(r);
    if ("row" in n) rows.push(n.row);
    else bump(n.skip);
  }
  return { ok: true, parsed: { rows, read, skipped }, manifest: { sha256: want, rows: typeof m.rows === "number" ? m.rows : null, generated_at: typeof m.generated_at === "string" ? m.generated_at : null } };
}
