/**
 * lib/admin/dashboard.ts — server data layer for the admin Dashboard
 * overview (Sprint 9, Figma Admin Desktop Surface 1).
 *
 * Single export: getAdminDashboard(window) returning a flat bundle with
 * KPIs + attention items + 7-day chart + health proxy + activity feed.
 *
 * All queries are issued in parallel to keep the dashboard responsive
 * even when polling every 30s. Per-section soft-fail: if a sub-query
 * errors the others still return. The overview tolerates partial data.
 */

import { sql } from "@/lib/db";

export type DashboardWindow = "today" | "week" | "month" | "all";

type Kpi = {
  value: number;
  delta_vs_yesterday: number;   // signed integer; null-safe (0 if no yesterday data)
};

export type AttentionKind =
  | "send_failed"
  | "doctor_locked"
  | "stuck_processing"
  | "llm_error_rate";

export type AttentionItem = {
  kind: AttentionKind;
  severity: "warn" | "info";
  title: string;
  detail: string;
  age_minutes: number;
  action: { label: string; href: string } | null;
};

export type DashboardActivityItem = {
  kind: string;
  title: string;
  detail: string;
  age_minutes: number;
};

export type HealthServiceRow = {
  name: string;
  ok: boolean;
  p50_ms: number | null;
};

export type AdminDashboardBundle = {
  kpi: {
    encounters_today:  Kpi & { active_total?: number };
    sent_successfully: Kpi;
    failed_sends:      Kpi;
    active_doctors:    Kpi & { active_total: number };
  };
  attention: AttentionItem[];
  chart_7d: { day: string; count: number }[];   // 7 entries oldest-first
  chart_total: number;
  chart_avg_per_day: number;
  health: { status: "ok" | "degraded"; services: HealthServiceRow[] };
  activity: DashboardActivityItem[];
};

function ageMin(iso: string | Date): number {
  const t = typeof iso === "string" ? new Date(iso).getTime() : iso.getTime();
  return Math.max(0, Math.round((Date.now() - t) / 60_000));
}

// ---- helpers ---------------------------------------------------------------

