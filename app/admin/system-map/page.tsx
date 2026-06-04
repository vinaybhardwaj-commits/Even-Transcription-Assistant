/**
 * /admin/system-map — a visual architecture overview of the Evenscribe (ETA)
 * system: the end-to-end pipeline (record → email), the infrastructure &
 * dependencies, the data model, and the key algorithms. Static, code-derived
 * infographic; admin-gated like the rest of the admin surface.
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { SystemMap } from "@/components/admin/SystemMap";

export const dynamic = "force-dynamic";

export default async function SystemMapPage() {
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
    <AdminShell adminEmail={email} active="system-map" pageTitle="System map" breadcrumb="System map">
      <SystemMap />
    </AdminShell>
  );
}
