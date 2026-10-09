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
export function linesFromTrack(doc: unknown, open: number, close: number, layer: "translate" | "stt"): { lines: ConsultLine[]; turns: Turn[]; allEnglish: boolean } | null {
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
    const sp = speakerOf(g.speaker);
    lines.push({ t_ms: a - open, speaker: sp.speaker, speaker_idx: sp.idx, text });
    turns.push({ source_ref: `reb${turns.length}`, start_ms: a - open, end_ms: Math.max(a - open + 1, b - open), speaker_idx: sp.idx, role: sp.speaker === "doctor" ? "clinician" : null, overlap_ms: null });
  }
  lines.sort((x, y) => x.t_ms - y.t_ms);
  return { lines, turns, allEnglish };
}

export async function readRebConsult(span: ConsultSpan): Promise<RebOutcome> {
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
      const got = linesFromTrack(doc, span.t_open_ms, span.t_close_ms, layer);
      if (!got || got.lines.length === 0) continue;
      if (layer === "stt" && !got.allEnglish) break; // a native-language stt track is not text we can score: fall back
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
