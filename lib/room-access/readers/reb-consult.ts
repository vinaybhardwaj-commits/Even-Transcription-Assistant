/**
 * Reader reb_consult — S7-2B: the words of one consult from palimpsest's Sarvam consult-clip tracks (R2 eta-lab-results), found through the Neon index reb_track_index.
 *
 * ORDER. The caller has ALREADY passed the consult's (room, IST date) through the held-out check (readConsultSpan refuses first). Here: the index (window_id = 'consult-' || consult_uid, status ok, not
 * shadow, layer translate or stt; newest finished first) -> for each layer in the order translate, stt: the newest ok track whose key is a consult key of THIS consult and room -> one GET (the lab store
 * allows GET of reb/<date>/<room>/_consults/ keys only) -> the object's sha256 must equal the index's (a mismatch is skipped and counted: source_integrity) -> parse -> turns clamped to the consult span.
 * A translate track is used as it is (English). An stt (native) track is used ONLY when every segment's lang starts with "en". Otherwise nothing is returned and the caller falls back to window_english.
 * Track shape (palimpsest-architect, bus #10536): { config, config_hash, engine, extras, layer, segments: [{ t0_ms, t1_ms, speaker, lang, text, extras }], status, window_id }; t0_ms / t1_ms are absolute UTC
 * epoch ms, an end may overrun the span by <= 0.56 s (clamped). Speaker: a label starting doctor / clinician / dr = doctor; patient / other / attender / nurse = other; anything else unknown (INFERRED: the label set).
 * No transcript text is returned beyond the ConsultText the engines already take; nothing is written.
 */
import { createHash } from "node:crypto";
import { sql } from "@/lib/db";
import { labStore, REB_CONSULT_KEY } from "@/lib/sarvam-lab";
import { blindRefusal } from "@/lib/room-access/readers/common";
import type { ConsultSpan } from "@/lib/room-access/readers/consult-span";
import type { ConsultLine } from "@/lib/rubrics/readers/consult-text";
import type { Turn } from "@/lib/room-access/readers/turns";

/**
 * ROLE-TJ: palimpsest's role.text-judge layer (doctor / patient / attendant by what is SAID, never by voiceprint). OFF: a later order flips it after palimpsest's measurement numbers. With it false this file
 * behaves exactly as before (the role layer is not even queried). Engine sarvam-doctor-map (withdrawn, voiceprint-based) is never read: the index query names engine text-judge and the row is re-checked.
 * Role row shape (INFERRED, palimpsest #10730 / #10733, layer not live): { status, engine, layer: "role", extras: { derived_from: { stt: <sha256 of the stt track read> } }, speakers: { "<sarvam speaker id>": { role: doctor|patient|attendant|unknown, confidence, abstain } } }.
 */
export const ROLE_TEXT_JUDGE_ENABLED = false;
export const ROLE_ENGINE = "text-judge";
export type RoleVerdict = "doctor" | "patient" | "attendant" | "unknown";
export type RoleOpts = { roleTextJudge?: boolean };
/** resolves a text-track segment (absolute ms) to the speaker the engines see */
type Resolve = (g: Record<string, unknown>, t0: number, t1: number) => { speaker: ConsultLine["speaker"]; idx: number | null; attendant?: true };

export const UID_RE = /^[A-Za-z0-9]{10,60}$/;
export type RebConsult = { source: "reb_translate" | "reb_stt_en"; config_hash: string; lines: ConsultLine[]; turns: Turn[]; n_integrity_skipped: number };
export type RebOutcome = { found: RebConsult | null; n_integrity_skipped: number };

type IndexRow = { layer: string; engine: string; config_hash: string; r2_key: string; sha256: string };
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function speakerOf(label: unknown): { speaker: ConsultLine["speaker"]; idx: number | null } {
  const s = typeof label === "string" ? label.trim().toLowerCase() : "";
  const n = /(\d+)\s*$/.exec(s);
  const idx = n ? Number(n[1]) : null;
  if (/^(doctor|clinician|dr)(?![a-z])/.test(s)) return { speaker: "doctor", idx };
  if (/^(patient|other|attender|nurse)(?![a-z])/.test(s)) return { speaker: "other", idx };
  return { speaker: "unknown", idx };
}

