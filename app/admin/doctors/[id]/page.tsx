/**
 * /admin/doctors/{id} — Doctor profile detail (Sprint 10, Figma S3 detail).
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { DoctorDetailClient } from "@/components/admin/DoctorDetailClient";

export const dynamic = "force-dynamic";

export default async function AdminDoctorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try {
    const claims = await verifyAdminJwt(cookie);
    email = String(claims.email ?? "");
  } catch {
    redirect("/admin");
  }
  const { id } = await params;
  return (
    <AdminShell
      adminEmail={email}
      active="doctors"
      pageTitle={id}
      breadcrumb="Doctors"
    >
      <DoctorDetailClient doctorId={id} />
    </AdminShell>
  );
}
