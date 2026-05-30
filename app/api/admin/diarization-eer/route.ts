/**
 * /api/admin/diarization-eer  (V2.SD.6 — EER measurement harness)
 *  GET  → diarized encounters with a clinician auto-match + per-encounter label
 *         + aggregate stats + EER (once enough labels exist).
 *  POST → upsert a ground-truth label {encounter_id, speaker_idx, is_correct}.
 *
 * EER needs labeled genuine (correct) + impostor (incorrect) confidence sets;
 * until ~5+ of each exist it reports null and shows how many more are needed.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Speaker = { idx: number; label?: string; type?: string; source?: string; confidence?: number; clinician_id?: string };

function computeEER(genuine: number[], impostor: number[]): { eer: number; threshold: number } | null {
  if (genuine.length < 3 || impostor.length < 3) return null;
  const cands = Array.from(new Set([...genuine, ...impostor])).sort((a, b) => a - b);
  let best: { d: number; eer: number; threshold: number } | null = null;
  for (const t of cands) {
    const frr = genuine.filter((s) => s < t).length / genuine.length;
    const far = impostor.filter((s) => s >= t).length / impostor.length;
    const d = Math.abs(frr - far);
    if (!best || d < best.d) best = { d, eer: (frr + far) / 2, threshold: t };
  }
  return best ? { eer: best.eer, threshold: best.threshold } : null;
}

async function guard(): Promise<{ ok: true; adminId: string } | { ok: false }> {
  const c = await readAdminCookie();
  if (!c) return { ok: false };
  try { const cl = await verifyAdminJwt(c); return { ok: true, adminId: String(cl.admin_id ?? "") }; } catch { return { ok: false }; }
}

export async function GET() {
  const g = await guard(); if (!g.ok) return respondError("AUTH_REQUIRED", "x");

  const totalRow = (await sql`SELECT COUNT(*)::int AS n FROM encounter WHERE diarize_status = 'complete'`) as Array<{ n: number }>;
  const rows = (await sql`
    SELECT id, patient_label_raw, recorded_at::text AS recorded_at, speakers
      FROM encounter
     WHERE diarize_status = 'complete' AND speakers IS NOT NULL
       AND speakers @> '[{"source":"auto"}]'::jsonb
     ORDER BY recorded_at DESC LIMIT 200
  `) as Array<{ id: string; patient_label_raw: string | null; recorded_at: string; speakers: Speaker[] }>;
  const labels = (await sql`SELECT encounter_id, speaker_idx, is_correct, matched_confidence FROM identification_label`) as Array<{ encounter_id: string; speaker_idx: number; is_correct: boolean; matched_confidence: number | null }>;
  const labelMap = new Map(labels.map((l) => [`${l.encounter_id}:${l.speaker_idx}`, l]));

  const items = rows.map((r) => {
    const auto = (Array.isArray(r.speakers) ? r.speakers : []).find((s) => s.source === "auto");
    const lab = auto ? labelMap.get(`${r.id}:${auto.idx}`) : undefined;
    return {
      encounter_id: r.id,
      patient: r.patient_label_raw,
      recorded_at: r.recorded_at,
      speaker_idx: auto?.idx ?? null,
      name: auto?.label ?? null,
      confidence: auto?.confidence ?? null,
      label: lab ? (lab.is_correct ? "correct" : "incorrect") : null,
    };
  });

  const confs = items.map((i) => i.confidence).filter((c): c is number => typeof c === "number");
  const genuine = labels.filter((l) => l.is_correct && l.matched_confidence != null).map((l) => Number(l.matched_confidence));
  const impostor = labels.filter((l) => !l.is_correct && l.matched_confidence != null).map((l) => Number(l.matched_confidence));
  const eer = computeEER(genuine, impostor);

  return respondOk({
    items,
    stats: {
      total_diarized: totalRow[0]?.n ?? 0,
      clinician_matched: items.length,
      avg_confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
      min_confidence: confs.length ? Math.min(...confs) : null,
      labeled_correct: genuine.length,
      labeled_incorrect: impostor.length,
      eer: eer?.eer ?? null,
      eer_threshold: eer?.threshold ?? null,
      labels_needed: eer ? 0 : Math.max(0, 3 - genuine.length) + Math.max(0, 3 - impostor.length),
    },
  });
}

export async function POST(req: NextRequest) {
  const g = await guard(); if (!g.ok) return respondError("AUTH_REQUIRED", "x");
  let body: { encounter_id?: string; speaker_idx?: number; is_correct?: boolean };
  try { body = await req.json(); } catch { return respondError("VALIDATION_FAILED", "bad_json"); }
  if (!body.encounter_id || typeof body.speaker_idx !== "number" || typeof body.is_correct !== "boolean") {
    return respondError("VALIDATION_FAILED", "encounter_id, speaker_idx, is_correct required");
  }
  // pull the matched confidence + doctor from the encounter speakers
  const er = (await sql`SELECT doctor_id, speakers FROM encounter WHERE id = ${body.encounter_id} LIMIT 1`) as Array<{ doctor_id: string; speakers: Speaker[] }>;
  if (!er[0]) return respondError("NOT_FOUND", "no encounter");
  const sp = (Array.isArray(er[0].speakers) ? er[0].speakers : []).find((s) => s.idx === body.speaker_idx);
  const conf = typeof sp?.confidence === "number" ? sp.confidence : null;
  const id = `ilbl_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await sql`
    INSERT INTO identification_label (id, encounter_id, doctor_id, speaker_idx, is_correct, matched_confidence, labeled_by)
    VALUES (${id}, ${body.encounter_id}, ${er[0].doctor_id}, ${body.speaker_idx}, ${body.is_correct}, ${conf}, ${g.adminId || null})
    ON CONFLICT (encounter_id, speaker_idx) DO UPDATE SET
      is_correct = EXCLUDED.is_correct, matched_confidence = EXCLUDED.matched_confidence,
      labeled_by = EXCLUDED.labeled_by, labeled_at = NOW()
  `;
  return respondOk({ ok: true });
}
