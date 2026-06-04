/**
 * /admin/admins — manage admin users (all admins are equal; any signed-in admin
 * can view + add). Replaces the unauthenticated seed-team hack for onboarding.
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { AdminsClient } from "@/components/admin/AdminsClient";

export const dynamic = "force-dynamic";

export default async function AdminsPage() {
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
    <AdminShell adminEmail={email} active="admins" pageTitle="Admins" breadcrumb="Admins">
      <AdminsClient currentEmail={email} />
    </AdminShell>
  );
}
