/**
 * /admin/traces — admin LLM trace dashboard (Sprint 6.2).
 *
 * Server component. Authenticates the admin cookie; if missing or expired,
 * falls back to the login screen at /admin (same auth model as other admin
 * pages). On success, wraps TracesListClient in AdminShell.
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { TracesListClient } from "@/components/admin/TracesListClient";

export const dynamic = "force-dynamic";

export default async function AdminTracesPage() {
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
    <AdminShell adminEmail={email} active="traces" pageTitle="LLM traces">
      <TracesListClient />
    </AdminShell>
  );
}
