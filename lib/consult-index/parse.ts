/**
 * lib/consult-index/parse.ts — PURE: CONSULT's name-free index (R2 eta-lab-results consult/index/latest.jsonl + manifest.json) to rows of the consult_index table (0150).
 *
 * THE FORMAT, as the WRITER publishes it (tools/index_mirror.py on the box, ALLOW / R2_ALLOW; its own test asserts both): one JSON object per line, the latest cutter row per consult_uid, kept ONLY if the
 * cutter row was status "cut" AND r2.status "mirrored" - and then PROJECTED through an allowlist that DROPS `status`, `bytes_total`, `path`, `doctor_name` and r2.status. So a published row carries NO `status`
 * and r2 is exactly {bucket, prefix, files, at}: "cut + mirrored" is implied by the row being there with an r2 key, and is NOT a field. (The first version of this parser required status === "cut" and
 * r2.status === "mirrored" and so skipped every published row: 0 of 429.) A row that DOES carry a status (a raw cutter row) must still say cut / mirrored.
 * Fields read here: consult_uid, ist_date, room_id, room_slug, span_start / span_end ("YYYY-MM-DD HH:MM:SS.mmm" in IST, no zone), span_end_epoch (UTC seconds), cut_at, code_commit, minutes,
 * bytes (an object of file sizes), quality, coverage, voice_isolated, doctor_uid, doctor_identified, r2 {bucket, prefix}.
 * It carries NO session_id, cut_version or sealed field today: this module reads them if consult-lead adds them (sealed === true; cut_version as a string), and otherwise derives
 *   cut_version = signatureVersion(row.signature) (what palimpsest stamps on its tracks as config.clip_signature; the row's cut_at only if there is no signature), and sealed = false. UNVERIFIED against a live mirror: the mirror object itself was not read from here.
 *
 * INTEGRITY: sha256(latest.jsonl) must equal the manifest's sha256, else NO row is read. A row that is not a clean cut clip is skipped and COUNTED by reason, never silently dropped.
 * NO NAMES: doctor_name is never read. `signature` (the cutter's clip signature: times, rule, mode, coverage, the room slug and an opaque doctor id) is read ONLY to be hashed into the cut version
 * (signatureVersion) and is never stored or returned.
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

export type SkipReason = "not_json" | "no_uid" | "not_cut" | "not_mirrored" | "no_clip_key" | "bad_place" | "bad_span" | "bad_prefix" | "no_cut_version";
export type ParsedIndex = { rows: IndexRow[]; read: number; skipped: Record<string, number> };

/**
 * PURE: the CUT VERSION from the cutter's row `signature` ({start, end, rule, mode, doctor, print, cov, room, day, ...}). Palimpsest stamps the same object into every track it makes as
 * config.clip_signature, so "the track is for this cut" is "the two signatures are equal" - measured on the box: 432 of 438 Sarvam tracks equal their row's signature, and the 6 that do not are
 * clips that were RE-CUT after the track was made (a different end / coverage). The version is a short hash of the signature with its keys sorted, so key order cannot matter.
 */
export function signatureVersion(sig: unknown): string | null {
  if (!sig || typeof sig !== "object" || Array.isArray(sig) || Object.keys(sig as object).length === 0) return null;
  const canon = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v));
  return `sig:${sha256Hex(canon(sig)).slice(0, 20)}`;
}

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

/** PURE: total bytes from `bytes_total` (a raw cutter row) or the sum of the per-file sizes in `bytes` (the published shape); null when neither is numbers. */
function bytesOf(v: unknown): number | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const sizes = Object.values(v as Record<string, unknown>).filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0);
  return sizes.length > 0 ? sizes.reduce((a, b) => a + b, 0) : null;
}

/** PURE: one upstream line to a row, or the reason it is not indexable. */
export function normalizeRow(r: Record<string, unknown>): { row: IndexRow } | { skip: SkipReason } {
  const uid = r.consult_uid;
  if (typeof uid !== "string" || !UID_RE.test(uid)) return { skip: "no_uid" };
  // the published row has NO status field (the writer drops it after keeping only cut rows); a row that does carry one must say "cut"
  if (r.status !== undefined && r.status !== "cut") return { skip: "not_cut" };
  const r2 = r.r2 && typeof r.r2 === "object" && !Array.isArray(r.r2) ? (r.r2 as Record<string, unknown>) : null;
  if (!r2) return { skip: "no_clip_key" };
  if (r2.status !== undefined && r2.status !== "mirrored") return { skip: "not_mirrored" };
  // what makes it a mirrored clip in the published shape: the R2 key parts. Without them there is no clip to send.
  if (typeof r2.bucket !== "string" || !r2.bucket || typeof r2.prefix !== "string" || !r2.prefix) return { skip: "no_clip_key" };
  if (r2.bucket !== "eta-audio") return { skip: "bad_prefix" };
  const slug = r.room_slug, date = r.ist_date, roomId = r.room_id;
  if (typeof slug !== "string" || !SLUG_RE.test(slug) || typeof date !== "string" || !DATE_RE.test(date) || typeof roomId !== "string" || !SLUG_RE.test(roomId)) return { skip: "bad_place" };
  const span = spanOf(r);
  if (!span) return { skip: "bad_span" };
  // the clip key is built from validated parts only, and must be the prefix the cutter says it mirrored to
  const key = consultClipKey(date, slug, uid);
  if (`${r2.prefix.replace(/\/+$/, "")}/consult.flac` !== key) return { skip: "bad_prefix" };
  const cutVersion = str(r.cut_version, 120) ?? signatureVersion(r.signature) ?? str(r.cut_at, 120);
  if (!cutVersion) return { skip: "no_cut_version" };
  const doctor = typeof r.doctor_uid === "string" && DOCTOR_RE.test(r.doctor_uid) ? r.doctor_uid : null;
  return {
    row: {
      consult_uid: uid, room_id: roomId, room_slug: slug, ist_date: date, t0_ms: span.t0, t1_ms: span.t1, clip_r2_key: key,
      doctor_uid: doctor, doctor_identified: typeof r.doctor_identified === "boolean" ? r.doctor_identified : null,
      cut_version: cutVersion, code_commit: str(r.code_commit, 40), sealed: r.sealed === true,
      voice_isolated: typeof r.voice_isolated === "boolean" ? r.voice_isolated : null,
      minutes: num(r.minutes), bytes: num(r.bytes_total) ?? bytesOf(r.bytes), quality: str(r.quality, 40), coverage: num(r.coverage),
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