async function getKpis(): Promise<AdminDashboardBundle["kpi"]> {
  try {
    const rows = (await sql`
      WITH
        enc_today AS (
          SELECT COUNT(*)::int AS n FROM encounter
           WHERE recorded_at >= date_trunc('day', NOW()) AND deleted_at IS NULL
        ),
        enc_yest AS (
          SELECT COUNT(*)::int AS n FROM encounter
           WHERE recorded_at >= date_trunc('day', NOW()) - INTERVAL '1 day'
             AND recorded_at <  date_trunc('day', NOW())
             AND deleted_at IS NULL
        ),
        sent_today AS (
          SELECT COUNT(*)::int AS n FROM send_event
           WHERE created_at >= date_trunc('day', NOW())
             AND status IN ('sent','delivered','opened')
        ),
        sent_yest AS (
          SELECT COUNT(*)::int AS n FROM send_event
           WHERE created_at >= date_trunc('day', NOW()) - INTERVAL '1 day'
             AND created_at <  date_trunc('day', NOW())
             AND status IN ('sent','delivered','opened')
        ),
        failed_today AS (
          SELECT COUNT(*)::int AS n FROM send_event
           WHERE created_at >= date_trunc('day', NOW())
             AND status IN ('failed','bounced','complained')
        ),
        failed_yest AS (
          SELECT COUNT(*)::int AS n FROM send_event
           WHERE created_at >= date_trunc('day', NOW()) - INTERVAL '1 day'
             AND created_at <  date_trunc('day', NOW())
             AND status IN ('failed','bounced','complained')
        ),
        doctors_active AS (
          SELECT COUNT(*)::int AS n FROM doctor
           WHERE status = 'active' AND deleted_at IS NULL
        ),
        doctors_total AS (
          SELECT COUNT(*)::int AS n FROM doctor
           WHERE deleted_at IS NULL
        )
      SELECT
        (SELECT n FROM enc_today)        AS enc_today,
        (SELECT n FROM enc_yest)         AS enc_yest,
        (SELECT n FROM sent_today)       AS sent_today,
        (SELECT n FROM sent_yest)        AS sent_yest,
        (SELECT n FROM failed_today)     AS failed_today,
        (SELECT n FROM failed_yest)      AS failed_yest,
        (SELECT n FROM doctors_active)   AS doctors_active,
        (SELECT n FROM doctors_total)    AS doctors_total
    `) as Array<{
      enc_today: number; enc_yest: number;
      sent_today: number; sent_yest: number;
      failed_today: number; failed_yest: number;
      doctors_active: number; doctors_total: number;
    }>;
    const r = rows[0] ?? {
      enc_today: 0, enc_yest: 0, sent_today: 0, sent_yest: 0,
      failed_today: 0, failed_yest: 0, doctors_active: 0, doctors_total: 0,
    };
    return {
      encounters_today: {
        value: Number(r.enc_today),
        delta_vs_yesterday: Number(r.enc_today) - Number(r.enc_yest),
      },
      sent_successfully: {
        value: Number(r.sent_today),
        delta_vs_yesterday: Number(r.sent_today) - Number(r.sent_yest),
      },
      failed_sends: {
        value: Number(r.failed_today),
        delta_vs_yesterday: Number(r.failed_today) - Number(r.failed_yest),
      },
      active_doctors: {
        value: Number(r.doctors_active),
        active_total: Number(r.doctors_total),
        delta_vs_yesterday: 0,   // no historic doctor snapshot — skip delta
      },
    };
  } catch (e) {
    console.warn("[admin] dashboard KPI query failed:", e);
    return {
      encounters_today:  { value: 0, delta_vs_yesterday: 0 },
      sent_successfully: { value: 0, delta_vs_yesterday: 0 },
      failed_sends:      { value: 0, delta_vs_yesterday: 0 },
      active_doctors:    { value: 0, active_total: 0, delta_vs_yesterday: 0 },
    };
  }
}

