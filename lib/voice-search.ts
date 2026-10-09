/**
 * lib/voice-search.ts — S6B: voice search v1, TRANSIENT and READ ONLY (scribe_voice_console action "search").
 * A query voice (one speaker of one diarized window, or one clinician's active centroid) is compared in memory by cosineSimilarity (lib/enroll.ts, raw vectors) with the stored speaker
 * embeddings of room_diarize_window rows in a scoped room / IST-date range. Nothing about the query or its hits is stored, logged or returned as a vector: the answer is window ids, room, date,
 * speaker index, a cosine to 3 dp and, where room_turn_speaker matched that speaker in that window, the clinician id. "voice similarity, not identity" — never a verdict.
 * HELD-OUT ROOM-DAYS (S6-BLIND Y1: EITHER placement, room_diarize_window.room_day_id or bench_window.room_day_id, held out excludes a window; same rule as lib/voice-blind refusalForPairs): the query window passes lib/voice-blind (blind_room_day / window_unplaced, 0 further reads); candidate windows on a held-out pair are excluded in SQL and counted
 * (n_blind_excluded), windows with no room-day are excluded and counted (n_unplaced_excluded); more than MAX_WINDOWS candidates is search_too_wide BEFORE any vector is read.
 */
import { sql } from "@/lib/db";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";
import { cosineSimilarity } from "@/lib/enroll";
import { DIARIZE_BATCH_THRESHOLD } from "@/lib/stt/diarize-window";
import { guardWindow } from "@/lib/voice-blind";

export const SEARCH_COSINE_FLOOR = 0.5;
export const SEARCH_COSINE_DEFAULT = DIARIZE_BATCH_THRESHOLD;
export const SEARCH_TOP_K_DEFAULT = 20;
export const SEARCH_TOP_K_MAX = 50;
export const SEARCH_MAX_WINDOWS = 5000;
export const SEARCH_MAX_ROOMS = 10;
export const SEARCH_MAX_DAYS = 14;
const EMBEDDING_BYTES = 768; // 192 float32
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAYS = BLIND_ROOM_DAYS.map(([d]) => d);
const ROOMS = BLIND_ROOM_DAYS.map(([, r]) => r);
const LABEL = "voice similarity, not identity";

type Err = { ok: false; error: string };
export type SearchArgs = { window_id?: unknown; speaker_idx?: unknown; clinician_id?: unknown; rooms?: unknown; from?: unknown; to?: unknown; min_cosine?: unknown; top_k?: unknown };

const dayNum = (s: string): number | null => (DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s) ? Date.parse(`${s}T00:00:00Z`) / 86_400_000 : null);

/** PURE — the validated scope, or why it is refused. */
export function parseScope(a: SearchArgs): { ok: true; rooms: string[]; from: string; to: string } | Err {
  const rooms = Array.isArray(a.rooms) ? [...new Set(a.rooms.filter((x): x is string => typeof x === "string"))] : [];
  if (!Array.isArray(a.rooms) || rooms.length !== (a.rooms as unknown[]).length || rooms.length < 1 || rooms.length > SEARCH_MAX_ROOMS || !rooms.every((r) => ID_RE.test(r))) return { ok: false, error: "bad_rooms" };
  if (typeof a.from !== "string" || typeof a.to !== "string") return { ok: false, error: "bad_dates" };
  const f = dayNum(a.from), t = dayNum(a.to);
  if (f === null || t === null || t < f) return { ok: false, error: "bad_dates" };
  if (t - f + 1 > SEARCH_MAX_DAYS) return { ok: false, error: "scope_too_wide" };
  return { ok: true, rooms, from: a.from, to: a.to };
}
/** PURE — floor and caps live in code; an argument can only move inside them. */
export function clampMinCosine(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? Math.max(SEARCH_COSINE_FLOOR, Math.min(1, v)) : SEARCH_COSINE_DEFAULT; }
export function clampTopK(v: unknown): number { return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(SEARCH_TOP_K_MAX, Math.trunc(v))) : SEARCH_TOP_K_DEFAULT; }

type Cand = { window_id: string; room_id: string; ist_date: string; idx: string; b64: string };

