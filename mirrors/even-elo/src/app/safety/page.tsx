import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AdminShell } from "@/components/AdminShell";
import SafetyNav from "@/components/safety/SafetyNav";
import SafetyHub from "@/components/safety/SafetyHub";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Page() {
  const u = await getCurrentUser();
  if (!u || u.status !== "active" || !(u.is_super_admin || u.is_sgc_member)) redirect("/home");
  return (
    <AdminShell breadcrumbs={[{ label: "Governance", href: "/overview" }, { label: "Incidents" }]} title="Incident Management" subtitle="Reporting, RCA & CAPA — all departments, all incident types. Patient safety is the first lens, not the whole container.">
      <SafetyNav />
      <SafetyHub />
    </AdminShell>
  );
}
