/**
 * Reader reb_consult — S7-2B: the words of one consult from palimpsest's Sarvam consult-clip tracks (R2 eta-lab-results), found through the Neon index reb_track_index.
 *
 * ORDER. The caller has ALREADY passed the consult's (room, IST date) through the held-out check (readConsultSpan refuses first). Here: the index (window_id = 'consult-' || consult_uid, status ok, not
 * shadow, layer translate or stt; newest finished first) -> for each layer in the order translate, stt: the newest ok track whose key is a consult key of THIS consult and room -> one GET (the lab store
 * allows GET of reb/<date>/<room>/_consults/ keys only) -> the object's sha256 must equal the index's (a mismatch is skipped and counted: source_integrity) -> parse -> turns clamped to the consult span.
 * A translate track is used as it is (English). An stt (native) track is used ONLY when every segment's lang starts with "en". Otherwise nothing is returned and the caller falls back to window_english.
 * Track shape (palimpsest-architect, bus #10536): { config, config_hash, engine, extras, layer, segments: [{ t0_ms, t1_ms, speaker, lang, text, extras }], status, window_id }; t0_ms / t1_ms are absolute UTC
 * epoch ms, an end may overrun the span by <= 0.56 s (clamped). Speaker: a label starting doctor / clinician / dr = doctor; patient / other / attender / nurse = other; anything else unknown (INFERRED: the label set).
 * Sarvam's own labels are numbers ("0", "1"), so speakerOf marks every such line unknown. Arch #91 (eta-lab role.llm-roles v1) writes a companion track, layer role / engine llm-roles, one segment per stt
 * segment at the same (t0_ms, t1_ms, speaker) and with no text. Behind ETA_REB_ROLE_LLM (parseFlag, default off) the newest ok not-shadow row of that track is joined and the line's speaker becomes
 * doctor, or other (patient / attender / staff / other), or unknown. The fine-grained role is ConsultLine.role and Turn.reb_role. Turn.role stays "clinician" for a doctor and null otherwise.
 * Flag off, or no role track: the returned object is unchanged (no role key, no role_source). A sha256 mismatch or a held-out key is skipped and counted, and the text track is still returned.
 * No transcript text is returned beyond the ConsultText the engines already take; the role track's text is never read; nothing is written.
 */
import { createHash } from "node:crypto";
import { sql } from "@/lib/db";
import { parseFlag } from "@/lib/flags";
import { labStore, REB_CONSULT_KEY, type LabStore } from "@/lib/sarvam-lab";
import { blindRefusal } from "@/lib/room-access/readers/common";
import type { ConsultSpan } from "@/lib/room-access/readers/consult-span";
import type { ConsultLine } from "@/lib/rubrics/readers/consult-text";
import { REB_SPEAKER_ROLES, type RebSpeakerRole, type Turn } from "@/lib/room-access/readers/turns";

export const UID_RE = /^[A-Za-z0-9]{10,60}$/;
/** Arch #91. Unset = off. A value parseFlag does not recognise throws; it is never read as off. Do not set this in production until a shadow hour is accepted. */
export const ETA_REB_ROLE_LLM = "ETA_REB_ROLE_LLM";
export const REB_ROLE_LAYER = "role";
export const REB_ROLE_ENGINE = "llm-roles";
export const rebRoleLlmEnabled = (env: Record<string, string | undefined> = process.env): boolean => parseFlag(ETA_REB_ROLE_LLM, env);

export type RebRoleFlags = { attender_present: boolean | null; two_consults: boolean | null; diar_partial: boolean | null };
export type RebConsult = {
  source: "reb_translate" | "reb_stt_en"; config_hash: string; lines: ConsultLine[]; turns: Turn[]; n_integrity_skipped: number;
  /** Present only when a role.llm-roles track was joined. Absent (not null) is the flag-off / no-track case, so the object stays byte-identical. */
  role_source?: "reb_llm_roles"; role_config_hash?: string;
};
export type RebOutcome = { found: RebConsult | null; n_integrity_skipped: number };
export type RoleLookup = { bySegment: ReadonlyMap<string, RebSpeakerRole>; bySpeaker?: ReadonlyMap<string, RebSpeakerRole> };