async function getAttention(): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  // 1. Failed sends with retries exhausted
  try {
    const rows = (await sql`
      SELECT id, sent_at::text AS sent_at, retry_count, send_status
        FROM encounter
       WHERE send_status = 'failed'
         AND retry_count >= 3
         AND deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 5
    `) as Array<{ id: string; sent_at: string | null; retry_count: number; send_status: string }>;
    for (const r of rows) {
      items.push({
        kind: "send_failed",
        severity: "warn",
        title: `Email send failed · ${r.retry_count} retries exhausted`,
        detail: `Encounter ${r.id.slice(0, 14)}…`,
        age_minutes: r.sent_at ? ageMin(r.sent_at) : 0,
        action: { label: "Retry now", href: `/admin/encounters/${r.id}?action=resend` },
      });
    }
  } catch (e) {
    console.warn("[admin] attention.send_failed query failed:", e);
  }

  // 2. Locked-out doctors
  try {
    const rows = (await sql`
      SELECT id, full_name, locked_until::text AS locked_until
        FROM doctor
       WHERE status = 'locked'
         AND deleted_at IS NULL
       ORDER BY locked_until DESC NULLS LAST
       LIMIT 5
    `) as Array<{ id: string; full_name: string; locked_until: string | null }>;
    for (const r of rows) {
      items.push({
        kind: "doctor_locked",
        severity: "warn",
        title: `Doctor locked out · ${r.full_name}`,
        detail: r.locked_until
          ? `Auto-unlock at ${new Date(r.locked_until).toLocaleString()}`
          : "Lockout in effect",
        age_minutes: r.locked_until ? ageMin(r.locked_until) : 0,
        action: null,
      });
    }
  } catch (e) {
    console.warn("[admin] attention.doctor_locked query failed:", e);
  }

  // 3. Stuck-in-processing encounters (>1h since recorded, still processing)
  try {
    const rows = (await sql`
      SELECT id, recorded_at::text AS recorded_at, doctor_id
        FROM encounter
       WHERE status = 'processing'
         AND recorded_at < NOW() - INTERVAL '1 hour'
         AND deleted_at IS NULL
       ORDER BY recorded_at ASC
       LIMIT 5
    `) as Array<{ id: string; recorded_at: string; doctor_id: string }>;
    for (const r of rows) {
      items.push({
        kind: "stuck_processing",
        severity: "info",
        title: `Stuck in processing · ${r.id.slice(0, 14)}…`,
        detail: `Recorded ${new Date(r.recorded_at).toLocaleString()}, likely /process crashed`,
        age_minutes: ageMin(r.recorded_at),
        action: { label: "View encounter", href: `/admin/encounters/${r.id}` },
      });
    }
  } catch (e) {
    console.warn("[admin] attention.stuck_processing query failed:", e);
  }

  // 4. LLM error rate >5% in last 24h
  try {
    const rows = (await sql`
      SELECT
        COUNT(*)::int                                       AS total,
        COUNT(*) FILTER (WHERE status = 'errored')::int     AS errored
      FROM llm_traces
      WHERE started_at >= NOW() - INTERVAL '24 hours'
    `) as Array<{ total: number; errored: number }>;
    const r = rows[0];
    if (r && r.total >= 5) {
      const rate = r.errored / r.total;
      if (rate > 0.05) {
        items.push({
          kind: "llm_error_rate",
          severity: "warn",
          title: `LLM error rate ${(rate * 100).toFixed(1)}% (last 24h)`,
          detail: `${r.errored} of ${r.total} traces failed`,
          age_minutes: 0,
          action: { label: "View traces", href: `/admin/traces?status=errored&window=last24h` },
        });
      }
    }
  } catch (e) {
    console.warn("[admin] attention.llm_error_rate query failed:", e);
  }

  // Sort warns first then by age desc (oldest first within severity)
  items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "warn" ? -1 : 1;
    return b.age_minutes - a.age_minutes;
  });

  return items.slice(0, 6);
}

async function getChart7d(): Promise<{
  chart_7d: { day: string; count: number }[];
  chart_total: number;
  chart_avg_per_day: number;
}> {
  try {
    const rows = (await sql`
      WITH days AS (
        SELECT generate_series(
                 date_trunc('day', NOW()) - INTERVAL '6 days',
                 date_trunc('day', NOW()),
                 INTERVAL '1 day'
               )::date AS day
      )
      SELECT
        days.day::text AS day,
        COALESCE(COUNT(e.id)::int, 0) AS count
      FROM days
      LEFT JOIN encounter e
        ON date_trunc('day', e.recorded_at)::date = days.day
       AND e.deleted_at IS NULL
      GROUP BY days.day
      ORDER BY days.day ASC
    `) as Array<{ day: string; count: number }>;
    const chart = rows.map((r) => ({ day: String(r.day), count: Number(r.count) }));
    const total = chart.reduce((a, b) => a + b.count, 0);
    const avg = chart.length > 0 ? total / chart.length : 0;
    return {
      chart_7d: chart,
      chart_total: total,
      chart_avg_per_day: Math.round(avg * 10) / 10,
    };
  } catch (e) {
    console.warn("[admin] chart_7d query failed:", e);
    return { chart_7d: [], chart_total: 0, chart_avg_per_day: 0 };
  }
}

