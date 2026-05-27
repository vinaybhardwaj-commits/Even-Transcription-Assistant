/**
 * /admin/traces/{id} — single-trace forensic detail (Sprint 6.2).
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { TraceDetailClient } from "@/components/admin/TraceDetailClient";

export const dynamic = "force-dynamic";

export default async function AdminTraceDetailPage({
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
      active="traces"
      pageTitle={id}
      breadcrumb="LLM traces"
    >
      <TraceDetailClient traceId={id} />
    </AdminShell>
  );
}
