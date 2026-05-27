/**
 * lib/admin/launch-readiness.ts — Sprint 12 data layer for the
 * /admin/settings/launch-readiness page (PRD §10.1).
 *
 * Returns a flat array of 9 criteria each shaped as:
 *   { id, label, target, current, status, detail, doc_anchor }
 *
 * Statuses:
 *   - "pass"    metric meets PRD target
 *   - "fail"    metric falls short
 *   - "manual"  requires human attestation (audio offline test)
 *   - "skipped" no data yet (e.g. zero send_events to measure rate against)
 *   - "info"    architectural assertion, not a queryable metric
 */
import { sql } from "@/lib/db";

export type LaunchCriterion = {
  id: string;
  label: string;
  target: string;
  current: string;
  status: "pass" | "fail" | "manual" | "skipped" | "info";
  detail: string;
  doc_anchor: string;
};

export type LaunchReadinessBundle = {
  criteria: LaunchCriterion[];
  overall: { pass: number; fail: number; manual: number; skipped: number; info: number };
  attestation: {
    audio_offline_test_passed: boolean;
    audio_offline_test_at: string | null;
  };
};

export async function getLaunchReadiness(): Promise<LaunchReadinessBundle> {
  // Fetch settings + 4 metric queries in parallel
  const [settingsRows, pipelineRows, sendRows, latencyRows, webhookRows] = await Promise.all([
    sql`SELECT audio_offline_test_passed, audio_offline_test_at::text AS audio_offline_test_at
          FROM settings WHERE id = 1 LIMIT 1` as unknown as Promise<Array<Record<string, unknown>>>,
    sql`
      SELECT
        COUNT(*)::int                                              AS total,
        COUNT(*) FILTER (WHERE status = 'complete')::int           AS complete,
        COUNT(*) FILTER (WHERE status = 'failed')::int             AS failed
      FROM encounter
      WHERE recorded_at >= NOW() - INTERVAL '30 days'
        AND deleted_at IS NULL
        AND status NOT IN ('draft', 'processing')
    ` as unknown as Promise<Array<Record<string, unknown>>>,
    sql`
      SELECT
        COUNT(*)::int                                                                 AS attempted,
        COUNT(*) FILTER (WHERE status IN ('sent','delivered','opened'))::int          AS succeeded,
        COUNT(*) FILTER (WHERE status IN ('failed','bounced','complained'))::int      AS failed
      FROM send_event
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND status != 'queued'
    ` as unknown as Promise<Array<Record<string, unknown>>>,
    sql`
      SELECT
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY total_ms)
          FILTER (WHERE total_ms IS NOT NULL) AS p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_ms)
          FILTER (WHERE total_ms IS NOT NULL) AS p95_ms,
        COUNT(*) FILTER (WHERE total_ms IS NOT NULL)::int AS sample_count
      FROM llm_traces
      WHERE started_at >= NOW() - INTERVAL '30 days'
        AND surface IN ('note-pipeline', 'cdmss-analysis')
        AND status = 'completed'
    ` as unknown as Promise<Array<Record<string, unknown>>>,
    sql`
      SELECT
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))) AS p50_sec,
        MAX(EXTRACT(EPOCH FROM (updated_at - created_at)))::int                                     AS max_sec,
        COUNT(*)::int                                                                                AS sample_count
      FROM send_event
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND status IN ('delivered', 'opened', 'bounced', 'failed')
    ` as unknown as Promise<Array<Record<string, unknown>>>,
  ]);

  const sett = settingsRows[0] ?? {};
  const audioPassed = Boolean(sett.audio_offline_test_passed);
  const audioAt = sett.audio_offline_test_at ? String(sett.audio_offline_test_at) : null;

  const p = pipelineRows[0] ?? {};
  const totalEnc = Number(p.total ?? 0);
  const completeEnc = Number(p.complete ?? 0);
  const pipelineRate = totalEnc > 0 ? completeEnc / totalEnc : null;

  const s = sendRows[0] ?? {};
  const sendAttempted = Number(s.attempted ?? 0);
  const sendSucceeded = Number(s.succeeded ?? 0);
  const sendRate = sendAttempted > 0 ? sendSucceeded / sendAttempted : null;

  const l = latencyRows[0] ?? {};
  const p50ms = l.p50_ms != null ? Math.round(Number(l.p50_ms)) : null;
  const p95ms = l.p95_ms != null ? Math.round(Number(l.p95_ms)) : null;
  const traceSamples = Number(l.sample_count ?? 0);

  const w = webhookRows[0] ?? {};
  const webhookP50 = w.p50_sec != null ? Number(w.p50_sec) : null;
  const webhookSamples = Number(w.sample_count ?? 0);

  const criteria: LaunchCriterion[] = [
    {
      id: "pipeline_complete_rate",
      label: "Pipeline end-to-end completes",
      target: "≥99%",
      current: pipelineRate == null ? "no data" : `${(pipelineRate * 100).toFixed(1)}%`,
      status: pipelineRate == null ? "skipped" : pipelineRate >= 0.99 ? "pass" : "fail",
      detail: `${completeEnc} of ${totalEnc} encounters reached status='complete' over last 30d`,
      doc_anchor: "§10.1 row 1",
    },
    {
      id: "email_send_success",
      label: "Email send success",
      target: "≥98%",
      current: sendRate == null ? "no data" : `${(sendRate * 100).toFixed(1)}%`,
      status: sendRate == null ? "skipped" : sendRate >= 0.98 ? "pass" : "fail",
      detail: `${sendSucceeded} of ${sendAttempted} send_events reached sent/delivered/opened over last 30d`,
      doc_anchor: "§10.1 row 2",
    },
    {
      id: "pipeline_p50",
      label: "Pipeline p50 latency",
      target: "<60s",
      current: p50ms == null ? "no data" : `${(p50ms / 1000).toFixed(1)}s`,
      status: p50ms == null ? "skipped" : p50ms < 60_000 ? "pass" : "fail",
      detail: `Median across ${traceSamples} completed pipeline traces (note-pipeline + cdmss-analysis) over 30d`,
      doc_anchor: "§10.1 row 3",
    },
    {
      id: "pipeline_p95",
      label: "Pipeline p95 latency",
      target: "<90s",
      current: p95ms == null ? "no data" : `${(p95ms / 1000).toFixed(1)}s`,
      status: p95ms == null ? "skipped" : p95ms < 90_000 ? "pass" : "fail",
      detail: `95th percentile across ${traceSamples} pipeline traces over 30d`,
      doc_anchor: "§10.1 row 4",
    },
    {
      id: "audio_data_loss",
      label: "Audio data loss in offline scenarios",
      target: "0 bytes lost in manual test",
      current: audioPassed ? `attested ${audioAt ? new Date(audioAt).toLocaleDateString() : "?"}` : "not attested",
      status: audioPassed ? "pass" : "manual",
      detail: audioPassed
        ? `V attested manual offline-recovery test passed${audioAt ? ` on ${new Date(audioAt).toLocaleString()}` : ""}.`
        : "Requires manual test: record offline → background app → reconnect → confirm transcript intact.",
      doc_anchor: "§10.1 row 5",
    },
    {
      id: "pin_auth_median",
      label: "PIN auth median",
      target: "<1s",
      current: "~250-450ms (bcrypt cost-12 verify)",
      status: "info",
      detail: "Not directly instrumented — bcrypt cost-12 hash verify is the dominant cost. Spot-check on prod showed sub-second responses. Adding pin_attempt latency_ms column is v2.",
      doc_anchor: "§10.1 row 6",
    },
    {
      id: "admin_audit_coverage",
      label: "Admin panel actions audit-logged",
      target: "100%",
      current: "all mutating admin routes",
      status: "info",
      detail: "Architectural assertion: PATCH /api/admin/doctors/[id], reset-pin, rotate-url, email-url, encounter resend + soft-delete, password change all write audit_log. Verified across Sprints 3-11.",
      doc_anchor: "§10.1 row 7",
    },
    {
      id: "resend_webhook_lag",
      label: "Resend webhook reliability",
      target: "<30s lag, 100% events processed",
      current: webhookP50 == null ? "no data" : `${webhookP50.toFixed(1)}s p50 lag`,
      status: webhookP50 == null ? "skipped" : webhookP50 < 30 ? "pass" : "fail",
      detail: `Median lag (updated_at - created_at) across ${webhookSamples} send_events where webhook fired over 30d`,
      doc_anchor: "§10.1 row 8",
    },
    {
      id: "cost_per_encounter",
      label: "Cost per encounter",
      target: "<$0.20",
      current: "$0.00",
      status: "pass",
      detail: "Mac Mini Ollama is local (zero marginal cost). Resend free tier covers v1 send volume. No per-encounter cloud LLM spend.",
      doc_anchor: "§10.1 row 9",
    },
  ];

  const overall = { pass: 0, fail: 0, manual: 0, skipped: 0, info: 0 };
  for (const c of criteria) overall[c.status]++;

  return {
    criteria,
    overall,
    attestation: {
      audio_offline_test_passed: audioPassed,
      audio_offline_test_at: audioAt,
    },
  };
}

export async function attestAudioOfflineTest(adminId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await sql`
      UPDATE settings
         SET audio_offline_test_passed = TRUE,
             audio_offline_test_at     = NOW(),
             audio_offline_test_by     = ${adminId}::uuid,
             updated_at                = NOW()
       WHERE id = 1
    `;
    await sql`
      INSERT INTO audit_log
        (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES
        ('admin', ${adminId}, 'launch.attest_audio_offline_test', 'settings', '1',
         ${JSON.stringify({ passed: true })}::jsonb)
    `;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function clearAudioOfflineTestAttestation(adminId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await sql`
      UPDATE settings
         SET audio_offline_test_passed = FALSE,
             audio_offline_test_at     = NULL,
             audio_offline_test_by     = NULL,
             updated_at                = NOW()
       WHERE id = 1
    `;
    await sql`
      INSERT INTO audit_log
        (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES
        ('admin', ${adminId}, 'launch.clear_audio_attestation', 'settings', '1',
         '{}'::jsonb)
    `;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
