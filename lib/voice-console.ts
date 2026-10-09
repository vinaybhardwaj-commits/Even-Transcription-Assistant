/**
 * lib/voice-console.ts — S6A: the voice centroid CONSOLE (read only). Doctors only.
 *
 * Reads what exists today with NO new writes: voice_print, voice_sample, voice_print_generation, voice_centroid (rows and counts only), room_turn_speaker (who matched, who lost).
 * NOTHING BIOMETRIC LEAVES THIS MODULE: no centroid, no embedding, no samples_json, no base64, no audio key or URL. The only vectors touched are the active voice_print centroids for the
 * `pairs` view, compared in memory by cosineSimilarity (lib/enroll.ts, raw vectors) and dropped; the answer carries the cosine to 3 dp.
 * HELD-OUT ROOM-DAYS: every room_turn_speaker aggregate joins turn -> bench_window -> room_day (the placement) and excludes a turn when ANY of its placements is a held-out (room, IST date) pair IN SQL: its own rts.room_day_id, its bench_window.room_day_id or its room_diarize_window.room_day_id (B2, REL2-R3); counted as n_blind_excluded. A turn
 * whose window has no room-day cannot be placed, so it is excluded too (fail closed) and counted as n_unplaced_excluded.
 * last_matched_at is the CREATED time of the newest role='clinician' turn row (room_turn_speaker has no separate matched-at column): INFERRED proxy, labelled so in the answer.
 */
import { sql } from "@/lib/db";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";
import { cosineSimilarity } from "@/lib/enroll";
import { DIARIZE_BATCH_THRESHOLD } from "@/lib/stt/diarize-window";

export const PAIRS_COSINE_FLOOR = 0.5;
export const PAIRS_COSINE_DEFAULT = DIARIZE_BATCH_THRESHOLD;
export const CLINICIAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAYS = BLIND_ROOM_DAYS.map(([d]) => d);
const ROOMS = BLIND_ROOM_DAYS.map(([, r]) => r);
const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const r3 = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 1000) / 1000);
const num = (v: unknown): number => Number(v ?? 0);

type Row = Record<string, unknown>;

/** Counts of room_turn_speaker rows kept out of every aggregate: held-out pairs and turns whose window has no room-day. */
async function excluded(): Promise<{ n_blind_excluded: number; n_unplaced_excluded: number }> {
  const b = (await sql`
    SELECT count(*)::int AS n FROM room_turn_speaker rts
      JOIN bench_window w ON w.id = rts.window_id JOIN room_day rd ON rd.id = w.room_day_id LEFT JOIN room_diarize_window dw ON dw.window_id = rts.window_id
     WHERE (rts.role = 'clinician' OR rts.losing_clinician_id IS NOT NULL)
       AND EXISTS (SELECT 1 FROM room_day r1, unnest(${DAYS}::date[], ${ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (rts.room_day_id, w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
  `) as Array<{ n: number }>;
  const u = (await sql`
    SELECT count(*)::int AS n FROM room_turn_speaker rts
      LEFT JOIN bench_window w ON w.id = rts.window_id LEFT JOIN room_day rd ON rd.id = w.room_day_id LEFT JOIN room_diarize_window dw ON dw.window_id = rts.window_id
     WHERE (rts.role = 'clinician' OR rts.losing_clinician_id IS NOT NULL) AND rd.id IS NULL
       AND NOT EXISTS (SELECT 1 FROM room_day r1, unnest(${DAYS}::date[], ${ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (rts.room_day_id, w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
  `) as Array<{ n: number }>;
  return { n_blind_excluded: num(b[0]?.n), n_unplaced_excluded: num(u[0]?.n) };
}

