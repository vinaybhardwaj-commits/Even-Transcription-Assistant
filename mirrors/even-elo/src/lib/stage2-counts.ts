import { sql } from "@/lib/db";
import type { EloCounts, Stage2DbCounts } from "@/lib/overview-modules";
import { emptyAdherenceInputs, type AdherenceInputs } from "@/lib/adherence-stage4";

interface CountRow {
  physicians_active: number;
  physicians_roster: number;
  engagements_active: number;
  positions_active: number;
  feedback_total: number;
  feedback_positive: number;
  feedback_open_negative: number;
  physicians_with_feedback: number;
  elo_vcs: number;
  elo_cases: number;
  elo_snapshots: number;
  elo_observation_cases: number;
  opd_last_day: string | null;
  opd_age_days: number | null;
  document_audits: number | null;
  document_audit_open: number | null;
  audit_finding_count: number | null;
  remediated_count: number | null;
  open_pressure_count: number | null;
  surgical_feedback_count: number | null;
  snapshot_percent: number | null;
}

function asElo(row: CountRow): EloCounts {
  return {
    vcs: row.elo_vcs,
    cases: row.elo_cases,
    snapshots: row.elo_snapshots,
    observationCases: row.elo_observation_cases,
  };
}

function asAdherence(row: CountRow): AdherenceInputs {
  return {
    auditFindingCount: Number(row.audit_finding_count ?? 0) || 0,
    remediatedCount: Number(row.remediated_count ?? 0) || 0,
    openPressureCount: Number(row.open_pressure_count ?? 0) || 0,
    surgicalFeedbackCount: Number(row.surgical_feedback_count ?? 0) || 0,
    snapshotPercent:
      row.snapshot_percent === null || row.snapshot_percent === undefined
        ? null
        : Number(row.snapshot_percent),
  };
}

/**
 * Live Overview / Surgical ELO counts. Returns null when the database cannot
 * be read so callers omit volumes instead of substituting zeros.
 */
export async function loadStage2Counts(): Promise<Stage2DbCounts | null> {
  try {
    const rows = (await sql`
      SELECT
        (SELECT count(*)::int FROM physicians WHERE current_status = 'active') AS physicians_active,
        (SELECT count(*)::int FROM physicians) AS physicians_roster,
        (SELECT count(*)::int FROM physician_engagements WHERE status = 'active') AS engagements_active,
        (SELECT count(*)::int FROM positions WHERE active = true) AS positions_active,
        (SELECT count(*)::int FROM incidents) AS feedback_total,
        (SELECT count(*)::int FROM incidents WHERE polarity = 'positive') AS feedback_positive,
        (SELECT count(*)::int FROM incidents WHERE status = 'open' AND polarity = 'negative') AS feedback_open_negative,
        (SELECT count(DISTINCT target_physician_id)::int FROM incidents) AS physicians_with_feedback,
        (SELECT count(*)::int FROM vcs) AS elo_vcs,
        (SELECT count(*)::int FROM surgical_cases) AS elo_cases,
        (SELECT count(*)::int FROM score_snapshots) AS elo_snapshots,
        (SELECT count(*)::int FROM vc_observation_cases) AS elo_observation_cases,
        (SELECT max(day)::text FROM gov_signal_snapshots WHERE source = 'cdmss_opd') AS opd_last_day,
        (SELECT (current_date - max(day))::int FROM gov_signal_snapshots WHERE source = 'cdmss_opd') AS opd_age_days,
        (SELECT count(*)::int FROM document_audits) AS document_audits,
        (SELECT count(*)::int FROM document_audit_findings
          WHERE status IN ('open','in_progress','contested','escalated')) AS document_audit_open,
        (SELECT count(*)::int FROM document_audit_findings) AS audit_finding_count,
        (SELECT count(*)::int FROM document_audit_findings WHERE status = 'remediated') AS remediated_count,
        (SELECT count(*)::int FROM document_audit_findings
          WHERE status IN ('open','in_progress','contested','escalated')) AS open_pressure_count,
        (SELECT count(*)::int FROM case_observations co
          JOIN streams s ON s.id = co.stream_id
          WHERE s.component = 'adherence') AS surgical_feedback_count,
        (SELECT avg(adherence_score)::float FROM score_snapshots
          WHERE adherence_score IS NOT NULL) AS snapshot_percent
    `) as unknown as CountRow[];
    const row = rows[0];
    if (!row) return null;
    return {
      physiciansActive: row.physicians_active,
      physiciansRoster: row.physicians_roster,
      engagementsActive: row.engagements_active,
      positionsActive: row.positions_active,
      feedbackTotal: row.feedback_total,
      feedbackPositive: row.feedback_positive,
      feedbackOpenNegative: row.feedback_open_negative,
      physiciansWithFeedback: row.physicians_with_feedback,
      elo: asElo(row),
      opdLastDay: row.opd_last_day,
      opdAgeDays: row.opd_age_days,
      documentAudits: row.document_audits,
      documentAuditOpenFindings: row.document_audit_open,
      adherence: asAdherence(row),
    };
  } catch {
    // Stage 4 tables may not be migrated yet — retry without them so Overview still loads.
    try {
      const rows = (await sql`
        SELECT
          (SELECT count(*)::int FROM physicians WHERE current_status = 'active') AS physicians_active,
          (SELECT count(*)::int FROM physicians) AS physicians_roster,
          (SELECT count(*)::int FROM physician_engagements WHERE status = 'active') AS engagements_active,
          (SELECT count(*)::int FROM positions WHERE active = true) AS positions_active,
          (SELECT count(*)::int FROM incidents) AS feedback_total,
          (SELECT count(*)::int FROM incidents WHERE polarity = 'positive') AS feedback_positive,
          (SELECT count(*)::int FROM incidents WHERE status = 'open' AND polarity = 'negative') AS feedback_open_negative,
          (SELECT count(DISTINCT target_physician_id)::int FROM incidents) AS physicians_with_feedback,
          (SELECT count(*)::int FROM vcs) AS elo_vcs,
          (SELECT count(*)::int FROM surgical_cases) AS elo_cases,
          (SELECT count(*)::int FROM score_snapshots) AS elo_snapshots,
          (SELECT count(*)::int FROM vc_observation_cases) AS elo_observation_cases,
          (SELECT max(day)::text FROM gov_signal_snapshots WHERE source = 'cdmss_opd') AS opd_last_day,
          (SELECT (current_date - max(day))::int FROM gov_signal_snapshots WHERE source = 'cdmss_opd') AS opd_age_days
      `) as unknown as CountRow[];
      const row = rows[0];
      if (!row) return null;
      return {
        physiciansActive: row.physicians_active,
        physiciansRoster: row.physicians_roster,
        engagementsActive: row.engagements_active,
        positionsActive: row.positions_active,
        feedbackTotal: row.feedback_total,
        feedbackPositive: row.feedback_positive,
        feedbackOpenNegative: row.feedback_open_negative,
        physiciansWithFeedback: row.physicians_with_feedback,
        elo: asElo(row),
        opdLastDay: row.opd_last_day,
        opdAgeDays: row.opd_age_days,
        documentAudits: 0,
        documentAuditOpenFindings: 0,
        adherence: emptyAdherenceInputs(),
      };
    } catch {
      return null;
    }
  }
}

export async function loadEloCounts(): Promise<EloCounts | null> {
  const all = await loadStage2Counts();
  return all ? all.elo : null;
}