type IndexRow = { layer: string; engine: string; config_hash: string; r2_key: string; sha256: string; version?: string };

/**
 * The stt engines the consult reader may take text from, in preference order. A consult holds stt tracks from several engines, so "newest" means nothing;
 * the first engine here with a usable row decides, and if that row is not wholly English the stt layer yields nothing (no fallback to a later engine).
 * medasr is English-only run on every clip, so its text is not the transcript of record and is deliberately absent. A caa-version row is never taken.
 */
export const REB_STT_ENGINE_PREFERENCE: readonly string[] = ["sarvam-saaras-v3"];
const isCaaVersion = (r: IndexRow): boolean => /caa/i.test(String(r.version ?? ""));
const isEnglishTag = (v: unknown): boolean => typeof v === "string" && v.toLowerCase().startsWith("en");
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export function isRebRole(v: unknown): v is RebSpeakerRole {
  return typeof v === "string" && (REB_SPEAKER_ROLES as readonly string[]).includes(v);
}

/** doctor stays doctor; patient / attender / staff / other collapse to the ConsultLine speaker "other"; unknown stays unknown. */
export function speakerFromRole(role: RebSpeakerRole): ConsultLine["speaker"] {
  if (role === "doctor") return "doctor";
  if (role === "unknown") return "unknown";
  return "other";
}

/** The speaker id as the role track stores it (`str(speaker)`). A JSON number and the same digits as a string share one key. */
export function roleSpeakerLabel(speaker: unknown): string | null {
  if (typeof speaker === "string") return speaker;
  if (typeof speaker === "number" && Number.isFinite(speaker)) return String(speaker);
  return null;
}

/** Exact join key. Times are the segment's own t0_ms / t1_ms, not the clamped consult-span times. */
export function roleSegmentKey(t0: number, t1: number, speaker: unknown): string | null {
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  const sp = roleSpeakerLabel(speaker);
  if (sp === null) return null;
  return `${t0}\u0000${t1}\u0000${sp}`;
}

/**
 * PURE. Index role segments by (t0_ms, t1_ms, speaker). The first segment for a key wins; a later duplicate is ignored.
 * An unrecognised role string becomes "unknown". A `text` field is never read (the track has none).
 */
export function indexRoleSegments(segments: unknown): Map<string, RebSpeakerRole> {
  const map = new Map<string, RebSpeakerRole>();
  if (!Array.isArray(segments)) return map;
  for (const g of segments) {
    if (!g || typeof g !== "object") continue;
    const rec = g as Record<string, unknown>;
    const key = roleSegmentKey(Number(rec.t0_ms), Number(rec.t1_ms), rec.speaker);
    if (!key || map.has(key)) continue;
    map.set(key, isRebRole(rec.role) ? rec.role : "unknown");
  }
  return map;
}

/** PURE. extras.map is speaker id → role (the speaker-level assignment, before per-utterance fixes). Invalid values become "unknown". No other extras field is read. */
export function speakerRoleMap(extras: unknown): Map<string, RebSpeakerRole> {
  const map = new Map<string, RebSpeakerRole>();
  if (!extras || typeof extras !== "object" || Array.isArray(extras)) return map;
  const raw = (extras as { map?: unknown }).map;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) map.set(k, isRebRole(v) ? v : "unknown");
  return map;
}

/**
 * PURE. The three flags the role track records on extras. Counts and booleans only: attender_present, two_consults.flag (or a bare boolean), diar_partial.
 * null when none of the three is present. Segment text, the speaker map, tokens and cost are not read.
 */
export function roleFlagsFromExtras(extras: unknown): RebRoleFlags | null {
  if (!extras || typeof extras !== "object" || Array.isArray(extras)) return null;
  const e = extras as Record<string, unknown>;
  const att = e.attender_present;
  const diar = e.diar_partial;
  const tc = e.two_consults;
  const two = typeof tc === "boolean" ? tc : tc && typeof tc === "object" && !Array.isArray(tc) ? (tc as { flag?: unknown }).flag : undefined;
  if (att === undefined && diar === undefined && two === undefined) return null;
  return {
    attender_present: typeof att === "boolean" ? att : null,
    two_consults: typeof two === "boolean" ? two : null,
    diar_partial: typeof diar === "boolean" ? diar : null,
  };
}