/** PURE — a parsed track to lines / turns clamped to [open, close] (absolute ms), times relative to the open. */
export function linesFromTrack(doc: unknown, open: number, close: number, layer: "translate" | "stt", resolve?: Resolve): { lines: ConsultLine[]; turns: Turn[]; allEnglish: boolean } | null {
  const d = doc as { status?: unknown; segments?: unknown } | null;
  if (!d || typeof d !== "object" || d.status !== "ok" || !Array.isArray(d.segments)) return null;
  const segs = d.segments as Array<Record<string, unknown>>;
  let allEnglish = segs.length > 0;
  const lines: ConsultLine[] = [];
  const turns: Turn[] = [];
  for (const g of segs) {
    if (!g || typeof g !== "object") continue;
    if (layer === "stt" && !(typeof g.lang === "string" && g.lang.toLowerCase().startsWith("en"))) allEnglish = false;
    const t0 = Number(g.t0_ms), t1 = Number(g.t1_ms);
    const text = typeof g.text === "string" ? g.text.trim() : "";
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || !text) continue;
    const a = Math.max(open, t0), b = Math.min(close, t1); // clamp to the consult span (an end may overrun by <= 0.56 s)
    if (b <= a) continue; // wholly outside the span
    const sp: ReturnType<Resolve> = resolve ? resolve(g, t0, t1) : speakerOf(g.speaker);
    lines.push({ t_ms: a - open, speaker: sp.speaker, speaker_idx: sp.idx, text, ...(sp.attendant ? { attendant: true as const } : {}) });
    turns.push({ source_ref: `reb${turns.length}`, start_ms: a - open, end_ms: Math.max(a - open + 1, b - open), speaker_idx: sp.idx, role: sp.speaker === "doctor" ? "clinician" : null, overlap_ms: null, ...(sp.attendant ? { attendant: true as const } : {}) });
  }
  lines.sort((x, y) => x.t_ms - y.t_ms);
  return { lines, turns, allEnglish };
}

const ROLES: readonly RoleVerdict[] = ["doctor", "patient", "attendant", "unknown"];
const idxOf = (k: unknown): number | null => { const n = /(\d+)\s*$/.exec(String(k ?? "")); return n ? Number(n[1]) : null; };

/** PURE — a parsed role row to a verdict per Sarvam speaker index; null (= every speaker unknown) unless the row is ok and was derived from exactly the stt track used. abstain or an unrecognised role = unknown. */
export function roleVerdicts(doc: unknown, usedSttSha: string): Map<number, RoleVerdict> | null {
  const d = doc as { status?: unknown; engine?: unknown; extras?: { derived_from?: unknown }; speakers?: unknown } | null;
  if (!d || typeof d !== "object" || d.status !== "ok" || (d.engine !== undefined && d.engine !== ROLE_ENGINE)) return null;
  const df = d.extras?.derived_from as unknown;
  const from = typeof df === "string" ? df : df && typeof df === "object" ? (df as { stt?: unknown }).stt : null;
  if (typeof from !== "string" || !usedSttSha || from.toLowerCase() !== usedSttSha.toLowerCase()) return null;
  const entries: Array<[unknown, unknown]> = Array.isArray(d.speakers)
    ? (d.speakers as Array<Record<string, unknown>>).map((e) => [e?.speaker ?? e?.id, e])
    : d.speakers && typeof d.speakers === "object" ? Object.entries(d.speakers as Record<string, unknown>) : [];
  const out = new Map<number, RoleVerdict>();
  for (const [k, v] of entries) {
    const idx = idxOf(k);
    const e = v as { role?: unknown; abstain?: unknown } | null;
    if (idx === null || !e || typeof e !== "object") continue;
    const role = typeof e.role === "string" ? (e.role.toLowerCase() as RoleVerdict) : "unknown";
    out.set(idx, e.abstain === true || !ROLES.includes(role) ? "unknown" : role);
  }
  return out;
}

const asSpeaker = (v: RoleVerdict | undefined, idx: number | null): ReturnType<Resolve> =>
  v === "doctor" ? { speaker: "doctor", idx } : v === "patient" ? { speaker: "other", idx } : v === "attendant" ? { speaker: "other", idx, attendant: true } : { speaker: "unknown", idx };

