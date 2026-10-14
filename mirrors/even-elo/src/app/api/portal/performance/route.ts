import { portalJson } from "@/lib/portal/forbidden-keys";
import { neon } from "@neondatabase/serverless";
import { getCurrentPhysician } from "@/lib/physician-auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/portal/performance — the logged-in physician's own weekly clinical
 * metrics, read from the local doctor_perf_weekly snapshot (a weekly copy of
 * Metabase's mv_doctor_weekly_performance). Scoped strictly to this physician
 * via their mapped metabase_doctor_email. No live Metabase connection needed.
 */
export async function GET() {
  const me = await getCurrentPhysician();
  if (!me) return portalJson({ ok: false, error: "Unauthenticated" }, { status: 401, headers: NO_STORE });
  const url = process.env.DATABASE_URL;
  if (!url) return portalJson({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  const phys = (await sql`SELECT metabase_doctor_email AS mb FROM physicians WHERE id = ${me.physicianId}::uuid`) as Array<{ mb: string | null }>;
  const mb = phys[0]?.mb ?? null;
  if (!mb) return portalJson({ ok: true, mapped: false, rows: [], snapshot_at: null }, { headers: NO_STORE });

  const rows = (await sql`
    SELECT week, doctor_specialty, doctor_channel_type, total_consults, csat_pct, csat_responses, positive_csat_count,
           doctor_noshow_tc_rate, patient_noshow_rate, cancellation_rate, doctor_cancellation_rate,
           missing_prescription_rate, presc_under_30_pct, inperson_consult_count, tc_active_event_count,
           tc_events_missing_recording_count, unwritten_count, completed_presc_count, cancelled_count, patient_noshow_count
    FROM doctor_perf_weekly
    WHERE lower(doctor_email) = lower(${mb})
    ORDER BY week ASC
  `) as Array<Record<string, unknown>>;

  const snap = (await sql`SELECT max(snapshot_at) AS s FROM doctor_perf_weekly`) as Array<{ s: string | null }>;
  return portalJson({ ok: true, mapped: true, doctor_email: mb, rows, snapshot_at: snap[0]?.s ?? null }, { headers: NO_STORE });
}