/** Exact segment match, else the speaker map when one was supplied, else unknown. A missing segment is unknown. */
export function lookupRole(roles: RoleLookup, t0: number, t1: number, speaker: unknown): RebSpeakerRole {
  const key = roleSegmentKey(t0, t1, speaker);
  if (key && roles.bySegment.has(key)) return roles.bySegment.get(key)!;
  if (roles.bySpeaker) {
    const lab = roleSpeakerLabel(speaker);
    if (lab !== null && roles.bySpeaker.has(lab)) return roles.bySpeaker.get(lab)!;
  }
  return "unknown";
}

function speakerOf(label: unknown): { speaker: ConsultLine["speaker"]; idx: number | null } {
  const s = typeof label === "string" ? label.trim().toLowerCase() : "";
  const n = /(\d+)\s*$/.exec(s);
  const idx = n ? Number(n[1]) : null;
  if (/^(doctor|clinician|dr)(?![a-z])/.test(s)) return { speaker: "doctor", idx };
  if (/^(patient|other|attender|nurse)(?![a-z])/.test(s)) return { speaker: "other", idx };
  return { speaker: "unknown", idx };
}

/**
 * PURE — a parsed track to lines / turns clamped to [open, close] (absolute ms), times relative to the open.
 * `roles` omitted: the objects are exactly the pre-Arch-#91 shape (no `role`, no `reb_role`).
 * `roles` set: each kept segment is joined on its own (t0_ms, t1_ms, speaker). A miss is speaker unknown and role unknown.
 * The stt path passes bySegment only, so a speaker named in extras.map but missing as a segment stays unknown.
 * The translate path also passes bySpeaker, because a translate job is a second segmentation and its times often differ from the stt segments the role track was written against.
 */
export function linesFromTrack(doc: unknown, open: number, close: number, layer: "translate" | "stt", roles?: RoleLookup | null): { lines: ConsultLine[]; turns: Turn[]; allEnglish: boolean } | null {
  const d = doc as { status?: unknown; segments?: unknown } | null;
  if (!d || typeof d !== "object" || d.status !== "ok" || !Array.isArray(d.segments)) return null;
  const segs = d.segments as Array<Record<string, unknown>>;
  let allEnglish = segs.length > 0;
  // a track that says its clip was not English is never English text, whatever its segments claim (medasr writes lang "en" on every segment)
  const extras = (doc as { extras?: unknown }).extras as { source_language?: unknown } | null | undefined;
  if (layer === "stt" && extras && typeof extras === "object" && extras.source_language != null && !isEnglishTag(extras.source_language)) allEnglish = false;
  const lines: ConsultLine[] = [];
  const turns: Turn[] = [];
  for (const g of segs) {
    if (!g || typeof g !== "object") continue;
    if (layer === "stt" && !isEnglishTag(g.lang)) allEnglish = false;
    const t0 = Number(g.t0_ms), t1 = Number(g.t1_ms);
    const text = typeof g.text === "string" ? g.text.trim() : "";
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || !text) continue;
    const a = Math.max(open, t0), b = Math.min(close, t1); // clamp to the consult span (an end may overrun by <= 0.56 s)
    if (b <= a) continue; // wholly outside the span
    const sp = speakerOf(g.speaker);
    if (roles) {
      const role = lookupRole(roles, t0, t1, g.speaker);
      const speaker = speakerFromRole(role);
      lines.push({ t_ms: a - open, speaker, speaker_idx: sp.idx, text, role });
      turns.push({ source_ref: `reb${turns.length}`, start_ms: a - open, end_ms: Math.max(a - open + 1, b - open), speaker_idx: sp.idx, role: speaker === "doctor" ? "clinician" : null, overlap_ms: null, reb_role: role });
    } else {
      lines.push({ t_ms: a - open, speaker: sp.speaker, speaker_idx: sp.idx, text });
      turns.push({ source_ref: `reb${turns.length}`, start_ms: a - open, end_ms: Math.max(a - open + 1, b - open), speaker_idx: sp.idx, role: sp.speaker === "doctor" ? "clinician" : null, overlap_ms: null });
    }
  }
  lines.sort((x, y) => x.t_ms - y.t_ms);
  return { lines, turns, allEnglish };
}

