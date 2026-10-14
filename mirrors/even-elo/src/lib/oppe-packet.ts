import type { NeonQueryFunction } from "@neondatabase/serverless";

/**
 * Aggregate the OPPE packet for a single (physician × hospital × period).
 *
 * Per PRD §C.6: clinical_metrics_monthly + incidents (open + retracted) +
 * incident-derived feedback, all scoped to the period_start → period_end window.
 *
 * The snapshot is frozen at OPPE creation time so a doctor can't game it by
 * delaying review.
 */
export async function buildOppePacket(
  sql: NeonQueryFunction<false, false>,
  physicianId: string,
  hospitalId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Record<string, unknown>> {
  const metricRows = (await sql`
    SELECT year, month, opd_count, ipd_admissions, ot_cases, revenue_inr
    FROM clinical_metrics_monthly
    WHERE physician_id = ${physicianId}::uuid
      AND hospital_id = ${hospitalId}::uuid
      AND (year * 100 + month) >=
          (EXTRACT(YEAR FROM ${periodStart}::date)::int * 100 + EXTRACT(MONTH FROM ${periodStart}::date)::int)
      AND (year * 100 + month) <=
          (EXTRACT(YEAR FROM ${periodEnd}::date)::int * 100 + EXTRACT(MONTH FROM ${periodEnd}::date)::int)
    ORDER BY year, month
  `) as Array<Record<string, unknown>>;

  const incidentRows = (await sql`
    SELECT
      id::text AS id,
      category,
      severity,
      polarity,
      source,
      commendation_category,
      patient_rating,
      status,
      submitted_at,
      anonymous_flag,
      retracted_at
    FROM incidents
    WHERE target_physician_id = ${physicianId}::uuid
      AND hospital_id = ${hospitalId}::uuid
      AND submitted_at >= ${periodStart}::date
      AND submitted_at <= ${periodEnd}::date + INTERVAL '1 day'
    ORDER BY submitted_at DESC
  `) as Array<Record<string, unknown>>;

  type Totals = { opd: number; ipd: number; ot: number; revenue: number };
  const totals: Totals = metricRows.reduce<Totals>(
    (acc: Totals, m) => {
      acc.opd += Number(m.opd_count ?? 0);
      acc.ipd += Number(m.ipd_admissions ?? 0);
      acc.ot += Number(m.ot_cases ?? 0);
      acc.revenue += Number(m.revenue_inr ?? 0);
      return acc;
    },
    { opd: 0, ipd: 0, ot: 0, revenue: 0 },
  );

  const openIncidents = incidentRows.filter((r) => r.status === "open").length;
  const retractedIncidents = incidentRows.filter((r) => r.status === "retracted").length;

  // Feedback PRD #14 — unified feedback summary derived from incidents (polarity x source + avg patient rating).
  const live = incidentRows.filter((r) => r.status !== "retracted");
  const positive = live.filter((r) => r.polarity === "positive").length;
  const negative = live.filter((r) => r.polarity === "negative").length;
  const bySource = (src: string) => ({
    positive: live.filter((r) => r.source === src && r.polarity === "positive").length,
    negative: live.filter((r) => r.source === src && r.polarity === "negative").length,
  });
  const ratings = live
    .filter((r) => r.source === "patient" && r.patient_rating != null)
    .map((r) => Number(r.patient_rating));
  const avgPatientRating = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;

  return {
    snapshot_at: new Date().toISOString(),
    period_start: periodStart,
    period_end: periodEnd,
    clinical_metrics_monthly: metricRows,
    incidents: incidentRows,
    feedback_summary: {
      positive,
      negative,
      by_source: { patient: bySource("patient"), peer: bySource("peer"), governance: bySource("governance") },
      avg_patient_rating: avgPatientRating,
      patient_rating_n: ratings.length,
    },
    summary: {
      months_covered: metricRows.length,
      totals,
      incidents_total: incidentRows.length,
      open_incidents: openIncidents,
      retracted_incidents: retractedIncidents,
      positive_feedback: positive,
      negative_feedback: negative,
    },
  };
}
