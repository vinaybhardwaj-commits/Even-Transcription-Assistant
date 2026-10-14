import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { getSeries, latestSnapshot, signalKey } from "@/lib/gov-signals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Per-physician OPD signal appearances (PRD §6.5 — profile Signals section).
 * Reconstructed from the snapshot store's affected[] lists (top-5 cap per
 * signal per day, so this remains partial). The CDMSS per-doctor endpoint HAS
 * now shipped and is read by /api/portal/findings — but it answers a different
 * question (findings routed to a doctor) from this one (a doctor's appearances
 * in cohort signals), so it does not supersede this route. Advisory framing is
 * mandatory at render.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const u = await getCurrentUser();
  if (!u || u.status !== "active") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const rows = (await sql`
    SELECT cdmss_doctor_uid FROM physicians WHERE id=${params.id}::uuid`) as unknown as Array<{
    cdmss_doctor_uid: string | null;
  }>;
  const uid = rows[0]?.cdmss_doctor_uid;
  if (!uid) return NextResponse.json({ ok: true, mapped: false, appearances: [] });

  const series = await getSeries(90);
  const latest = latestSnapshot(series);
  const appearances: Array<{
    day: string;
    signal: string;
    label: string;
    severity: string;
    doctor_value: number | null;
    n: number;
    cohort_value: number | null;
    unit: string;
  }> = [];
  for (const row of series) {
    for (const s of row.payload.report?.signals ?? []) {
      const hit = (s.affected ?? []).find((a) => a.uid === uid);
      if (hit) {
        appearances.push({
          day: row.day,
          signal: signalKey(s),
          label: s.label,
          severity: s.severity,
          doctor_value: hit.mean ?? hit.value ?? null,
          n: hit.n,
          cohort_value: s.mean ?? s.value ?? null,
          unit: s.kind === "domain" ? s.unit ?? "" : "/5",
        });
      }
    }
  }
  appearances.sort((a, b) => (a.day < b.day ? 1 : -1));
  const interventions = (await sql`
    SELECT i.signal_key, i.signal_label, i.kind, i.note, i.done_on::text AS done_on, i.actor_email
    FROM gov_interventions i WHERE i.physician_id=${params.id}::uuid
    ORDER BY i.done_on DESC LIMIT 20`) as unknown as Array<Record<string, unknown>>;
  return NextResponse.json({
    ok: true,
    mapped: true,
    uid,
    latest_day: latest?.day ?? null,
    appearances: appearances.slice(0, 60),
    interventions,
  });
}