/** the stt segments of the stt track used: [t0, t1, speaker index] */
function sttSpans(doc: unknown): Array<[number, number, number | null]> {
  const segs = (doc as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(segs)) return [];
  return (segs as Array<Record<string, unknown>>).filter((g) => g && typeof g === "object").map((g) => [Number(g.t0_ms), Number(g.t1_ms), speakerOf(g.speaker).idx] as [number, number, number | null]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}

/**
 * ROLE-TJ steps 1-4. `used` is the text track chosen (layer, row, parsed doc). The newest text-judge role row decides (any status; not ok -> all unknown), read with the same key ownership and sha256 checks as
 * a text track; its derived_from.stt must equal the stt track actually used (for translate: the newest ok stt row of this consult in the index, read and sha-checked for its segments). A translate segment takes
 * the speaker of the stt segment it overlaps by >= 50% of its own duration, else unknown. Anything off = every speaker unknown.
 */
async function roleResolver(span: ConsultSpan, uid: string, store: NonNullable<ReturnType<typeof labStore>>, used: { layer: "translate" | "stt"; row: IndexRow; doc: unknown }, sttRows: IndexRow[]): Promise<Resolve> {
  const unknown: Resolve = () => ({ speaker: "unknown", idx: null });
  const roleRows = ((await sql`
    SELECT status, engine, r2_key, sha256
      FROM reb_track_index
     WHERE window_id = ${`consult-${uid}`}::text AND layer = 'role' AND engine = ${ROLE_ENGINE} AND shadow = false
     ORDER BY finished_at DESC NULLS LAST, id DESC
     LIMIT 1
  `) as Array<{ status: string; engine: string; r2_key: string; sha256: string }>).filter((r) => r.engine === ROLE_ENGINE);
  const role = roleRows[0];
  if (!role || role.status !== "ok") return unknown; // no row, or the newest is skipped / failed / empty: every speaker unknown
  const owned = (key: string): boolean => { const m = REB_CONSULT_KEY.exec(String(key)); return !!m && m[3] === uid && m[2] === span.room_id && !blindRefusal(m[2]!, m[1]!); };
  const fetchChecked = async (row: { r2_key: string; sha256: string }): Promise<unknown | null> => {
    if (!owned(row.r2_key)) return null;
    const obj = await store.get(row.r2_key);
    if (!obj || typeof row.sha256 !== "string" || sha256(obj.body) !== row.sha256.toLowerCase()) return null;
    try { return JSON.parse(obj.body); } catch { return null; }
  };
  // the stt track actually used
  let sttSha: string, sttDoc: unknown;
  if (used.layer === "stt") { sttSha = used.row.sha256; sttDoc = used.doc; }
  else {
    const srow = sttRows.find((r) => owned(r.r2_key));
    if (!srow) return unknown;
    sttDoc = await fetchChecked(srow);
    if (!sttDoc) return unknown;
    sttSha = srow.sha256;
  }
  const roleDoc = await fetchChecked(role);
  const verdicts = roleVerdicts(roleDoc, sttSha);
  if (!verdicts) return unknown;
  if (used.layer === "stt") return (g) => { const idx = speakerOf(g.speaker).idx; return asSpeaker(idx === null ? undefined : verdicts.get(idx), idx); };
  const spans = sttSpans(sttDoc);
  return (_g, t0, t1) => {
    const dur = t1 - t0;
    let best: { ov: number; idx: number | null } | null = null;
    for (const [a, b, idx] of spans) {
      const ov = Math.min(t1, b) - Math.max(t0, a);
      if (ov > 0 && (!best || ov > best.ov)) best = { ov, idx };
    }
    if (!best || !(dur > 0) || best.ov / dur < 0.5 || best.idx === null) return { speaker: "unknown", idx: null };
    return asSpeaker(verdicts.get(best.idx), best.idx);
  };
}

export async function readRebConsult(span: ConsultSpan, opts: RoleOpts = {}): Promise<RebOutcome> {
  const none: RebOutcome = { found: null, n_integrity_skipped: 0 };
  const uid = span.consult_uid;
  if (!uid || !UID_RE.test(uid)) return none;
  if (blindRefusal(span.room_id, span.ist_date)) return none; // belt and braces: the caller refused already; nothing below runs for a held-out pair
  const store = labStore();
  if (!store) return none;
  const rows = (await sql`
    SELECT layer, engine, config_hash, r2_key, sha256
      FROM reb_track_index
     WHERE window_id = ${`consult-${uid}`}::text AND status = 'ok' AND shadow = false AND layer IN ('translate', 'stt')
     ORDER BY finished_at DESC NULLS LAST, id DESC
     LIMIT 40
  `) as IndexRow[];
  let skipped = 0;
  for (const layer of ["translate", "stt"] as const) {
    for (const row of rows.filter((r) => r.layer === layer)) {
      const m = REB_CONSULT_KEY.exec(String(row.r2_key));
      // the key must be a consult key of THIS consult in THIS room, and not a held-out pair
      if (!m || m[3] !== uid || m[2] !== span.room_id || blindRefusal(m[2]!, m[1]!)) { skipped += 1; continue; }
      const obj = await store.get(row.r2_key);
      if (!obj) continue;
      if (typeof row.sha256 !== "string" || sha256(obj.body) !== row.sha256.toLowerCase()) { skipped += 1; continue; } // source_integrity
      let doc: unknown;
      try { doc = JSON.parse(obj.body); } catch { skipped += 1; continue; }
      const probe = linesFromTrack(doc, span.t_open_ms, span.t_close_ms, layer);
      if (!probe || probe.lines.length === 0) continue;
      if (layer === "stt" && !probe.allEnglish) break; // a native-language stt track is not text we can score: fall back
      const got = (opts.roleTextJudge ?? ROLE_TEXT_JUDGE_ENABLED)
        ? linesFromTrack(doc, span.t_open_ms, span.t_close_ms, layer, await roleResolver(span, uid, store, { layer, row, doc }, rows.filter((r) => r.layer === "stt")))!
        : probe;
      return { found: { source: layer === "translate" ? "reb_translate" : "reb_stt_en", config_hash: String(row.config_hash), lines: got.lines, turns: got.turns, n_integrity_skipped: skipped }, n_integrity_skipped: skipped };
    }
  }
  return { found: null, n_integrity_skipped: skipped };
}

// ---- S8C: a palimpsest track of a consult, as a reference (scribe_sarvam status / result / transcribe) --------------------------------------------------------------------------
export type RebTrackRef = { source: "palimpsest"; layer: "translate" | "stt"; config_hash: string; n_segments: number; segments?: Array<{ t0_ms: number; t1_ms: number; speaker: string; lang: string | null; text: string }> };
/**
 * The newest ok palimpsest track (translate first, then stt) of one consult, with the same key ownership (this uid, this room, not held out) and sha256 checks as consult text. The caller has already passed the
 * consult's (room, date) through the held-out check. Text (segments) only when asked. No Sarvam call, no write.
 */
export async function findRebTrack(uid: string, roomId: string, istDate: string, opts: { withText?: boolean } = {}): Promise<{ found: RebTrackRef | null; n_integrity_skipped: number }> {
  if (!UID_RE.test(uid) || blindRefusal(roomId, istDate)) return { found: null, n_integrity_skipped: 0 };
  const store = labStore();
  if (!store) return { found: null, n_integrity_skipped: 0 };
  const rows = (await sql`
    SELECT layer, engine, config_hash, r2_key, sha256
      FROM reb_track_index
     WHERE window_id = ${`consult-${uid}`}::text AND status = 'ok' AND shadow = false AND layer IN ('translate', 'stt')
     ORDER BY finished_at DESC NULLS LAST, id DESC
     LIMIT 40
  `) as IndexRow[];
  let skipped = 0;
  for (const layer of ["translate", "stt"] as const) {
    for (const row of rows.filter((r) => r.layer === layer)) {
      const m = REB_CONSULT_KEY.exec(String(row.r2_key));
      if (!m || m[3] !== uid || m[2] !== roomId || blindRefusal(m[2]!, m[1]!)) { skipped += 1; continue; }
      const obj = await store.get(row.r2_key);
      if (!obj) continue;
      if (typeof row.sha256 !== "string" || sha256(obj.body) !== row.sha256.toLowerCase()) { skipped += 1; continue; }
      let doc: { status?: unknown; segments?: unknown };
      try { doc = JSON.parse(obj.body); } catch { skipped += 1; continue; }
      if (doc?.status !== "ok" || !Array.isArray(doc.segments)) continue;
      const segs = (doc.segments as Array<Record<string, unknown>>).filter((g) => g && typeof g === "object");
      return {
        found: {
          source: "palimpsest", layer, config_hash: String(row.config_hash), n_segments: segs.length,
          ...(opts.withText ? { segments: segs.map((g) => ({ t0_ms: Number(g.t0_ms), t1_ms: Number(g.t1_ms), speaker: String(g.speaker ?? ""), lang: typeof g.lang === "string" ? g.lang : null, text: typeof g.text === "string" ? g.text : "" })) } : {}),
        },
        n_integrity_skipped: skipped,
      };
    }
  }
  return { found: null, n_integrity_skipped: skipped };
}
