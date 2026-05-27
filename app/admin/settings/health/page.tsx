import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { HealthDetailClient } from "@/components/admin/HealthDetailClient";

export const dynamic = "force-dynamic";

export default async function HealthSettingsPage() {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try {
    const claims = await verifyAdminJwt(cookie);
    email = String(claims.email ?? "");
  } catch {
    redirect("/admin");
  }
  return (
    <AdminShell adminEmail={email} active="settings" pageTitle="Settings">
      <SettingsTabs current="health">
        <div className="space-y-4">
          <header>
            <h2 className="text-heading text-even-navy-800">Health probes</h2>
            <p className="text-caption text-even-ink-500 mt-1">
              Live status of every external dependency. Same probes feed the dashboard.
            </p>
          </header>
          <HealthDetailClient />
        </div>
      </SettingsTabs>
    </AdminShell>
  );
}
