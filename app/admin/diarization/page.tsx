import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { DiarizationEerClient } from "@/components/admin/DiarizationEerClient";

export const dynamic = "force-dynamic";

export default async function AdminDiarizationPage() {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try { email = String((await verifyAdminJwt(cookie)).email ?? ""); } catch { redirect("/admin"); }
  return (
    <AdminShell adminEmail={email} active="diarization" pageTitle="Diarization">
      <DiarizationEerClient />
    </AdminShell>
  );
}