async function samplesBy(): Promise<Map<string, Row>> {
  const rows = (await sql`
    SELECT clinician_id,
           count(*) FILTER (WHERE source = 'enrollment')::int AS enrollment,
           count(*) FILTER (WHERE source = 'enrollment' AND included)::int AS enrollment_included,
           count(*) FILTER (WHERE source = 'passive')::int AS passive,
           count(*) FILTER (WHERE source = 'passive' AND included)::int AS passive_included,
           percentile_cont(0.1) WITHIN GROUP (ORDER BY match_confidence) FILTER (WHERE source = 'passive' AND match_confidence IS NOT NULL) AS p10,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY match_confidence) FILTER (WHERE source = 'passive' AND match_confidence IS NOT NULL) AS p50,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY match_confidence) FILTER (WHERE source = 'passive' AND match_confidence IS NOT NULL) AS p90
      FROM voice_sample GROUP BY clinician_id
  `) as Row[];
  return new Map(rows.map((r) => [String(r.clinician_id), r]));
}
async function generationsBy(): Promise<Map<string, Row>> {
  const rows = (await sql`
    SELECT clinician_id, count(*)::int AS n, max(generation)::int AS latest_generation, (array_agg(origin ORDER BY generation DESC))[1] AS latest_origin
      FROM voice_print_generation GROUP BY clinician_id
  `) as Row[];
  return new Map(rows.map((r) => [String(r.clinician_id), r]));
}
async function centroidsBy(): Promise<Map<string, Row[]>> {
  const rows = (await sql`
    SELECT clinician_id, domain, count(*) FILTER (WHERE retired_at IS NULL)::int AS active, count(*) FILTER (WHERE retired_at IS NOT NULL)::int AS retired
      FROM voice_centroid GROUP BY clinician_id, domain ORDER BY clinician_id, domain
  `) as Row[];
  const m = new Map<string, Row[]>();
  for (const r of rows) (m.get(String(r.clinician_id)) ?? m.set(String(r.clinician_id), []).get(String(r.clinician_id))!).push({ domain: r.domain, active: num(r.active), retired: num(r.retired) });
  return m;
}
async function matchedBy(): Promise<Map<string, Row>> {
  const rows = (await sql`
    SELECT rts.clinician_id, max(rts.created_at) AS last_matched_at, count(*) FILTER (WHERE rts.created_at >= now() - interval '30 days')::int AS n_matched_30d
      FROM room_turn_speaker rts
      JOIN bench_window w ON w.id = rts.window_id JOIN room_day rd ON rd.id = w.room_day_id LEFT JOIN room_diarize_window dw ON dw.window_id = rts.window_id
     WHERE rts.role = 'clinician' AND rts.clinician_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM room_day r1, unnest(${DAYS}::date[], ${ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (rts.room_day_id, w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
     GROUP BY rts.clinician_id
  `) as Row[];
  return new Map(rows.map((r) => [String(r.clinician_id), r]));
}
async function lostBy(): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT rts.losing_clinician_id AS clinician_id, count(*) FILTER (WHERE rts.created_at >= now() - interval '30 days')::int AS n_lost_30d
      FROM room_turn_speaker rts
      JOIN bench_window w ON w.id = rts.window_id JOIN room_day rd ON rd.id = w.room_day_id LEFT JOIN room_diarize_window dw ON dw.window_id = rts.window_id
     WHERE rts.losing_clinician_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM room_day r1, unnest(${DAYS}::date[], ${ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (rts.room_day_id, w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
     GROUP BY rts.losing_clinician_id
  `) as Row[];
  return new Map(rows.map((r) => [String(r.clinician_id), num(r.n_lost_30d)]));
}

async function printRows(only?: string): Promise<Row[]> {
  const id = only ?? null;
  return (await sql`
    SELECT vp.doctor_id AS clinician_id, vp.sample_count, vp.enrolled_at, vp.last_sample_at, vp.needs_reenrollment, (vp.centroid IS NOT NULL) AS has_centroid,
           c.status::text AS clinician_status, (c.deleted_at IS NOT NULL) AS deleted,
           (c.id IS NOT NULL AND c.status = 'active' AND c.deleted_at IS NULL AND vp.centroid IS NOT NULL) AS matchable
      FROM voice_print vp LEFT JOIN clinician c ON c.id = vp.doctor_id
     WHERE (${id}::text IS NULL OR vp.doctor_id = ${id}::text)
     ORDER BY vp.doctor_id
  `) as Row[];
}

function shape(vp: Row, s: Row | undefined, g: Row | undefined, c: Row[] | undefined, m: Row | undefined, lost: number | undefined): Record<string, unknown> {
  return {
    clinician_id: String(vp.clinician_id),
    clinician_status: vp.clinician_status ?? null, deleted: vp.deleted === true, matchable: vp.matchable === true, has_centroid: vp.has_centroid === true,
    sample_count: num(vp.sample_count), enrolled_at: iso(vp.enrolled_at), last_sample_at: iso(vp.last_sample_at), needs_reenrollment: vp.needs_reenrollment === true,
    samples: { enrollment: num(s?.enrollment), enrollment_included: num(s?.enrollment_included), passive: num(s?.passive), passive_included: num(s?.passive_included) },
    passive_match_confidence: { p10: r3(s?.p10), p50: r3(s?.p50), p90: r3(s?.p90) },
    generations: { count: num(g?.n), latest_generation: g?.latest_generation == null ? null : num(g.latest_generation), latest_origin: (g?.latest_origin as string | undefined) ?? null },
    centroids: c ?? [],
    last_matched_at: iso(m?.last_matched_at), n_matched_30d: num(m?.n_matched_30d), n_lost_30d: lost ?? 0,
  };
}

export async function consoleOverview(): Promise<Record<string, unknown>> {
  const [vps, s, g, c, m, lost, ex] = await Promise.all([printRows(), samplesBy(), generationsBy(), centroidsBy(), matchedBy(), lostBy(), excluded()]);
  return {
    view: "overview", clinicians: vps.map((v) => shape(v, s.get(String(v.clinician_id)), g.get(String(v.clinician_id)), c.get(String(v.clinician_id)), m.get(String(v.clinician_id)), lost.get(String(v.clinician_id)))),
    summary: { total: vps.length, matchable: vps.filter((v) => v.matchable === true).length }, ...ex,
    notes: { last_matched_at: "created time of the newest role=clinician turn row (INFERRED: room_turn_speaker has no matched-at column)", window: "30 days by created time", held_out: "held-out room-days and turns with no room-day are excluded from the match counts" },
  };
}

/** Numeric leaves of a provenance object only (counts and seconds): ids and strings are dropped. */
function countsOnly(p: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (p && typeof p === "object" && !Array.isArray(p)) for (const [k, v] of Object.entries(p as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
}

export async function consoleClinician(clinicianId: string): Promise<Record<string, unknown>> {
  if (!CLINICIAN_ID_RE.test(clinicianId)) return { ok: false, error: "bad_clinician_id" };
  const vps = await printRows(clinicianId);
  if (vps.length === 0) return { ok: false, error: "no_voiceprint" };
  const [s, g, c, m, lost, ex] = await Promise.all([samplesBy(), generationsBy(), centroidsBy(), matchedBy(), lostBy(), excluded()]);
  const gens = (await sql`
    SELECT generation, origin, sample_count, provenance_json, created_at FROM voice_print_generation WHERE clinician_id = ${clinicianId}::text ORDER BY generation
  `) as Row[];
  const cents = (await sql`
    SELECT domain, generation, embedding_model, embedding_dim, n_samples, created_at, retired_at, retired_by, retired_reason
      FROM voice_centroid WHERE clinician_id = ${clinicianId}::text ORDER BY domain, embedding_model, generation
  `) as Row[];
  const series = (await sql`
    SELECT rd.ist_date::text AS day, count(*)::int AS n_matched, percentile_cont(0.5) WITHIN GROUP (ORDER BY rts.match_confidence) AS p50
      FROM room_turn_speaker rts
      JOIN bench_window w ON w.id = rts.window_id JOIN room_day rd ON rd.id = w.room_day_id LEFT JOIN room_diarize_window dw ON dw.window_id = rts.window_id
     WHERE rts.role = 'clinician' AND rts.clinician_id = ${clinicianId}::text AND rd.ist_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 29
       AND NOT EXISTS (SELECT 1 FROM room_day r1, unnest(${DAYS}::date[], ${ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (rts.room_day_id, w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
     GROUP BY rd.ist_date ORDER BY rd.ist_date
  `) as Row[];
  return {
    view: "clinician", ...shape(vps[0]!, s.get(clinicianId), g.get(clinicianId), c.get(clinicianId), m.get(clinicianId), lost.get(clinicianId)),
    generation_history: gens.map((x) => ({ generation: num(x.generation), origin: x.origin, sample_count: num(x.sample_count), provenance_counts: countsOnly(x.provenance_json), created_at: iso(x.created_at) })),
    voice_centroids: cents.map((x) => ({ domain: x.domain, generation: num(x.generation), embedding_model: x.embedding_model, embedding_dim: num(x.embedding_dim), n_samples: num(x.n_samples), created_at: iso(x.created_at), retired_at: iso(x.retired_at), retired_by: (x.retired_by as string | null) ?? null, retired_reason: (x.retired_reason as string | null) ?? null })),
    daily_30d: series.map((x) => ({ day: x.day, n_matched: num(x.n_matched), match_confidence_p50: r3(x.p50) })),
    ...ex,
  };
}

export async function consolePairs(minCosine?: number): Promise<Record<string, unknown>> {
  const floor = PAIRS_COSINE_FLOOR;
  const min = typeof minCosine === "number" && Number.isFinite(minCosine) ? Math.max(floor, Math.min(1, minCosine)) : PAIRS_COSINE_DEFAULT;
  const cents = (await sql`
    SELECT vp.doctor_id AS clinician_id, encode(vp.centroid, 'base64') AS b64
      FROM voice_print vp JOIN clinician c ON c.id = vp.doctor_id
     WHERE vp.centroid IS NOT NULL AND c.status = 'active' AND c.deleted_at IS NULL
     ORDER BY vp.doctor_id
  `) as Array<{ clinician_id: string; b64: string }>;
  const contested = (await sql`
    SELECT rts.clinician_id AS won, rts.losing_clinician_id AS lost, count(*)::int AS n
      FROM room_turn_speaker rts
      JOIN bench_window w ON w.id = rts.window_id JOIN room_day rd ON rd.id = w.room_day_id LEFT JOIN room_diarize_window dw ON dw.window_id = rts.window_id
     WHERE rts.role = 'clinician' AND rts.clinician_id IS NOT NULL AND rts.losing_clinician_id IS NOT NULL AND rts.created_at >= now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM room_day r1, unnest(${DAYS}::date[], ${ROOMS}::text[]) AS b(d, r) WHERE r1.id IN (rts.room_day_id, w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
     GROUP BY rts.clinician_id, rts.losing_clinician_id
  `) as Array<{ won: string; lost: string; n: number }>;
  const ex = await excluded();
  const won = new Map(contested.map((x) => [`${x.won}\u0000${x.lost}`, num(x.n)]));
  const pairs: Array<{ a: string; b: string; cosine: number; a_won_b_lost_30d: number; b_won_a_lost_30d: number; n_contested_30d: number }> = [];
  for (let i = 0; i < cents.length; i++) for (let j = i + 1; j < cents.length; j++) {
    const a = cents[i]!, b = cents[j]!;
    const c = cosineSimilarity(a.b64, b.b64);
    if (c === null || c < min) continue;
    const ab = won.get(`${a.clinician_id}\u0000${b.clinician_id}`) ?? 0, ba = won.get(`${b.clinician_id}\u0000${a.clinician_id}`) ?? 0;
    pairs.push({ a: a.clinician_id, b: b.clinician_id, cosine: Math.round(c * 1000) / 1000, a_won_b_lost_30d: ab, b_won_a_lost_30d: ba, n_contested_30d: ab + ba });
  }
  pairs.sort((x, y) => y.cosine - x.cosine || (x.a < y.a ? -1 : 1));
  return { view: "pairs", label: "near pairs", min_cosine: min, floor, default: PAIRS_COSINE_DEFAULT, n_active_prints: cents.length, pairs, ...ex };
}
