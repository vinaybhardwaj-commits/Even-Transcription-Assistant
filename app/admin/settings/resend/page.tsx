import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { SettingsTabs } from "@/components/admin/SettingsTabs";

export const dynamic = "force-dynamic";

export default async function ResendPage() {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try {
    const claims = await verifyAdminJwt(cookie);
    email = String(claims.email ?? "");
  } catch {
    redirect("/admin");
  }
  // Read env to display (read-only). Mask the API key.
  const fromEmail = process.env.RESEND_FROM_EMAIL ?? "(not set)";
  const apiKey = process.env.RESEND_API_KEY;
  const maskedKey = apiKey ? `${apiKey.slice(0, 6)}…${apiKey.slice(-4)}` : "(not set)";
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET ? "configured" : "missing";

  return (
    <AdminShell adminEmail={email} active="settings" pageTitle="Settings">
      <SettingsTabs current="resend">
        <div className="space-y-6 max-w-2xl">
          <header>
            <h2 className="text-heading text-even-navy-800">Resend configuration</h2>
            <p className="text-caption text-even-ink-500 mt-1">
              Outbound email transport. Read-only — edit via Vercel env dashboard.
            </p>
          </header>
          <dl className="rounded-xl border border-even-ink-100 bg-even-white p-5 grid grid-cols-[180px,1fr] gap-y-3 text-body">
            <dt className="text-caption text-even-ink-500">From address</dt>
            <dd className="text-even-navy-800 font-mono">{fromEmail}</dd>
            <dt className="text-caption text-even-ink-500">API key</dt>
            <dd className="text-even-navy-800 font-mono">{maskedKey}</dd>
            <dt className="text-caption text-even-ink-500">Webhook secret</dt>
            <dd className="text-even-navy-800">
              {webhookSecret === "configured" ? (
                <span className="text-success-700">✓ configured</span>
              ) : (
                <span className="text-danger-700">⚠ missing</span>
              )}
            </dd>
            <dt className="text-caption text-even-ink-500">Webhook URL</dt>
            <dd className="text-even-navy-800 font-mono break-all">/api/webhooks/resend</dd>
            <dt className="text-caption text-even-ink-500">Retry policy</dt>
            <dd className="text-even-navy-800">3 attempts · exponential backoff (60s · 5m · 30m)</dd>
          </dl>
          <p className="text-caption text-even-ink-500">
            Sandbox/production toggle deferred to v2.
          </p>
        </div>
      </SettingsTabs>
    </AdminShell>
  );
}