function roleLookupFromDoc(doc: unknown, layer: "translate" | "stt"): RoleLookup | null {
  const d = doc as { status?: unknown; segments?: unknown; extras?: unknown; engine?: unknown; layer?: unknown } | null;
  if (!d || typeof d !== "object" || d.status !== "ok" || !Array.isArray(d.segments)) return null;
  if (typeof d.engine === "string" && d.engine !== REB_ROLE_ENGINE) return null;
  if (typeof d.layer === "string" && d.layer !== REB_ROLE_LAYER) return null;
  const bySegment = indexRoleSegments(d.segments);
  // translate is a second Sarvam job, so its times often miss the stt-aligned role segments; the speaker map still names "0" / "1"
  if (layer === "translate") return { bySegment, bySpeaker: speakerRoleMap(d.extras) };
  return { bySegment };
}

/**
 * Newest ok, not-shadow role / llm-roles row for this consult. The same key ownership (this uid, one of `rooms`, not a held-out pair) and sha256 check as the text read.
 * A mismatch is skipped and counted; the next older row is tried. No row, or none that parses as an ok track, returns doc null. The body's text is never copied out.
 */
async function loadRoleDoc(uid: string, rooms: ReadonlySet<string>, store: LabStore): Promise<{ doc: unknown; config_hash: string; skipped: number } | { doc: null; skipped: number }> {
  const rows = (await sql`
    SELECT layer, engine, config_hash, r2_key, sha256
      FROM reb_track_index
     WHERE window_id = ${`consult-${uid}`}::text AND status = 'ok' AND shadow = false AND layer = 'role' AND engine = 'llm-roles'
     ORDER BY finished_at DESC NULLS LAST, id DESC
     LIMIT 40
  `) as IndexRow[];
  let skipped = 0;
  for (const row of rows) {
    const m = REB_CONSULT_KEY.exec(String(row.r2_key));
    if (!m || m[3] !== uid || !rooms.has(m[2]!) || blindRefusal(m[2]!, m[1]!)) { skipped += 1; continue; }
    const obj = await store.get(row.r2_key);
    if (!obj) continue;
    if (typeof row.sha256 !== "string" || sha256(obj.body) !== row.sha256.toLowerCase()) { skipped += 1; continue; }
    let doc: unknown;
    try { doc = JSON.parse(obj.body); } catch { skipped += 1; continue; }
    if (!roleLookupFromDoc(doc, "stt")) continue;
    return { doc, config_hash: String(row.config_hash), skipped };
  }
  return { doc: null, skipped };
}

/**
 * Flag off: the text track's lines and turns, untouched, and no index read. Flag on: join the role track when one passes the checks.
 * A sha or key failure is counted and the text track is still returned without roles (lines stay as speakerOf left them).
 */
async function joinRoleTrack(uid: string, roomId: string, store: LabStore, layer: "translate" | "stt", textDoc: unknown, open: number, close: number, got: { lines: ConsultLine[]; turns: Turn[] }): Promise<{ lines: ConsultLine[]; turns: Turn[]; skipped: number; provenance: { role_source: "reb_llm_roles"; role_config_hash: string } | Record<string, never> }> {
  if (!rebRoleLlmEnabled()) return { lines: got.lines, turns: got.turns, skipped: 0, provenance: {} };
  const loaded = await loadRoleDoc(uid, new Set([roomId]), store);
  if (!loaded.doc || !("config_hash" in loaded)) return { lines: got.lines, turns: got.turns, skipped: loaded.skipped, provenance: {} };
  const lookup = roleLookupFromDoc(loaded.doc, layer);
  if (!lookup) return { lines: got.lines, turns: got.turns, skipped: loaded.skipped, provenance: {} };
  const again = linesFromTrack(textDoc, open, close, layer, lookup);
  if (!again || again.lines.length === 0) return { lines: got.lines, turns: got.turns, skipped: loaded.skipped, provenance: {} };
  return { lines: again.lines, turns: again.turns, skipped: loaded.skipped, provenance: { role_source: "reb_llm_roles", role_config_hash: loaded.config_hash } };
}

