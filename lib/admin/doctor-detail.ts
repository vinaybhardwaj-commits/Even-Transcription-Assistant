/**
 * lib/admin/doctor-detail.ts — server helper for the admin Doctor detail
 * page (Sprint 10, Figma S3). Returns a full bundle: doctor row + KPIs +
 * recent encounters + per-doctor recipients + audit_log entries.
 */
import { sql } from "@/lib/db";

export type DoctorFull = {
  doctor: {
    id: string;
    full_name: string;
    email: string;
    phone: string | null;
    url_slug: string;
    url_token: string;
    status: "active" | "disabled" | "locked";
    pin_set_at: string | null;
    failed_pin_count: number;
    locked_until: string | null;
    last_active_at: string | null;
    joined_at: string;
    deleted_at: string | null;
  } | null;
  kpis: {
    encounters_30d: number;
    encounters_total: number;
    send_success_30d_pct: number | null; // 0..100 or null if no sends
    sent_30d: number;
    failed_30d: number;
    active_days_30d: number;
  };
  recent_encounters: Array<{
    id: string;
    patient_label_raw: string | null;
    chief_complaint: string | null;
    recorded_at: string;
    duration_seconds: number | null;
    send_status: "pending" | "sent" | "failed";
  }>;
  recipients: Array<{
    id: string;
    email: string;
    name: string;
    role: string;
    set_by: string;
  }>;
  audit_log: Array<{
    id: string;
    actor_type: "admin" | "doctor" | "system";
    actor_id: string | null;
    action: string;
    metadata_json: unknown;
    created_at: string;
  }>;
};

export async function getFullDoctor(id: string): Promise<DoctorFull> {
  const empty: DoctorFull = {
    doctor: null,
    kpis: {
      encounters_30d: 0,
      encounters_total: 0,
      send_success_30d_pct: null,
      sent_30d: 0,
      failed_30d: 0,
      active_days_30d: 0,
    },
    recent_encounters: [],
    recipients: [],
    audit_log: [],
  };

  let doctorRow: DoctorFull["doctor"] = null;
  try {
    const rows = (await sql`
      SELECT
        id, full_name, email, phone,
        url_slug, url_token, status,
        pin_set_at::text       AS pin_set_at,
        failed_pin_count,
        locked_until::text     AS locked_until,
        last_active_at::text   AS last_active_at,
        joined_at::text        AS joined_at,
        deleted_at::text       AS deleted_at
      FROM doctor
      WHERE id = ${id}
      LIMIT 1
    `) as Array<Record<string, unknown>>;
    const r = rows[0];
    if (!r) return empty;
    doctorRow = {
      id: String(r.id),
      full_name: String(r.full_name),
      email: String(r.email),
      phone: r.phone ? String(r.phone) : null,
      url_slug: String(r.url_slug),
      url_token: String(r.url_token),
      status: r.status as "active" | "disabled" | "locked",
      pin_set_at: r.pin_set_at ? String(r.pin_set_at) : null,
      failed_pin_count: Number(r.failed_pin_count ?? 0),
      locked_until: r.locked_until ? String(r.locked_until) : null,
      last_active_at: r.last_active_at ? String(r.last_active_at) : null,
      joined_at: String(r.joined_at),
      deleted_at: r.deleted_at ? String(r.deleted_at) : null,
    };
  } catch (e) {
    console.warn("[admin] getFullDoctor doctor load failed:", e);
    return empty;
  }

  // KPIs (parallel)
  const [kpiRow, recentRows, recipRows, auditRows] = await Promise.all([
    sql`
      SELECT
        (SELECT COUNT(*)::int FROM encounter
          WHERE doctor_id = ${id}
            AND recorded_at >= NOW() - INTERVAL '30 days'
            AND deleted_at IS NULL)                                    AS encounters_30d,
        (SELECT COUNT(*)::int FROM encounter
          WHERE doctor_id = ${id}
            AND deleted_at IS NULL)                                    AS encounters_total,
        (SELECT COUNT(*)::int FROM send_event se
          JOIN encounter e ON e.id = se.encounter_id
         WHERE e.doctor_id = ${id}
           AND se.created_at >= NOW() - INTERVAL '30 days'
           AND se.status IN ('sent','delivered','opened'))             AS sent_30d,
        (SELECT COUNT(*)::int FROM send_event se
          JOIN encounter e ON e.id = se.encounter_id
         WHERE e.doctor_id = ${id}
           AND se.created_at >= NOW() - INTERVAL '30 days'
           AND se.status IN ('failed','bounced','complained'))         AS failed_30d,
        (SELECT COUNT(DISTINCT date_trunc('day', recorded_at))::int
           FROM encounter
          WHERE doctor_id = ${id}
            AND recorded_at >= NOW() - INTERVAL '30 days'
            AND deleted_at IS NULL)                                    AS active_days_30d
    ` as unknown as Promise<Array<{
      encounters_30d: number; encounters_total: number;
      sent_30d: number; failed_30d: number; active_days_30d: number;
    }>>,
    sql`
      SELECT id, patient_label_raw, chief_complaint,
             recorded_at::text AS recorded_at,
             duration_seconds, send_status
        FROM encounter
       WHERE doctor_id = ${id}
         AND deleted_at IS NULL
       ORDER BY recorded_at DESC
       LIMIT 8
    ` as unknown as Promise<Array<Record<string, unknown>>>,
    sql`
      SELECT id::text AS id, email, name, role, set_by
        FROM recipient_per_doctor
       WHERE doctor_id = ${id}
       ORDER BY name
    ` as unknown as Promise<Array<Record<string, unknown>>>,
    sql`
      SELECT id, actor_type, actor_id, action, metadata_json,
             created_at::text AS created_at
        FROM audit_log
       WHERE (target_type = 'doctor' AND target_id = ${id})
       ORDER BY created_at DESC
       LIMIT 25
    ` as unknown as Promise<Array<Record<string, unknown>>>,
  ]);

  const k = kpiRow[0] ?? { encounters_30d: 0, encounters_total: 0, sent_30d: 0, failed_30d: 0, active_days_30d: 0 };
  const totalSends = Number(k.sent_30d) + Number(k.failed_30d);
  const successPct = totalSends > 0 ? Math.round((Number(k.sent_30d) / totalSends) * 100) : null;

  return {
    doctor: doctorRow,
    kpis: {
      encounters_30d: Number(k.encounters_30d),
      encounters_total: Number(k.encounters_total),
      sent_30d: Number(k.sent_30d),
      failed_30d: Number(k.failed_30d),
      send_success_30d_pct: successPct,
      active_days_30d: Number(k.active_days_30d),
    },
    recent_encounters: recentRows.map((r) => ({
      id: String(r.id),
      patient_label_raw: r.patient_label_raw ? String(r.patient_label_raw) : null,
      chief_complaint: r.chief_complaint ? String(r.chief_complaint) : null,
      recorded_at: String(r.recorded_at),
      duration_seconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
      send_status: (r.send_status as "pending" | "sent" | "failed") ?? "pending",
    })),
    recipients: recipRows.map((r) => ({
      id: String(r.id),
      email: String(r.email),
      name: String(r.name),
      role: String(r.role),
      set_by: String(r.set_by),
    })),
    audit_log: auditRows.map((r) => ({
      id: String(r.id),
      actor_type: r.actor_type as "admin" | "doctor" | "system",
      actor_id: r.actor_id ? String(r.actor_id) : null,
      action: String(r.action),
      metadata_json: r.metadata_json ?? null,
      created_at: String(r.created_at),
    })),
  };
}