export async function voiceSearch(a: SearchArgs): Promise<Record<string, unknown>> {
  const hasWin = typeof a.window_id === "string" && a.window_id !== "";
  const hasIdx = a.speaker_idx !== undefined && a.speaker_idx !== null;
  const hasClin = typeof a.clinician_id === "string" && a.clinician_id !== "";
  if (hasClin === (hasWin || hasIdx)) return { ok: false, error: "one_query_required" };
  if (hasWin !== hasIdx) return { ok: false, error: "window_id_and_speaker_idx_required" };
  const scope = parseScope(a);
  if (!scope.ok) return scope;
  const minCos = clampMinCosine(a.min_cosine), topK = clampTopK(a.top_k);

  // --- the query vector
  let qB64: string | null = null;
  let qWin: string | null = null, qIdx: string | null = null;
  if (hasWin) {
    const wid = String(a.window_id);
    const idxN = typeof a.speaker_idx === "number" ? a.speaker_idx : Number(a.speaker_idx);
    if (!ID_RE.test(wid)) return { ok: false, error: "bad_window_id" };
    if (!Number.isInteger(idxN) || idxN < 0 || idxN > 99) return { ok: false, error: "bad_speaker_idx" };
    const g = await guardWindow(wid); // placement only; refused here = no other read happens
    if (g) return { ok: false, error: g };
    const rows = (await sql`
      SELECT sp->>'embedding_base64' AS b64
        FROM room_diarize_window d, jsonb_array_elements(CASE WHEN jsonb_typeof(d.speakers_json) = 'array' THEN d.speakers_json ELSE '[]'::jsonb END) sp
       WHERE d.window_id = ${wid}::text AND d.state = 'ok' AND sp->>'idx' = ${String(idxN)}::text
       LIMIT 1
    `) as Array<{ b64: string | null }>;
    qB64 = rows[0]?.b64 ?? null;
    if (!qB64) return { ok: false, error: "no_query_embedding" };
    qWin = wid; qIdx = String(idxN);
  } else {
    const cid = String(a.clinician_id);
    if (!ID_RE.test(cid)) return { ok: false, error: "bad_clinician_id" };
    const rows = (await sql`
      SELECT encode(vp.centroid, 'base64') AS b64
        FROM voice_print vp JOIN clinician c ON c.id = vp.doctor_id
       WHERE vp.doctor_id = ${cid}::text AND vp.centroid IS NOT NULL AND c.status = 'active' AND c.deleted_at IS NULL
       LIMIT 1
    `) as Array<{ b64: string | null }>;
    qB64 = rows[0]?.b64 ?? null;
    if (!qB64) return { ok: false, error: "no_voiceprint" };
  }
  if (Buffer.from(qB64, "base64").length !== EMBEDDING_BYTES) return { ok: false, error: "bad_query_dim" };

  // --- the scope: counts first, no vectors
  const counts = (await sql`
    SELECT count(*) FILTER (WHERE NOT blind)::int AS n_candidates, count(*) FILTER (WHERE blind)::int AS n_blind
      FROM (
        SELECT EXISTS (SELECT 1 FROM room_day r1, unnest(${DAYS}::date[], ${ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (d.room_day_id, w.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id) AS blind
          FROM room_diarize_window d
          JOIN bench_window w ON w.id = d.window_id
          JOIN room_day rd ON rd.id = COALESCE(d.room_day_id, w.room_day_id)
         WHERE d.state = 'ok' AND rd.room_id = ANY(${scope.rooms}::text[]) AND rd.ist_date BETWEEN ${scope.from}::date AND ${scope.to}::date
      ) x
  `) as Array<{ n_candidates: number; n_blind: number }>;
  const unplaced = (await sql`
    SELECT count(*)::int AS n
      FROM room_diarize_window d
      JOIN bench_window w ON w.id = d.window_id
      JOIN bench_session s ON s.id = w.session_id
      LEFT JOIN room_day rd ON rd.id = COALESCE(d.room_day_id, w.room_day_id)
     WHERE d.state = 'ok' AND rd.id IS NULL AND s.room_id = ANY(${scope.rooms}::text[])
       AND (s.started_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${scope.from}::date AND ${scope.to}::date
  `) as Array<{ n: number }>;
  const n_candidates = Number(counts[0]?.n_candidates ?? 0), n_blind_excluded = Number(counts[0]?.n_blind ?? 0), n_unplaced_excluded = Number(unplaced[0]?.n ?? 0);
  const base = { label: LABEL, floor: SEARCH_COSINE_FLOOR, min_cosine: minCos, top_k: topK, n_windows_in_scope: n_candidates, n_blind_excluded, n_unplaced_excluded };
  if (n_candidates > SEARCH_MAX_WINDOWS) return { ok: false, error: "search_too_wide", max_windows: SEARCH_MAX_WINDOWS, ...base };

  // --- the candidate vectors (held-out pairs excluded in SQL)
  const cands = (await sql`
    SELECT d.window_id, rd.room_id, rd.ist_date::text AS ist_date, sp->>'idx' AS idx, sp->>'embedding_base64' AS b64
      FROM room_diarize_window d
      JOIN bench_window w ON w.id = d.window_id
      JOIN room_day rd ON rd.id = COALESCE(d.room_day_id, w.room_day_id),
      jsonb_array_elements(CASE WHEN jsonb_typeof(d.speakers_json) = 'array' THEN d.speakers_json ELSE '[]'::jsonb END) sp
     WHERE d.state = 'ok' AND rd.room_id = ANY(${scope.rooms}::text[]) AND rd.ist_date BETWEEN ${scope.from}::date AND ${scope.to}::date
       AND NOT EXISTS (SELECT 1 FROM room_day r1, unnest(${DAYS}::date[], ${ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (d.room_day_id, w.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
       AND sp->>'embedding_base64' IS NOT NULL
     ORDER BY d.window_id, sp->>'idx'
  `) as Cand[];

  let n_speakers_compared = 0, n_bad_dim = 0;
  const scored: Array<{ window_id: string; room_id: string; ist_date: string; speaker_idx: number; cosine: number }> = [];
  for (const c of cands) {
    if (qWin !== null && c.window_id === qWin && c.idx === qIdx) continue; // the query's own speaker
    if (typeof c.b64 !== "string" || Buffer.from(c.b64, "base64").length !== EMBEDDING_BYTES) { n_bad_dim++; continue; }
    const cos = cosineSimilarity(qB64, c.b64);
    if (cos === null) { n_bad_dim++; continue; }
    n_speakers_compared++;
    if (cos >= minCos) scored.push({ window_id: c.window_id, room_id: c.room_id, ist_date: c.ist_date, speaker_idx: Number(c.idx), cosine: Math.round(cos * 1000) / 1000 });
  }
  scored.sort((x, y) => y.cosine - x.cosine || (x.window_id < y.window_id ? -1 : x.window_id > y.window_id ? 1 : x.speaker_idx - y.speaker_idx));
  const top = scored.slice(0, topK);

  // --- the clinician a hit's speaker matched in that window (room_turn_speaker), for the hits only
  const matched = new Map<string, string>();
  if (top.length > 0) {
    const wids = [...new Set(top.map((h) => h.window_id))];
    const rows = (await sql`
      SELECT window_id, speaker_idx, clinician_id
        FROM room_turn_speaker
       WHERE window_id = ANY(${wids}::text[]) AND role = 'clinician' AND clinician_id IS NOT NULL
       GROUP BY window_id, speaker_idx, clinician_id
    `) as Array<{ window_id: string; speaker_idx: number; clinician_id: string }>;
    for (const r of rows) matched.set(`${r.window_id}\u0000${r.speaker_idx}`, r.clinician_id);
  }
  return {
    ok: true,
    ...base,
    query: { kind: hasWin ? "window_speaker" : "clinician" },
    n_windows_scanned: new Set(cands.map((c) => c.window_id)).size,
    n_speakers_compared,
    n_bad_dim,
    hits: top.map((h) => ({ ...h, clinician_id: matched.get(`${h.window_id}\u0000${h.speaker_idx}`) ?? null })),
  };
}
