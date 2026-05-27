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
      return (
        <AdminShell adminEmail={email} active="dashboard" pageTitle="Dashboard">
          <AdminDashboard />
        </AdminShell>
      );
    } catch {
      /* fall through to login */
    }
  }
  return <AdminLoginClient />;
}
