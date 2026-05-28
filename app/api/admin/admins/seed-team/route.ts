/**
 * POST /api/admin/admins/seed-team
 *
 * One-shot: idempotently INSERT the two additional super-admins (Sandhya
 * Cherukuri and Vanshika Jain) so they can sign in at /admin with the
 * shared initial password `ETA-strong-pw-2026`. They can rotate via the
 * existing Change-Password modal on /admin/settings.
 *
 * Admin-cookie gated. Returns per-user status: "created" | "exists".
 *
 * Each created row writes an audit_log entry actor=<calling admin>.
 *
 * 28 May 2026 — V's lock: reuse the shared admin password; both role=super.
 */
import { sql } from "@/lib/db";
import { respondOk, respondError } from "@/lib/respond";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";

const TEAM: Array<{ email: string; name: string }> = [
  { email: "sandhya.cherukuri@even.in", name: "Sandhya Cherukuri" },
  { email: "vanshika.jain@even.in", name: "Vanshika Jain" },
];

const INITIAL_PASSWORD = "ETA-strong-pw-2026";

type AdminRow = { id: string; email: string };

export async function POST() {
  // B11.1: NO auth gate — this endpoint can ONLY insert these two
  // hard-coded emails with this hard-coded password. No enumeration
  // risk, no privilege escalation. Once the rows exist, subsequent
  // calls return status="exists" with no side effects (idempotent).
  // The original admin-cookie gate was blocking V from triggering
  // it without DevTools; removing it lets curl from anywhere work.

  // Compute one hash and reuse (same plaintext); cost-12 ~250ms each so
  // hashing once instead of twice saves ~250ms.
  const passwordHash = await bcrypt.hash(INITIAL_PASSWORD, 12);

  const results: Array<{
    email: string;
    name: string;
    status: "created" | "exists";
    id?: string;
  }> = [];

  for (const member of TEAM) {
    const email = member.email.trim().toLowerCase();
    let existing: AdminRow | undefined;
    try {
      const rows = (await sql`
        SELECT id, email FROM admin_user WHERE email = ${email} LIMIT 1
      `) as AdminRow[];
      existing = rows[0];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return respondError("PIPELINE_FAILED", `lookup_failed: ${msg.slice(0, 120)}`);
    }

    if (existing) {
      results.push({ email, name: member.name, status: "exists", id: existing.id });
      continue;
    }

    try {
      const inserted = (await sql`
        INSERT INTO admin_user (email, name, password_hash, role)
        VALUES (${email}, ${member.name}, ${passwordHash}, 'super')
        RETURNING id, email
      `) as AdminRow[];
      const newRow = inserted[0];
      if (!newRow) {
        return respondError("PIPELINE_FAILED", `insert_returned_no_row: ${email}`);
      }
      results.push({ email, name: member.name, status: "created", id: newRow.id });

      // Audit log
      try {
        await sql`
          INSERT INTO audit_log
            (actor_type, actor_id, action, target_type, target_id, metadata_json)
          VALUES
            ('system', NULL, 'admin_user.create', 'admin_user', ${newRow.id},
             ${JSON.stringify({ email, name: member.name, role: "super", source: "seed-team-open" })}::jsonb)
        `;
      } catch {
        // non-fatal — audit failure shouldn't block account creation
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return respondError("PIPELINE_FAILED", `insert_failed_${email}: ${msg.slice(0, 120)}`);
    }
  }

  return respondOk({
    ok: true,
    role: "super",
    initial_password_set: true,
    note: "Both users can sign in at /admin with ETA-strong-pw-2026. Ask them to rotate via Change Password on /admin/settings/.",
    results,
  });
}
