/**
 * /admin/doctors — list of all doctors (Sprint 10, Figma S3 list view).
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { DoctorsListClient } from "@/components/admin/DoctorsListClient";

export const dynamic = "force-dynamic";

export default async function AdminDoctorsPage() {
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
    <AdminShell adminEmail={email} active="doctors" pageTitle="Doctors">
      <DoctorsListClient />
    </AdminShell>
  );
}
