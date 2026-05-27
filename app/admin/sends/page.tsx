/**
 * /admin/sends — send_event analytics + failed-send retries (Sprint 11, S8).
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { SendsClient } from "@/components/admin/SendsClient";

export const dynamic = "force-dynamic";

export default async function AdminSendsPage() {
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
    <AdminShell adminEmail={email} active="sends" pageTitle="Sends">
      <SendsClient />
    </AdminShell>
  );
}
