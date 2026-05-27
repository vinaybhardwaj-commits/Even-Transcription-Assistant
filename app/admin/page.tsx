import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminLoginClient } from "@/components/admin/AdminLoginClient";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminDashboard } from "@/components/admin/AdminDashboard";

export const dynamic = "force-dynamic";

export default async function AdminEntry() {
  const cookie = await readAdminCookie();
  if (cookie) {
    try {
      const claims = await verifyAdminJwt(cookie);
      const email = String(claims.email ?? "");
      // JWT doesn't carry admin name; derive from email local-part:
      // 'vinay.bhardwaj@even.in' → 'Vinay Bhardwaj'
      const local = email.split("@")[0] ?? "";
      const name = local
        .split(/[._\-]/)
        .filter(Boolean)
        .map((part) => (part[0] ?? "").toUpperCase() + part.slice(1))
        .join(" ") || email;
      return (
        <AdminShell adminEmail={email} active="dashboard" pageTitle="Dashboard">
          <AdminDashboard adminName={name} />
        </AdminShell>
      );
    } catch {
      /* fall through to login */
    }
  }
  return <AdminLoginClient />;
}
