import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AdminShell } from "@/components/AdminShell";
import SafetyNav from "@/components/safety/SafetyNav";
import RoutesClient from "@/components/safety/RoutesClient";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export default async function Page() {
  const u = await getCurrentUser();
  if (!u || u.status !== "active" || !(u.is_super_admin || u.is_sgc_member)) redirect("/home");
  return (
    <AdminShell breadcrumbs={[{ label: "Governance", href: "/overview" }, { label: "Incidents", href: "/safety" }, { label: "Notifications" }]} title="Notification routing">
      <SafetyNav />
      <RoutesClient />
    </AdminShell>
  );
}
