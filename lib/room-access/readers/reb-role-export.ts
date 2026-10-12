/**
 * Read-only export of the REB role.llm-roles track. Roles and times only: a segment `text` field is never copied.
 *
 * This does not read ETA_REB_ROLE_LLM. That flag still gates joining roles into the live consult reader.
 * The box calls GET /api/reb/roles so the offline pipeline can use the track instead of model_inferred.
 */
import { createHash } from "node:crypto";
import { sql } from "@/lib/db";
import { labStore, REB_CONSULT_KEY } from "@/lib/sarvam-lab";
import { blindRefusal } from "@/lib/room-access/readers/common";
import {
  REB_ROLE_ENGINE,
  REB_ROLE_LAYER,
  isRebRole,
  roleFlagsFromExtras,
  roleSpeakerLabel,
  type RebRoleFlags,
} from "@/lib/room-access/readers/reb-consult";

export const ROLE_BATCH_MAX = 25;
const UID_OK = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Row = Record<string, unknown>;
type IndexHit = { window_id: string; room_id: string; r2_key: string; sha256: string; config_hash: string; ist_date: string };

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const realDate = (s: string): boolean => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export type RoleSegmentOut = { t0_ms: number; t1_ms: number; speaker: string; role: string };

/** Segments as the box stores them in role.json. `text` is never read into the result. */
export function roleTrackPublic(doc: unknown): { segments: RoleSegmentOut[]; flags: RebRoleFlags | null } | null {
  const d = doc as { status?: unknown; segments?: unknown; extras?: unknown; engine?: unknown; layer?: unknown } | null;
  if (!d || typeof d !== "object" || d.status !== "ok" || !Array.isArray(d.segments)) return null;
  if (typeof d.engine === "string" && d.engine !== REB_ROLE_ENGINE) return null;
  if (typeof d.layer === "string" && d.layer !== REB_ROLE_LAYER) return null;
  const segments: RoleSegmentOut[] = [];
  for (const g of d.segments) {
    if (!g || typeof g !== "object") continue;
    const rec = g as Record<string, unknown>;
    const sp = roleSpeakerLabel(rec.speaker);
    const t0 = Number(rec.t0_ms);
    const t1 = Number(rec.t1_ms);
    if (sp === null || !Number.isFinite(t0) || !Number.isFinite(t1)) continue;
    segments.push({ t0_ms: t0, t1_ms: t1, speaker: sp, role: isRebRole(rec.role) ? rec.role : "unknown" });
  }
  return { segments, flags: roleFlagsFromExtras(d.extras) };
}

async function loadHit(hit: IndexHit): Promise<Row> {
  const uid = hit.window_id.startsWith("consult-") ? hit.window_id.slice("consult-".length) : "";
  const m = REB_CONSULT_KEY.exec(String(hit.r2_key));
  if (!m || m[3] !== uid) return { ok: true, consult_uid: uid, track: null, note: "key_rejected" };
  if (blindRefusal(m[2]!, m[1]!)) return { ok: false, consult_uid: uid, error: "blind_room_day" };
  const store = labStore();
  if (!store) return { ok: false, consult_uid: uid, error: "lab_store_unavailable" };
  const obj = await store.get(hit.r2_key);
  if (!obj) return { ok: true, consult_uid: uid, track: null, ist_date: hit.ist_date, room_id: hit.room_id };
  if (typeof hit.sha256 !== "string" || sha256(obj.body) !== hit.sha256.toLowerCase()) return { ok: true, consult_uid: uid, track: null, note: "source_integrity" };
  let doc: unknown;
  try { doc = JSON.parse(obj.body); } catch { return { ok: true, consult_uid: uid, track: null, note: "unreadable" }; }
  const pub = roleTrackPublic(doc);
  if (!pub || pub.segments.length === 0) return { ok: true, consult_uid: uid, track: null };
  return {
    ok: true, consult_uid: uid, ist_date: hit.ist_date, room_id: hit.room_id, config_hash: hit.config_hash,
    layer: REB_ROLE_LAYER, engine: REB_ROLE_ENGINE, status: "ok", source: "reb_llm_roles", ...pub,
  };
}

async function newest(uid: string): Promise<IndexHit | null> {
  const rows = (await sql`
    SELECT window_id, room_id, r2_key, sha256, config_hash, ist_date::text AS ist_date
      FROM reb_track_index
     WHERE window_id = ${`consult-${uid}`}::text AND status = 'ok' AND shadow = false
       AND layer = 'role' AND engine = 'llm-roles'
     ORDER BY finished_at DESC NULLS LAST, id DESC
     LIMIT 1
  `) as IndexHit[];
  return rows[0] ?? null;
}

async function dayHits(day: string): Promise<IndexHit[]> {
  const rows = (await sql`
    SELECT DISTINCT ON (window_id) window_id, room_id, r2_key, sha256, config_hash, ist_date::text AS ist_date
      FROM reb_track_index
     WHERE ist_date = ${day}::date AND status = 'ok' AND shadow = false
       AND layer = 'role' AND engine = 'llm-roles' AND window_id LIKE 'consult-%'
     ORDER BY window_id, finished_at DESC NULLS LAST, id DESC
     LIMIT 80
  `) as IndexHit[];
  return rows;
}

/** One consult, a list of at most 25, or one IST day. No transcript text. */
export async function exportRoleTracks(q: { consult_uids?: string[]; ist_date?: string | null }): Promise<Row> {
  const uids = q.consult_uids?.map((s) => s.trim()).filter((s) => s.length > 0);
  if (uids && uids.length > ROLE_BATCH_MAX) return { ok: false, error: "bad_args", detail: "consult_uids max 25" };
  if (uids && uids.length > 0) {
    const rows: Row[] = [];
    let withheld = 0;
    for (const uid of uids) {
      if (!UID_OK.test(uid)) { rows.push({ ok: false, consult_uid: uid, error: "consult_uid_invalid" }); continue; }
      const hit = await newest(uid);
      if (!hit) { rows.push({ ok: true, consult_uid: uid, track: null }); continue; }
      const got = await loadHit(hit);
      if (got.error === "blind_room_day") { withheld += 1; continue; }
      rows.push(got);
    }
    return { ok: true, selector: "consult_uids", n: rows.length, withheld_blind: withheld, rows };
  }
  if (q.ist_date) {
    if (!realDate(q.ist_date)) return { ok: false, error: "bad_date" };
    const hits = await dayHits(q.ist_date);
    const rows: Row[] = [];
    let withheld = 0;
    for (const hit of hits) {
      if (rows.length >= ROLE_BATCH_MAX) break;
      const got = await loadHit(hit);
      if (got.error === "blind_room_day") { withheld += 1; continue; }
      rows.push(got);
    }
    return { ok: true, selector: "ist_date", ist_date: q.ist_date, n: rows.length, truncated: hits.length > ROLE_BATCH_MAX, withheld_blind: withheld, rows };
  }
  return { ok: false, error: "bad_args" };
}
