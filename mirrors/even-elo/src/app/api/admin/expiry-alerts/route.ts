import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { actorFromRequest } from "@/lib/auth";
import { sendEmail, wrapHtml, emailEnabled } from "@/lib/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

// Default look-ahead window (days). Items expiring within this many days — or already
// expired — are surfaced. Overridable per call via ?days=N.
const DEFAULT_WINDOW = 30;

interface ExpiryItem {
  kind: "Registration" | "Indemnity" | "Special privilege";
  physician_name: string;
  detail: string;        // council/number or procedure
  expiry: string;        // YYYY-MM-DD
  days_remaining: number; // negative = already expired
}

function rowsToHtml(items: ExpiryItem[]): string {
  const r = items
    .map((i) => {
      const when =
        i.days_remaining < 0
          ? `<span style="color:#b91c1c;">expired ${Math.abs(i.days_remaining)}d ago</span>`
          : i.days_remaining === 0
          ? `<span style="color:#b91c1c;">expires today</span>`
          : `in ${i.days_remaining}d`;
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e7e5e4;">${i.kind}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e7e5e4;">${i.physician_name}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e7e5e4;color:#57534e;">${i.detail}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e7e5e4;white-space:nowrap;">${i.expiry} · ${when}</td>
      </tr>`;
    })
    .join("");
  return `<table style="border-collapse:collapse;width:100%;font-size:13px;">
    <thead><tr style="text-align:left;color:#78716c;">
      <th style="padding:6px 10px;">Type</th><th style="padding:6px 10px;">Physician</th>
      <th style="padding:6px 10px;">Detail</th><th style="padding:6px 10px;">Expiry</th>
    </tr></thead><tbody>${r}</tbody></table>`;
}

/**
 * POST /api/admin/expiry-alerts — N.3.
 * Scans registration / indemnity / Special-privilege expiries within the window
 * (default 30 days, incl. already-expired) and emails a digest to the credentialing
 * team (super_admin + Site Medical Head + HR). Gated by EMAIL_SENDING_ENABLED.
 *
 * Auth: a super_admin session, OR ?token=<EXPIRY_ALERT_TOKEN> when that env is set
 * (so it can be driven by a scheduler / Vercel Cron). Idempotency note: v1 has no
 * notification_log, so each run re-sends — run it on a cadence (e.g. daily), not in a loop.
 */
export async function POST(req: NextRequest) {
  const url = process.env.DATABASE_URL;
  if (!url) return NextResponse.json({ ok: false, error: "DATABASE_URL not configured" }, { status: 500, headers: NO_STORE });
  const sql = neon(url);

  // ── auth ──
  const token = req.nextUrl.searchParams.get("token");
  const envToken = process.env.EXPIRY_ALERT_TOKEN;
  let authorized = false;
  let actorId: string | null = null;
  if (envToken && token && token === envToken) {
    authorized = true;
  } else {
    try {
      const actor = await actorFromRequest();
      const me = (await sql`SELECT is_super_admin FROM profiles_with_roles WHERE id = ${actor.profileId}::uuid LIMIT 1`) as Array<{ is_super_admin: boolean }>;
      if (me.length > 0 && me[0].is_super_admin) { authorized = true; actorId = actor.profileId; }
    } catch { /* fall through */ }
  }
  if (!authorized) return NextResponse.json({ ok: false, error: "Not permitted" }, { status: 403, headers: NO_STORE });

  const daysParam = Number(req.nextUrl.searchParams.get("days"));
  const windowDays = Number.isFinite(daysParam) && daysParam > 0 && daysParam <= 365 ? Math.floor(daysParam) : DEFAULT_WINDOW;
  const dryRun = req.nextUrl.searchParams.get("dry_run") === "1";

  // ── scan ──
  const reg = (await sql`
    SELECT full_name, registration_council, registration_number, registration_expiry::text AS expiry,
           (registration_expiry - CURRENT_DATE) AS days_remaining
    FROM physicians
    WHERE current_status = 'active' AND registration_expiry IS NOT NULL
      AND registration_expiry <= CURRENT_DATE + (${windowDays})::int
    ORDER BY registration_expiry ASC
  `) as Array<{ full_name: string; registration_council: string | null; registration_number: string | null; expiry: string; days_remaining: number }>;

  const ind = (await sql`
    SELECT full_name, indemnity_expiry::text AS expiry, (indemnity_expiry - CURRENT_DATE) AS days_remaining
    FROM physicians
    WHERE current_status = 'active' AND indemnity_expiry IS NOT NULL
      AND indemnity_expiry <= CURRENT_DATE + (${windowDays})::int
    ORDER BY indemnity_expiry ASC
  `) as Array<{ full_name: string; expiry: string; days_remaining: number }>;

  const priv = (await sql`
    SELECT ph.full_name, pr.procedure_or_specialty, pr.expires_at::text AS expiry,
           (pr.expires_at - CURRENT_DATE) AS days_remaining
    FROM privileges pr JOIN physicians ph ON ph.id = pr.physician_id
    WHERE pr.expires_at IS NOT NULL AND COALESCE(pr.is_core, false) = false
      AND pr.withdrawn_date IS NULL
      AND pr.expires_at <= CURRENT_DATE + (${windowDays})::int
    ORDER BY pr.expires_at ASC
  `) as Array<{ full_name: string; procedure_or_specialty: string; expiry: string; days_remaining: number }>;

  const items: ExpiryItem[] = [
    ...reg.map((r) => ({ kind: "Registration" as const, physician_name: r.full_name, detail: [r.registration_council, r.registration_number].filter(Boolean).join(" · ") || "—", expiry: r.expiry, days_remaining: Number(r.days_remaining) })),
    ...ind.map((r) => ({ kind: "Indemnity" as const, physician_name: r.full_name, detail: "Professional indemnity", expiry: r.expiry, days_remaining: Number(r.days_remaining) })),
    ...priv.map((r) => ({ kind: "Special privilege" as const, physician_name: r.full_name, detail: r.procedure_or_specialty, expiry: r.expiry, days_remaining: Number(r.days_remaining) })),
  ].sort((a, b) => a.days_remaining - b.days_remaining);

  const counts = { registration: reg.length, indemnity: ind.length, privileges: priv.length, total: items.length };

  // ── recipients: credentialing team ──
  const recips = (await sql`
    SELECT DISTINCT pwr.email
    FROM profiles_with_roles pwr JOIN profiles p ON p.id = pwr.id
    WHERE (pwr.is_super_admin = true OR pwr.is_hr = true OR pwr.is_site_medical_head = true)
      AND p.status = 'active' AND pwr.email IS NOT NULL
  `) as Array<{ email: string }>;
  const recipients = recips.map((r) => r.email).filter(Boolean);

  let emailsSent = 0;
  if (!dryRun && items.length > 0 && recipients.length > 0) {
    const body = `<p>${items.length} credentialing item(s) expire within ${windowDays} days (or have already lapsed). Please action renewals.</p>${rowsToHtml(items)}<p style="margin-top:16px;color:#78716c;font-size:12px;">Open the Even Physician Index for full physician records.</p>`;
    const html = wrapHtml("Credentialing expiry alert", body);
    for (const to of recipients) {
      const res = await sendEmail({ to, subject: `Credentialing expiry alert — ${items.length} item(s) within ${windowDays}d`, html });
      if (res.ok && !res.skipped) emailsSent++;
    }
  }

  await sql`INSERT INTO audit_log_v2 (actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (${actorId}::uuid, 'expiry_alerts_run', 'system', ${null},
            ${JSON.stringify({ window_days: windowDays, dry_run: dryRun, counts, recipients: recipients.length, emails_sent: emailsSent, email_enabled: emailEnabled(), via: actorId ? "session" : "token" })}::jsonb)`;

  return NextResponse.json({ ok: true, enabled: emailEnabled(), dry_run: dryRun, window_days: windowDays, counts, recipients: recipients.length, emails_sent: emailsSent, items }, { headers: NO_STORE });
}
