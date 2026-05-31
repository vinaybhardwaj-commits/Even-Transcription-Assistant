import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { SttLabClient } from "@/components/admin/SttLabClient";

export const dynamic = "force-dynamic";

export default async function AdminSttLabPage() {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try { email = String((await verifyAdminJwt(cookie)).email ?? ""); } catch { redirect("/admin"); }
  return (
    <AdminShell adminEmail={email} active="stt-lab" pageTitle="STT Lab">
      <SttLabClient />
    </AdminShell>
  );
}
