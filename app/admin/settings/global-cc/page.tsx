import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { SettingsTabs } from "@/components/admin/SettingsTabs";
import { GlobalRecipients } from "@/components/admin/GlobalRecipients";

export const dynamic = "force-dynamic";

export default async function GlobalCcPage() {
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
      <SettingsTabs current="global-cc">
        <div className="space-y-4">
          <header>
            <h2 className="text-heading text-even-navy-800">Global CC list</h2>
            <p className="text-caption text-even-ink-500 mt-1">
              These recipients receive every encounter email by default. Per-doctor + per-encounter overrides apply on top.
              PRD §4.13: changes apply prospectively.
            </p>
          </header>
          <GlobalRecipients />
        </div>
      </SettingsTabs>
    </AdminShell>
  );
}
