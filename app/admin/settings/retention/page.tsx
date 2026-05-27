import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { SettingsTabs } from "@/components/admin/SettingsTabs";

export const dynamic = "force-dynamic";

export default async function RetentionPage() {
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
      <SettingsTabs current="retention">
        <div className="space-y-6 max-w-2xl">
          <header>
            <h2 className="text-heading text-even-navy-800">Audio retention policy</h2>
            <p className="text-caption text-even-ink-500 mt-1">
              PRD §4.17 lock (Q13, 26 May 2026): keep audio indefinitely with
              default-yes doctor delete privilege. Read-only in v1.
            </p>
          </header>
          <dl className="rounded-xl border border-even-ink-100 bg-even-white p-5 grid grid-cols-[180px,1fr] gap-y-3 text-body">
            <dt className="text-caption text-even-ink-500">Default policy</dt>
            <dd className="text-even-navy-800">Keep indefinitely</dd>
            <dt className="text-caption text-even-ink-500">Auto-purge cron</dt>
            <dd className="text-even-navy-800">Not scheduled</dd>
            <dt className="text-caption text-even-ink-500">Doctor self-delete</dt>
            <dd className="text-even-navy-800">Enabled (default-yes)</dd>
            <dt className="text-caption text-even-ink-500">Soft-delete behavior</dt>
            <dd className="text-even-navy-800">
              encounter row + audio object retained in R2; JSONs nulled.
              <span className="block text-caption text-even-ink-500 mt-0.5">See Sprint 7 soft-tombstone.</span>
            </dd>
            <dt className="text-caption text-even-ink-500">Storage backend</dt>
            <dd className="text-even-navy-800 font-mono">Cloudflare R2 · eta-audio</dd>
          </dl>
          <p className="text-caption text-even-ink-500">
            Editing the policy is deferred to v2 (would require backfill of
            existing audio + cron infrastructure + admin policy review).
          </p>
        </div>
      </SettingsTabs>
    </AdminShell>
  );
}
