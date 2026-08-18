import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { BenchSessionDetailClient } from "@/components/admin/BenchSessionDetailClient";
import { BenchConsultMarks } from "@/components/admin/BenchConsultMarks";

/**
 * Admin · Bench session detail — chunk timeline, totals, day download
 * (Room-Bench PRD §3.5; mockup screen 5). Kickoff C adds the read-only
 * "Consult marks" block under the chunk strip (decision C4).
 */

export const dynamic = "force-dynamic";

export default async function AdminBenchSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try {
    email = String((await verifyAdminJwt(cookie)).email ?? "");
  } catch {
    redirect("/admin");
  }
  return (
    <AdminShell
      adminEmail={email}
      active="bench"
      pageTitle="Bench session"
      breadcrumb="Bench / session detail"
    >
      <BenchSessionDetailClient sessionId={id} />
      <BenchConsultMarks sessionId={id} />
    </AdminShell>
  );
}
