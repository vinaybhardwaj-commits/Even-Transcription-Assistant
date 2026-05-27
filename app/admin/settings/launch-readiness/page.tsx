import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { LaunchReadinessClient } from "@/components/admin/LaunchReadinessClient";

export const dynamic = "force-dynamic";

export default async function LaunchReadinessPage() {
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
      <SettingsTabs current="launch-readiness">
        <div className="space-y-4">
          <header>
            <h2 className="text-heading text-even-navy-800">Launch readiness</h2>
            <p className="text-caption text-even-ink-500 mt-1 max-w-3xl">
              PRD §10.1 — nine launch-day correctness criteria. Computed live from prod
              data (encounter / send_event / llm_traces) over the trailing 30 days.
              One row requires manual attestation: V tests offline-recovery and toggles
              the checkbox below.
            </p>
          </header>
          <LaunchReadinessClient />
        </div>
      </SettingsTabs>
    </AdminShell>
  );
}