async function getActivity(): Promise<DashboardActivityItem[]> {
  // Union audit_log + send_event into a chronological feed
  try {
    const auditRows = (await sql`
      SELECT
        'audit' AS kind,
        action,
        actor_type,
        target_id,
        metadata_json,
        created_at::text AS created_at
      FROM audit_log
      ORDER BY created_at DESC
      LIMIT 15
    `) as Array<Record<string, unknown>>;

    const sendRows = (await sql`
      SELECT
        se.id,
        se.encounter_id,
        se.recipient_email,
        se.status,
        se.updated_at::text AS updated_at,
        e.patient_label_raw
      FROM send_event se
      LEFT JOIN encounter e ON e.id = se.encounter_id
      WHERE se.status IN ('sent','delivered','failed','bounced')
      ORDER BY se.updated_at DESC
      LIMIT 10
    `) as Array<Record<string, unknown>>;

    const out: DashboardActivityItem[] = [];

    for (const r of auditRows) {
      const action = String(r.action);
      const actor = String(r.actor_type);
      out.push({
        kind: action,
        title: humanizeAction(action),
        detail: r.target_id ? `target: ${String(r.target_id).slice(0, 14)}…` : actor,
        age_minutes: ageMin(String(r.created_at)),
      });
    }
    for (const r of sendRows) {
      const status = String(r.status);
      const email = String(r.recipient_email);
      const patient = r.patient_label_raw ? String(r.patient_label_raw) : "encounter";
      out.push({
        kind: `send.${status}`,
        title: status === "failed" || status === "bounced"
          ? `Send ${status} · ${email}`
          : `Send ${status} · ${email}`,
        detail: patient,
        age_minutes: ageMin(String(r.updated_at)),
      });
    }

    out.sort((a, b) => a.age_minutes - b.age_minutes);
    return out.slice(0, 8);
  } catch (e) {
    console.warn("[admin] activity query failed:", e);
    return [];
  }
}

function humanizeAction(action: string): string {
  // Tidy action names for activity feed. Falls back to the raw key.
  const map: Record<string, string> = {
    "encounter.cancel_processing": "Encounter processing cancelled",
    "encounter.soft_delete":       "Encounter deleted",
    "encounter.resend":            "Encounter re-sent",
    "doctor.create":               "Doctor onboarded",
    "doctor.disable":              "Doctor disabled",
    "doctor.unlock":               "Doctor unlocked",
    "pin.reset":                   "PIN reset",
    "admin.password_change":       "Admin password rotated",
  };
  return map[action] ?? action.replace(/[._]/g, " ");
}

async function getHealth(): Promise<{ status: "ok" | "degraded"; services: HealthServiceRow[] }> {
  try {
    // Build URL from the request host — server-side fetch needs an absolute URL.
    // process.env.VERCEL_URL is set in production; otherwise fall back to APP_URL or localhost.
    const base =
      process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` :
      process.env.APP_URL    ? process.env.APP_URL.replace(/\/+$/, "") :
      "http://localhost:3000";
    const res = await fetch(`${base}/api/health`, { cache: "no-store" });
    if (!res.ok) throw new Error(`health_http_${res.status}`);
    const j = (await res.json()) as {
      ok: boolean;
      services: Record<string, { ok: boolean; latency_ms?: number }>;
    };
    const services: HealthServiceRow[] = Object.entries(j.services ?? {}).map(([name, s]) => ({
      name,
      ok: !!s.ok,
      p50_ms: typeof s.latency_ms === "number" ? s.latency_ms : null,
    }));
    return {
      status: j.ok ? "ok" : "degraded",
      services,
    };
  } catch (e) {
    console.warn("[admin] health proxy failed:", e);
    return { status: "degraded", services: [] };
  }
}

// ---- main entrypoint -------------------------------------------------------

export async function getAdminDashboard(): Promise<AdminDashboardBundle> {
  const [kpi, attention, chart, activity, health] = await Promise.all([
    getKpis(),
    getAttention(),
    getChart7d(),
    getActivity(),
    getHealth(),
  ]);
  return {
    kpi,
    attention,
    chart_7d: chart.chart_7d,
    chart_total: chart.chart_total,
    chart_avg_per_day: chart.chart_avg_per_day,
    health,
    activity,
  };
}