/**
 * The three role-track flags for one consult, or null when the flag is off, the store is absent, or no ok role track passes the checks.
 * Booleans only. roomSlug is accepted the same way findSarvamTracks accepts it (the key may name either id).
 */
export async function readRebRoleFlags(uid: string, roomId: string, roomSlug = ""): Promise<RebRoleFlags | null> {
  if (!rebRoleLlmEnabled() || !UID_RE.test(uid)) return null;
  const store = labStore();
  if (!store) return null;
  const rooms = new Set([roomId, roomSlug].filter((r) => r.length > 0));
  const loaded = await loadRoleDoc(uid, rooms, store);
  if (!loaded.doc) return null;
  return roleFlagsFromExtras((loaded.doc as { extras?: unknown }).extras);
}

export async function readRebConsult(span: ConsultSpan): Promise<RebOutcome> {
  const none: RebOutcome = { found: null, n_integrity_skipped: 0 };
  const uid = span.consult_uid;
  if (!uid || !UID_RE.test(uid)) return none;
  if (blindRefusal(span.room_id, span.ist_date)) return none; // belt and braces: the caller refused already; nothing below runs for a held-out pair
  const store = labStore();
  if (!store) return none;
  const rows = (await sql`
    SELECT layer, engine, version, config_hash, r2_key, sha256
      FROM reb_track_index
     WHERE window_id = ${`consult-${uid}`}::text AND status = 'ok' AND shadow = false AND layer IN ('translate', 'stt')
     ORDER BY finished_at DESC NULLS LAST, id DESC
     LIMIT 40
  `) as IndexRow[];
  let skipped = 0;
  for (const layer of ["translate", "stt"] as const) {
    // stt: only a named engine, never a caa version, ordered by engine preference then newest (the query order is kept within an engine)
    const layerRows = layer === "translate"
      ? rows.filter((r) => r.layer === layer)
      : REB_STT_ENGINE_PREFERENCE.flatMap((eng) => rows.filter((r) => r.layer === "stt" && r.engine === eng && !isCaaVersion(r)));
    for (const row of layerRows) {
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
      if (layer === "stt" && !got.allEnglish) break; // the preferred engine's latest row is not wholly English: the stt layer yields nothing, the caller falls through to window_english
      const joined = await joinRoleTrack(uid, span.room_id, store, layer, doc, span.t_open_ms, span.t_close_ms, got);
      skipped += joined.skipped;
      return {
        found: {
          source: layer === "translate" ? "reb_translate" : "reb_stt_en", config_hash: String(row.config_hash),
          lines: joined.lines, turns: joined.turns, n_integrity_skipped: skipped, ...joined.provenance,
        },
        n_integrity_skipped: skipped,
      };
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

// ---- consult-reuse: the palimpsest's OWN Sarvam tracks of THIS cut, found before Sarvam is called again ---------------------------------------------------------------------
export const SARVAM_TRACK_ENGINE = "sarvam-saaras-v3";
export type SarvamTrackSegment = { t0_ms: number; t1_ms: number; speaker: string | null; lang: string | null; text: string };
export type SarvamTrack = { layer: "stt" | "translate"; engine: string; model: string | null; version: string | null; config_hash: string; r2_key: string; segments: SarvamTrackSegment[] };
export type SarvamReuse = { found: { stt: SarvamTrack | null; translate: SarvamTrack | null } | null; n_integrity_skipped: number; n_other_cut: number; missing: Array<"stt" | "translate"> } | { unavailable: true };

/**
 * A live (status ok, not shadow) engine sarvam-saaras-v3 track of this consult, FOR THIS CUT: the track's own config.clip_signature must give the same cut version as the index row's (`cutVersion`, from
 * lib/consult-index/parse.ts signatureVersion). A track of another cut (the clip was re-cut after the track was made) is skipped and counted, never returned. The same key ownership (this uid, this room) and
 * sha256 checks as every other palimpsest read. Newest first; the newest matching track of each layer (stt, translate) is returned.
 *
 * FAIL CLOSED. If the lookup cannot be made (the index table cannot be read, the lab store is not configured, or a read throws) the answer is { unavailable: true }, never "none": a caller that took a
 * failure for "no track" would pay Sarvam for a consult that already has one. A track the INDEX says is ok but whose R2 object is gone cannot be checked against the cut (its signature is in the object),
 * so it is reported in `missing` (by layer) and the caller must NOT silently pay Sarvam for it (track_missing; only force:true goes on).
 */
export async function findSarvamTracks(uid: string, roomId: string, roomSlug: string, cutVersion: string, signatureOf: (sig: unknown) => string | null): Promise<SarvamReuse> {
  if (!UID_RE.test(uid)) return { found: null, n_integrity_skipped: 0, n_other_cut: 0, missing: [] };
  const store = labStore();
  if (!store) return { unavailable: true };
  let rows: IndexRow[];
  try {
    rows = (await sql`
      SELECT layer, engine, config_hash, r2_key, sha256
        FROM reb_track_index
       WHERE window_id = ${`consult-${uid}`}::text AND status = 'ok' AND shadow = false AND engine = ${SARVAM_TRACK_ENGINE}::text AND layer IN ('stt', 'translate')
       ORDER BY finished_at DESC NULLS LAST, id DESC
       LIMIT 40
    `) as IndexRow[];
  } catch {
    return { unavailable: true };
  }
  const out: { stt: SarvamTrack | null; translate: SarvamTrack | null } = { stt: null, translate: null };
  let skipped = 0, otherCut = 0;
  const missing: Array<"stt" | "translate"> = [];
  try {
    for (const row of rows) {
      const layer = row.layer === "stt" || row.layer === "translate" ? row.layer : null;
      if (!layer || out[layer]) continue;
      const m = REB_CONSULT_KEY.exec(String(row.r2_key));
      if (!m || m[3] !== uid || (m[2] !== roomId && m[2] !== roomSlug)) { skipped += 1; continue; }
      const obj = await store.get(row.r2_key);
      if (!obj) { if (!missing.includes(layer)) missing.push(layer); continue; }
      if (typeof row.sha256 !== "string" || sha256(obj.body) !== row.sha256.toLowerCase()) { skipped += 1; continue; }
      let doc: { status?: unknown; engine?: unknown; model?: unknown; version?: unknown; segments?: unknown; config?: { clip_signature?: unknown } };
      try { doc = JSON.parse(obj.body); } catch { skipped += 1; continue; }
      if (doc?.status !== "ok" || doc.engine !== SARVAM_TRACK_ENGINE || !Array.isArray(doc.segments)) continue;
      if (signatureOf(doc.config?.clip_signature) !== cutVersion) { otherCut += 1; continue; }
      const segs: SarvamTrackSegment[] = [];
      for (const g of doc.segments as Array<Record<string, unknown>>) {
        if (!g || typeof g !== "object") continue;
        const t0 = Number(g.t0_ms), t1 = Number(g.t1_ms);
        if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
        segs.push({ t0_ms: t0, t1_ms: t1, speaker: typeof g.speaker === "string" ? g.speaker : null, lang: typeof g.lang === "string" ? g.lang : null, text: typeof g.text === "string" ? g.text : "" });
      }
      out[layer] = { layer, engine: SARVAM_TRACK_ENGINE, model: typeof doc.model === "string" ? doc.model : null, version: typeof doc.version === "string" ? doc.version : null, config_hash: String(row.config_hash), r2_key: row.r2_key, segments: segs };
    }
  } catch {
    return { unavailable: true };
  }
  // a layer that WAS found is not missing (an older indexed row of it may be gone; the newest matching track is what counts)
  return { found: out.stt || out.translate ? out : null, n_integrity_skipped: skipped, n_other_cut: otherCut, missing: missing.filter((l) => !out[l]) };
}
