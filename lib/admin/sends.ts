/**
 * lib/admin/sends.ts — Sprint 11 data layer for /admin/sends (Figma S8).
 *
 * One entry point: getAdminSends({window}) returns:
 *   - aggregates (totals across the window)
 *   - per-recipient top 10 by delivered count
 *   - per-domain rollup with bounce/complaint rates
 *   - failed_recent (last 25 failures across encounters, with encounter
 *     ID + recipient + reason for the Retry button)
 *
 * Window: today / week / month / all (defaults to month).
 */
import { sql } from "@/lib/db";

export type SendsWindow = "today" | "week" | "month" | "all";

export type AdminSendsBundle = {
  aggregates: {
    sent: number;
    delivered: number;
    opened: number;
    failed: number;
    bounced: number;
    complained: number;
    queued: number;
    delivery_rate_pct: number | null;
    open_rate_pct: number | null;
  };
  per_recipient: Array<{
    email: string;
    sent: number;
    delivered: number;
    opened: number;
    open_rate_pct: number | null;
  }>;
  per_domain: Array<{
    domain: string;
    total: number;
    delivered: number;
    bounced: number;
    bounce_rate_pct: number | null;
  }>;
  failed_recent: Array<{
    id: string;
    encounter_id: string;
    recipient_email: string;
    status: string;
    failure_reason: string | null;
    created_at: string;
    updated_at: string;
  }>;
};

function windowSinceForSends(w: SendsWindow): Date {
  const d = new Date();
  switch (w) {
    case "today": d.setUTCHours(0, 0, 0, 0); return d;
    case "week":  return new Date(d.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "month": return new Date(d.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "all":   return new Date(0);
  }
}

export async function getAdminSends(args: { window?: SendsWindow } = {}): Promise<AdminSendsBundle> {
  const since = windowSinceForSends(args.window ?? "month").toISOString();
  const empty: AdminSendsBundle = {
    aggregates: { sent: 0, delivered: 0, opened: 0, failed: 0, bounced: 0, complained: 0, queued: 0, delivery_rate_pct: null, open_rate_pct: null },
    per_recipient: [],
    per_domain: [],
    failed_recent: [],
  };

  try {
    const [aggRows, recipRows, domainRows, failRows] = await Promise.all([
      sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'sent')::int       AS sent,
          COUNT(*) FILTER (WHERE status = 'delivered')::int  AS delivered,
          COUNT(*) FILTER (WHERE status = 'opened')::int     AS opened,
          COUNT(*) FILTER (WHERE status = 'failed')::int     AS failed,
          COUNT(*) FILTER (WHERE status = 'bounced')::int    AS bounced,
          COUNT(*) FILTER (WHERE status = 'complained')::int AS complained,
          COUNT(*) FILTER (WHERE status = 'queued')::int     AS queued,
          COUNT(*)::int                                       AS total_count
        FROM send_event
       WHERE created_at >= ${since}::timestamptz
      ` as unknown as Promise<Array<Record<string, unknown>>>,
      sql`
        SELECT
          recipient_email AS email,
          COUNT(*)::int                                                     AS sent,
          COUNT(*) FILTER (WHERE status IN ('delivered','opened'))::int     AS delivered,
          COUNT(*) FILTER (WHERE status = 'opened')::int                    AS opened
        FROM send_event
       WHERE created_at >= ${since}::timestamptz
         AND status IN ('sent','delivered','opened','failed','bounced')
       GROUP BY recipient_email
       ORDER BY COUNT(*) DESC, recipient_email ASC
       LIMIT 10
      ` as unknown as Promise<Array<Record<string, unknown>>>,
      sql`
        SELECT
          SUBSTRING(recipient_email FROM POSITION('@' IN recipient_email) + 1) AS domain,
          COUNT(*)::int                                                         AS total,
          COUNT(*) FILTER (WHERE status IN ('delivered','opened','sent'))::int  AS delivered,
          COUNT(*) FILTER (WHERE status IN ('bounced','complained','failed'))::int AS bounced
        FROM send_event
       WHERE created_at >= ${since}::timestamptz
       GROUP BY domain
       ORDER BY COUNT(*) DESC
       LIMIT 10
      ` as unknown as Promise<Array<Record<string, unknown>>>,
      sql`
        SELECT
          id, encounter_id, recipient_email, status, failure_reason,
          created_at::text AS created_at,
          updated_at::text AS updated_at
        FROM send_event
       WHERE status IN ('failed','bounced','complained')
         AND created_at >= ${since}::timestamptz
       ORDER BY updated_at DESC
       LIMIT 25
      ` as unknown as Promise<Array<Record<string, unknown>>>,
    ]);

    const a = aggRows[0] ?? {};
    const sent = Number(a.sent ?? 0);
    const delivered = Number(a.delivered ?? 0);
    const opened = Number(a.opened ?? 0);
    const failed = Number(a.failed ?? 0);
    const bounced = Number(a.bounced ?? 0);
    const complained = Number(a.complained ?? 0);
    const queued = Number(a.queued ?? 0);
    const totalAttempted = sent + delivered + opened + failed + bounced + complained;
    const deliveryRate = totalAttempted > 0 ? Math.round(((delivered + opened) / totalAttempted) * 100) : null;
    const openRate = (delivered + opened) > 0 ? Math.round((opened / (delivered + opened)) * 100) : null;

    return {
      aggregates: {
        sent, delivered, opened, failed, bounced, complained, queued,
        delivery_rate_pct: deliveryRate,
        open_rate_pct: openRate,
      },
      per_recipient: recipRows.map((r) => {
        const sentR = Number(r.sent ?? 0);
        const openedR = Number(r.opened ?? 0);
        const deliveredR = Number(r.delivered ?? 0);
        return {
          email: String(r.email),
          sent: sentR,
          delivered: deliveredR,
          opened: openedR,
          open_rate_pct: deliveredR > 0 ? Math.round((openedR / deliveredR) * 100) : null,
        };
      }),
      per_domain: domainRows.map((r) => {
        const total = Number(r.total ?? 0);
        const bouncedD = Number(r.bounced ?? 0);
        return {
          domain: String(r.domain),
          total,
          delivered: Number(r.delivered ?? 0),
          bounced: bouncedD,
          bounce_rate_pct: total > 0 ? Math.round((bouncedD / total) * 100) : null,
        };
      }),
      failed_recent: failRows.map((r) => ({
        id: String(r.id),
        encounter_id: String(r.encounter_id),
        recipient_email: String(r.recipient_email),
        status: String(r.status),
        failure_reason: r.failure_reason ? String(r.failure_reason) : null,
        created_at: String(r.created_at),
        updated_at: String(r.updated_at),
      })),
    };
  } catch (e) {
    console.warn("[admin] getAdminSends failed:", e);
    return empty;
  }
}
